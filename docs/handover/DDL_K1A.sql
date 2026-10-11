-- DDL MANUAL K1a — Kasir ↔ Incaso (BL-59): setoran per orang per hari, penjelasan selisih, event hari (append-only + REVOKE) dan
-- cache pelunasan berkolom sempit (K1b).
-- Rujukan: db/schema.ts (kasirSetoran, kasirSelisihCatatan, kasirHariEvent, kasirPelunasan, kasirPelunasanFaktur), scripts/migrate-pg.mjs
-- (entri "kasir (setoran, catatan, hari, cache pelunasan)" = SQL sama dengan blok 1), db/migrations/0029_kasir.sql,
-- lib/kasir/skema-pg.test.ts, lib/kasir/rekonsiliasi.ts, docs/handover/KASIR-KONTRAK.md. Keputusan owner:
-- scratch/fiori-intake/OWNER-ANSWERS-S7-2026-10-10.md (C8 + Kasir 11 Okt).
--
-- SIAPA & KAPAN (pola S6e-2/S7-0, owner 9 Okt "DDL manual = Claude tulis, IT Support jalankan"): IT Support, SAAT DEPLOY K1a, sebagai
-- role PEMILIK tabel (accapi, bukan accapi_app), SEBELUM image baru di-deploy. JANGAN dijalankan oleh loop/agen ke produksi.
--
--   docker exec -i accapi-postgres psql -U accapi -d accapi -v ON_ERROR_STOP=1 < docs/handover/DDL_K1A.sql
--
-- KENAPA SEBELUM: migrate-pg (container start) tanpa DATABASE_MIGRATION_URL berjalan sebagai accapi_app yang tak punya CREATE ->
--   CREATE TABLE kasir_* gagal -> container crash loop. Sesudah berkas ini entri migrate-pg di-SKIP (sudahAda). Image LAMA tidak
--   terganggu (tabel baru tanpa pembaca/penulis).
-- JALUR DATABASE_MIGRATION_URL: migrate-pg membuat tabel sendiri TETAPI tanpa trigger append-only dan tanpa REVOKE -> berkas ini TETAP
--   WAJIB (aman sesudah migrate-pg — idempoten) dan blok VERIFIKASI-nya diperiksa: semua `ok` true.
--
-- ISI (nama tabel TANPA skema = public pada search_path bawaan; ditulis begitu agar uji PG bisa memakai skema sekali-pakai):
--   1. CREATE TABLE/INDEX IF NOT EXISTS kasir_setoran, kasir_selisih_catatan, kasir_hari_event, kasir_pelunasan, kasir_pelunasan_faktur.
--   2. Trigger append-only (UPDATE/DELETE per baris + TRUNCATE) pada kasir_setoran, kasir_selisih_catatan, kasir_hari_event.
--      Koreksi setoran = baris revisi baru; penjelasan baru = baris baru; buka kembali = event baru. Cache pelunasan TIDAK dijaga
--      (upsert/hapus oleh pembaca K1b).
--   3. accapi_app: REVOKE UPDATE/DELETE/TRUNCATE + GRANT SELECT/INSERT (+ USAGE sequence) pada tiga tabel jejak; GRANT SELECT/INSERT/
--      UPDATE/DELETE (tanpa TRUNCATE) pada dua tabel cache. Role absen = dilewati.
--   4. VERIFIKASI (baca-saja) — semua `ok` harus true (NULL = role accapi_app tidak ada, tidak relevan).
-- Menjalankan ulang seluruh berkas = tanpa perubahan.
--
-- CARA UJI DI DB SINTETIS (BUKAN produksi; contoh container accapi-am040-pg, DB am040_k1a):
--   AM040_DATABASE_URL=<url> npx tsx --test lib/kasir/skema-pg.test.ts
--
-- ROLLBACK DARURAT (hanya bila trigger menghalangi operasi sah; catat alasannya): image lama tetap jalan dengan objek ini.
--   DROP TRIGGER IF EXISTS trg_kasir_setoran_append_only ON kasir_setoran;   (dst. untuk 5 trigger lain)
--   JANGAN drop tabel — jejak setoran/penjelasan/kunci hari adalah catatan uang.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- 1. Tabel (sama dengan entri migrate-pg "kasir (setoran, catatan, hari, cache pelunasan)" dan db/migrations/0029_kasir.sql).
CREATE TABLE IF NOT EXISTS kasir_setoran (
    id                bigserial PRIMARY KEY,
    tanggal           date NOT NULL,
    salesman_kode     text NOT NULL,
    revisi            integer NOT NULL,
    revisi_sebelumnya integer,
    tunai             numeric(18,2) NOT NULL,
    transfer          numeric(18,2) NOT NULL,
    giro              numeric(18,2) NOT NULL,
    no_form_kasir     text,
    bukti_transfer    text,
    catatan           text,
    dicatat_oleh      text NOT NULL,
    dicatat_pada      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_kasir_setoran_revisi UNIQUE (tanggal, salesman_kode, revisi),
    CONSTRAINT kasir_setoran_revisi_sebelumnya_fk FOREIGN KEY (tanggal, salesman_kode, revisi_sebelumnya)
        REFERENCES kasir_setoran (tanggal, salesman_kode, revisi),
    CONSTRAINT kasir_setoran_rantai CHECK (revisi >= 1 AND revisi_sebelumnya IS NOT DISTINCT FROM nullif(revisi - 1, 0)),
    CONSTRAINT kasir_setoran_nominal CHECK (tunai >= 0 AND transfer >= 0 AND giro >= 0),
    CONSTRAINT kasir_setoran_kode CHECK (salesman_kode <> '' AND salesman_kode = btrim(salesman_kode)),
    CONSTRAINT kasir_setoran_teks CHECK (btrim(coalesce(no_form_kasir, '-')) <> '' AND btrim(coalesce(bukti_transfer, '-')) <> ''
        AND btrim(coalesce(catatan, '-')) <> ''),
    CONSTRAINT kasir_setoran_oleh CHECK (btrim(dicatat_oleh) <> '')
);
CREATE TABLE IF NOT EXISTS kasir_selisih_catatan (
    id            bigserial PRIMARY KEY,
    tanggal       date NOT NULL,
    salesman_kode text NOT NULL,
    pelunasan     numeric(18,2) NOT NULL,
    setoran       numeric(18,2) NOT NULL,
    penjelasan    text NOT NULL,
    tindak_lanjut text NOT NULL,
    dicatat_oleh  text NOT NULL,
    dicatat_pada  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT kasir_selisih_catatan_kode CHECK (salesman_kode = btrim(salesman_kode)),
    CONSTRAINT kasir_selisih_catatan_setoran CHECK (setoran >= 0),
    CONSTRAINT kasir_selisih_catatan_penjelasan CHECK (char_length(btrim(penjelasan)) >= 15),
    CONSTRAINT kasir_selisih_catatan_tindak_lanjut CHECK (tindak_lanjut IN ('setor_susulan', 'koreksi_incaso', 'lapor_om')),
    CONSTRAINT kasir_selisih_catatan_oleh CHECK (btrim(dicatat_oleh) <> '')
);
CREATE INDEX IF NOT EXISTS idx_kasir_selisih_catatan_hari ON kasir_selisih_catatan (tanggal, salesman_kode);
CREATE TABLE IF NOT EXISTS kasir_hari_event (
    id       bigserial PRIMARY KEY,
    tanggal  date NOT NULL,
    jenis    text NOT NULL,
    alasan   text,
    snapshot jsonb,
    oleh     text NOT NULL,
    pada     timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT kasir_hari_event_jenis CHECK (jenis IN ('tutup', 'kunci', 'buka')),
    CONSTRAINT kasir_hari_event_alasan_buka CHECK (jenis <> 'buka' OR char_length(btrim(coalesce(alasan, ''))) >= 15),
    CONSTRAINT kasir_hari_event_snapshot CHECK ((jenis = 'buka') = (snapshot IS NULL)
        AND (snapshot IS NULL OR jsonb_typeof(snapshot) = 'object')),
    CONSTRAINT kasir_hari_event_oleh CHECK (btrim(oleh) <> '')
);
CREATE INDEX IF NOT EXISTS idx_kasir_hari_event_tanggal ON kasir_hari_event (tanggal, id);
CREATE TABLE IF NOT EXISTS kasir_pelunasan (
    database_id   text NOT NULL,
    pelunasan_id  bigint NOT NULL,
    nomor         text NOT NULL,
    tanggal       date NOT NULL,
    metode        text NOT NULL,
    cheque_amount numeric(18,2) NOT NULL,
    last_update   text,
    dibaca_pada   timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT kasir_pelunasan_pkey PRIMARY KEY (database_id, pelunasan_id),
    CONSTRAINT kasir_pelunasan_isi CHECK (btrim(database_id) <> '' AND btrim(nomor) <> '' AND btrim(metode) <> '')
);
CREATE INDEX IF NOT EXISTS idx_kasir_pelunasan_tanggal ON kasir_pelunasan (database_id, tanggal);
CREATE TABLE IF NOT EXISTS kasir_pelunasan_faktur (
    database_id        text NOT NULL,
    pelunasan_id       bigint NOT NULL,
    faktur_id          bigint NOT NULL,
    nomor_faktur       text,
    master_salesman_id bigint,
    invoice_payment    numeric(18,2) NOT NULL,
    CONSTRAINT kasir_pelunasan_faktur_pkey PRIMARY KEY (database_id, pelunasan_id, faktur_id),
    CONSTRAINT kasir_pelunasan_faktur_pelunasan_fk FOREIGN KEY (database_id, pelunasan_id)
        REFERENCES kasir_pelunasan (database_id, pelunasan_id) ON DELETE CASCADE
);

