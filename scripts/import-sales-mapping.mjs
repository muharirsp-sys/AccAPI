/*
 * Tujuan: Backfill mapping Sales History dari file lokal:
 *   - Mapping_Customer.xlsx        -> tabel customer_map  (kode -> nama, alamat, kota, region, npwp)
 *   - Data_Penjualan/**.xlsx       -> tabel invoice_map   (NO_NOTA=referensi -> kode_cust, principal, salesman, tanggal)
 *   - Data_Penjualan/**.xlsx       -> tabel sales_history_item (baris item per NO_NOTA, termasuk qty+satuan)
 * Caller: dijalankan manual (sekali / saat ada data baru). Lihat perintah di bawah.
 * Dependensi: @libsql/client + xlsx (SheetJS). DB: SALES_HISTORY_DATABASE_URL || file:sales-history-inv.db.
 * Main Functions: ensureSchema, importCustomers, importInvoices, bulkIndexSalesItems, main.
 * Side Effects: Membuat/memperbarui sales-history-inv.db, upsert customer_map/invoice_map, replace sales_history_item per faktur,
 *   opsional upsert Elasticsearch jika ELASTICSEARCH_URL tersedia, dan log progres ke console.
 * Catatan: jalur legacy/incremental; full rebuild besar pakai scripts/build-sales-history-staging.mjs.
 *   Kolom dicari by NAMA HEADER (bukan posisi) â€” toleran beda layout antar tahun.
 *   Hanya referensi INV/ yang diimpor; RJN/SRT di-skip. File diproses urut mtime ASC -> versi FIX/UPDATE terbaru menang.
 *
 * Jalankan:
 *   node --experimental-strip-types scripts/import-sales-mapping.mjs
 *   SALES_HISTORY_IMPORT_YEAR=2025 node --experimental-strip-types scripts/import-sales-mapping.mjs
 *   SALES_HISTORY_IMPORT_FILE="12 DATA PENJUALAN" node --experimental-strip-types scripts/import-sales-mapping.mjs
 */
import { createClient } from "@libsql/client";
import { createRequire } from "node:module";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const XLSX = require("xlsx");

const DB_URL = process.env.SALES_HISTORY_DATABASE_URL || "file:sales-history-inv.db";
const MAPPING_FILE = "Mapping_Customer.xlsx";
const SALES_DIR = "Data_Penjualan";
const db = createClient({ url: DB_URL });

