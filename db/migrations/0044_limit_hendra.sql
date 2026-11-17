-- =====================================================================
-- Limit pelanggan "Hendra" (owner 17 Nov 2026): pelanggan yang catatan Accurate-nya memuat "Hendra" adalah keputusan manual.
--
--   limit_hendra_ubah    (baru) peristiwa perubahan Limit Piutang / Limit Hari pelanggan Hendra (limit sebelum & sesudah), diamati
--                         saat salinan customer di-upsert (webhook + sync, lib/sync -> lib/pelanggan-hendra). Pemulih (cron
--                         pulih-limit-hendra + akhir sync-accurate) memutuskan tiap peristiwa: impor massal -> dikembalikan;
--                         edit satuan -> dibiarkan. Unik per simpanan (customer_id, last_update).
--   limit_menit_simpan   (baru) jumlah simpanan pelanggan per menit lastUpdate yang teramati (penentu impor massal; hanya bertambah).
--
-- accapi_app SELECT/INSERT/UPDATE, TANPA DELETE (jejak). EXPAND saja. Menjalankan ulang = tanpa perubahan.
-- Entri migrate-pg: "limit hendra". DDL manual: docs/handover/DDL_LIMIT_HENDRA.sql.
-- =====================================================================
SET lock_timeout = '5s';
CREATE TABLE IF NOT EXISTS limit_hendra_ubah (
    id              bigserial PRIMARY KEY,
    customer_id     bigint NOT NULL,
    customer_no     text NOT NULL,
    last_update     text NOT NULL,
    lama            jsonb NOT NULL,
    baru            jsonb NOT NULL,
    status          text NOT NULL DEFAULT 'baru',
    alasan          text,
    dicatat_pada    timestamptz NOT NULL DEFAULT now(),
    diputuskan_pada timestamptz,
    CONSTRAINT limit_hendra_ubah_status CHECK (status IN ('baru', 'diproses', 'dipulihkan', 'dibiarkan', 'dilewati', 'sistem'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_limit_hendra_ubah_simpanan ON limit_hendra_ubah (customer_id, last_update);
CREATE INDEX IF NOT EXISTS idx_limit_hendra_ubah_status ON limit_hendra_ubah (status, id);
CREATE TABLE IF NOT EXISTS limit_menit_simpan (
    menit   text PRIMARY KEY,
    jumlah  integer NOT NULL DEFAULT 0
);
DO $lh$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'accapi_app') THEN
    REVOKE DELETE, TRUNCATE ON limit_hendra_ubah, limit_menit_simpan FROM accapi_app;
    GRANT SELECT, INSERT, UPDATE ON limit_hendra_ubah, limit_menit_simpan TO accapi_app;
    GRANT USAGE, SELECT ON SEQUENCE limit_hendra_ubah_id_seq TO accapi_app;
  END IF;
END $lh$;
RESET lock_timeout;
