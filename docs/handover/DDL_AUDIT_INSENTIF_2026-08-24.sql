-- Migrasi manual untuk perbaikan audit Kelompok 1-4 (2026-08-24).
-- Lihat docs/handover/AUDIT_INSENTIF_SALES_2026-08-24.md.
-- Dijalankan manual via docker exec, sama seperti migrasi lain di project ini.
--
--   docker exec -it accapi-postgres psql -U accapi -d accapi -f /dev/stdin < docs/handover/DDL_AUDIT_INSENTIF_2026-08-24.sql
--
-- CATATAN: file ini TERPISAH dari DDL_UNIQUE_INSENTIF_2026-08-24.sql (temuan C2).
-- Urutan tidak penting — keduanya independen.
--
-- SEMUA statement di sini aman dijalankan saat aplikasi hidup dan aman diulang
-- (IF NOT EXISTS / ADD COLUMN IF NOT EXISTS). Tidak ada yang menghapus data.

-- ============================================================
-- M7 — jejak siapa mengubah target & nominal pembayaran.
-- Nullable, tanpa default: baris lama tetap NULL (artinya "tidak tercatat"), bukan
-- mengaku-ngaku diubah oleh seseorang.
-- ============================================================

ALTER TABLE sales_targets      ADD COLUMN IF NOT EXISTS updated_by text;
ALTER TABLE incentive_payments ADD COLUMN IF NOT EXISTS updated_by text;

-- ============================================================
-- M1 — index untuk DELETE saat upload closing.
-- Predikatnya (sales_code, principle, period_year, period_month, date) — semuanya equality.
-- Tanpa ini, planner memakai idx_sdp_code lalu memfilter sisanya di heap; jumlah baris per
-- sales_code tumbuh linier dengan riwayat, jadi upload closing makin lambat tiap tahun
-- sambil menahan row lock (SM lain yang upload bersamaan ikut menunggu).
-- ============================================================

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sdp_code_prin_period_date
  ON sales_daily_progress (sales_code, principle, period_year, period_month, date);

-- Setelah index di atas terpasang, idx_sdp_code menjadi REDUNDAN — ia adalah prefiks dari
-- index baru, jadi query apa pun yang bisa memakainya juga bisa memakai yang baru.
-- Menghapusnya memangkas biaya tulis ~2.000 baris per upload closing.
-- Jalankan HANYA setelah memastikan CREATE INDEX di atas sukses:
--
--   DROP INDEX CONCURRENTLY IF EXISTS idx_sdp_code;
--
-- Sengaja dikomentari — hapus manual kalau sudah yakin, tidak otomatis.

-- ============================================================
-- Verifikasi
-- ============================================================

-- Kolom baru ada?
--   \d sales_targets
--   \d incentive_payments
--
-- Index baru terpakai? (harusnya Index Scan, bukan Seq Scan)
--   EXPLAIN ANALYZE DELETE FROM sales_daily_progress
--     WHERE sales_code='M-ARM' AND principle='ABC PRESIDENT INDONESIA, PT'
--       AND period_year=2026 AND period_month=7 AND date='2026-07-01';
--   (jalankan dalam BEGIN; ... ROLLBACK; supaya tidak benar-benar menghapus)
