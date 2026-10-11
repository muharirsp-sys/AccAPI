// Tujuan: Laporan kandidat principal + usulan benih SQL (S7-2, BL-64) — BACA-SAJA.
// Caller: manusia (IT Support / owner) sebelum benih; uji lib/principal-pg.test.ts.
//   Produksi (tanpa terowongan, tanpa tsx di image): IT Support menjalankan docs/handover/PRINCIPAL_EKSPOR.sql lewat
//     docker exec -i accapi-postgres psql -U accapi -d accapi -qAt -v ON_ERROR_STOP=1 < PRINCIPAL_EKSPOR.sql > principal-ekspor.json
//   lalu OFFLINE di checkout repo:  npx tsx scripts/principal-laporan.mjs --dari-json principal-ekspor.json [--keluar <folder>]
//   Langsung ke DB (dev / DB uji):  DATABASE_URL=<url> npx tsx scripts/principal-laporan.mjs [--keluar <folder>]
//   (tsx: logika di lib/principal/laporan.ts). Kedua mode memakai berkas SQL ekspor yang SAMA dan pengurai yang SAMA (uraiEkspor).
// Dependensi: pg, docs/handover/PRINCIPAL_EKSPOR.sql, lib/principal/laporan.ts (murni). DATABASE_URL (tidak pernah dicetak).
// Main Functions: eksporDariDb, jalankan.
// Side Effects: mode DB HANYA membaca (berkas ekspor: default_transaction_read_only=on + BEGIN ... READ ONLY, diperiksa sebelum membaca,
//   ROLLBACK); menulis laporan.json, laporan.md, benih.sql ke folder keluaran (bawaan scratch/principal-laporan/<waktu>/, git-ignored).
// Keluar: 0 = semua sumber terbaca; 2 = laporan ditulis tetapi ada sumber GAGAL dibaca (lihat laporan, galat ≠ kosong); 1 = gagal.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";
import * as modulLaporan from "../lib/principal/laporan.ts";

// Paket ini bukan "type": "module" -> tsx memuat .ts sebagai CommonJS dan ekspor bernama tidak terlihat dari .mjs (hanya `default`).
const { benihSql, laporanMarkdown, ringkas, susunLaporan, uraiEkspor } = modulLaporan.default ?? modulLaporan;
export const EKSPOR_SQL = new URL("../docs/handover/PRINCIPAL_EKSPOR.sql", import.meta.url);

/** Mode DB: jalankan berkas ekspor (baca-saja; berkas sendiri memeriksa & ROLLBACK) -> teks JSON yang sama dengan keluaran psql -qAt. */
export async function eksporDariDb(url) {
    if (!String(url ?? "").startsWith("postgres")) throw new Error("DATABASE_URL bukan Postgres");
    const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 15_000 });
    await client.connect();
    try {
        const hasil = [await client.query(await readFile(EKSPOR_SQL, "utf8"))].flat();
        const baris = hasil.find((r) => r.fields?.[0]?.name === "ekspor")?.rows?.[0]?.ekspor;
        if (typeof baris !== "string") throw new Error("PRINCIPAL_EKSPOR.sql tidak menghasilkan baris ekspor");
        return baris;
    } finally {
        await client.end();
    }
}

/** `dariJson` = berkas keluaran PRINCIPAL_EKSPOR.sql (tanpa DB); selain itu baca `url`. `sekarang` menimpa waktu laporan (uji). */
export async function jalankan({ url, dariJson, keluar, sekarang }) {
    const { dibaca, data } = uraiEkspor(dariJson ? await readFile(dariJson, "utf8") : await eksporDariDb(url));
    const lap = susunLaporan(data, sekarang ? sekarang.toISOString() : dibaca);
    await mkdir(keluar, { recursive: true });
    const json = { dibuat: lap.dibuat, registri: { ...lap.registri, principal: [...lap.registri.principal.values()],
        varian: [...lap.registri.varian.values()], alias: [...lap.registri.alias.values()].flat() }, sumber: lap.sumber.map((b) => ({ ...b, ringkas: ringkas(b) })) };
    await writeFile(path.join(keluar, "laporan.json"), `${JSON.stringify(json, null, 2)}\n`);
    await writeFile(path.join(keluar, "laporan.md"), laporanMarkdown(lap));
    await writeFile(path.join(keluar, "benih.sql"), benihSql(lap));
    return { lap, gagal: lap.sumber.filter((b) => b.galat).map((b) => b.judul) };
}

async function main() {
    const arg = (nama) => {
        const i = process.argv.indexOf(nama);
        return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : undefined;
    };
    const cap = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
    const keluar = arg("--keluar") ?? path.join("scratch", "principal-laporan", cap);
    try {
        const { lap, gagal } = await jalankan({ url: process.env.DATABASE_URL, dariJson: arg("--dari-json"), keluar });
        for (const b of lap.sumber) {
            const r = ringkas(b);
            console.log(`[principal-laporan] ${b.judul}: ${b.galat ? `GAGAL — ${b.galat}` : `matched ${r.matched}, ambiguous ${r.ambiguous}, unmatched ${r.unmatched}`}`);
        }
        console.log(`[principal-laporan] data dibaca ${lap.dibuat}; ditulis: ${keluar}/laporan.md, laporan.json, benih.sql (TINJAU sebelum dijalankan)`);
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
