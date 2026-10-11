// Tujuan: Laporan kandidat principal + usulan benih SQL (S7-2, BL-64) — BACA-SAJA terhadap DATABASE_URL.
// Caller: manusia (IT Support / owner) sebelum benih; uji lib/principal-pg.test.ts.
//   npx tsx scripts/principal-laporan.mjs [--keluar <folder>]      (tsx: logika di lib/principal/laporan.ts)
// Dependensi: pg, lib/principal/laporan.ts (murni). DATABASE_URL (tidak pernah dicetak).
// Main Functions: bukaBacaSaja, bacaSumber, jalankan.
// Side Effects: HANYA membaca DB (sesi default_transaction_read_only=on + transaksi READ ONLY, diperiksa sebelum membaca);
//   menulis laporan.json, laporan.md, benih.sql ke folder keluaran (bawaan scratch/principal-laporan/<waktu>/, git-ignored).
// Keluar: 0 = semua sumber terbaca; 2 = laporan ditulis tetapi ada sumber GAGAL dibaca (lihat laporan, galat ≠ kosong); 1 = gagal.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";
import * as modulLaporan from "../lib/principal/laporan.ts";

// Paket ini bukan "type": "module" -> tsx memuat .ts sebagai CommonJS dan ekspor bernama tidak terlihat dari .mjs (hanya `default`).
const { benihSql, laporanMarkdown, ringkas, susunLaporan } = modulLaporan.default ?? modulLaporan;

/** Klien dalam transaksi REPEATABLE READ READ ONLY (satu snapshot untuk semua sumber). Menolak bila sesi tidak baca-saja. */
export async function bukaBacaSaja(url) {
    const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 15_000 });
    await client.connect();
    try {
        await client.query("SET default_transaction_read_only = on");
        await client.query("SET statement_timeout = '60s'");
        await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
        const { rows } = await client.query("SHOW transaction_read_only");
        if (rows[0]?.transaction_read_only !== "on") throw new Error("sesi tidak baca-saja — berhenti tanpa membaca");
        return client;
    } catch (error) {
        await client.end().catch(() => undefined);
        throw error;
    }
}

const KUERI = {
    masterBarang: `SELECT principle_code AS "principleCode", principle_name AS "principleName", count(*)::int AS n
                   FROM master_barang GROUP BY 1, 2 ORDER BY 1, 2`,
    principalMapping: `SELECT principal, kind, count(*)::int AS n FROM principal_mapping GROUP BY 1, 2 ORDER BY 1, 2`,
    noClaimTemplate: `SELECT principle_code AS "principleCode", variant_key AS "variantKey" FROM no_claim_template ORDER BY 1, 2`,
    offBatch: `SELECT principle_code AS "principleCode", principle_name AS "principleName", count(*)::int AS n
               FROM off_batch GROUP BY 1, 2 ORDER BY 1, 2`,
    claimWorkflow: `SELECT principle_code AS "principleCode", principle_name AS "principleName", count(*)::int AS n
                    FROM claim_workflow GROUP BY 1, 2 ORDER BY 1, 2`,
    principal: `SELECT code, name, is_active AS "isActive" FROM principal ORDER BY code`,
    principalVariant: `SELECT p.code, v.variant_key AS "variantKey", v.name, v.is_active AS "isActive"
                       FROM principal_variant v JOIN principal p ON p.id = v.principal_id ORDER BY 1, 2`,
    principalAlias: `SELECT p.code, a.variant_key AS "variantKey", a.alias_norm AS "aliasNorm", a.alias_asli AS "aliasAsli", a.jenis, a.sumber
                     FROM principal_alias a JOIN principal p ON p.id = a.principal_id ORDER BY 3, 1`,
};

/** Tiap sumber dibaca di SAVEPOINT sendiri: satu tabel hilang/galat tidak menggugurkan yang lain dan tercatat sebagai galat. */
export async function bacaSumber(client) {
    const data = {};
    for (const [nama, kueri] of Object.entries(KUERI)) {
        await client.query("SAVEPOINT sumber");
        try {
            data[nama] = { ok: true, rows: (await client.query(kueri)).rows };
            await client.query("RELEASE SAVEPOINT sumber");
        } catch (error) {
            await client.query("ROLLBACK TO SAVEPOINT sumber");
            data[nama] = { ok: false, galat: `${error?.code ?? ""} ${String(error?.message ?? error)}`.trim() };
        }
    }
    return data;
}

export async function jalankan({ url, keluar, sekarang = new Date() }) {
    if (!String(url ?? "").startsWith("postgres")) throw new Error("DATABASE_URL bukan Postgres");
    const client = await bukaBacaSaja(url);
    let data;
    try {
        data = await bacaSumber(client);
    } finally {
        await client.query("ROLLBACK").catch(() => undefined);
        await client.end();
    }
    const lap = susunLaporan(data, sekarang.toISOString());
    await mkdir(keluar, { recursive: true });
    const json = { dibuat: lap.dibuat, registri: { ...lap.registri, principal: [...lap.registri.principal.values()],
        varian: [...lap.registri.varian.values()], alias: [...lap.registri.alias.values()].flat() }, sumber: lap.sumber.map((b) => ({ ...b, ringkas: ringkas(b) })) };
    await writeFile(path.join(keluar, "laporan.json"), `${JSON.stringify(json, null, 2)}\n`);
    await writeFile(path.join(keluar, "laporan.md"), laporanMarkdown(lap));
    await writeFile(path.join(keluar, "benih.sql"), benihSql(lap));
    return { lap, gagal: lap.sumber.filter((b) => b.galat).map((b) => b.judul) };
}

async function main() {
    const i = process.argv.indexOf("--keluar");
    const cap = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
    const keluar = i > 0 && process.argv[i + 1] ? process.argv[i + 1] : path.join("scratch", "principal-laporan", cap);
    try {
        const { lap, gagal } = await jalankan({ url: process.env.DATABASE_URL, keluar });
        for (const b of lap.sumber) {
            const r = ringkas(b);
            console.log(`[principal-laporan] ${b.judul}: ${b.galat ? `GAGAL — ${b.galat}` : `matched ${r.matched}, ambiguous ${r.ambiguous}, unmatched ${r.unmatched}`}`);
        }
        console.log(`[principal-laporan] ditulis: ${keluar}/laporan.md, laporan.json, benih.sql (TINJAU sebelum dijalankan)`);
        if (gagal.length) {
            console.error(`[principal-laporan] ${gagal.length} sumber GAGAL dibaca — laporan tidak lengkap.`);
            process.exit(2);
        }
    } catch (error) {
        console.error("[principal-laporan] GAGAL:", String(error?.message ?? error));
        process.exit(1);
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
