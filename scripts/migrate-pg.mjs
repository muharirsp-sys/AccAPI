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

// DATABASE_MIGRATION_URL: role ber-hak DDL, terpisah dari role aplikasi. Role aplikasi
// (accapi_app) sengaja bukan owner tabel — runbook L1g — dan Postgres menolak ALTER TABLE
// dari non-owner. Kalau tidak di-set, jatuh ke DATABASE_URL seperti semula.
const url = process.env.DATABASE_MIGRATION_URL || process.env.DATABASE_URL || "";
if (!url.startsWith("postgres")) {
  console.log("[migrate-pg] DATABASE_URL bukan Postgres — dilewati.");
  process.exit(0);
}

/** @type {{ nama: string, sudahAda: string, sql: string }[]} */
const migrations = [
  {
    // 2026-08-29. Deteksi kandidat "Gabung Kode Sales" hanya bisa membaca nama dari
    // sales_targets, jadi kode yang punya penjualan tapi belum punya target sampai ke sana
    // sebagai kode telanjang dan pasangan satu-orang-dua-rute tidak pernah terbentuk.
    // Kasus nyata: target BASRI YUSUF di M-BSR, penjualannya di M-BSR2.
    nama: "sales_daily_progress.sales_name",
    sudahAda: `SELECT 1 FROM information_schema.columns
               WHERE table_name = 'sales_daily_progress' AND column_name = 'sales_name'`,
    sql: "ALTER TABLE sales_daily_progress ADD COLUMN IF NOT EXISTS sales_name TEXT",
  },
  {
    // 2026-08-31. Tabel penyimpanan rekonsiliasi (db/migrations/0001_reconciliation_storage.sql)
    // dibuat setelah cutover D4 lewat `drizzle-kit push` yang tidak pernah kena prod, jadi
    // GET /api/reconciliation/{mappings,history} error `relation ... does not exist`.
    // Versi IF NOT EXISTS ini menutup celahnya secara idempoten saat container start.
    nama: "reconciliation storage",
    sudahAda: `SELECT 1 FROM information_schema.tables
               WHERE table_name IN ('reconciliation_mapping_version', 'reconciliation_run')
               GROUP BY 1 HAVING count(*) = 2`,
    sql: `
      CREATE TABLE IF NOT EXISTS reconciliation_mapping_version (
          id text PRIMARY KEY,
          division text NOT NULL CHECK (division IN ('sales', 'purchases', 'returns')),
          principal_code text NOT NULL,
          version integer NOT NULL CHECK (version > 0),
          original_name text NOT NULL,
          mime_type text NOT NULL,
          byte_size integer NOT NULL CHECK (byte_size > 0 AND byte_size <= 10485760),
          sha256 text NOT NULL CHECK (length(sha256) = 64),
          workbook bytea NOT NULL,
          uploaded_by text NOT NULL,
          uploaded_by_name text NOT NULL,
          uploaded_by_email text NOT NULL,
          is_active boolean NOT NULL DEFAULT true,
          created_at timestamp NOT NULL,
          UNIQUE (division, principal_code, version)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS reconciliation_mapping_version_active_idx
          ON reconciliation_mapping_version (division, principal_code)
          WHERE is_active = true;
      CREATE INDEX IF NOT EXISTS reconciliation_mapping_version_lookup_idx
          ON reconciliation_mapping_version (division, principal_code, created_at);
      CREATE TABLE IF NOT EXISTS reconciliation_run (
          id text PRIMARY KEY,
          division text NOT NULL CHECK (division IN ('sales', 'purchases', 'returns')),
          principal_code text NOT NULL,
          mapping_version_id text NOT NULL REFERENCES reconciliation_mapping_version(id) ON DELETE RESTRICT,
          status text NOT NULL CHECK (status IN ('processing', 'success', 'failed')),
          uploaded_by text NOT NULL,
          uploaded_by_name text NOT NULL,
          uploaded_by_email text NOT NULL,
          input_files jsonb NOT NULL,
          summary jsonb,
          issues jsonb,
          error text,
          duration_ms integer CHECK (duration_ms IS NULL OR duration_ms >= 0),
          started_at timestamp NOT NULL,
          finished_at timestamp
      );
      CREATE INDEX IF NOT EXISTS reconciliation_run_lookup_idx
          ON reconciliation_run (division, principal_code, started_at);
      CREATE INDEX IF NOT EXISTS reconciliation_run_uploader_idx
          ON reconciliation_run (uploaded_by, started_at);
      CREATE INDEX IF NOT EXISTS reconciliation_run_mapping_version_idx
          ON reconciliation_run (mapping_version_id);
    `,
  },
];

const pool = new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 15_000 });

try {
  for (const m of migrations) {
    // Cek dulu lewat information_schema (read-only, tidak butuh hak DDL). Postgres memeriksa
    // kepemilikan tabel SEBELUM IF NOT EXISTS sempat berlaku, jadi tanpa cek ini ALTER tetap
    // ditolak walau kolomnya sudah ada — dan karena kegagalan mematikan container, hasilnya
    // crash loop permanen: "no available server" di proxy.
    const { rowCount } = await pool.query(m.sudahAda);
    if (rowCount) {
      console.log(`[migrate-pg] SKIP ${m.nama} (sudah ada)`);
      continue;
    }
    await pool.query(m.sql);
    console.log(`[migrate-pg] OK ${m.nama}`);
  }
  console.log(`[migrate-pg] ${migrations.length} migrasi selesai.`);
} catch (error) {
  // Sengaja MEMATIKAN container: kode yang butuh kolom ini sudah ikut di image yang sama.
  // Start dengan skema setengah jadi berarti error muncul nanti, di tangan user, pada
  // request acak — jauh lebih mahal daripada gagal start yang langsung terlihat di log.
  console.error("[migrate-pg] GAGAL:", String(error?.message || error));
  console.error("[migrate-pg] Kalau pesannya soal owner/permission: role aplikasi memang bukan owner tabel.");
  console.error("[migrate-pg] Jalankan DDL-nya sekali sebagai role owner (lihat docs/handover/), atau set");
  console.error("[migrate-pg] DATABASE_MIGRATION_URL ke role yang berhak DDL. Setelah kolomnya ada, migrasi ini di-skip.");
  process.exit(1);
} finally {
  await pool.end();
}
