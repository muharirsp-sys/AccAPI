-- DDL MANUAL Limit pelanggan "Hendra" (owner 17 Nov 2026). Rujukan: db/schema.ts (limitHendraAcuan), scripts/migrate-pg.mjs (entri
-- "limit hendra acuan" = SQL sama dengan db/migrations/0044_limit_hendra_acuan.sql), lib/pelanggan-hendra.ts.
--
-- SIAPA & KAPAN (pola DDL lain, owner 9 Okt "DDL manual = Claude tulis, IT Support jalankan"): IT Support, SAAT DEPLOY, sebagai role
-- PEMILIK tabel (accapi, bukan accapi_app), SEBELUM image baru — hanya bila DATABASE_MIGRATION_URL tidak di-set. Idempoten.
--
--   docker exec -i accapi-postgres psql -U accapi -d accapi -v ON_ERROR_STOP=1 < docs/handover/DDL_LIMIT_HENDRA.sql
--
-- Tanpa tabel ini: penjaga proxy tetap jalan; pemulih melempar galat di setiap jalan (tercatat di jawaban cron) tanpa menulis Accurate.
SET lock_timeout = '5s';
CREATE TABLE IF NOT EXISTS limit_hendra_acuan (
    customer_id               bigint PRIMARY KEY,
    customer_no               text NOT NULL,
    limit_aktif               boolean NOT NULL,
    limit_nilai               double precision,
    hari_aktif                boolean NOT NULL,
    hari_nilai                integer,
    acuan_last_update         text,
    sumber                    text NOT NULL,
    diperbarui_pada           timestamptz NOT NULL DEFAULT now(),
    terakhir_dipulihkan_pada  timestamptz,
    terakhir_dipulihkan_dari  jsonb,
    jumlah_dipulihkan         integer NOT NULL DEFAULT 0,
    CONSTRAINT limit_hendra_acuan_sumber CHECK (sumber IN ('awal', 'edit_manual'))
);
DO $lha$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'accapi_app') THEN
    REVOKE DELETE, TRUNCATE ON limit_hendra_acuan FROM accapi_app;
    GRANT SELECT, INSERT, UPDATE ON limit_hendra_acuan TO accapi_app;
  END IF;
END $lha$;
RESET lock_timeout;
