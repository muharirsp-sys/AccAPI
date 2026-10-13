-- DDL MANUAL NOO — toko baru (New Open Outlet) dari kunjungan salesman (owner 13 Okt 2026; brief scratch/fiori-redesign/briefs/NOO-brief-toko-baru.md).
-- Rujukan: db/schema.ts (nooToko), scripts/migrate-pg.mjs (entri "noo_toko (NOO)" = SQL sama dengan blok 1), db/migrations/0035_noo_toko.sql,
-- lib/form-kontrol/noo.ts, app/api/form-kontrol/noo/**, lib/form-kontrol/noo-pg.test.ts.
--
-- SIAPA & KAPAN (pola DDL_FK_MSM2, owner 9 Okt "DDL manual = Claude tulis, IT Support jalankan"): IT Support, SAAT DEPLOY NOO, sebagai role
-- PEMILIK (accapi, bukan accapi_app), SESUDAH docs/handover/DDL_FK_MSM2.sql, dan SEBELUM image baru. JANGAN dijalankan loop/agen ke produksi.
--
--   docker exec -i accapi-postgres psql -U accapi -d accapi -v ON_ERROR_STOP=1 < docs/handover/DDL_NOO.sql
--
-- Lalu kunci izin ke grup: docs/handover/RBAC_PRESET_NOO.sql (SESUDAH image — kunci baru harus sudah ada di registry aplikasi).
--
-- KENAPA SEBELUM: migrate-pg (container start) tanpa DATABASE_MIGRATION_URL berjalan sebagai accapi_app yang tak punya CREATE -> CREATE TABLE
--   gagal -> container crash loop. Sesudah berkas ini entri migrate-pg di-SKIP (sudahAda via pg_indexes + pg_attribute). Image LAMA tidak
--   terganggu (tabel baru tidak dibacanya).
-- JALUR DATABASE_MIGRATION_URL: migrate-pg membuat tabel TETAPI tanpa GRANT -> berkas ini TETAP WAJIB (idempoten) dan VERIFIKASI-nya
--   diperiksa: semua `ok` true.
-- KUNCI: tabel baru saja — tidak mengunci tabel lama (kunjungan_luar_rute tidak diubah bentuknya; kunjungan NOO = baris biasanya).
--
-- DATA PRIBADI: kolom nik + foto_ktp (nama berkas; berkasnya di volume /app/data/private/noo/, BUKAN public/ dan BUKAN data/uploads/). Metabase
--   TIDAK diberi tabel ini (db/metabase_readonly.sql = whitelist eksplisit; JANGAN ditambahkan). Retensi = TERBUKA (owner); belum ada hapus
--   otomatis.
--
-- ISI (nama tabel TANPA skema = public pada search_path bawaan; agar uji PG bisa memakai skema sekali-pakai):
--   1. CREATE TABLE IF NOT EXISTS noo_toko (PK id; UNIQUE kode; UNIQUE customer_id WHERE NOT NULL = satu pelanggan satu NOO; 7 CHECK: status,
--      isi + format kode/tanggal, data pribadi (NIK 16 digit, HP 08…, nama berkas acak), GPS, duplikat (pengajuan "pemilik sama" + konfirmasi
--      wajib sebelum disetujui), keputusan (siapa/kapan + alasan tolak), tautan (terdaftar = pelanggan + siapa/kapan)). Indeks antrean, NIK &
--      HP (cek ganda, tanpa yang ditolak). TANPA trigger, TANPA data.
--   2. accapi_app: GRANT SELECT/INSERT/UPDATE; REVOKE DELETE/TRUNCATE (jejak pengajuan + keputusan; aplikasi tidak pernah menghapus).
--      Role absen = dilewati.
--   3. VERIFIKASI (baca-saja) — semua `ok` harus true (NULL = role accapi_app tidak ada, tidak relevan). Juga prasyarat jalur NOO: accapi_app
--      boleh SELECT/INSERT kunjungan_luar_rute (kunjungan NOO), INSERT kontrol_audit_log (jejak + "lihat KTP"), SELECT customer/branch/
--      accurate_employee/sales_profile/jks_master (cakupan cabang + principal + penautan).
-- Menjalankan ulang seluruh berkas = tanpa perubahan.
--
-- CARA UJI DI DB SINTETIS (BUKAN produksi; contoh container accapi-am040-pg):
--   AM040_DATABASE_URL=<url> npx tsx --test lib/form-kontrol/noo-pg.test.ts
--
-- ROLLBACK DARURAT: image lama tetap jalan dengan tabel ini (tanpa pembaca). Tabel boleh dibiarkan (aditif); JANGAN DROP tanpa keputusan
--   owner tercatat (memuat data pribadi + jejak keputusan; berkas foto di volume tidak ikut terhapus oleh DROP).

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- 1. Tabel (sama dengan entri migrate-pg "noo_toko (NOO)" dan db/migrations/0035_noo_toko.sql).
CREATE TABLE IF NOT EXISTS noo_toko (
    id                    text PRIMARY KEY,
    kode                  text NOT NULL,
    sales_code            text NOT NULL,
    principle             text NOT NULL,
    branch_id             bigint NOT NULL,
    branch_name           text,
    tanggal               text NOT NULL,
    nama_toko             text NOT NULL,
    nama_pemilik          text NOT NULL,
    alamat                text NOT NULL,
    no_hp                 text NOT NULL,
    nik                   text NOT NULL,
    nama_ktp              text NOT NULL,
    foto_ktp              text NOT NULL,
    foto_toko             text NOT NULL,
    lat                   double precision NOT NULL,
    lng                   double precision NOT NULL,
    akurasi               double precision NOT NULL,
    gps_flag              text,
    status                text NOT NULL DEFAULT 'menunggu_spv',
    duplikat_dengan       text,
    alasan_duplikat       text,
    duplikat_dikonfirmasi boolean NOT NULL DEFAULT false,
    dibuat_oleh           text NOT NULL,
    dibuat_oleh_nama      text,
    dibuat_pada           timestamptz NOT NULL DEFAULT now(),
    diputuskan_oleh       text,
    diputuskan_oleh_nama  text,
    diputuskan_pada       timestamptz,
    alasan_tolak          text,
    customer_id           bigint,
    customer_no           text,
    ditautkan_oleh        text,
    ditautkan_oleh_nama   text,
    ditautkan_pada        timestamptz,
    CONSTRAINT noo_toko_status CHECK (status IN ('menunggu_spv', 'disetujui', 'ditolak', 'terdaftar')),
    CONSTRAINT noo_toko_isi CHECK (kode ~ '^NOO-[0-9A-Z]{8}$' AND btrim(sales_code) <> '' AND btrim(principle) <> ''
        AND tanggal ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' AND btrim(nama_toko) <> '' AND btrim(nama_pemilik) <> '' AND btrim(alamat) <> ''
        AND btrim(nama_ktp) <> ''),
    CONSTRAINT noo_toko_pribadi CHECK (nik ~ '^[0-9]{16}$' AND no_hp ~ '^08[1-9][0-9]{7,10}$'
        AND foto_ktp ~ '^[0-9a-f-]{36}[.]jpg$' AND foto_toko ~ '^[0-9a-f-]{36}[.]jpg$' AND foto_ktp <> foto_toko),
    CONSTRAINT noo_toko_gps CHECK (lat BETWEEN -90 AND 90 AND lng BETWEEN -180 AND 180 AND akurasi >= 0),
    CONSTRAINT noo_toko_duplikat CHECK ((duplikat_dengan IS NULL) = (alasan_duplikat IS NULL)
        AND (alasan_duplikat IS NULL OR btrim(alasan_duplikat) <> '')
        AND (NOT duplikat_dikonfirmasi OR duplikat_dengan IS NOT NULL)
        AND (duplikat_dengan IS NULL OR status IN ('menunggu_spv', 'ditolak') OR duplikat_dikonfirmasi)),
    CONSTRAINT noo_toko_keputusan CHECK ((status = 'menunggu_spv') = (diputuskan_pada IS NULL)
        AND (diputuskan_pada IS NULL) = (diputuskan_oleh IS NULL)
        AND (status = 'ditolak') = (alasan_tolak IS NOT NULL)
        AND (alasan_tolak IS NULL OR btrim(alasan_tolak) <> '')),
    CONSTRAINT noo_toko_tautan CHECK ((status = 'terdaftar') = (customer_id IS NOT NULL)
        AND (customer_id IS NULL) = (customer_no IS NULL)
        AND (customer_id IS NULL) = (ditautkan_pada IS NULL)
        AND (ditautkan_pada IS NULL) = (ditautkan_oleh IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_noo_kode ON noo_toko (kode);
CREATE UNIQUE INDEX IF NOT EXISTS idx_noo_customer ON noo_toko (customer_id) WHERE customer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_noo_sales ON noo_toko (sales_code, status);
CREATE INDEX IF NOT EXISTS idx_noo_antrean ON noo_toko (status, branch_id);
CREATE INDEX IF NOT EXISTS idx_noo_nik ON noo_toko (nik) WHERE status <> 'ditolak';
CREATE INDEX IF NOT EXISTS idx_noo_hp ON noo_toko (no_hp) WHERE status <> 'ditolak';

-- 2. Hak role aplikasi. Default privileges (L1g) bisa saja sudah memberi DML penuh -> REVOKE eksplisit DELETE/TRUNCATE.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'accapi_app') THEN
        REVOKE DELETE, TRUNCATE ON noo_toko FROM accapi_app;
        GRANT SELECT, INSERT, UPDATE ON noo_toko TO accapi_app;
    END IF;
END $$;

COMMIT;

-- 3. VERIFIKASI (baca-saja).
SELECT cek, ok FROM (VALUES
    ('tabel noo_toko', to_regclass('noo_toko') IS NOT NULL),
    ('PK (id)', EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'noo_toko_pkey' AND conrelid = to_regclass('noo_toko') AND contype = 'p')),
    ('UNIQUE idx_noo_kode (kode)', EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = to_regclass('noo_toko')
        AND i.indexrelid = to_regclass('idx_noo_kode') AND i.indisunique AND pg_get_indexdef(i.indexrelid) LIKE '% USING btree (kode)')),
    ('UNIQUE idx_noo_customer (customer_id) WHERE terisi', EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = to_regclass('noo_toko')
        AND i.indexrelid = to_regclass('idx_noo_customer') AND i.indisunique
        AND pg_get_indexdef(i.indexrelid) LIKE '% USING btree (customer_id) WHERE (customer_id IS NOT NULL)')),
    ('indeks idx_noo_sales/antrean/nik/hp', (SELECT count(*) = 4 FROM pg_index i WHERE i.indrelid = to_regclass('noo_toko') AND (
        (i.indexrelid = to_regclass('idx_noo_sales') AND pg_get_indexdef(i.indexrelid) LIKE '% USING btree (sales_code, status)')
        OR (i.indexrelid = to_regclass('idx_noo_antrean') AND pg_get_indexdef(i.indexrelid) LIKE '% USING btree (status, branch_id)')
        OR (i.indexrelid = to_regclass('idx_noo_nik') AND pg_get_indexdef(i.indexrelid) LIKE '% USING btree (nik) WHERE (status <> ''ditolak''::text)')
        OR (i.indexrelid = to_regclass('idx_noo_hp') AND pg_get_indexdef(i.indexrelid) LIKE '% USING btree (no_hp) WHERE (status <> ''ditolak''::text)')))),
    -- Definisi PERSIS (pg_get_constraintdef, bentuk PG 16): CHECK bernama sama tetapi dilemahkan (mis. CHECK (true)) = false.
    ('CHECK status/isi/pribadi/gps/duplikat/keputusan/tautan (7) — definisi persis', (SELECT count(*) = 7 FROM pg_constraint c JOIN (VALUES
        ('noo_toko_status', $d$CHECK ((status = ANY (ARRAY['menunggu_spv'::text, 'disetujui'::text, 'ditolak'::text, 'terdaftar'::text])))$d$),
        ('noo_toko_isi', $d$CHECK (((kode ~ '^NOO-[0-9A-Z]{8}$'::text) AND (btrim(sales_code) <> ''::text) AND (btrim(principle) <> ''::text) AND (tanggal ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'::text) AND (btrim(nama_toko) <> ''::text) AND (btrim(nama_pemilik) <> ''::text) AND (btrim(alamat) <> ''::text) AND (btrim(nama_ktp) <> ''::text)))$d$),
        ('noo_toko_pribadi', $d$CHECK (((nik ~ '^[0-9]{16}$'::text) AND (no_hp ~ '^08[1-9][0-9]{7,10}$'::text) AND (foto_ktp ~ '^[0-9a-f-]{36}[.]jpg$'::text) AND (foto_toko ~ '^[0-9a-f-]{36}[.]jpg$'::text) AND (foto_ktp <> foto_toko)))$d$),
        ('noo_toko_gps', $d$CHECK ((((lat >= ('-90'::integer)::double precision) AND (lat <= (90)::double precision)) AND ((lng >= ('-180'::integer)::double precision) AND (lng <= (180)::double precision)) AND (akurasi >= (0)::double precision)))$d$),
        ('noo_toko_duplikat', $d$CHECK ((((duplikat_dengan IS NULL) = (alasan_duplikat IS NULL)) AND ((alasan_duplikat IS NULL) OR (btrim(alasan_duplikat) <> ''::text)) AND ((NOT duplikat_dikonfirmasi) OR (duplikat_dengan IS NOT NULL)) AND ((duplikat_dengan IS NULL) OR (status = ANY (ARRAY['menunggu_spv'::text, 'ditolak'::text])) OR duplikat_dikonfirmasi)))$d$),
        ('noo_toko_keputusan', $d$CHECK ((((status = 'menunggu_spv'::text) = (diputuskan_pada IS NULL)) AND ((diputuskan_pada IS NULL) = (diputuskan_oleh IS NULL)) AND ((status = 'ditolak'::text) = (alasan_tolak IS NOT NULL)) AND ((alasan_tolak IS NULL) OR (btrim(alasan_tolak) <> ''::text))))$d$),
        ('noo_toko_tautan', $d$CHECK ((((status = 'terdaftar'::text) = (customer_id IS NOT NULL)) AND ((customer_id IS NULL) = (customer_no IS NULL)) AND ((customer_id IS NULL) = (ditautkan_pada IS NULL)) AND ((ditautkan_pada IS NULL) = (ditautkan_oleh IS NULL))))$d$)
    ) AS e(nama, def) ON c.conname = e.nama AND pg_get_constraintdef(c.oid) = e.def
        WHERE c.conrelid = to_regclass('noo_toko') AND c.contype = 'c')),
    ('accapi_app boleh SELECT/INSERT/UPDATE noo_toko', CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'accapi_app')
        THEN (SELECT bool_and(has_table_privilege('accapi_app', 'noo_toko', p)) FROM unnest(ARRAY['SELECT', 'INSERT', 'UPDATE']) AS p) END),
    ('accapi_app tanpa DELETE/TRUNCATE noo_toko (jejak)', CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'accapi_app')
        THEN NOT (SELECT bool_or(has_table_privilege('accapi_app', 'noo_toko', p)) FROM unnest(ARRAY['DELETE', 'TRUNCATE']) AS p) END),
    ('prasyarat: accapi_app boleh SELECT/INSERT kunjungan_luar_rute (kunjungan NOO)', CASE
        WHEN to_regclass('kunjungan_luar_rute') IS NULL THEN false
        WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'accapi_app')
        THEN (SELECT bool_and(has_table_privilege('accapi_app', 'kunjungan_luar_rute', p)) FROM unnest(ARRAY['SELECT', 'INSERT']) AS p) END),
    ('prasyarat: accapi_app boleh SELECT customer/branch/accurate_employee/sales_profile/jks_master', CASE
        WHEN to_regclass('customer') IS NULL OR to_regclass('branch') IS NULL OR to_regclass('accurate_employee') IS NULL
            OR to_regclass('sales_profile') IS NULL OR to_regclass('jks_master') IS NULL THEN false
        WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'accapi_app')
        THEN (SELECT bool_and(has_table_privilege('accapi_app', t, 'SELECT'))
              FROM unnest(ARRAY['customer', 'branch', 'accurate_employee', 'sales_profile', 'jks_master']) AS t) END),
    ('prasyarat: accapi_app boleh INSERT kontrol_audit_log (jejak + lihat KTP)', CASE
        WHEN to_regclass('kontrol_audit_log') IS NULL THEN false
        WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'accapi_app')
        THEN has_table_privilege('accapi_app', 'kontrol_audit_log', 'INSERT') END)
) AS v(cek, ok);
