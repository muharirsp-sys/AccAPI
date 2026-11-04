-- =====================================================================
-- OFF Program Control: Potong Tagihan dicatat Incaso dengan nomor faktur (owner 3 Nov 2026).
--
--   off_potong_tagihan : satu baris per (item OPC, faktur yang dipotong). Satu item boleh dipotong dari beberapa faktur;
--                        Σ amount per item = nominal item, Σ per invoice_no ≤ sisa tagihan faktur saat dicatat.
--   idx_sales_invoice_number : cari faktur per nomor (±179 rb baris; tanpa indeks = pindaian penuh tiap pencarian).
--
-- Apply otomatis lewat scripts/migrate-pg.mjs (entri "off_potong_tagihan + idx_sales_invoice_number") saat container start bila
-- DATABASE_MIGRATION_URL terpasang; selain itu jalankan berkas ini sebagai role pemilik SEBELUM image baru:
--   docker exec -i accapi-postgres psql -U accapi -d accapi -v ON_ERROR_STOP=1 --     --single-transaction < db/migrations/0040_off_potong_tagihan.sql
-- Idempoten dan aditif: tabel baru + dua indeks, tanpa UPDATE data. CREATE INDEX (non-concurrent) mengunci tulis sales_invoice
-- sebentar (±179 rb baris).
-- =====================================================================

CREATE TABLE IF NOT EXISTS off_potong_tagihan (
    id            TEXT PRIMARY KEY,
    batch_id      TEXT NOT NULL REFERENCES off_batch(id),
    item_id       TEXT NOT NULL REFERENCES off_batch_item(id),
    payment_id    TEXT NOT NULL REFERENCES off_payment(id),
    invoice_id    BIGINT,
    invoice_no    TEXT NOT NULL,
    customer_no   TEXT,
    customer_name TEXT,
    amount        DOUBLE PRECISION NOT NULL,
    created_by    TEXT,
    created_at    TIMESTAMP NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_off_potong_tagihan_invoice ON off_potong_tagihan (invoice_no);
CREATE INDEX IF NOT EXISTS idx_off_potong_tagihan_batch ON off_potong_tagihan (batch_id);
CREATE INDEX IF NOT EXISTS idx_sales_invoice_number ON sales_invoice (number);
DO $opt$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'accapi_app') THEN
    GRANT SELECT, INSERT ON off_potong_tagihan TO accapi_app;
  END IF;
END $opt$;
