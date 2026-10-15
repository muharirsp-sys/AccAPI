-- DDL MANUAL K2a — Kasir ↔ Incaso (BL-59): kolom Giro + aturan owner setoran di DB (owner 12 Okt 2026: Giro WAJIB nomor BG + jatuh tempo,
-- bukti Transfer WAJIB, Nomor Form Kasir WAJIB bila nominal > 0; orkestrator: tegakkan juga di DB sesudah tinjauan B).
-- Rujukan: db/schema.ts (kasirSetoran), scripts/migrate-pg.mjs (entri "kasir_setoran giro (K2a)" = SQL sama dengan blok 1),
-- db/migrations/0032_kasir_setoran_giro.sql, lib/kasir/hari.ts (uraiSetoran/catatSetoran menegakkan lebih dulu, 400 berkode),
-- lib/kasir/hari-pg.test.ts, docs/handover/KASIR-KONTRAK.md §8.
--
-- SIAPA & KAPAN (pola K1a/K1b): IT Support, SAAT DEPLOY K2, sebagai role PEMILIK tabel (accapi, bukan accapi_app), SESUDAH
-- docs/handover/DDL_K1A.sql -> DDL_S7_2.sql -> DDL_K1B.sql, dan SEBELUM image baru. JANGAN dijalankan loop/agen ke produksi.
--
--   docker exec -i accapi-postgres psql -U accapi -d accapi -v ON_ERROR_STOP=1 < docs/handover/DDL_K2A.sql
--
-- KENAPA SEBELUM: migrate-pg (container start) tanpa DATABASE_MIGRATION_URL berjalan sebagai accapi_app (bukan pemilik) -> ALTER TABLE
--   ditolak -> container crash loop. Sesudah berkas ini entri migrate-pg di-SKIP (sudahAda lewat katalog pg_attribute + pg_constraint, tanpa
--   hak tabel). Image LAMA tidak terganggu (kolom baru nullable; CHECK hanya membatasi INSERT setoran, yang belum ada sebelum K2a).
-- JALUR DATABASE_MIGRATION_URL: migrate-pg menjalankan SQL yang sama; berkas ini tetap aman (idempoten) dan VERIFIKASI-nya diperiksa.
-- PRASYARAT DATA: kasir_setoran KOSONG (belum ada route tulis sebelum K2a). Bila berisi baris yang melanggar, ADD CONSTRAINT gagal dan seluruh
--   berkas di-ROLLBACK (BEGIN/COMMIT) — laporkan, jangan dilemahkan.
--
-- ISI (nama tabel TANPA skema = public pada search_path bawaan; agar uji PG bisa memakai skema sekali-pakai):
--   1. ADD COLUMN IF NOT EXISTS giro_nomor text + giro_jatuh_tempo date (nullable: NULL = bukan setoran giro), lalu CHECK yang belum ada:
--      kasir_setoran_giro_nomor (nomor BG tidak hanya spasi), kasir_setoran_giro_wajib (giro > 0 -> nomor BG + jatuh tempo),
--      kasir_setoran_bukti_wajib (transfer > 0 -> bukti_transfer), kasir_setoran_form_wajib (nominal > 0 -> no_form_kasir).
--      Trigger append-only K1a tetap (ADD COLUMN/CONSTRAINT tidak memicu trigger).
--   2. Hak: GRANT SELECT/INSERT tingkat tabel (DDL_K1A) sudah mencakup kolom baru — tidak ada GRANT baru.
--   3. VERIFIKASI (baca-saja) — semua `ok` harus true (NULL = role accapi_app tidak ada, tidak relevan). Baris "definisi persis" false =
--      CHECK diubah/dilemahkan.
-- Menjalankan ulang seluruh berkas = tanpa perubahan.
--
-- CARA UJI DI DB SINTETIS (BUKAN produksi; contoh container accapi-am040-pg):
--   AM040_DATABASE_URL=<url> npx tsx --test lib/kasir/hari-pg.test.ts
--
-- ROLLBACK DARURAT: image lama tetap jalan dengan kolom/CHECK ini. JANGAN DROP kolom yang sudah berisi setoran giro (jejak uang).

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- 1. Kolom + CHECK (sama dengan entri migrate-pg "kasir_setoran giro (K2a)" dan db/migrations/0032_kasir_setoran_giro.sql).
ALTER TABLE kasir_setoran ADD COLUMN IF NOT EXISTS giro_nomor text;
ALTER TABLE kasir_setoran ADD COLUMN IF NOT EXISTS giro_jatuh_tempo date;
DO $k2a$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'kasir_setoran'::regclass AND conname = 'kasir_setoran_giro_nomor') THEN
    ALTER TABLE kasir_setoran ADD CONSTRAINT kasir_setoran_giro_nomor CHECK (btrim(giro_nomor) <> '');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'kasir_setoran'::regclass AND conname = 'kasir_setoran_giro_wajib') THEN
    ALTER TABLE kasir_setoran ADD CONSTRAINT kasir_setoran_giro_wajib CHECK (giro = 0 OR (giro_nomor IS NOT NULL AND giro_jatuh_tempo IS NOT NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'kasir_setoran'::regclass AND conname = 'kasir_setoran_bukti_wajib') THEN
    ALTER TABLE kasir_setoran ADD CONSTRAINT kasir_setoran_bukti_wajib CHECK (transfer = 0 OR bukti_transfer IS NOT NULL);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'kasir_setoran'::regclass AND conname = 'kasir_setoran_form_wajib') THEN
    ALTER TABLE kasir_setoran ADD CONSTRAINT kasir_setoran_form_wajib CHECK ((tunai + transfer + giro) = 0 OR no_form_kasir IS NOT NULL);
  END IF;