-- 2. Append-only (CREATE OR REPLACE = idempoten, PG14+). Satu fungsi untuk tiga tabel jejak.
CREATE OR REPLACE FUNCTION kasir_append_only() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
    RAISE EXCEPTION 'K1a: % append-only — % ditolak (koreksi = baris baru)', TG_TABLE_NAME, TG_OP
        USING ERRCODE = 'restrict_violation';
END $fn$;
CREATE OR REPLACE TRIGGER trg_kasir_setoran_append_only BEFORE UPDATE OR DELETE ON kasir_setoran
    FOR EACH ROW EXECUTE FUNCTION kasir_append_only();
CREATE OR REPLACE TRIGGER trg_kasir_setoran_no_truncate BEFORE TRUNCATE ON kasir_setoran
    FOR EACH STATEMENT EXECUTE FUNCTION kasir_append_only();
CREATE OR REPLACE TRIGGER trg_kasir_selisih_catatan_append_only BEFORE UPDATE OR DELETE ON kasir_selisih_catatan
    FOR EACH ROW EXECUTE FUNCTION kasir_append_only();
CREATE OR REPLACE TRIGGER trg_kasir_selisih_catatan_no_truncate BEFORE TRUNCATE ON kasir_selisih_catatan
    FOR EACH STATEMENT EXECUTE FUNCTION kasir_append_only();
