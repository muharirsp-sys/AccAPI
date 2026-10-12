-- DDL MANUAL K2a — Kasir ↔ Incaso (BL-59): kolom Giro di kasir_setoran (owner 12 Okt 2026: setoran Giro WAJIB nomor BG + tanggal jatuh tempo).
-- Rujukan: db/schema.ts (kasirSetoran.giroNomor/giroJatuhTempo), scripts/migrate-pg.mjs (entri "kasir_setoran giro (K2a)" = SQL sama dengan
-- blok 1), db/migrations/0032_kasir_setoran_giro.sql, lib/kasir/hari.ts (catatSetoran menegakkan "giro > 0 -> wajib"),
-- lib/kasir/hari-pg.test.ts, docs/handover/KASIR-KONTRAK.md §8.
--
-- SIAPA & KAPAN (pola K1a/K1b): IT Support, SAAT DEPLOY K2, sebagai role PEMILIK tabel (accapi, bukan accapi_app), SESUDAH
-- docs/handover/DDL_K1A.sql -> DDL_S7_2.sql -> DDL_K1B.sql, dan SEBELUM image baru. JANGAN dijalankan loop/agen ke produksi.
--
--   docker exec -i accapi-postgres psql -U accapi -d accapi -v ON_ERROR_STOP=1 < docs/handover/DDL_K2A.sql
--
-- KENAPA SEBELUM: migrate-pg (container start) tanpa DATABASE_MIGRATION_URL berjalan sebagai accapi_app (bukan pemilik) -> ALTER TABLE
--   ditolak -> container crash loop. Sesudah berkas ini entri migrate-pg di-SKIP (sudahAda lewat pg_attribute). Image LAMA tidak terganggu
--   (kolom baru nullable, tidak dibaca kode lama).
-- JALUR DATABASE_MIGRATION_URL: migrate-pg menambah kolom sendiri; berkas ini tetap aman (idempoten) dan VERIFIKASI-nya diperiksa.
--
-- ISI (nama tabel TANPA skema = public pada search_path bawaan; agar uji PG bisa memakai skema sekali-pakai):
--   1. ALTER TABLE kasir_setoran ADD COLUMN IF NOT EXISTS giro_nomor text (CHECK kasir_setoran_giro_nomor: tidak hanya spasi) +
--      giro_jatuh_tempo date. Nullable: NULL = bukan setoran giro. Trigger append-only K1a tetap (ADD COLUMN tidak memicu trigger).
--   2. Hak: GRANT SELECT/INSERT tingkat tabel (DDL_K1A) sudah mencakup kolom baru — tidak ada GRANT baru.
--   3. VERIFIKASI (baca-saja) — semua `ok` harus true (NULL = role accapi_app tidak ada, tidak relevan). Baris "definisi persis" false =
--      CHECK diubah/dilemahkan, atau kolom sudah ada SEBELUM berkas ini tanpa CHECK (ADD COLUMN IF NOT EXISTS melewati CHECK-nya) — hanya
--      mungkin di DB uji: ALTER TABLE kasir_setoran DROP COLUMN giro_nomor lalu jalankan ulang (kolom belum pernah berisi di produksi).
-- Menjalankan ulang seluruh berkas = tanpa perubahan.
--
-- CARA UJI DI DB SINTETIS (BUKAN produksi; contoh container accapi-am040-pg):
--   AM040_DATABASE_URL=<url> npx tsx --test lib/kasir/hari-pg.test.ts
--
-- ROLLBACK DARURAT: image lama tetap jalan dengan kolom ini (diabaikan). JANGAN DROP kolom yang sudah berisi setoran giro (jejak uang).

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- 1. Kolom (sama dengan entri migrate-pg "kasir_setoran giro (K2a)" dan db/migrations/0032_kasir_setoran_giro.sql).
ALTER TABLE kasir_setoran ADD COLUMN IF NOT EXISTS giro_nomor text CONSTRAINT kasir_setoran_giro_nomor CHECK (btrim(giro_nomor) <> '');
ALTER TABLE kasir_setoran ADD COLUMN IF NOT EXISTS giro_jatuh_tempo date;

COMMIT;

-- 3. VERIFIKASI (baca-saja).
SELECT cek, ok FROM (VALUES
    ('prasyarat K1a: tabel kasir_setoran', to_regclass('kasir_setoran') IS NOT NULL),
    ('kolom giro_nomor text + giro_jatuh_tempo date, nullable', (SELECT count(*) = 2 FROM pg_attribute WHERE attrelid = to_regclass('kasir_setoran')
        AND NOT attisdropped AND NOT attnotnull AND ((attname = 'giro_nomor' AND atttypid = 'text'::regtype)
            OR (attname = 'giro_jatuh_tempo' AND atttypid = 'date'::regtype)))),
    -- Definisi PERSIS (pg_get_constraintdef, bentuk PG 16): CHECK bernama sama tetapi dilemahkan (mis. CHECK (true)) = false.
    ('CHECK kasir_setoran_giro_nomor — definisi persis', EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass('kasir_setoran')
        AND conname = 'kasir_setoran_giro_nomor' AND contype = 'c' AND pg_get_constraintdef(oid) = $d$CHECK ((btrim(giro_nomor) <> ''::text))$d$)),
    ('trigger append-only kasir_setoran (K1a) tetap aktif', EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = to_regclass('kasir_setoran')
        AND tgname = 'trg_kasir_setoran_append_only' AND NOT tgisinternal AND tgenabled = 'O' AND tgtype = 27)),
    ('accapi_app boleh SELECT/INSERT kolom giro', CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'accapi_app')
        THEN (SELECT bool_and(has_column_privilege('accapi_app', 'kasir_setoran', c, p))
              FROM unnest(ARRAY['giro_nomor', 'giro_jatuh_tempo']) AS c, unnest(ARRAY['SELECT', 'INSERT']) AS p) END),
    ('accapi_app tanpa UPDATE/DELETE/TRUNCATE kasir_setoran', CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'accapi_app')
        THEN NOT (SELECT bool_or(has_table_privilege('accapi_app', 'kasir_setoran', p)) FROM unnest(ARRAY['UPDATE', 'DELETE', 'TRUNCATE']) AS p) END)
) AS v(cek, ok);
