-- DDL MANUAL S7-2 — riwayat principal_log APPEND-ONLY (BL-64) untuk API /api/principals dan benih principal.
-- Rujukan: db/schema.ts (principalLog), scripts/migrate-pg.mjs (entri "principal_log" = SQL sama dengan blok 1 di bawah),
-- db/migrations/0029_principal_log.sql, lib/principal/tulis.ts (cekDdl: jalur tulis menolak 503 PRINCIPAL_DDL_BELUM tanpa trigger
-- di bawah ATAU tanpa trg_principal_code_tetap S7-0), docs/handover/S7-2-KONTRAK-PRINCIPAL-API.md, lib/principal-pg.test.ts.
--
-- SIAPA & KAPAN (pola S6e-2/S7-0, owner 9 Okt "DDL manual = Claude tulis, IT Support jalankan"): IT Support, SAAT DEPLOY S7-2,
-- sebagai role PEMILIK tabel (accapi, bukan accapi_app), SESUDAH docs/handover/DDL_S7_0.sql dan SEBELUM image baru.
-- JANGAN dijalankan oleh loop/agen ke produksi.
--
--   docker exec -i accapi-postgres psql -U accapi -d accapi -v ON_ERROR_STOP=1 < docs/handover/DDL_S7_2.sql
--
-- KENAPA SEBELUM:
--   - migrate-pg (container start) tanpa DATABASE_MIGRATION_URL berjalan sebagai accapi_app yang tak punya CREATE -> CREATE TABLE
--     principal_log gagal -> container crash loop. Sesudah berkas ini entri itu di-SKIP (sudahAda).
--   - Image LAMA tidak terganggu (tabel baru tanpa pembaca).
-- JALUR DATABASE_MIGRATION_URL: migrate-pg membuat tabel + indeks sendiri, TETAPI tidak memasang trigger append-only maupun
--   REVOKE/GRANT. Berkas ini TETAP WAJIB (idempoten, aman sesudah migrate-pg); tanpa trigger jalur tulis menolak 503.
--
-- ISI (nama tanpa skema = public pada search_path bawaan; ditulis begitu agar uji PG bisa memakai skema sekali-pakai):
--   0. Prasyarat S7-0: tabel principal + trigger trg_principal_code_tetap aktif — bila tidak, berhenti (RAISE) tanpa mengubah apa pun.
--   1. CREATE TABLE/INDEX IF NOT EXISTS principal_log (aditif).
--   2. Trigger append-only: UPDATE/DELETE per baris + TRUNCATE ditolak (CREATE OR REPLACE = idempoten, PG14+).
--   3. Hak accapi_app: REVOKE UPDATE, DELETE, TRUNCATE; GRANT SELECT, INSERT + USAGE sequence (role absen = dilewati).
--   4. VERIFIKASI (baca-saja) — semua `ok` harus true (NULL = role accapi_app tidak ada, tidak relevan).
-- Menjalankan ulang seluruh berkas = tanpa perubahan.
--
-- CARA UJI DI DB SINTETIS (BUKAN produksi; contoh container accapi-am040-pg, DB am040_s72):
--   AM040_DATABASE_URL=<url> npx tsx --test lib/principal-pg.test.ts
--
-- ROLLBACK DARURAT (hanya bila trigger menghalangi operasi sah; catat alasannya). JANGAN drop tabel — jejak audit.
--   Catatan: tanpa trigger ini jalur tulis /api/principals menolak 503 (sengaja); memasang ulang = jalankan berkas ini lagi.
--   DROP TRIGGER IF EXISTS trg_principal_log_append_only ON principal_log;
--   DROP TRIGGER IF EXISTS trg_principal_log_no_truncate ON principal_log;

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- 0. Prasyarat S7-0.
DO $$
BEGIN
    IF to_regclass('principal') IS NULL THEN
        RAISE EXCEPTION 'S7-2: tabel principal belum ada — jalankan docs/handover/DDL_S7_0.sql dulu';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_principal_code_tetap' AND tgrelid = to_regclass('principal')
                   AND NOT tgisinternal AND tgenabled IN ('O', 'A')) THEN
        RAISE EXCEPTION 'S7-2: trigger trg_principal_code_tetap tidak aktif — jalankan docs/handover/DDL_S7_0.sql dulu';
    END IF;
