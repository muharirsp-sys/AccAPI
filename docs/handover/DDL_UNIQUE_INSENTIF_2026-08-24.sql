-- Migrasi manual untuk temuan C2 (docs/handover/AUDIT_INSENTIF_SALES_2026-08-24.md).
-- Dijalankan manual via docker exec, sama seperti migrasi lain di project ini
-- (lihat docs/handover/handover9.md §5). TIDAK dijalankan oleh drizzle-kit.
--
-- Cara jalankan tiap statement:
--   docker exec -it accapi-postgres psql -U accapi -d accapi -c '<SQL>'
--
-- PENTING — urutan:
-- 1. Jalankan LANGKAH 1 dulu (cek duplikat). Kalau ada baris duplikat, keputusan bagaimana
--    menggabungkannya HARUS diambil manual (mana yang benar) sebelum LANGKAH 2 — CREATE UNIQUE
--    INDEX akan GAGAL kalau ada duplikat, jadi ini aman dicoba: gagal = ada yang perlu dibersihkan
--    dulu, bukan merusak data.
-- 2. Setelah LANGKAH 2 sukses di produksi, kode aplikasi (targets/route.ts, payments/route.ts,
--    support/route.ts) masih memakai pola SELECT-lalu-INSERT/UPDATE seperti sebelumnya — TIDAK
--    diubah ke onConflictDoUpdate di commit ini, supaya deploy commit ini tidak butuh urutan
--    "DDL harus jalan duluan, atau semua POST ke 3 endpoint ini error 500". Constraint ini untuk
--    sementara berfungsi sebagai BACKSTOP: race yang sebelumnya diam-diam membuat baris duplikat
--    (dan nominal insentif salah tanpa error) sekarang akan gagal dengan error unique-violation
--    yang jelas, bukan silently corrupt. Migrasi kode ke onConflictDoUpdate adalah langkah
--    lanjutan yang aman dilakukan KAPAN SAJA setelah LANGKAH 2 ini sukses.

-- ============================================================
-- LANGKAH 1 — cek duplikat dulu. JANGAN lanjut ke LANGKAH 2 kalau salah satu query ini
-- mengembalikan baris.
-- ============================================================

SELECT sales_code, principle, period_month, period_year, count(*)
FROM sales_targets
GROUP BY 1,2,3,4
HAVING count(*) > 1;

SELECT sales_code, principle, period_month, period_year, count(*)
FROM incentive_payments
GROUP BY 1,2,3,4
HAVING count(*) > 1;

SELECT sales_code, principle, period_month, period_year, count(*)
FROM incentive_support
GROUP BY 1,2,3,4
HAVING count(*) > 1;

-- ============================================================
-- LANGKAH 2 — kalau LANGKAH 1 bersih (nol baris di ketiga query), jalankan ini.
-- CONCURRENTLY supaya tidak mengunci tabel saat dibuat (aman dijalankan saat aplikasi hidup).
-- CONCURRENTLY tidak bisa dijalankan di dalam transaksi — jalankan tiap statement terpisah,
-- persis seperti gaya `docker exec ... -c '<SQL>'` satu per satu di handover9 §5.
-- ============================================================

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS uq_sales_targets_key
  ON sales_targets (sales_code, principle, period_month, period_year);

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS uq_incentive_payments_key
  ON incentive_payments (sales_code, principle, period_month, period_year);

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS uq_incentive_support_key
  ON incentive_support (sales_code, principle, period_month, period_year);

-- ============================================================
-- Kalau LANGKAH 1 TIDAK bersih: jangan buang salah satu duplikat begitu saja. Untuk setiap
-- kelompok duplikat, putuskan baris mana yang benar (biasanya yang `updated_at` paling baru),
-- lalu hapus sisanya secara eksplisit dengan `id`-nya — jangan pakai DELETE massal tanpa
-- memverifikasi id satu per satu.
-- ============================================================
