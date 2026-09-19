-- =====================================================================
-- Hapus `promo_rule.prd_id` — kolom yang ditulis tetapi tidak pernah dibaca.
--
-- Jejaknya sebelum penghapusan: diisi dari kolom Excel `PRD_ID_KINO` saat impor
-- Rekap Promo, digabung berdampingan bila satu barang internal punya dua kode
-- principal, lalu disimpan. Tidak ada satu pun pembacanya:
--   * Validator Order Principal (app/api/principal-order/validate) menyebut
--     setiap kolom yang dibutuhkannya satu per satu; `prd_id` tidak di antaranya.
--   * Mesin Rekap Promo memang `select()` seluruh baris, tetapi objek `PromoRule`
--     yang diserahkan ke `recap()` membuangnya sebelum sampai ke pencocokan.
--   * Jalur `from-summary` selalu mengisinya kosong.
--   * Rekap Promo tidak punya jalur ekspor, jadi nilainya tidak pernah keluar lagi.
--
-- Pemetaan PRD_ID principal -> kode barang internal punya rumahnya sendiri:
-- tabel `principal_mapping` (kind='item'), dan itulah yang benar-benar dipakai.
-- =====================================================================

ALTER TABLE promo_rule DROP COLUMN IF EXISTS prd_id;