END $$;

-- 1. Tabel (sama dengan entri migrate-pg "principal_log").
CREATE TABLE IF NOT EXISTS principal_log (
    id           bigserial PRIMARY KEY,
    entitas      text NOT NULL,
    kunci        text NOT NULL,
    principal_id text NOT NULL,
    aksi         text NOT NULL,
    before       jsonb,
    after        jsonb,
    aktor        text NOT NULL,
    waktu        timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT principal_log_entitas CHECK (entitas IN ('principal', 'varian', 'alias')),
    CONSTRAINT principal_log_aksi CHECK (aksi IN ('buat', 'aktif', 'nonaktif', 'hapus')),
    CONSTRAINT principal_log_aktor_isi CHECK (btrim(aktor) <> '')
);
CREATE INDEX IF NOT EXISTS idx_principal_log_principal ON principal_log (principal_id, id);

-- 2. Append-only.
CREATE OR REPLACE FUNCTION principal_log_append_only() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
    RAISE EXCEPTION 'S7-2: principal_log append-only — % ditolak (riwayat principal)', TG_OP
        USING ERRCODE = 'restrict_violation';
END $fn$;
CREATE OR REPLACE TRIGGER trg_principal_log_append_only BEFORE UPDATE OR DELETE ON principal_log
    FOR EACH ROW EXECUTE FUNCTION principal_log_append_only();
CREATE OR REPLACE TRIGGER trg_principal_log_no_truncate BEFORE TRUNCATE ON principal_log
    FOR EACH STATEMENT EXECUTE FUNCTION principal_log_append_only();

-- 3. Hak role aplikasi: tambah & baca saja (default privileges L1g memberi DML penuh -> dicabut). Role absen = dilewati.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'accapi_app') THEN
        REVOKE UPDATE, DELETE, TRUNCATE ON principal_log FROM accapi_app;
        GRANT SELECT, INSERT ON principal_log TO accapi_app;
        EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE %s TO accapi_app', pg_get_serial_sequence('principal_log', 'id'));
    END IF;
END $$;

COMMIT;

-- 4. VERIFIKASI (baca-saja).
SELECT cek, ok FROM (VALUES
    ('tabel principal_log', to_regclass('principal_log') IS NOT NULL),
    ('indeks idx_principal_log_principal', to_regclass('idx_principal_log_principal') IS NOT NULL),
    ('trigger principal_log tolak UPDATE/DELETE aktif', EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_principal_log_append_only'
        AND tgrelid = to_regclass('principal_log') AND NOT tgisinternal AND tgenabled IN ('O', 'A'))),
    ('trigger principal_log tolak TRUNCATE aktif', EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_principal_log_no_truncate'
        AND tgrelid = to_regclass('principal_log') AND NOT tgisinternal AND tgenabled IN ('O', 'A'))),
    ('trigger principal.code tetap aktif (S7-0)', EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_principal_code_tetap'
        AND tgrelid = to_regclass('principal') AND NOT tgisinternal AND tgenabled IN ('O', 'A'))),
    ('accapi_app tanpa UPDATE/DELETE/TRUNCATE principal_log', CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'accapi_app')
        THEN NOT (has_table_privilege('accapi_app', 'principal_log', 'UPDATE') OR has_table_privilege('accapi_app', 'principal_log', 'DELETE')
                  OR has_table_privilege('accapi_app', 'principal_log', 'TRUNCATE')) END),
    ('accapi_app boleh SELECT/INSERT principal_log + sequence', CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'accapi_app')
        THEN has_table_privilege('accapi_app', 'principal_log', 'SELECT') AND has_table_privilege('accapi_app', 'principal_log', 'INSERT')
             AND has_sequence_privilege('accapi_app', pg_get_serial_sequence('principal_log', 'id'), 'USAGE') END),
    ('accapi_app boleh SELECT/INSERT/UPDATE/DELETE principal* (S7-0)', CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'accapi_app')
        THEN (SELECT bool_and(has_table_privilege('accapi_app', t, p))
              FROM unnest(ARRAY['principal', 'principal_variant', 'principal_alias']) AS t,
                   unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']) AS p) END)
) AS v(cek, ok);