END $k2a$;

COMMIT;

-- 3. VERIFIKASI (baca-saja).
SELECT cek, ok FROM (VALUES
    ('prasyarat K1a: tabel kasir_setoran', to_regclass('kasir_setoran') IS NOT NULL),
    ('kolom giro_nomor text + giro_jatuh_tempo date, nullable', (SELECT count(*) = 2 FROM pg_attribute WHERE attrelid = to_regclass('kasir_setoran')
        AND NOT attisdropped AND NOT attnotnull AND ((attname = 'giro_nomor' AND atttypid = 'text'::regtype)
            OR (attname = 'giro_jatuh_tempo' AND atttypid = 'date'::regtype)))),
    -- Definisi PERSIS (pg_get_constraintdef, bentuk PG 16): CHECK bernama sama tetapi dilemahkan (mis. CHECK (true)) = false.
    ('CHECK giro_nomor / giro_wajib / bukti_wajib / form_wajib (4) — definisi persis', (SELECT count(*) = 4 FROM pg_constraint c JOIN (VALUES
        ('kasir_setoran_giro_nomor', $d$CHECK ((btrim(giro_nomor) <> ''::text))$d$),
        ('kasir_setoran_giro_wajib', $d$CHECK (((giro = (0)::numeric) OR ((giro_nomor IS NOT NULL) AND (giro_jatuh_tempo IS NOT NULL))))$d$),
        ('kasir_setoran_bukti_wajib', $d$CHECK (((transfer = (0)::numeric) OR (bukti_transfer IS NOT NULL)))$d$),
        ('kasir_setoran_form_wajib', $d$CHECK (((((tunai + transfer) + giro) = (0)::numeric) OR (no_form_kasir IS NOT NULL)))$d$)
    ) AS e(nama, def) ON c.conname = e.nama AND pg_get_constraintdef(c.oid) = e.def
        WHERE c.conrelid = to_regclass('kasir_setoran') AND c.contype = 'c')),
    ('trigger append-only kasir_setoran (K1a) tetap aktif', EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = to_regclass('kasir_setoran')
        AND tgname = 'trg_kasir_setoran_append_only' AND NOT tgisinternal AND tgenabled = 'O' AND tgtype = 27)),
    ('accapi_app boleh SELECT/INSERT kolom giro', CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'accapi_app')
        THEN (SELECT bool_and(has_column_privilege('accapi_app', 'kasir_setoran', c, p))
              FROM unnest(ARRAY['giro_nomor', 'giro_jatuh_tempo']) AS c, unnest(ARRAY['SELECT', 'INSERT']) AS p) END),
    ('accapi_app tanpa UPDATE/DELETE/TRUNCATE kasir_setoran', CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'accapi_app')
        THEN NOT (SELECT bool_or(has_table_privilege('accapi_app', 'kasir_setoran', p)) FROM unnest(ARRAY['UPDATE', 'DELETE', 'TRUNCATE']) AS p) END)
) AS v(cek, ok);
