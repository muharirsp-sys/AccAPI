-- =====================================================================
-- ASAL setiap baris aturan promo — penjaga jembatan Summary -> promo_rule.
--
-- Kenapa perlu: mulai sekarang `promo_rule` punya EMPAT penulis, dan tiga di
-- antaranya memuat dengan cara MENGGANTI irisannya sendiri:
--
--   surat   publikasi Summary (surat -> OCR -> koreksi -> terbit -> jembatan)
--   excel   impor sheet `Detail` di Rekap Promo
--   tarif   impor sheet `Discount Reguler` (melekat outlet)
--   manual  diketik di layar Aturan Promo
--
-- Tanpa kolom ini, impor Excel yang menghapus "semua aturan surat principal X"
-- akan ikut menghapus aturan yang datang dari jembatan, dan sebaliknya. Yang
-- hilang TIDAK akan terlihat sebagai galat: gerbang cuma berhenti menahan, dan
-- potongan mulai lewat tanpa dasar. Itu cara kehilangan uang yang paling sulit
-- ditemukan, jadi tiap penulis wajib hanya menyentuh irisannya sendiri.
--
-- `source_ref` menyimpan JEJAKNYA: id publikasi Summary untuk baris jembatan,
-- nama berkas untuk impor, kosong untuk yang diketik. Dipakai menjawab
-- "aturan ini datang dari mana" tanpa menebak.
--
-- Baris yang sudah ada (234 di produksi) sengaja dibiarkan ber-`source` KOSONG
-- dan diperlakukan sebagai milik jalur Excel/tarif, sama seperti sebelum kolom
-- ini ada. Menebak asalnya surut berarti mengarang jejak.
--
-- Apply: docker exec -i accapi-postgres psql -U accapi -d accapi \
--          -v ON_ERROR_STOP=1 --single-transaction < db/migrations/0016_promo_rule_source.sql
-- Idempoten dan aditif; tidak menyentuh satu baris data pun.
-- =====================================================================

ALTER TABLE promo_rule ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT '';
ALTER TABLE promo_rule ADD COLUMN IF NOT EXISTS source_ref text NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_promo_rule_source ON promo_rule (source, surat_program);
