-- Pengerasan DB modul Insentif Sales — audit 2026-08-28.
-- Role accapi_app bukan owner dan tidak boleh DDL, jadi dijalankan sebagai owner:
--   docker exec -i accapi-postgres psql -U accapi -d accapi -v ON_ERROR_STOP=1 -f - < DDL_INSENTIF_HARDENING_2026-08-29.sql
--
-- URUT. Bagian 1 WAJIB dicek dulu: kalau sudah ada duplikat, index-nya akan gagal dibuat
-- dan itu memang benar — duplikatnya harus dibereskan lebih dulu, bukan dipaksa lewat.

-- ── 1. Cek duplikat sebelum menambah UNIQUE (H5) ────────────────────────────
-- Harus mengembalikan 0 baris. Kalau tidak, realisasi periode itu SUDAH terhitung dobel.
SELECT sales_code, principle, branch, period_year, period_month, date, COUNT(*) AS jumlah
FROM sales_daily_progress
GROUP BY 1,2,3,4,5,6
HAVING COUNT(*) > 1
ORDER BY jumlah DESC
LIMIT 20;

-- ── 2. UNIQUE pada kunci idempotensi upload (H5) ────────────────────────────
-- Tanpa ini, idempotensi hanya dijaga aplikasi: retry setelah 502 bisa menghapus 0 baris lalu
-- menyisipkan semuanya lagi (READ COMMITTED), dan realisasi jadi dua kali lipat tanpa error.
-- Kedua penulis sudah beragregasi tepat ke grain ini.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS uq_sdp_key
    ON sales_daily_progress (sales_code, principle, branch, period_year, period_month, date);

-- ── 3. Indeks penutup untuk agregasi periode (M11) ──────────────────────────
-- Tiga dashboard menghitung agregat yang sama tiap pemuatan halaman; indeks lama hanya
-- menyaring, seluruh kolom achieved_* tetap diambil dari heap.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sdp_period_agg
    ON sales_daily_progress (period_year, period_month)
    INCLUDE (sales_code, principle, achieved_value_dpp, achieved_ec, achieved_ao, achieved_ia);

-- ── 4. Urutan kolom untuk query "setahun" (LOW) ─────────────────────────────
-- Strip Rekap Pembayaran Tahunan memfilter period_year SAJA; indeks lama berkolom pertama
-- period_month sehingga tidak terpakai.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_inc_payments_year_month
    ON incentive_payments (period_year, period_month);

-- ── 5. Buang indeks yang tidak menambah apa pun (LOW) ───────────────────────
-- idx_sdp_code adalah prefiks MURNI dari idx_sdp_code_prin_period_date: redundan secara
-- struktural, tapi tetap ditulis ulang setiap upload closing.
DROP INDEX CONCURRENTLY IF EXISTS idx_sdp_code;
-- idx_sdp_period digantikan idx_sdp_period_agg (bagian 3). Jalankan SETELAH memastikan
-- bagian 3 sukses.
DROP INDEX CONCURRENTLY IF EXISTS idx_sdp_period;

-- Sebelum membuang dua ini, LIHAT dulu pemakaiannya — keduanya mungkin dipakai Metabase:
--   SELECT indexrelname, idx_scan FROM pg_stat_user_indexes
--   WHERE indexrelname IN ('idx_sdp_date','idx_inc_payments_status');
-- DROP INDEX CONCURRENTLY IF EXISTS idx_sdp_date;
-- DROP INDEX CONCURRENTLY IF EXISTS idx_inc_payments_status;

-- ── 6. Verifikasi ───────────────────────────────────────────────────────────
SELECT indexname FROM pg_indexes
WHERE tablename IN ('sales_daily_progress','incentive_payments')
ORDER BY tablename, indexname;
