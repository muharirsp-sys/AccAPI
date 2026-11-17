-- DDL MANUAL Limit pelanggan "Hendra" (owner 17 Nov 2026). Rujukan: db/schema.ts (limitHendraUbah, limitMenitSimpan), scripts/migrate-pg.mjs (entri
-- "limit hendra" = SQL sama dengan db/migrations/0044_limit_hendra.sql), lib/pelanggan-hendra.ts.
--
-- SIAPA & KAPAN (pola DDL lain, owner 9 Okt "DDL manual = Claude tulis, IT Support jalankan"): IT Support, SAAT DEPLOY, sebagai role
-- PEMILIK tabel (accapi, bukan accapi_app), SEBELUM image baru — hanya bila DATABASE_MIGRATION_URL tidak di-set. Idempoten.
--
--   docker exec -i accapi-postgres psql -U accapi -d accapi -v ON_ERROR_STOP=1 < docs/handover/DDL_LIMIT_HENDRA.sql
--
-- Tanpa tabel ini: penjaga proxy tetap jalan; pengamat (lib/sync) hanya mencatat galat di log; pemulih gagal di setiap jalan tanpa
-- menulis Accurate. Catatan: image baru menjalankan migrate-pg saat start (Dockerfile.frontend) — bila migrasi gagal, container tidak start.
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
