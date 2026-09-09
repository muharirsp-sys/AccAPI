-- =====================================================================
-- Master cabang Accurate + cabang Accurate pada profil sales.
--
-- Kenapa perlu: penomoran faktur di Accurate berjalan PER CABANG. Order yang
-- dikirim tanpa `branchId` akan dinomori pada cabang default, bukan cabang
-- penjualnya. Harga jual juga per cabang (`item_selling_price.branch_id`),
-- jadi satu kolom ini menentukan dua hal sekaligus: nomor faktur dan harga.
--
-- `sales_profile.branch` yang lama adalah TEKS BEBAS dan isinya sudah campur
-- aduk di produksi (BANDUNG/CIMAHI/SUMEDANG bercampur nama principal seperti
-- CUSSONS/GODREJ di tabel sejenis). Kolom baru ini sengaja numerik dan
-- merujuk id cabang Accurate — satu-satunya penomoran yang diakui Accurate.
-- Kolom lama TIDAK diubah/dihapus supaya modul insentif yang memakainya
-- tidak ikut terganggu.
--
-- NULL = profil belum dipetakan ke cabang Accurate. Jalur order menolak
-- profil seperti itu; lebih baik sales tidak bisa order daripada fakturnya
-- masuk ke penomoran cabang yang salah.
--
-- Apply: docker exec -i accapi-postgres psql -U accapi -d accapi \
--          -v ON_ERROR_STOP=1 --single-transaction < db/migrations/0005_branch_and_sales_branch.sql
-- Idempoten dan aditif; tidak mengubah kolom yang sudah ada.
-- =====================================================================

CREATE TABLE IF NOT EXISTS branch (
    id             bigint      PRIMARY KEY,   -- id cabang Accurate, bukan id lokal
    name           text        NOT NULL,
    default_branch boolean     NOT NULL DEFAULT false,
    suspended      boolean     NOT NULL DEFAULT false,
    raw_data       jsonb,
    last_update    text,
    synced_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_branch_synced_at ON branch (synced_at, id);

ALTER TABLE sales_profile ADD COLUMN IF NOT EXISTS accurate_branch_id bigint;

CREATE INDEX IF NOT EXISTS idx_sales_profile_branch ON sales_profile (accurate_branch_id);