const clean = (v) => String(v ?? "").replace(/[\r\n]+/g, " ").trim();
const ONLY_YEAR = clean(process.env.SALES_HISTORY_IMPORT_YEAR);
const ONLY_FILE = clean(process.env.SALES_HISTORY_IMPORT_FILE).toLowerCase();
const stripCode = (name) => clean(name).replace(/\s*\{[^}]*\}\s*$/, "").trim();
const isInvoiceRef = (ref) => clean(ref).toUpperCase().startsWith("INV/");
const num = (v) => {
    const n = Number(String(v ?? "").replace(/,/g, "").trim());
    return Number.isFinite(n) ? n : 0;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function withBusyRetry(label, fn) {
    let lastError;
    for (let attempt = 1; attempt <= 6; attempt++) {
        try {
            return await fn();
        } catch (error) {
            lastError = error;
            if (!String(error?.code || error?.message || "").includes("SQLITE_BUSY")) throw error;
            const delay = attempt * 1500;
            console.warn(`SQLITE_BUSY ${label}; retry ${attempt}/6 dalam ${delay}ms`);
            await sleep(delay);
        }
    }
    throw lastError;
}

function elasticsearchConfig() {
    const url = process.env.ELASTICSEARCH_URL?.replace(/\/+$/, "");
    if (!url) return null;
    return {
        url,
        index: process.env.ELASTICSEARCH_SALES_HISTORY_INDEX || "sales-history-items",
        apiKey: process.env.ELASTICSEARCH_API_KEY || "",
        username: process.env.ELASTICSEARCH_USERNAME || "",
        password: process.env.ELASTICSEARCH_PASSWORD || "",
    };
}

function elasticsearchHeaders(config) {
    const headers = { "Content-Type": "application/json" };
    if (config.apiKey) headers.Authorization = `ApiKey ${config.apiKey}`;
    else if (config.username || config.password) headers.Authorization = `Basic ${Buffer.from(`${config.username}:${config.password}`).toString("base64")}`;
    return headers;
}

async function ensureSalesSearchIndex(config) {
    await fetch(`${config.url}/${encodeURIComponent(config.index)}`, {
        method: "PUT",
        headers: elasticsearchHeaders(config),
        body: JSON.stringify({
            settings: {
                analysis: {
                    analyzer: {
                        sales_history_analyzer: {
                            tokenizer: "standard",
                            filter: ["lowercase", "asciifolding"],
                        },
                    },
                },
            },
            mappings: {
                properties: {
                    referensi: { type: "keyword" },
                    tanggal: { type: "date" },
                    principal: { type: "keyword" },
                    kodeCust: { type: "keyword" },
                    kodeObjek: { type: "text", analyzer: "sales_history_analyzer", fields: { keyword: { type: "keyword" } } },
                    namaProduk: { type: "text", analyzer: "sales_history_analyzer" },
                },
            },
        }),
    }).catch(() => undefined);
}

async function bulkIndexSalesItems(config, docs) {
    if (!config || docs.length === 0) return;
    for (let i = 0; i < docs.length; i += 500) {
        const chunk = docs.slice(i, i + 500);
        const body = chunk
            .flatMap((doc) => [{ index: { _index: config.index, _id: doc.id } }, doc])
            .map((line) => JSON.stringify(line))
            .join("\n");
        const response = await fetch(`${config.url}/_bulk?refresh=false`, {
            method: "POST",
            headers: elasticsearchHeaders(config),
            body: `${body}\n`,
        });
        if (!response.ok) throw new Error(`Bulk Elasticsearch gagal: ${response.status}`);
    }
}

// Excel serial / string -> ISO yyyy-mm-dd (epoch Excel 1899-12-30).
function toIso(v) {
    if (typeof v === "number" && Number.isFinite(v)) {
        const ms = Math.round((v - 25569) * 86400 * 1000); // 25569 = 1970-01-01 dalam serial Excel
        const d = new Date(ms);
        return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
    }
    const m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(clean(v));
    if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
    return "";
}

async function ensureSchema() {
    await db.execute("PRAGMA busy_timeout = 30000");
    await db.execute("PRAGMA journal_mode = TRUNCATE");
    await db.execute(`CREATE TABLE IF NOT EXISTS sales_history_item (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        referensi TEXT NOT NULL,
        nomor_faktur TEXT NOT NULL,
        tanggal TEXT NOT NULL,
        customer_nama TEXT NOT NULL,
        customer_npwp TEXT NOT NULL,
        kode_objek TEXT NOT NULL,
        nama_produk TEXT NOT NULL,
        qty REAL NOT NULL,
        satuan TEXT NOT NULL DEFAULT '',
        harga_satuan REAL NOT NULL,
        harga_total REAL NOT NULL,
        diskon_rp REAL NOT NULL,
        dpp REAL NOT NULL,
        ppn REAL NOT NULL,
        source_file TEXT NOT NULL,
        keterangan TEXT NOT NULL DEFAULT ''
    )`);
    const itemColumns = await db.execute("PRAGMA table_info(sales_history_item)");
    if (!itemColumns.rows.some((row) => String(row.name || "") === "satuan")) {
        await db.execute("ALTER TABLE sales_history_item ADD COLUMN satuan TEXT NOT NULL DEFAULT ''");
    }
    if (!itemColumns.rows.some((row) => String(row.name || "") === "keterangan")) {
        await db.execute("ALTER TABLE sales_history_item ADD COLUMN keterangan TEXT NOT NULL DEFAULT ''");
    }
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_shi_referensi ON sales_history_item(referensi)`);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_shi_tanggal ON sales_history_item(tanggal)`);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_shi_customer ON sales_history_item(customer_nama)`);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_shi_nama_produk ON sales_history_item(nama_produk)`);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_shi_kode_objek ON sales_history_item(kode_objek)`);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_shi_source ON sales_history_item(source_file)`);
    await db.execute(`CREATE TABLE IF NOT EXISTS customer_map (
        kode TEXT PRIMARY KEY, nama TEXT NOT NULL, alamat TEXT NOT NULL,
        kota TEXT NOT NULL)`);
    await db.execute(`CREATE TABLE IF NOT EXISTS invoice_map (
        referensi TEXT PRIMARY KEY, kode_cust TEXT NOT NULL, principal TEXT NOT NULL,
        tanggal TEXT NOT NULL)`);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_im_principal ON invoice_map(principal)`);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_im_kode_cust ON invoice_map(kode_cust)`);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_im_principal_kode_cust ON invoice_map(principal, kode_cust)`);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_im_principal_tanggal ON invoice_map(principal, tanggal DESC)`);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_im_kode_cust_tanggal ON invoice_map(kode_cust, tanggal DESC)`);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_im_kode_cust_principal_tanggal ON invoice_map(kode_cust, principal, tanggal DESC)`);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_im_tanggal_principal ON invoice_map(tanggal DESC, principal)`);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_im_tanggal ON invoice_map(tanggal DESC)`);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_cm_nama ON customer_map(nama COLLATE NOCASE)`);
}

// Cari index kolom by salah satu nama header (case-insensitive).
function colIndex(header, ...names) {
    const norm = header.map((h) => clean(h).toUpperCase());
    for (const n of names) {
        const i = norm.indexOf(n.toUpperCase());
        if (i >= 0) return i;
    }
    return -1;
}

async function batchExec(stmts) {
    // libsql batch transaksional, potong per 100 agar write sandbox lebih stabil.
    for (let i = 0; i < stmts.length; i += 100) {
        const chunk = stmts.slice(i, i + 100);
        await withBusyRetry(`batch ${i}-${i + chunk.length}`, () => db.batch(chunk, "write"));
    }
}

async function deleteItemsForRefs(refs) {
    const uniqueRefs = [...new Set(refs)].filter(Boolean);
    for (let i = 0; i < uniqueRefs.length; i += 100) {
        const chunk = uniqueRefs.slice(i, i + 100);
        await withBusyRetry(`delete ${i}-${i + chunk.length}`, () => db.execute({
            sql: `DELETE FROM sales_history_item WHERE referensi IN (${chunk.map(() => "?").join(",")})`,
            args: chunk,
        }));
    }
}

async function importCustomers() {
    const wb = XLSX.readFile(MAPPING_FILE);
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });
    const header = rows[0] || [];
    const iKode = colIndex(header, "KODE0", "KODE", "CUSTOMERNO", "NO");
    const iNama = colIndex(header, "NAME", "NAMA");
    const iAlamat = colIndex(header, "ADDRESS", "ALAMAT");
    const iKota = colIndex(header, "KOTANAMA", "KOTA");
    if (iKode < 0 || iNama < 0) throw new Error("Mapping_Customer.xlsx: kolom KODE0/NAME tak ditemukan");

    const stmts = [];
    const seen = new Set();
    for (let r = 1; r < rows.length; r++) {
        const row = rows[r];
        const kode = clean(row[iKode]);
        if (!kode || seen.has(kode)) continue;
        seen.add(kode);
        stmts.push({
            sql: `INSERT OR REPLACE INTO customer_map (kode, nama, alamat, kota) VALUES (?,?,?,?)`,
            args: [
                kode,
                stripCode(row[iNama]),
                clean(row[iAlamat]),
                clean(iKota >= 0 ? row[iKota] : ""),
            ],
        });
    }
    await batchExec(stmts);
    console.log(`customer_map: ${stmts.length} customer.`);
}

function listXlsx(dir) {
    const out = [];
    for (const name of readdirSync(dir)) {
        if (name.startsWith("~$")) continue; // lock file Excel
        const p = join(dir, name);
        const st = statSync(p);
        if (st.isDirectory()) out.push(...listXlsx(p));
        else if (name.toLowerCase().endsWith(".xlsx")) out.push({ path: p, mtime: st.mtimeMs });
    }
    return out;
}

async function importInvoices() {
    const elastic = elasticsearchConfig();
    if (elastic) await ensureSalesSearchIndex(elastic);
    let files = listXlsx(SALES_DIR).sort((a, b) => a.mtime - b.mtime); // terbaru diproses terakhir -> menang
    if (ONLY_YEAR) files = files.filter((f) => f.path.replace(/\\/g, "/").includes(`Data_Penjualan/${ONLY_YEAR}/`));
    if (ONLY_FILE) files = files.filter((f) => f.path.toLowerCase().includes(ONLY_FILE));
    let totalInvoices = 0;
    let totalItems = 0;
    for (const { path } of files) {
        const sourceFile = path.replace(/.*Data_Penjualan[\\/]/, "");
        let wb;
        try { wb = XLSX.readFile(path); }
        catch (e) { console.warn(`SKIP (gagal baca): ${path} â€” ${e.message}`); continue; }
        const ws = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });
        const header = rows[0] || [];
        const iNota = colIndex(header, "NO_NOTA", "NONOTA", "NO NOTA");
        const iKode = colIndex(header, "KODE_CUST", "KODECUST");
        const iPrin = colIndex(header, "PRINCIPAL", "PRINCIPLE");
        const iTgl = colIndex(header, "TANGGAL", "TGL");
        const iCustomer = colIndex(header, "CUSTOMER", "NAMA CUSTOMER", "Nama Customer");
        const iNpwp = colIndex(header, "NPWP", "KTP / NPWP");
        const iKodeBarang = colIndex(header, "KODE_BARANG", "KODE BARANG", "Kode Barang");
        const iNamaBarang = colIndex(header, "NAMA_BARANG", "NAMA BARANG", "Nama Barang");
        const iQty = colIndex(header, "QTY", "Qty");
        const iSatuan = colIndex(header, "SATUAN", "Satuan", "UNIT", "Unit");
        const iHarga = colIndex(header, "HARGA", "Harga");
        const iPotongan = colIndex(header, "POTONGAN", "Nilai Disc");
        const iNilaiJual = colIndex(header, "NILAI_JUAL", "Nilai Bruto");
        const iDpp = colIndex(header, "DPP");
        const iPpn = colIndex(header, "NILAI_PAJAK", "Nilai Pajak");
        const iRem = colIndex(header, "REM");
        if (iNota < 0 || iKode < 0 || iPrin < 0) {
            console.warn(`SKIP (kolom kurang): ${path}`);
            continue;
        }
        const perInvoice = new Map(); // referensi -> {kode, principal, tanggal}
        const itemRefs = [];
        const itemStmts = [];
        const itemDocs = [];
        const canImportItems = [iCustomer, iKodeBarang, iNamaBarang, iQty, iHarga].every((i) => i >= 0);
        for (let r = 1; r < rows.length; r++) {
            const row = rows[r];
            const ref = clean(row[iNota]);
            if (!ref || !isInvoiceRef(ref)) continue;
            const tanggal = toIso(iTgl >= 0 ? row[iTgl] : "");
            if (!perInvoice.has(ref)) {
                perInvoice.set(ref, {
                    kode: clean(row[iKode]),
                    principal: clean(row[iPrin]),
                    tanggal,
                });
            }
            if (canImportItems) {
                const qty = num(row[iQty]);
                const hargaSatuan = num(row[iHarga]);
                const hargaTotal = iNilaiJual >= 0 ? num(row[iNilaiJual]) : qty * hargaSatuan;
                itemRefs.push(ref);
                const kodeCust = clean(row[iKode]);
                const principal = clean(row[iPrin]);
                const kodeObjek = clean(row[iKodeBarang]);
                const namaProduk = clean(row[iNamaBarang]);
                itemStmts.push({
                    sql: `INSERT INTO sales_history_item (
                        referensi, nomor_faktur, tanggal, customer_nama, customer_npwp,
                        kode_objek, nama_produk, qty, satuan, harga_satuan, harga_total,
                        diskon_rp, dpp, ppn, source_file, keterangan
                    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
                    args: [
                        ref,
                        ref,
                        tanggal,
                        clean(row[iCustomer]),
                        clean(iNpwp >= 0 ? row[iNpwp] : ""),
                        kodeObjek,
                        namaProduk,
                        qty,
                        clean(iSatuan >= 0 ? row[iSatuan] : ""),
                        hargaSatuan,
                        hargaTotal,
                        iPotongan >= 0 ? num(row[iPotongan]) : 0,
                        iDpp >= 0 ? num(row[iDpp]) : hargaTotal,
                        iPpn >= 0 ? num(row[iPpn]) : 0,
                        sourceFile,
                        clean(iRem >= 0 ? row[iRem] : ""),
                    ],
                });
                if (elastic) {
                    itemDocs.push({
                        id: `${sourceFile}:${r}:${ref}:${kodeObjek}`,
                        referensi: ref,
                        tanggal,
                        principal,
                        kodeCust,
                        kodeObjek,
                        namaProduk,
                    });
                }
            }
        }
        const stmts = [];
        for (const [ref, v] of perInvoice) {
            stmts.push({
                sql: `INSERT OR REPLACE INTO invoice_map (referensi, kode_cust, principal, tanggal) VALUES (?,?,?,?)`,
                args: [ref, v.kode, v.principal, v.tanggal],
            });
        }
        await batchExec(stmts);
        if (itemStmts.length) {
            await deleteItemsForRefs(itemRefs);
            await batchExec(itemStmts);
            await bulkIndexSalesItems(elastic, itemDocs);
        }
        totalInvoices += stmts.length;
        totalItems += itemStmts.length;
        console.log(`  ${sourceFile}: ${stmts.length} faktur, ${itemStmts.length} item`);
    }
    console.log(`invoice_map: ${totalInvoices} faktur (kumulatif, upsert).`);
    console.log(`sales_history_item: ${totalItems} item (replace per faktur).`);
}

async function main() {
    console.log("DB:", DB_URL);
    await ensureSchema();
    await importCustomers();
    await importInvoices();
    console.log("Selesai.");
}

main()
    .catch((e) => {
        console.error(e);
        process.exitCode = 1;
    })
    .finally(() => {
        db.close();
    });


