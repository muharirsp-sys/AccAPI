// Tujuan: Isi kolom ringkas Supervisor Review (sales_invoice.salesman_id/qty_total/jumlah_item/dpp) untuk faktur 60 hari terakhir yang
//   masuk SEBELUM image SR-1 (spec docs/superpowers/specs/2026-10-16-supervisor-review-design.md §3.2). Sesudahnya lib/sync.ts mengisinya.
// Caller: IT Support sekali, SESUDAH DDL_SUPERVISOR_REVIEW.sql + image SR-1, di luar jam sibuk (perkiraan ±10 menit: ±800 faktur/hari,
//   urai ±9 dtk/hari di VPS 2 core). Uji: lib/supervisor-review/supervisor-review-pg.test.ts.
//   Di container frontend (image tanpa tsx; Node 22 mengurai .ts dengan --experimental-strip-types):
//     docker cp scripts/backfill-ringkas-faktur.mjs <frontend>:/app/scripts/
//     docker exec <frontend> mkdir -p /app/lib/supervisor-review
//     docker cp lib/supervisor-review/ringkas-faktur.ts <frontend>:/app/lib/supervisor-review/
//     docker exec <frontend> node --experimental-strip-types scripts/backfill-ringkas-faktur.mjs --cek   (hitung saja)
//     docker exec <frontend> node --experimental-strip-types scripts/backfill-ringkas-faktur.mjs
// Dependensi: pg, DATABASE_URL (tidak pernah dicetak), lib/supervisor-review/ringkas-faktur.ts (fungsi yang SAMA dengan sinkron).
// Main Functions: backfill, tanggalMundur. Side Effects: UPDATE 4 kolom ringkas saja (synced_at TIDAK diubah -> feed delta lain tidak terpicu).
// Idempoten: hanya baris `qty_total IS NULL` (juga di UPDATE -> tidak menimpa yang baru diisi sinkron). Berurutan, TIDAK paralel:
//   per hari ambil id dulu (indeks trans_date), lalu raw_data per PK bertahap PER_AMBIL baris.
import pg from "pg";
import { pathToFileURL } from "node:url";
import * as modulRingkas from "../lib/supervisor-review/ringkas-faktur.ts";

// Pola scripts/principal-laporan.mjs: tsx memuat .ts sebagai CJS (package.json tanpa "type") -> ekspor bernama di .default; node
// --experimental-strip-types memuatnya sebagai ESM. Keduanya fungsi yang SAMA dengan lib/sync.ts.
const { ringkasFaktur } = modulRingkas.default ?? modulRingkas;

export const HARI_BAWAAN = 60;
const PER_AMBIL = 50; // ponytail: ±50 KB raw_data per faktur -> ±2,5 MB per ambil; naikkan bila terbukti lambat.

/** `hari` tanggal dd/MM/yyyy (bentuk sales_invoice.trans_date) mundur dari `hariIni` (YYYY-MM-DD, termasuk hari itu). */
export function tanggalMundur(hariIni, hari = HARI_BAWAAN) {
    const [y, m, d] = hariIni.split("-").map(Number);
    return Array.from({ length: hari }, (_, i) => {
        const t = new Date(Date.UTC(y, m - 1, d - i));
        return `${String(t.getUTCDate()).padStart(2, "0")}/${String(t.getUTCMonth() + 1).padStart(2, "0")}/${t.getUTCFullYear()}`;
    });
}

/** `cek` = hanya menghitung baris kosong per hari (tanpa menulis). Kembali: { kosong, diisi, tanpaRincian }. */
export async function backfill(pool, { cek = false, hari = HARI_BAWAAN, hariIni, log = console.log } = {}) {
    const hasil = { kosong: 0, diisi: 0, tanpaRincian: 0 };
    const mulai = hariIni ?? new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Makassar" }).format(new Date());
    for (const tanggal of tanggalMundur(mulai, hari)) {
        const id = (await pool.query(`SELECT id FROM sales_invoice WHERE trans_date = $1 AND qty_total IS NULL ORDER BY id`, [tanggal])).rows.map((r) => r.id);
        hasil.kosong += id.length;
        if (cek || id.length === 0) {
            if (id.length) log(`${tanggal}: ${id.length} faktur belum berringkasan`);
            continue;
        }
        let diisi = 0, tanpa = 0;
        for (let i = 0; i < id.length; i += PER_AMBIL) {
            const { rows } = await pool.query(`SELECT id, raw_data #>> '{}' AS raw FROM sales_invoice WHERE id = ANY($1::bigint[]) AND qty_total IS NULL`,
                [id.slice(i, i + PER_AMBIL)]);
            for (const r of rows) {
                const x = ringkasFaktur(r.raw);
                if (x.qtyTotal === null) { tanpa++; continue; } // detailItem belum ada: cron webhook-backfill yang mengisinya lewat sinkron
                const u = await pool.query(`UPDATE sales_invoice SET salesman_id = $2, qty_total = $3, jumlah_item = $4, dpp = $5
                    WHERE id = $1 AND qty_total IS NULL`, [r.id, x.salesmanId, x.qtyTotal, x.jumlahItem, x.dpp]);
                diisi += u.rowCount;
            }
        }
        hasil.diisi += diisi;
        hasil.tanpaRincian += tanpa;
        log(`${tanggal}: ${id.length} kosong -> ${diisi} diisi, ${tanpa} tanpa rincian`);
    }
    log(`${cek ? "CEK" : "SELESAI"}: ${hasil.kosong} kosong, ${hasil.diisi} diisi, ${hasil.tanpaRincian} tanpa rincian (${hari} hari s.d. ${mulai}).`);
    return hasil;
}

async function main() {
    const url = process.env.DATABASE_URL || "";
    if (!url.startsWith("postgres")) throw new Error("DATABASE_URL PostgreSQL wajib di-set.");
    const i = process.argv.indexOf("--hari");
    const hari = i > 0 ? Number(process.argv[i + 1]) : HARI_BAWAAN;
    if (!Number.isInteger(hari) || hari < 1 || hari > 366) throw new Error("--hari harus bilangan 1..366.");
    const pool = new pg.Pool({ connectionString: url, max: 1 });
    try {
        await backfill(pool, { cek: process.argv.includes("--cek"), hari });
    } finally {
        await pool.end();
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((e) => { console.error("[backfill-ringkas-faktur] GAGAL:", String(e?.message || e)); process.exit(1); });
}
