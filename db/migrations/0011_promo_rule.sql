-- =====================================================================
-- Aturan promo terbit dalam bentuk yang bisa DIBANDINGKAN dengan faktur nyata.
--
-- Skema kolomnya sengaja sama persis dengan yang dibaca mesin Validator Diskon
-- (`shared.run_engine` -> `promo_needed`), supaya satu bentuk aturan dipakai dua
-- tempat: validator diskon dan rekap bulanan. Nama kolom karangan baru berarti
-- dua sumber kebenaran yang bisa berbeda jawaban.
--
-- Baris ber-`item_code` KOSONG = aturan TINGKAT FAKTUR (mis. MSG nilai belanja),
-- berlaku untuk seluruh barang. Itu perjanjian yang sama dengan `_ALL_ITEM_RULE`
-- pada mesin validator; jangan diisi kode palsu supaya "kelihatan rapi".
--
-- Apply: docker exec -i accapi-postgres psql -U accapi -d accapi \
--          -v ON_ERROR_STOP=1 --single-transaction < db/migrations/0011_promo_rule.sql
-- Idempoten dan aditif.
-- =====================================================================

CREATE TABLE IF NOT EXISTS promo_rule (
    id             bigserial   PRIMARY KEY,
    principal      text        NOT NULL,
    -- Nomor surat program; satu surat bisa menurunkan banyak aturan.
    surat_program  text        NOT NULL DEFAULT '',
    promo_label    text        NOT NULL DEFAULT '',
    promo_group_id text        NOT NULL DEFAULT '',
    promo_group    text        NOT NULL DEFAULT '',
    -- Kosong = aturan tingkat faktur (berlaku semua barang).
    item_code      text        NOT NULL DEFAULT '',
    item_name      text        NOT NULL DEFAULT '',
    prd_id         text        NOT NULL DEFAULT '',
    period_start   date,
    period_end     date,
    active         boolean     NOT NULL DEFAULT true,
    tier_no        integer     NOT NULL DEFAULT 1,
    trigger_qty    numeric(18, 2) NOT NULL DEFAULT 0,
    -- PCS/KRT untuk pemicu jumlah, RP untuk pemicu nilai belanja.
    trigger_unit   text        NOT NULL DEFAULT 'PCS',
    benefit_type   text        NOT NULL DEFAULT '',
    benefit_value  text        NOT NULL DEFAULT '',
    benefit_unit   text        NOT NULL DEFAULT '',
    -- PRINCIPAL (bisa diklaim) atau DISTRIBUTOR (tanggungan sendiri).
    benefit_beban  text        NOT NULL DEFAULT 'PRINCIPAL',
    on_faktur      boolean     NOT NULL DEFAULT true,
    note           text        NOT NULL DEFAULT '',
    imported_by    text        NOT NULL DEFAULT '',
    imported_at    timestamptz NOT NULL DEFAULT now()
);

-- Satu aturan = (surat, kelompok, barang, tingkat). Impor ulang berkas yang sama
-- memperbarui barisnya, bukan menggandakan.
CREATE UNIQUE INDEX IF NOT EXISTS idx_promo_rule_key
    ON promo_rule (principal, surat_program, promo_group, item_code, tier_no);
CREATE INDEX IF NOT EXISTS idx_promo_rule_item
    ON promo_rule (item_code, period_start, period_end);
