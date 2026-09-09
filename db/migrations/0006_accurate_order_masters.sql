-- =====================================================================
-- Master Accurate yang dibutuhkan input order sales, hasil probe live
-- 2026-09-09 ke DB CV Surya Perkasa (iris.accurate.id).
--
-- Yang dibuktikan live dan menjadi alasan tiap kolom di sini:
--
-- 1. `branch/list.do` -> 22 cabang, dan di database ini "cabang" berarti
--    DIVISI PRINCIPAL (MIX FOOD, GODREJ, RECKITT, ...), bukan kota.
--    `Kantor Pusat` (id 50) adalah cabang default.
-- 2. `auto-number/list.do` -> 155 baris; `transactionType='SI'` adalah
--    penomoran Faktur Penjualan, satu per principal. **Tidak ada rujukan
--    cabang di dalamnya**, dan `auto-number/detail.do` TIDAK ADA (404).
--    Jadi pasangan cabang -> penomoran harus disimpan sendiri:
--    `branch.si_auto_number_id`. NULL = belum dipetakan, dan jalur faktur
--    menolaknya. Lebih baik gagal daripada nomor faktur masuk seri cabang lain.
-- 3. `customer/list.do` membawa objek `branch{}`, `category{}` (TIPE OUTLET:
--    TT, MT, NKA, KANVAS, MOTORIST, BTL, INDOGROSIR, EKSPEDISI, Umum) dan
--    `priceCategory{}` (TIER HARGA). Varian datar (`categoryId`, `branchId`,
--    `salesman`) TIDAK ADA di list.do — diabaikan diam-diam.
--    Satu outlet fisik punya satu customerNo PER CABANG (mis. `C-100005-RB`
--    untuk RECKITT dan `C-100005-VIN` untuk VINDA), jadi cabang pelanggan
--    wajib ikut tersimpan.
-- 4. `item/list.do` TIDAK membawa nama satuan sama sekali (`unit1Name` dkk
--    diabaikan diam-diam; hanya `ratio2`/`ratio3` yang lolos). Nama dan id
--    satuan hanya ada di `item/detail.do` — endpoint yang SUDAH dipanggil
--    per item oleh scripts/sync-item-selling-price.ts, jadi satuan ikut
--    terisi tanpa satu pun panggilan API tambahan.
--    `itemUnitId` inilah yang wajib dikirim pada baris faktur Accurate.
--
-- Apply: docker exec -i accapi-postgres psql -U accapi -d accapi \
--          -v ON_ERROR_STOP=1 --single-transaction < db/migrations/0006_accurate_order_masters.sql
-- Idempoten dan aditif; tidak mengubah kolom yang sudah ada.
-- =====================================================================

-- 1. Penomoran dokumen Accurate. Disimpan apa adanya; pemilihan seri untuk
--    faktur terjadi lewat branch.si_auto_number_id, bukan tebakan saat kirim.
CREATE TABLE IF NOT EXISTS accurate_auto_number (
    id               bigint      PRIMARY KEY,
    name             text        NOT NULL,
    transaction_type text        NOT NULL DEFAULT '',
    auto_number_type text        NOT NULL DEFAULT '',
    counter_digit    integer,
    suspended        boolean     NOT NULL DEFAULT false,
    raw_data         jsonb,
    synced_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_auto_number_type ON accurate_auto_number (transaction_type, name);

-- 2. Seri penomoran Faktur Penjualan milik cabang ini.
ALTER TABLE branch ADD COLUMN IF NOT EXISTS si_auto_number_id bigint;

-- 3. Tipe outlet + cabang pemilik pelanggan.
ALTER TABLE customer ADD COLUMN IF NOT EXISTS category_id   bigint;
ALTER TABLE customer ADD COLUMN IF NOT EXISTS category_name text;
ALTER TABLE customer ADD COLUMN IF NOT EXISTS branch_id     bigint;
ALTER TABLE customer ADD COLUMN IF NOT EXISTS branch_name   text;

CREATE INDEX IF NOT EXISTS idx_customer_branch ON customer (branch_id);

-- 4. Satuan item. unit1 = satuan dasar; unit2..5 kelipatannya lewat ratio.
ALTER TABLE item ADD COLUMN IF NOT EXISTS unit1_id       bigint;
ALTER TABLE item ADD COLUMN IF NOT EXISTS unit1_name     text;
ALTER TABLE item ADD COLUMN IF NOT EXISTS unit2_id       bigint;
ALTER TABLE item ADD COLUMN IF NOT EXISTS unit2_name     text;
ALTER TABLE item ADD COLUMN IF NOT EXISTS unit3_id       bigint;
ALTER TABLE item ADD COLUMN IF NOT EXISTS unit3_name     text;
ALTER TABLE item ADD COLUMN IF NOT EXISTS unit4_id       bigint;
ALTER TABLE item ADD COLUMN IF NOT EXISTS unit4_name     text;
ALTER TABLE item ADD COLUMN IF NOT EXISTS unit5_id       bigint;
ALTER TABLE item ADD COLUMN IF NOT EXISTS unit5_name     text;
ALTER TABLE item ADD COLUMN IF NOT EXISTS ratio2         double precision;
ALTER TABLE item ADD COLUMN IF NOT EXISTS ratio3         double precision;
ALTER TABLE item ADD COLUMN IF NOT EXISTS ratio4         double precision;
ALTER TABLE item ADD COLUMN IF NOT EXISTS ratio5         double precision;
ALTER TABLE item ADD COLUMN IF NOT EXISTS has_multi_unit boolean;

-- 5. Master satuan Accurate (37 baris). `unit/list.do` memakai RUANG ID YANG SAMA dengan
--    `item.unitNId` (dibuktikan 2026-09-09: PCS=50 dan KRT=100 sama di kedua sumber),
--    jadi tabel ini adalah sumber `detailItem[].itemUnitId` saat membuat faktur.
CREATE TABLE IF NOT EXISTS accurate_unit (
    id        bigint      PRIMARY KEY,
    name      text        NOT NULL,
    suspended boolean     NOT NULL DEFAULT false,
    raw_data  jsonb,
    synced_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_accurate_unit_name ON accurate_unit (upper(name));
