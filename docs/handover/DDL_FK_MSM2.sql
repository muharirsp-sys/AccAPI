-- DDL MANUAL FK-MSM2 — Kunjungan LUAR RUTE + konfirmasi masuk JKS (pilot Form Kontrol cabang MSM, owner 12 Okt 2026).
-- Rujukan: db/schema.ts (kunjunganLuarRute), scripts/migrate-pg.mjs (entri "kunjungan_luar_rute (FK-MSM2)" = SQL sama dengan blok 1),
-- db/migrations/0034_kunjungan_luar_rute.sql, lib/form-kontrol/luar-rute.ts, app/api/form-kontrol/luar-rute/**,
-- lib/form-kontrol/fk-msm2-pg.test.ts.
--
-- SIAPA & KAPAN (pola K1a/K1b/O1, owner 9 Okt "DDL manual = Claude tulis, IT Support jalankan"): IT Support, SAAT DEPLOY FK-MSM2, sebagai
-- role PEMILIK (accapi, bukan accapi_app), SESUDAH docs/handover/DDL_O1.sql, dan SEBELUM image baru. JANGAN dijalankan loop/agen ke
-- produksi.
--
--   docker exec -i accapi-postgres psql -U accapi -d accapi -v ON_ERROR_STOP=1 < docs/handover/DDL_FK_MSM2.sql
--
-- KENAPA SEBELUM: migrate-pg (container start) tanpa DATABASE_MIGRATION_URL berjalan sebagai accapi_app yang tak punya CREATE ->
--   CREATE TABLE gagal -> container crash loop. Sesudah berkas ini entri migrate-pg di-SKIP (sudahAda via pg_indexes + pg_attribute).
--   Image LAMA tidak terganggu (tabel baru tidak dibacanya).
-- JALUR DATABASE_MIGRATION_URL: migrate-pg membuat tabel TETAPI tanpa GRANT -> berkas ini TETAP WAJIB (idempoten) dan VERIFIKASI-nya
--   diperiksa: semua `ok` true.
-- KUNCI: tabel baru saja — tidak mengunci tabel lama (jks_master tidak diubah bentuknya).
--
-- ISI (nama tabel TANPA skema = public pada search_path bawaan; agar uji PG bisa memakai skema sekali-pakai):
--   1. CREATE TABLE IF NOT EXISTS kunjungan_luar_rute (PK id; UNIQUE (sales_code, cust_code, principle, tanggal) WHERE belum batal = satu
--      toko luar rute AKTIF per hari; CHECK konfirmasi menunggu/jks/tidak/sudah_jks, isi + format tanggal, hari Senin–Sabtu + pola
--      ganjil/genap/all, konfirmasi 'jks' WAJIB membawa jks_id + hari + pola + waktu konfirmasi, dan batal lunak (dibatalkan_pada/oleh
--      berpasangan, baris 'jks' tidak bisa batal)). Indeks jks_id (jejak baris JKS di Kontrol JKS). TANPA trigger, TANPA data.
--      Bentuk ini menggantikan draf 12 Okt (tanpa kolom batal) yang TIDAK pernah dijalankan di produksi.
--   2. accapi_app: GRANT SELECT/INSERT/UPDATE; REVOKE DELETE/TRUNCATE (baris ini = JEJAK asal baris JKS; aplikasi tidak pernah menghapus —
--      "Batalkan" kunjungan salah tambah = UPDATE dibatalkan_pada/oleh, butuh UPDATE saja).
--      Role absen = dilewati.
--   3. VERIFIKASI (baca-saja) — semua `ok` harus true (NULL = role accapi_app tidak ada, tidak relevan). Juga prasyarat jalur yang dipakai:
--      accapi_app boleh SELECT/INSERT/UPDATE jks_master (konfirmasi menulis baris JKS; unggah menonaktifkan baris tambahan salesman yang
--      digantikan), SELECT customer/branch/accurate_employee/sales_profile (cakupan cabang salesman), INSERT kontrol_audit_log.
-- Menjalankan ulang seluruh berkas = tanpa perubahan.
--
-- SESUDAH IMAGE (baca-saja, opsional): sebelum pilot dipakai, periksa nama cabang Accurate salesman TANPA JKS (mis. M-RIV) = principal JKS
--   cabangnya (principal tanpa JKS diambil dari nama cabang karyawan Accurate):
--     SELECT sp.sales_code, b.name AS cabang FROM sales_profile sp JOIN accurate_employee e ON upper(trim(e.number)) = upper(trim(sp.sales_code))
--       LEFT JOIN branch b ON b.id = e.branch_id WHERE sp.accurate_linked;
--     SELECT DISTINCT principle FROM jks_master WHERE is_active;
--   Nama berbeda (mis. cabang "MSM " vs principal "MSM") = baris JKS hasil konfirmasi salesman tanpa JKS memakai principal yang berbeda dari
--   tim — laporkan ke orkestrator sebelum salesman itu memakai fitur ini.
--
-- CARA UJI DI DB SINTETIS (BUKAN produksi; contoh container accapi-am040-pg):
--   AM040_DATABASE_URL=<url> npx tsx --test lib/form-kontrol/fk-msm2-pg.test.ts
--
-- ROLLBACK DARURAT: image lama tetap jalan dengan tabel ini (tanpa pembaca). Tabel boleh dibiarkan (aditif); JANGAN DROP tanpa alasan
--   tercatat (memuat jejak asal baris JKS tambahan salesman).

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- 1. Tabel (sama dengan entri migrate-pg "kunjungan_luar_rute (FK-MSM2)" dan db/migrations/0034_kunjungan_luar_rute.sql).
CREATE TABLE IF NOT EXISTS kunjungan_luar_rute (
    id                     text PRIMARY KEY,
    sales_code             text NOT NULL,
    principle              text NOT NULL,
    tanggal                text NOT NULL,
    cust_code              text NOT NULL,
    cust_name              text NOT NULL,
    alamat                 text,
    customer_id            bigint,
    dibuat_oleh            text NOT NULL,
    dibuat_oleh_nama       text,
    dibuat_pada            timestamptz NOT NULL DEFAULT now(),
    konfirmasi             text NOT NULL DEFAULT 'menunggu',
    hari                   text,
    minggu_pattern         text,
    jks_id                 text,
    dikonfirmasi_oleh      text,
    dikonfirmasi_oleh_nama text,
    dikonfirmasi_pada      timestamptz,
    dibatalkan_pada        timestamptz,
    dibatalkan_oleh        text,
    CONSTRAINT kunjungan_luar_rute_konfirmasi CHECK (konfirmasi IN ('menunggu', 'jks', 'tidak', 'sudah_jks')),
    CONSTRAINT kunjungan_luar_rute_isi CHECK (btrim(sales_code) <> '' AND btrim(principle) <> '' AND btrim(cust_code) <> ''
        AND tanggal ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
    CONSTRAINT kunjungan_luar_rute_jadwal CHECK ((hari IS NULL OR hari IN ('Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'))
        AND (minggu_pattern IS NULL OR minggu_pattern IN ('ganjil', 'genap', 'all'))),
    CONSTRAINT kunjungan_luar_rute_jks CHECK (konfirmasi <> 'jks' OR (jks_id IS NOT NULL AND hari IS NOT NULL
        AND minggu_pattern IS NOT NULL AND dikonfirmasi_pada IS NOT NULL)),
    CONSTRAINT kunjungan_luar_rute_batal CHECK ((dibatalkan_pada IS NULL) = (dibatalkan_oleh IS NULL)
        AND (dibatalkan_pada IS NULL OR konfirmasi <> 'jks'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_klr_unik ON kunjungan_luar_rute (sales_code, cust_code, principle, tanggal) WHERE dibatalkan_pada IS NULL;
CREATE INDEX IF NOT EXISTS idx_klr_jks ON kunjungan_luar_rute (jks_id);

-- 2. Hak role aplikasi. Default privileges (L1g) bisa saja sudah memberi DML penuh -> REVOKE eksplisit DELETE/TRUNCATE.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'accapi_app') THEN
        REVOKE DELETE, TRUNCATE ON kunjungan_luar_rute FROM accapi_app;
        GRANT SELECT, INSERT, UPDATE ON kunjungan_luar_rute TO accapi_app;
    END IF;
END $$;

COMMIT;

-- 3. VERIFIKASI (baca-saja).
SELECT cek, ok FROM (VALUES
    ('tabel kunjungan_luar_rute', to_regclass('kunjungan_luar_rute') IS NOT NULL),
    ('PK (id)', EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'kunjungan_luar_rute_pkey'
        AND conrelid = to_regclass('kunjungan_luar_rute') AND contype = 'p')),
    ('UNIQUE idx_klr_unik (sales_code, cust_code, principle, tanggal) WHERE belum batal', EXISTS (SELECT 1 FROM pg_index i
        WHERE i.indrelid = to_regclass('kunjungan_luar_rute') AND i.indexrelid = to_regclass('idx_klr_unik') AND i.indisunique
          AND pg_get_indexdef(i.indexrelid) LIKE '% USING btree (sales_code, cust_code, principle, tanggal) WHERE (dibatalkan_pada IS NULL)')),
    ('indeks idx_klr_jks (jks_id)', EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = to_regclass('kunjungan_luar_rute')
        AND i.indexrelid = to_regclass('idx_klr_jks') AND pg_get_indexdef(i.indexrelid) LIKE '% USING btree (jks_id)')),
    -- Definisi PERSIS (pg_get_constraintdef, bentuk PG 16): CHECK bernama sama tetapi dilemahkan (mis. CHECK (true)) = false.
    ('CHECK konfirmasi/isi/jadwal/jks/batal (5) — definisi persis', (SELECT count(*) = 5 FROM pg_constraint c JOIN (VALUES
        ('kunjungan_luar_rute_konfirmasi', $d$CHECK ((konfirmasi = ANY (ARRAY['menunggu'::text, 'jks'::text, 'tidak'::text, 'sudah_jks'::text])))$d$),
        ('kunjungan_luar_rute_isi', $d$CHECK (((btrim(sales_code) <> ''::text) AND (btrim(principle) <> ''::text) AND (btrim(cust_code) <> ''::text) AND (tanggal ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'::text)))$d$),
        ('kunjungan_luar_rute_jadwal', $d$CHECK ((((hari IS NULL) OR (hari = ANY (ARRAY['Senin'::text, 'Selasa'::text, 'Rabu'::text, 'Kamis'::text, 'Jumat'::text, 'Sabtu'::text]))) AND ((minggu_pattern IS NULL) OR (minggu_pattern = ANY (ARRAY['ganjil'::text, 'genap'::text, 'all'::text])))))$d$),
        ('kunjungan_luar_rute_jks', $d$CHECK (((konfirmasi <> 'jks'::text) OR ((jks_id IS NOT NULL) AND (hari IS NOT NULL) AND (minggu_pattern IS NOT NULL) AND (dikonfirmasi_pada IS NOT NULL))))$d$),
        ('kunjungan_luar_rute_batal', $d$CHECK ((((dibatalkan_pada IS NULL) = (dibatalkan_oleh IS NULL)) AND ((dibatalkan_pada IS NULL) OR (konfirmasi <> 'jks'::text))))$d$)
    ) AS e(nama, def) ON c.conname = e.nama AND pg_get_constraintdef(c.oid) = e.def
        WHERE c.conrelid = to_regclass('kunjungan_luar_rute') AND c.contype = 'c')),
    ('accapi_app boleh SELECT/INSERT/UPDATE kunjungan_luar_rute', CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'accapi_app')
        THEN (SELECT bool_and(has_table_privilege('accapi_app', 'kunjungan_luar_rute', p)) FROM unnest(ARRAY['SELECT', 'INSERT', 'UPDATE']) AS p) END),
    ('accapi_app tanpa DELETE/TRUNCATE kunjungan_luar_rute (jejak)', CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'accapi_app')
        THEN NOT (SELECT bool_or(has_table_privilege('accapi_app', 'kunjungan_luar_rute', p)) FROM unnest(ARRAY['DELETE', 'TRUNCATE']) AS p) END),
    ('prasyarat: accapi_app boleh SELECT/INSERT/UPDATE jks_master (konfirmasi + unggah)', CASE
        WHEN to_regclass('jks_master') IS NULL THEN false
        WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'accapi_app')
        THEN (SELECT bool_and(has_table_privilege('accapi_app', 'jks_master', p)) FROM unnest(ARRAY['SELECT', 'INSERT', 'UPDATE']) AS p) END),
    ('prasyarat: accapi_app boleh SELECT customer/branch/accurate_employee/sales_profile (cakupan cabang)', CASE
        WHEN to_regclass('customer') IS NULL OR to_regclass('branch') IS NULL OR to_regclass('accurate_employee') IS NULL
            OR to_regclass('sales_profile') IS NULL THEN false
        WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'accapi_app')
        THEN (SELECT bool_and(has_table_privilege('accapi_app', t, 'SELECT'))
              FROM unnest(ARRAY['customer', 'branch', 'accurate_employee', 'sales_profile']) AS t) END),
    ('prasyarat: accapi_app boleh INSERT kontrol_audit_log (jejak tambah/konfirmasi)', CASE
        WHEN to_regclass('kontrol_audit_log') IS NULL THEN false
        WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'accapi_app')
        THEN has_table_privilege('accapi_app', 'kontrol_audit_log', 'INSERT') END)
) AS v(cek, ok);
