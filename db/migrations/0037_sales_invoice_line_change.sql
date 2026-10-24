-- =====================================================================
-- Perubahan rincian faktur INV (owner 23 Okt 2026; spec docs/superpowers/specs/2026-10-23-perubahan-rincian-faktur-design.md §4).
--
-- Satu baris per baris faktur yang hilang / bertambah / berubah / ikut faktur yang dihapus, dicatat lib/sync.ts
-- (upsertSalesInvoiceById) saat cache faktur diperbarui lewat webhook, penambal, atau kirim faktur. Tanpa FK ke
-- sales_invoice: faktur yang dihapus di Accurate tetap tercatat.
--
-- EXPAND saja: tabel baru tanpa pembaca lama, tidak menyentuh tabel lain. Idempoten.
-- Apply otomatis lewat scripts/migrate-pg.mjs (entri "sales_invoice_line_change") saat container start bila
-- DATABASE_MIGRATION_URL terpasang (produksi: terpasang). Manual:
--   docker exec -i accapi-postgres psql -U accapi -d accapi -v ON_ERROR_STOP=1 --single-transaction \
--     < db/migrations/0037_sales_invoice_line_change.sql
-- =====================================================================

CREATE TABLE IF NOT EXISTS sales_invoice_line_change (
    id              bigserial     PRIMARY KEY,
    invoice_id      bigint        NOT NULL,
    invoice_number  text          NOT NULL,
    trans_date      text          NOT NULL,
    customer_no     text          NOT NULL DEFAULT '',
    kind            text          NOT NULL,
    line_id         bigint,
    item_no         text          NOT NULL,
    item_name       text          NOT NULL DEFAULT '',
    old_line        jsonb,
    new_line        jsonb,
    base_qty_delta  numeric,
    total_before    numeric(18,2),
    total_after     numeric(18,2),
    app_key         text,
    source          text          NOT NULL,
    saved_at        timestamptz,
    printed_at      timestamptz,
    printed_by      text          NOT NULL DEFAULT '',
    after_print     boolean       NOT NULL,
    detected_at     timestamptz   NOT NULL DEFAULT now(),
    CONSTRAINT sales_invoice_line_change_kind CHECK (kind IN ('removed', 'added', 'changed', 'invoice_deleted')),
    CONSTRAINT sales_invoice_line_change_source CHECK (source IN ('webhook', 'backfill', 'send'))
);
CREATE INDEX IF NOT EXISTS idx_silc_item_no ON sales_invoice_line_change (item_no, detected_at);
CREATE INDEX IF NOT EXISTS idx_silc_invoice_id ON sales_invoice_line_change (invoice_id);
DO $silc$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'accapi_app') THEN
    GRANT SELECT, INSERT ON sales_invoice_line_change TO accapi_app;
    GRANT USAGE ON SEQUENCE sales_invoice_line_change_id_seq TO accapi_app;
  END IF;
END $silc$;
