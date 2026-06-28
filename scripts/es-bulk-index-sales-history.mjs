/**
 * Direct bulk-index script: sales-history-inv.db → Elasticsearch
 * Usage: node scripts/es-bulk-index-sales-history.mjs [--recreate] [--batch=N]
 *
 * Reads env from .env.local automatically. No Next.js server needed.
 */

import Database from "better-sqlite3";
import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// --- load .env.local ---
function loadEnv() {
    const envFile = resolve(ROOT, ".env.local");
    if (!existsSync(envFile)) return;
    for (const line of readFileSync(envFile, "utf8").split("\n")) {
        const clean = line.trim();
        if (!clean || clean.startsWith("#")) continue;
        const eq = clean.indexOf("=");
        if (eq < 1) continue;
        const key = clean.slice(0, eq).trim();
        const val = clean.slice(eq + 1).trim().replace(/^['"]|['"]$/g, "");
        if (key && !(key in process.env)) process.env[key] = val;
    }
}
loadEnv();

// --- config ---
const ES_URL = (process.env.ELASTICSEARCH_URL || "").replace(/\/+$/, "");
const ES_INDEX = process.env.ELASTICSEARCH_SALES_HISTORY_INDEX || "sales-history";
const DB_PATH = resolve(ROOT, "sales-history-inv.db");
const RECREATE = process.argv.includes("--recreate");
const BATCH = parseInt(process.argv.find(a => a.startsWith("--batch="))?.split("=")[1] || "10000", 10);

if (!ES_URL) { console.error("ELASTICSEARCH_URL tidak di-set di .env.local"); process.exit(1); }
if (!existsSync(DB_PATH)) { console.error("DB tidak ditemukan:", DB_PATH); process.exit(1); }

const HEADERS = { "Content-Type": "application/json" };

// --- ES helpers ---
async function esReq(method, path, body) {
    const res = await fetch(`${ES_URL}${path}`, {
        method,
        headers: HEADERS,
        body: body != null ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`ES ${method} ${path} → ${res.status}: ${text.slice(0, 200)}`);
    return JSON.parse(text);
}

async function ensureIndex() {
    const head = await fetch(`${ES_URL}/${ES_INDEX}`, { method: "HEAD", headers: HEADERS });
    if (head.status === 200 && !RECREATE) {
        console.log(`Index '${ES_INDEX}' sudah ada, lanjut indexing.`);
        return;
    }
    if (head.status === 200 && RECREATE) {
        console.log("Hapus index lama...");
        await esReq("DELETE", `/${ES_INDEX}`);
    }
    console.log("Buat index baru...");
    await esReq("PUT", `/${ES_INDEX}`, {
        settings: { number_of_shards: 1, number_of_replicas: 0 },
        mappings: {
            dynamic: false,
            properties: {
                id:           { type: "long" },
                referensi:    { type: "keyword" },
                nomorFaktur:  { type: "keyword" },
                tanggal:      { type: "date" },
                principal:    { type: "keyword" },
                kodeCust:     { type: "keyword" },
                customerNama: { type: "text", fields: { keyword: { type: "keyword", ignore_above: 256 } } },
                customerNpwp: { type: "keyword" },
                kodeObjek:    { type: "text", fields: { keyword: { type: "keyword", ignore_above: 128 } } },
                namaProduk:   { type: "text", fields: { keyword: { type: "keyword", ignore_above: 512 } } },
                qty:          { type: "double" },
                satuan:       { type: "keyword" },
                hargaSatuan:  { type: "double" },
                hargaTotal:   { type: "double" },
                diskonRp:     { type: "double" },
                dpp:          { type: "double" },
                ppn:          { type: "double" },
                sourceFile:   { type: "keyword" },
            },
        },
    });
    console.log("Index dibuat.");
}

async function bulkIndex(docs) {
    const lines = [];
    for (const doc of docs) {
        lines.push(JSON.stringify({ index: { _index: ES_INDEX, _id: String(doc.id) } }));
        lines.push(JSON.stringify(doc));
    }
    const res = await fetch(`${ES_URL}/_bulk`, {
        method: "POST",
        headers: HEADERS,
        body: `${lines.join("\n")}\n`,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(`Bulk gagal ${res.status}`);
    const errors = data.errors
        ? (data.items || []).map(i => i.index?.error).filter(Boolean)
        : [];
    return { took: data.took, indexed: docs.length - errors.length, errors: errors.slice(0, 5) };
}

// --- main ---
const db = new Database(DB_PATH, { readonly: true });

const totalRow = db.prepare("SELECT COUNT(*) AS c FROM sales_history_item WHERE referensi LIKE 'INV/%'").get();
const TOTAL = totalRow.c;

const stmt = db.prepare(`
    SELECT shi.id,
           shi.referensi,
           shi.nomor_faktur     AS nomorFaktur,
           shi.tanggal,
           im.principal,
           im.kode_cust         AS kodeCust,
           COALESCE(cm.nama, shi.customer_nama) AS customerNama,
           shi.customer_npwp    AS customerNpwp,
           shi.kode_objek       AS kodeObjek,
           shi.nama_produk      AS namaProduk,
           shi.qty,
           shi.satuan,
           shi.harga_satuan     AS hargaSatuan,
           shi.harga_total      AS hargaTotal,
           shi.diskon_rp        AS diskonRp,
           shi.dpp,
           shi.ppn,
           shi.source_file      AS sourceFile
    FROM sales_history_item shi
    JOIN invoice_map im ON im.referensi = shi.referensi
    LEFT JOIN customer_map cm ON cm.kode = im.kode_cust
    WHERE shi.referensi LIKE 'INV/%'
      AND shi.id > ?
    ORDER BY shi.id
    LIMIT ?
`);

await ensureIndex();

let cursor = 0;
let totalIndexed = 0;
const startMs = Date.now();

console.log(`\nIndexing ${TOTAL.toLocaleString()} items → ${ES_INDEX} (batch ${BATCH})...\n`);

while (true) {
    const rows = stmt.all(cursor, BATCH);
    if (rows.length === 0) break;

    const { indexed, errors, took } = await bulkIndex(rows);
    totalIndexed += indexed;
    cursor = rows.at(-1).id;

    const pct = ((totalIndexed / TOTAL) * 100).toFixed(1);
    const elapsed = ((Date.now() - startMs) / 1000).toFixed(0);
    const rate = Math.round(totalIndexed / ((Date.now() - startMs) / 1000));
    process.stdout.write(`\r[${pct}%] ${totalIndexed.toLocaleString()}/${TOTAL.toLocaleString()} | ${rate.toLocaleString()}/s | ${elapsed}s${errors.length ? " ⚠ err:" + errors.length : ""}   `);

    if (errors.length > 0) console.error("\nBatch errors:", errors);
}

const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
console.log(`\n\nSelesai! ${totalIndexed.toLocaleString()} dokumen diindex dalam ${elapsed}s.`);

db.close();
