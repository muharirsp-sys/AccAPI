-- DDL MANUAL K1b — Kasir ↔ Incaso (BL-59): status baca cache pelunasan Accurate per (database, tanggal).
-- Rujukan: db/schema.ts (kasirPelunasanBaca), scripts/migrate-pg.mjs (entri "kasir_pelunasan_baca (status baca K1b)" = SQL sama dengan
-- blok 1), db/migrations/0031_kasir_baca.sql, lib/kasir/baca-pelunasan.ts (lease + tulis cache), lib/kasir/pembaca.ts (KELAS_GALAT),
-- lib/kasir/baca-pg.test.ts, docs/handover/KASIR-KONTRAK.md §7.
--
-- SIAPA & KAPAN (pola K1a, owner 9 Okt "DDL manual = Claude tulis, IT Support jalankan"): IT Support, SAAT DEPLOY K1b, sebagai role
-- PEMILIK tabel (accapi, bukan accapi_app), SESUDAH docs/handover/DDL_K1A.sql lalu docs/handover/DDL_S7_2.sql, dan SEBELUM image baru. JANGAN dijalankan loop/agen ke
-- produksi.
--
--   docker exec -i accapi-postgres psql -U accapi -d accapi -v ON_ERROR_STOP=1 < docs/handover/DDL_K1B.sql
--
-- KENAPA SEBELUM: migrate-pg (container start) tanpa DATABASE_MIGRATION_URL berjalan sebagai accapi_app yang tak punya CREATE ->
--   CREATE TABLE gagal -> container crash loop. Sesudah berkas ini entri migrate-pg di-SKIP (sudahAda). Image LAMA tidak terganggu.
-- JALUR DATABASE_MIGRATION_URL: migrate-pg membuat tabel TETAPI tanpa GRANT -> berkas ini TETAP WAJIB (idempoten) dan VERIFIKASI-nya
--   diperiksa: semua `ok` true.
--
-- ISI (nama tabel TANPA skema = public pada search_path bawaan; agar uji PG bisa memakai skema sekali-pakai):
--   1. CREATE TABLE IF NOT EXISTS kasir_pelunasan_baca (PK database_id+tanggal, CHECK status/sebab/isi/konsisten, akun_sinkron = user.id akun
--      Accurate sinkron yang membaca). TANPA trigger (cache).
--   2. accapi_app: GRANT SELECT/INSERT/UPDATE; REVOKE DELETE/TRUNCATE (status tidak pernah dihapus aplikasi). Role absen = dilewati.
--   3. VERIFIKASI (baca-saja) — semua `ok` harus true (NULL = role accapi_app tidak ada, tidak relevan). Juga memeriksa prasyarat
--      K1a: accapi_app boleh SELECT/INSERT/UPDATE/DELETE cache kasir_pelunasan(+_faktur) (pembaca menghapus pelunasan yang hilang).
-- Menjalankan ulang seluruh berkas = tanpa perubahan.
--
-- CARA UJI DI DB SINTETIS (BUKAN produksi; contoh container accapi-am040-pg, DB am040_k1b):
--   AM040_DATABASE_URL=<url> npx tsx --test lib/kasir/baca-pg.test.ts
--
-- ROLLBACK DARURAT: image lama tetap jalan dengan tabel ini (tanpa pembaca). Tabel boleh dikosongkan oleh pemilik (cache status; pembaca
--   membangunnya lagi) — JANGAN hapus kasir_pelunasan* tanpa alasan tercatat.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- 1. Tabel (sama dengan entri migrate-pg "kasir_pelunasan_baca (status baca K1b)" dan db/migrations/0031_kasir_baca.sql).
CREATE TABLE IF NOT EXISTS kasir_pelunasan_baca (
    database_id   text NOT NULL,
    tanggal       date NOT NULL,
    status        text NOT NULL,
    sebab         text,
    pesan         text,
    jumlah_daftar integer,
    sisa_detail   integer,
    ditolak       jsonb NOT NULL DEFAULT '[]'::jsonb,
    token         text,
    mulai_pada    timestamptz NOT NULL DEFAULT now(),
    selesai_pada  timestamptz,
    lengkap_pada  timestamptz,
    pemicu        text NOT NULL,
    akun_sinkron  text,
    CONSTRAINT kasir_pelunasan_baca_pkey PRIMARY KEY (database_id, tanggal),
    CONSTRAINT kasir_pelunasan_baca_status CHECK (status IN ('berjalan', 'lengkap', 'sebagian', 'gagal')),
    CONSTRAINT kasir_pelunasan_baca_sebab CHECK (sebab IS NULL OR sebab IN ('sesi_sinkron', 'hak_akses', 'batas_laju', 'accurate_5xx',
        'jaringan', 'tidak_pasti', 'ditolak', 'bentuk', 'nominal', 'terpotong', 'hapus_massal')),
    CONSTRAINT kasir_pelunasan_baca_isi CHECK (btrim(database_id) <> '' AND btrim(pemicu) <> '' AND jsonb_typeof(ditolak) = 'array'
        AND jumlah_daftar >= 0 AND sisa_detail >= 0 AND sisa_detail <= jumlah_daftar),
    CONSTRAINT kasir_pelunasan_baca_konsisten CHECK ((status = 'gagal') = (sebab IS NOT NULL)
        AND (status = 'berjalan') = (token IS NOT NULL) AND (status = 'berjalan') = (selesai_pada IS NULL)
        AND (status <> 'lengkap' OR (coalesce(sisa_detail, -1) = 0 AND jumlah_daftar IS NOT NULL
            AND ditolak = '[]'::jsonb AND lengkap_pada IS NOT NULL)))
);