CREATE OR REPLACE TRIGGER trg_kasir_hari_event_append_only BEFORE UPDATE OR DELETE ON kasir_hari_event
    FOR EACH ROW EXECUTE FUNCTION kasir_append_only();
CREATE OR REPLACE TRIGGER trg_kasir_hari_event_no_truncate BEFORE TRUNCATE ON kasir_hari_event
    FOR EACH STATEMENT EXECUTE FUNCTION kasir_append_only();

-- 3. Hak role aplikasi. Default privileges (L1g) bisa saja sudah memberi DML penuh -> REVOKE eksplisit pada tabel jejak.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'accapi_app') THEN
        REVOKE UPDATE, DELETE, TRUNCATE ON kasir_setoran, kasir_selisih_catatan, kasir_hari_event FROM accapi_app;
        GRANT SELECT, INSERT ON kasir_setoran, kasir_selisih_catatan, kasir_hari_event TO accapi_app;
        GRANT USAGE, SELECT ON SEQUENCE kasir_setoran_id_seq, kasir_selisih_catatan_id_seq, kasir_hari_event_id_seq TO accapi_app;
        REVOKE TRUNCATE ON kasir_pelunasan, kasir_pelunasan_faktur FROM accapi_app;
        GRANT SELECT, INSERT, UPDATE, DELETE ON kasir_pelunasan, kasir_pelunasan_faktur TO accapi_app;
    END IF;
