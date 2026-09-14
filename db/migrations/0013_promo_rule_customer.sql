-- =====================================================================
-- Dimensi OUTLET pada aturan promo — tarif "Discount Reguler (Tanggungan
-- Distributor)" (butir 4.10).
--
-- Kenapa perlu kolom baru: tarif itu melekat pada PELANGGAN, bukan pada barang.
-- SS DIAPERS MESJID RAYA mendapat 2% di posisi 1 untuk SELURUH barang yang
-- dibelinya (terbukti pada ORDER_DETAIL 12 September 2026: delapan baris, delapan
-- barang berbeda, 2% yang sama). Tanpa kolom ini tarifnya hanya bisa dimuat dengan
-- menyalin satu baris aturan per barang — 4.182 baris yang harus dimuat ulang tiap
-- master barang bertambah, dan diam-diam salah begitu ada barang baru.
--
-- `customer_code` KOSONG = aturan berlaku untuk semua pelanggan (perilaku lama,
-- semua 145 baris yang sudah termuat). Terisi = tarif milik satu outlet.
-- Pada baris tarif, `tier_no` berarti POSISI kolom DISC_n, bukan tingkat pembelian:
-- posisi menentukan siapa menanggung, jadi 4% di posisi 1 dan 4% di posisi 2 adalah
-- dua hal berbeda meski jumlahnya sama.
--
-- Apply: docker exec -i accapi-postgres psql -U accapi -d accapi \
--          -v ON_ERROR_STOP=1 --single-transaction < db/migrations/0013_promo_rule_customer.sql
-- Idempoten dan aditif; tidak menyentuh satu baris data pun.
-- =====================================================================

ALTER TABLE promo_rule ADD COLUMN IF NOT EXISTS customer_code text NOT NULL DEFAULT '';

-- Kunci unik lama (principal, surat, kelompok, barang, tingkat) tidak bisa menampung
-- tarif: seluruh barisnya ber-`item_code` kosong dan hanya berbeda outlet, sehingga
-- outlet kedua akan MENIMPA yang pertama. Outlet ikut jadi bagian kunci.
DROP INDEX IF EXISTS idx_promo_rule_key;
CREATE UNIQUE INDEX IF NOT EXISTS idx_promo_rule_key
    ON promo_rule (principal, surat_program, promo_group, item_code, customer_code, tier_no);

CREATE INDEX IF NOT EXISTS idx_promo_rule_customer
    ON promo_rule (customer_code) WHERE customer_code <> '';
