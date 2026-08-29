// Tujuan: Migrasi Postgres yang ADITIF dan idempoten, dijalankan otomatis saat container start.
// Caller: Dockerfile.frontend CMD, sebelum `node server.js`. Bisa juga `node scripts/migrate-pg.mjs`.
// Dependensi: pg (sudah dependency runtime lewat lib/db).
// Main Functions: jalankan daftar DDL berurutan, laporkan yang berubah.
// Side Effects: DDL pada database di DATABASE_URL.
//
// Kenapa ada: skema Postgres dibuat lewat `drizzle-kit push` saat cutover D4, dan sejak itu
// setiap kolom baru jadi langkah manual `docker exec ... psql` di VPS yang gampang terlewat —
// kode sudah ter-deploy sementara kolomnya belum ada, dan errornya baru muncul saat dipakai.
// File ini menutup celah itu untuk perubahan yang aman diulang.
//
// ATURAN ISI DAFTAR — hanya perubahan yang aman dijalankan berkali-kali dan tidak bisa
// menghilangkan data:
//   BOLEH : ADD COLUMN IF NOT EXISTS, CREATE INDEX IF NOT EXISTS, CREATE TABLE IF NOT EXISTS
//   JANGAN: DROP apa pun, ALTER TYPE, NOT NULL pada tabel berisi, UPDATE/DELETE data.
// Yang tidak boleh di sini tetap lewat DDL manual di docs/handover/ supaya ada yang menekan
// tombolnya secara sadar dan bisa memeriksa hasilnya baris per baris.

import { Pool } from "pg";

const url = process.env.DATABASE_URL ?? "";
if (!url.startsWith("postgres")) {
  console.log("[migrate-pg] DATABASE_URL bukan Postgres — dilewati.");
  process.exit(0);
}

/** @type {{ nama: string, sql: string }[]} */
const migrations = [
  {
    // 2026-08-29. Deteksi kandidat "Gabung Kode Sales" hanya bisa membaca nama dari
    // sales_targets, jadi kode yang punya penjualan tapi belum punya target sampai ke sana
    // sebagai kode telanjang dan pasangan satu-orang-dua-rute tidak pernah terbentuk.
    // Kasus nyata: target BASRI YUSUF di M-BSR, penjualannya di M-BSR2.
    nama: "sales_daily_progress.sales_name",
    sql: "ALTER TABLE sales_daily_progress ADD COLUMN IF NOT EXISTS sales_name TEXT",
  },
];

const pool = new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 15_000 });

try {
  for (const m of migrations) {
    await pool.query(m.sql);
    console.log(`[migrate-pg] OK ${m.nama}`);
  }
  console.log(`[migrate-pg] ${migrations.length} migrasi selesai.`);
} catch (error) {
  // Sengaja MEMATIKAN container: kode yang butuh kolom ini sudah ikut di image yang sama.
  // Start dengan skema setengah jadi berarti error muncul nanti, di tangan user, pada
  // request acak — jauh lebih mahal daripada gagal start yang langsung terlihat di log.
  console.error("[migrate-pg] GAGAL:", String(error?.message || error));
  process.exit(1);
} finally {
  await pool.end();
}
