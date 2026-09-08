-- =====================================================================
-- Harga jual per kategori pelanggan dari Accurate `item.detailSellingPrice[]`.
-- Dibuktikan live 2026-09-08: `item/list.do` TIDAK membawa priceCategory, jadi
-- harga bertingkat hanya bisa diambil lewat `item/detail.do` per item.
-- Satu baris per (item, kategori harga, satuan, cabang, tanggal berlaku) —
-- tanggal berlaku ikut kunci supaya kenaikan terjadwal bisa hidup berdampingan
-- dengan harga yang sedang berlaku.
-- Apply: node scripts/apply-item-selling-price-migration.mjs   (idempoten)
-- =====================================================================

CREATE TABLE IF NOT EXISTS item_selling_price (
    item_no             text        NOT NULL,
    item_id             bigint      NOT NULL,
    price_category_id   bigint      NOT NULL,
    price_category_name text        NOT NULL DEFAULT '',
    unit_name           text        NOT NULL DEFAULT '',
    branch_id           bigint      NOT NULL DEFAULT 0,
    branch_name         text        NOT NULL DEFAULT '',
    default_branch      boolean     NOT NULL DEFAULT false,
    default_category    boolean     NOT NULL DEFAULT false,
    price               double precision NOT NULL,
    effective_date      date        NOT NULL,
    currency_code       text        NOT NULL DEFAULT 'IDR',
    synced_at           timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (item_no, price_category_id, unit_name, branch_id, effective_date)
);

-- Pencarian harga selalu: kode barang + satuan + tanggal berlaku terbesar <= tanggal order.
CREATE INDEX IF NOT EXISTS idx_item_selling_price_lookup
    ON item_selling_price (item_no, unit_name, price_category_id, effective_date DESC);
CREATE INDEX IF NOT EXISTS idx_item_selling_price_item
    ON item_selling_price (item_id);

-- Kategori harga pelanggan: penentu tier mana yang dipakai untuk pelanggan itu.
ALTER TABLE customer ADD COLUMN IF NOT EXISTS price_category_id   bigint;
ALTER TABLE customer ADD COLUMN IF NOT EXISTS price_category_name text;