END $$;

COMMIT;

-- 4. VERIFIKASI (baca-saja).
SELECT cek, ok FROM (VALUES
    ('tabel kasir_* (5)', (SELECT count(*) = 5 FROM unnest(ARRAY['kasir_setoran', 'kasir_selisih_catatan', 'kasir_hari_event',
        'kasir_pelunasan', 'kasir_pelunasan_faktur']) AS t WHERE to_regclass(t) IS NOT NULL)),
    ('unik revisi setoran (tanggal, kode, revisi)', EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uq_kasir_setoran_revisi'
        AND conrelid = to_regclass('kasir_setoran') AND contype = 'u')),
    ('FK revisi setoran -> revisi sebelumnya', EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'kasir_setoran_revisi_sebelumnya_fk'
        AND conrelid = to_regclass('kasir_setoran') AND confrelid = to_regclass('kasir_setoran') AND contype = 'f')),
    ('CHECK nominal setoran >= 0', EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'kasir_setoran_nominal'
        AND conrelid = to_regclass('kasir_setoran') AND contype = 'c')),
    ('trigger append-only (6)', (SELECT count(*) = 6 FROM pg_trigger WHERE NOT tgisinternal AND tgname IN
        ('trg_kasir_setoran_append_only', 'trg_kasir_setoran_no_truncate', 'trg_kasir_selisih_catatan_append_only',
         'trg_kasir_selisih_catatan_no_truncate', 'trg_kasir_hari_event_append_only', 'trg_kasir_hari_event_no_truncate')
        AND tgrelid IN (to_regclass('kasir_setoran'), to_regclass('kasir_selisih_catatan'), to_regclass('kasir_hari_event')))),
    ('accapi_app tanpa UPDATE/DELETE/TRUNCATE jejak', CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'accapi_app')
        THEN NOT (SELECT bool_or(has_table_privilege('accapi_app', t, p))
              FROM unnest(ARRAY['kasir_setoran', 'kasir_selisih_catatan', 'kasir_hari_event']) AS t,
                   unnest(ARRAY['UPDATE', 'DELETE', 'TRUNCATE']) AS p) END),
    ('accapi_app boleh SELECT/INSERT jejak + sequence', CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'accapi_app')
        THEN (SELECT bool_and(has_table_privilege('accapi_app', t, p))
              FROM unnest(ARRAY['kasir_setoran', 'kasir_selisih_catatan', 'kasir_hari_event']) AS t,
                   unnest(ARRAY['SELECT', 'INSERT']) AS p)
         AND (SELECT bool_and(has_sequence_privilege('accapi_app', s, 'USAGE'))
              FROM unnest(ARRAY['kasir_setoran_id_seq', 'kasir_selisih_catatan_id_seq', 'kasir_hari_event_id_seq']) AS s) END),
    ('accapi_app boleh SELECT/INSERT/UPDATE/DELETE cache pelunasan', CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'accapi_app')
        THEN (SELECT bool_and(has_table_privilege('accapi_app', t, p))
              FROM unnest(ARRAY['kasir_pelunasan', 'kasir_pelunasan_faktur']) AS t,
                   unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']) AS p) END)
) AS v(cek, ok);