ALTER TABLE kasir_pelunasan_baca ADD COLUMN IF NOT EXISTS akun_sinkron text; -- EXPAND bila tabel dibuat versi awal K1b

-- 2. Hak role aplikasi. Default privileges (L1g) bisa saja sudah memberi DML penuh -> REVOKE eksplisit DELETE/TRUNCATE.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'accapi_app') THEN
        REVOKE DELETE, TRUNCATE ON kasir_pelunasan_baca FROM accapi_app;
        GRANT SELECT, INSERT, UPDATE ON kasir_pelunasan_baca TO accapi_app;
    END IF;
END $$;

COMMIT;

-- 3. VERIFIKASI (baca-saja).
SELECT cek, ok FROM (VALUES
    ('tabel kasir_pelunasan_baca', to_regclass('kasir_pelunasan_baca') IS NOT NULL),
    ('PK (database_id, tanggal)', EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'kasir_pelunasan_baca_pkey'
        AND conrelid = to_regclass('kasir_pelunasan_baca') AND contype = 'p')),
    -- Definisi PERSIS (pg_get_constraintdef, bentuk PG 16): CHECK bernama sama tetapi dilemahkan (mis. CHECK (true)) = false.
    ('CHECK status/sebab/isi/konsisten (4) — definisi persis', (SELECT count(*) = 4 FROM pg_constraint c JOIN (VALUES
        ('kasir_pelunasan_baca_status', $d$CHECK ((status = ANY (ARRAY['berjalan'::text, 'lengkap'::text, 'sebagian'::text, 'gagal'::text])))$d$),
        ('kasir_pelunasan_baca_sebab', $d$CHECK (((sebab IS NULL) OR (sebab = ANY (ARRAY['sesi_sinkron'::text, 'hak_akses'::text, 'batas_laju'::text, 'accurate_5xx'::text, 'jaringan'::text, 'tidak_pasti'::text, 'ditolak'::text, 'bentuk'::text, 'nominal'::text, 'terpotong'::text, 'hapus_massal'::text]))))$d$),
        ('kasir_pelunasan_baca_isi', $d$CHECK (((btrim(database_id) <> ''::text) AND (btrim(pemicu) <> ''::text) AND (jsonb_typeof(ditolak) = 'array'::text) AND (jumlah_daftar >= 0) AND (sisa_detail >= 0) AND (sisa_detail <= jumlah_daftar)))$d$),
        ('kasir_pelunasan_baca_konsisten', $d$CHECK ((((status = 'gagal'::text) = (sebab IS NOT NULL)) AND ((status = 'berjalan'::text) = (token IS NOT NULL)) AND ((status = 'berjalan'::text) = (selesai_pada IS NULL)) AND ((status <> 'lengkap'::text) OR ((COALESCE(sisa_detail, '-1'::integer) = 0) AND (jumlah_daftar IS NOT NULL) AND (ditolak = '[]'::jsonb) AND (lengkap_pada IS NOT NULL)))))$d$)
    ) AS e(nama, def) ON c.conname = e.nama AND pg_get_constraintdef(c.oid) = e.def
        WHERE c.conrelid = to_regclass('kasir_pelunasan_baca') AND c.contype = 'c')),
    ('kolom akun_sinkron (akun sinkron pembaca)', EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema()
        AND table_name = 'kasir_pelunasan_baca' AND column_name = 'akun_sinkron')),
    ('accapi_app boleh SELECT/INSERT/UPDATE status baca', CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'accapi_app')
        THEN (SELECT bool_and(has_table_privilege('accapi_app', 'kasir_pelunasan_baca', p)) FROM unnest(ARRAY['SELECT', 'INSERT', 'UPDATE']) AS p) END),
    ('accapi_app tanpa DELETE/TRUNCATE status baca', CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'accapi_app')
        THEN NOT (SELECT bool_or(has_table_privilege('accapi_app', 'kasir_pelunasan_baca', p)) FROM unnest(ARRAY['DELETE', 'TRUNCATE']) AS p) END),
    ('prasyarat K1a: accapi_app boleh SELECT/INSERT/UPDATE/DELETE cache pelunasan', CASE
        WHEN to_regclass('kasir_pelunasan') IS NULL OR to_regclass('kasir_pelunasan_faktur') IS NULL THEN false
        WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'accapi_app')
        THEN (SELECT bool_and(has_table_privilege('accapi_app', t, p))
              FROM unnest(ARRAY['kasir_pelunasan', 'kasir_pelunasan_faktur']) AS t,
                   unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']) AS p) END)
) AS v(cek, ok);
