-- =====================================================================
-- Unggahan laporan integrasi principal (Order Detail Kino) dan barisnya.
--
-- Satu unggahan = satu batch. `file_hash` unik per principal supaya berkas
-- yang sama tidak pernah masuk dua kali: faktur ganda di Accurate tidak bisa
-- dibatalkan, jadi anti-ganda harus ada di pintu masuk, bukan di ujung.
-- Unggah ulang berkas yang sama TETAP BISA, tetapi harus menyatakan
-- `replace` — batch lama dihapus dulu, bukan menumpuk diam-diam.
--
-- Baris menyimpan DUA versi angka:
--   * `report_*` = apa adanya dari laporan principal (bukti, tidak pernah diubah)
--   * `qty/unit/price` = hasil aturan Fix Qty/Satuan/Harga dari Power Query admin
-- Keduanya disimpan karena gerbang validasi membandingkan keduanya, dan saat
-- ada selisih peninjau harus bisa melihat angka aslinya.
--
-- Apply: docker exec -i accapi-postgres psql -U accapi -d accapi \
--          -v ON_ERROR_STOP=1 --single-transaction < db/migrations/0008_principal_order_batch.sql
-- Idempoten dan aditif.
-- =====================================================================

CREATE TABLE IF NOT EXISTS principal_order_batch (
    id           text        PRIMARY KEY,
    principal    text        NOT NULL,
    file_name    text        NOT NULL,
    file_hash    text        NOT NULL,
    branch       text        NOT NULL DEFAULT '',
    period       text        NOT NULL DEFAULT '',
    line_count   integer     NOT NULL DEFAULT 0,
    skipped      integer     NOT NULL DEFAULT 0,
    issues       jsonb       NOT NULL DEFAULT '[]'::jsonb,
    status       text        NOT NULL DEFAULT 'parsed',
    uploaded_by  text        NOT NULL DEFAULT '',
    uploaded_at  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_principal_order_batch_file
    ON principal_order_batch (principal, file_hash);
CREATE INDEX IF NOT EXISTS idx_principal_order_batch_recent
    ON principal_order_batch (uploaded_at DESC, id);

CREATE TABLE IF NOT EXISTS principal_order_line (
    batch_id       text           NOT NULL REFERENCES principal_order_batch(id) ON DELETE CASCADE,
    row_number     integer        NOT NULL,
    so_no          text           NOT NULL,
    so_date        date,
    so_status      text           NOT NULL DEFAULT '',
    customer_code  text           NOT NULL DEFAULT '',
    customer_name  text           NOT NULL DEFAULT '',
    customer_type  text           NOT NULL DEFAULT '',
    salesman_code  text           NOT NULL DEFAULT '',
    product_code   text           NOT NULL DEFAULT '',
    product_name   text           NOT NULL DEFAULT '',
    -- Apa adanya dari laporan principal; jangan pernah ditimpa.
    report_qty      numeric(16, 4) NOT NULL DEFAULT 0,
    report_price    numeric(18, 4) NOT NULL DEFAULT 0,
    report_gross    numeric(18, 2) NOT NULL DEFAULT 0,
    report_discount numeric(18, 2) NOT NULL DEFAULT 0,
    report_promo    numeric(18, 2) NOT NULL DEFAULT 0,
    report_net      numeric(18, 2) NOT NULL DEFAULT 0,
    -- Hasil aturan satuan; nilai barisnya harus sama dengan report_gross.
    qty            numeric(16, 4) NOT NULL DEFAULT 0,
    unit           text           NOT NULL DEFAULT '',
    price          numeric(18, 4) NOT NULL DEFAULT 0,
    -- [{position, percent}] — POSISI menentukan siapa yang menanggung diskonnya.
    discounts      jsonb          NOT NULL DEFAULT '[]'::jsonb,
    bonus          boolean        NOT NULL DEFAULT false,
    PRIMARY KEY (batch_id, row_number)
);

CREATE INDEX IF NOT EXISTS idx_principal_order_line_so ON principal_order_line (batch_id, so_no);
