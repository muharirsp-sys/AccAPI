-- Tujuan: Jejak program beku dan pemeriksaan faktur Accurate pada antrean order.
-- Caller: deployment migration. Dependensi: invoice_outbox (0004).
-- Main Functions: additive nullable columns + index periode.
-- Side Effects: DDL singkat; tidak menulis ulang payload lama atau mengarang snapshot historis.
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE invoice_outbox ADD COLUMN IF NOT EXISTS program_snapshot jsonb;
ALTER TABLE invoice_outbox ADD COLUMN IF NOT EXISTS realization jsonb;
ALTER TABLE invoice_outbox ADD COLUMN IF NOT EXISTS realization_checked_at timestamptz;
CREATE INDEX IF NOT EXISTS idx_invoice_outbox_period ON invoice_outbox(order_date, order_id);
CREATE INDEX IF NOT EXISTS idx_invoice_outbox_identity ON invoice_outbox(accurate_db_id, accurate_id) WHERE state='posted';
COMMIT;
