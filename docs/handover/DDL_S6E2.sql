-- DDL MANUAL S6e-2 — Pelunasan: idempotency_log."databaseId" + idempotency_override.database_id (lock & override mencatat
-- database Accurate) + idempotency_resolution (jejak "Selesaikan" pelunasan tidak pasti, append-only).
-- Rujukan: db/schema.ts (idempotencyLog.databaseId, idempotencyOverride.databaseId, idempotencyResolution), scripts/migrate-pg.mjs
-- (entri `idempotency_s6e2` + `idempotency_override_database` = SQL sama dengan blok 1 di bawah), docs/handover/S6e2-KONTRAK-API.md,
-- lib/pelunasan-ddl-pg.test.ts.
--
-- SIAPA & KAPAN (pola S6-0a/ADR-004, keputusan owner 9 Okt 2026 "DDL manual = Claude tulis, IT Support jalankan"):
-- IT Support, SAAT DEPLOY S6e-2, sebagai role PEMILIK tabel (bukan accapi_app), SESUDAH image baru hidup. JANGAN dijalankan
-- oleh loop/agen ke produksi.
--
--   docker exec -i accapi-postgres psql -U accapi -d accapi -v ON_ERROR_STOP=1 < docs/handover/DDL_S6E2.sql
--
-- PRASYARAT: migrate-pg (container start) membuat kolom + tabel bila `DATABASE_MIGRATION_URL` (role ber-hak DDL) terpasang.
-- Bila tidak, blok 1 berkas ini membuatnya (idempoten, sama persis) — jalankan berkas ini SEBELUM image baru agar
-- migrate-pg tidak gagal start.
--
-- IDEMPOTEN (satu transaksi; menjalankan ulang = tanpa perubahan):
--   1. ADD COLUMN / CREATE TABLE / CREATE INDEX IF NOT EXISTS (aditif, tanpa backfill: baris lama "databaseId" NULL =
--      "tidak tercatat"; Selesaikan "tidak_ada" untuk baris itu ditolak 409 database_unknown — keputusan orkestrator).
--   2. Trigger idempotency_resolution: UPDATE & DELETE per baris + TRUNCATE ditolak (jejak tidak bisa diubah).
--   3. REVOKE UPDATE, DELETE, TRUNCATE ON idempotency_resolution FROM accapi_app; GRANT SELECT, INSERT (bila role ada).
--      Tidak ada sequence (id = UUID teks dari aplikasi).
--   4. Blok VERIFIKASI (baris terakhir) — semua `ok` harus true (NULL = role accapi_app tidak ada, tidak relevan).
--
-- CARA UJI DI DB SINTETIS (BUKAN produksi; contoh: container accapi-am040-pg, DB am040_s6):
--   AM040_DATABASE_URL=<url am040_s6> npx tsx --test lib/pelunasan-ddl-pg.test.ts
--   -> menjalankan berkas ini DUA kali (kedua kalinya tanpa perubahan) + VERIFIKASI semua ok + UPDATE/DELETE ditolak.
--
-- ROLLBACK DARURAT (hanya bila trigger menghalangi operasi sah; catat alasannya):
--   DROP TRIGGER IF EXISTS trg_idempotency_resolution_guard ON idempotency_resolution;
--   DROP TRIGGER IF EXISTS trg_idempotency_resolution_no_truncate ON idempotency_resolution;
--   JANGAN drop tabel/kolom — jejak audit dan pengikatan database kiriman.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- 1. Kolom + tabel (sama dengan entri migrate-pg `idempotency_s6e2` dan `idempotency_override_database`).
ALTER TABLE idempotency_log ADD COLUMN IF NOT EXISTS "databaseId" text;
-- Tinjauan B2 (11 Okt): database lock juga di override (lock yang hanya berisi override resend_success). NULL = override lama.
ALTER TABLE idempotency_override ADD COLUMN IF NOT EXISTS database_id text;
CREATE TABLE IF NOT EXISTS idempotency_resolution (
    id              text PRIMARY KEY,
    key             text NOT NULL,
    lock_id         text,
    previous_status text NOT NULL,
    decision        text NOT NULL,
    accurate_number text,
    database_id     text NOT NULL,
    checked_source  text NOT NULL,
    reason          text NOT NULL,
    actor           text NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT idempotency_resolution_decision CHECK (decision IN ('terposting', 'tidak_ada')),
    CONSTRAINT idempotency_resolution_reason CHECK (char_length(btrim(reason)) >= 15),
    CONSTRAINT idempotency_resolution_number CHECK (decision <> 'terposting' OR coalesce(btrim(accurate_number), '') <> ''),
    CONSTRAINT idempotency_resolution_source CHECK (btrim(checked_source) <> '')
);
CREATE INDEX IF NOT EXISTS idx_idempotency_resolution_key ON idempotency_resolution (key);

-- 2. Append-only (CREATE OR REPLACE = idempoten).
CREATE OR REPLACE FUNCTION idempotency_resolution_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
    RAISE EXCEPTION 'S6e-2: idempotency_resolution append-only — % ditolak (jejak Selesaikan pelunasan)', TG_OP
        USING ERRCODE = 'restrict_violation';
END $fn$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_idempotency_resolution_guard'
                   AND tgrelid = 'public.idempotency_resolution'::regclass) THEN
        CREATE TRIGGER trg_idempotency_resolution_guard BEFORE UPDATE OR DELETE ON idempotency_resolution
            FOR EACH ROW EXECUTE FUNCTION idempotency_resolution_guard();
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_idempotency_resolution_no_truncate'
                   AND tgrelid = 'public.idempotency_resolution'::regclass) THEN
        CREATE TRIGGER trg_idempotency_resolution_no_truncate BEFORE TRUNCATE ON idempotency_resolution
            FOR EACH STATEMENT EXECUTE FUNCTION idempotency_resolution_guard();
    END IF;
END $$;

-- 3. Hak role aplikasi: tambah & baca saja. Role absen = dilewati, bukan galat.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'accapi_app') THEN
        REVOKE UPDATE, DELETE, TRUNCATE ON idempotency_resolution FROM accapi_app;
        GRANT SELECT, INSERT ON idempotency_resolution TO accapi_app;
    END IF;
END $$;

COMMIT;

-- 4. VERIFIKASI (baca-saja).
SELECT cek, ok FROM (VALUES
    ('kolom idempotency_log.databaseId', EXISTS (SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'idempotency_log' AND column_name = 'databaseId')),
    ('kolom idempotency_override.database_id', EXISTS (SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'idempotency_override' AND column_name = 'database_id')),
    ('tabel idempotency_resolution', to_regclass('public.idempotency_resolution') IS NOT NULL),
    ('trigger UPDATE/DELETE', EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_idempotency_resolution_guard')),
    ('trigger TRUNCATE', EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_idempotency_resolution_no_truncate')),
    ('accapi_app tanpa UPDATE', CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'accapi_app')
        THEN NOT has_table_privilege('accapi_app', 'public.idempotency_resolution', 'UPDATE') END),
    ('accapi_app tanpa DELETE', CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'accapi_app')
        THEN NOT has_table_privilege('accapi_app', 'public.idempotency_resolution', 'DELETE') END),
    ('accapi_app boleh INSERT', CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'accapi_app')
        THEN has_table_privilege('accapi_app', 'public.idempotency_resolution', 'INSERT') END)
) AS v(cek, ok);
