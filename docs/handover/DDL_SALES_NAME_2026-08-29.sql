-- DDL_SALES_NAME_2026-08-29.sql
-- Kolom nama salesman di sales_daily_progress.
--
-- Kenapa: deteksi kandidat "Gabung Kode Sales" hanya bisa membaca nama dari sales_targets.
-- Kode yang punya penjualan tapi BELUM punya target sampai di sana sebagai kode telanjang,
-- sehingga pasangan satu-orang-dua-rute tidak pernah terbentuk. Kasus nyata closing Juli 2026:
--   target FOKUS RITEL BASRI YUSUF ada di M-BSR  (nama M2_1_BASRI YUSUF)
--   penjualannya dibukukan di       M-BSR2 (nama FRN5_BASRI YUSUF), Rp 271.562.890
-- Prefiks rutenya beda (M2_1 vs FRN5) jadi pencocokan lama pun buta. Dengan nama tersimpan,
-- keduanya muncul sebagai kandidat merge dan bisa dikonfirmasi user.
--
-- Aman dijalankan berkali-kali. Additive, nullable, tanpa rewrite tabel.
-- Baris lama tetap NULL sampai periodenya diunggah ulang; itu tidak mengubah angka apa pun
-- (nama tidak dipakai perhitungan), hanya membuat kandidat merge periode itu tidak terbaca.

ALTER TABLE sales_daily_progress ADD COLUMN IF NOT EXISTS sales_name TEXT;

-- Verifikasi
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'sales_daily_progress' AND column_name = 'sales_name';
