-- =====================================================================
-- Jenis mapping keempat: `brand` — nama merek sebagaimana TERTULIS DI SURAT
-- principal, dipetakan ke pola nama pada master barang.
--
-- Kenapa perlu: surat promo menyebut merek dengan bahasa pemasaran, master
-- barang memakai bahasa gudang. Contoh nyata (keputusan pengguna 2026-09-11):
--   "OVALE 2IN1 CLEANSER" -> "OVALE FACIAL LOTION"
--   "RESIK V CAIR"        -> "RESIK V"  (seluruh RESIK V)
-- Tanpa catatan ini, tiap surat berikutnya akan menanyakan hal yang sama, dan
-- jawabannya hanya ada di kepala orang.
--
-- Ditaruh di tabel yang sama, bukan tabel baru: bentuknya sama persis (kode/
-- nama sana -> sana sini), dan tabel baru berarti importir, endpoint, dan layar
-- keempat untuk hal yang sama. `unit` dan `pack_size` tetap NULL untuk jenis ini.
--
-- Apply: docker exec -i accapi-postgres psql -U accapi -d accapi \
--          -v ON_ERROR_STOP=1 --single-transaction < db/migrations/0010_principal_mapping_brand.sql
-- Idempoten dan aditif; hanya melonggarkan CHECK, tidak menyentuh baris mana pun.
-- =====================================================================

ALTER TABLE principal_mapping DROP CONSTRAINT IF EXISTS principal_mapping_kind_check;
ALTER TABLE principal_mapping ADD CONSTRAINT principal_mapping_kind_check
    CHECK (kind IN ('item', 'customer', 'salesman', 'brand'));
