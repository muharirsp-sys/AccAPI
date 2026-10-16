-- DDL MANUAL Supervisor Review — ringkasan harian per salesman (owner 16 Okt 2026; spec docs/superpowers/specs/2026-10-16-supervisor-review-design.md §3.1).
-- Rujukan: db/schema.ts (salesInvoiceCache, salesProfile, tokoKoordinat), scripts/migrate-pg.mjs (entri "supervisor review (SR-1)" = SQL sama
-- dengan db/migrations/0036_supervisor_review.sql; blok 1 di bawah = bentuk yang sama, tanpa IF EXISTS), lib/sync.ts (upsertPage sales_invoice),
-- lib/supervisor-review/**, scripts/backfill-ringkas-faktur.mjs, lib/supervisor-review/supervisor-review-pg.test.ts.
--
-- SIAPA & KAPAN (pola DDL_K2A/DDL_NOO, owner 9 Okt "DDL manual = Claude tulis, IT Support jalankan"): IT Support, SAAT DEPLOY SR-1, sebagai role
-- PEMILIK tabel (accapi, bukan accapi_app), SESUDAH cadangan DB, dan SEBELUM image baru. JANGAN dijalankan loop/agen ke produksi.
--
--   docker exec -i accapi-postgres psql -U accapi -d accapi -v ON_ERROR_STOP=1 < docs/handover/DDL_SUPERVISOR_REVIEW.sql
--
-- Sesudah image: scripts/backfill-ringkas-faktur.mjs (60 hari, luar jam sibuk), lalu docs/handover/RBAC_PRESET_SUPERVISOR_REVIEW.sql.
--
-- KENAPA SEBELUM: migrate-pg (container start) tanpa DATABASE_MIGRATION_URL berjalan sebagai accapi_app (bukan pemilik) -> ALTER/CREATE ditolak
--   -> container crash loop. Sesudah berkas ini entri migrate-pg di-SKIP (sudahAda lewat katalog pg_attribute + pg_constraint, tanpa hak tabel).
--   Image BARU membaca kolom ini (Drizzle memilih semua kolom sales_profile/sales_invoice) -> DDL WAJIB lebih dulu.
--   Image LAMA tidak terganggu: semua perubahan EXPAND (kolom nullable tanpa default, CHECK hanya membatasi no_hp yang belum ditulis siapa pun,
--   tabel baru tanpa pembaca lama).
-- JALUR DATABASE_MIGRATION_URL: migrate-pg membuat kolom + tabel TETAPI tanpa GRANT -> berkas ini TETAP WAJIB (idempoten) dan VERIFIKASI-nya
--   diperiksa: semua `ok` true.
-- KUNCI: ALTER sales_invoice (±2,3 GB) = satu pernyataan, kolom nullable TANPA default -> hanya katalog (tidak menulis ulang tabel), tetapi
--   butuh ACCESS EXCLUSIVE sesaat. lock_timeout 5 dtk: bila tertahan kueri panjang / webhook, berkas gagal + ROLLBACK seluruhnya -> jalankan
--   ulang di luar jam sibuk (tidak ada yang setengah jadi). CHECK sales_profile memindai sales_profile (kecil).
--
-- ISI (nama tabel TANPA skema = public pada search_path bawaan; agar uji PG bisa memakai skema sekali-pakai):
--   1. sales_invoice + salesman_id bigint, qty_total numeric, jumlah_item integer, dpp numeric(18,2) — nullable, tanpa default; NULL = rincian
--      faktur (detailItem) belum terbaca. Diisi lib/sync.ts saat upsert + backfill.
--      sales_profile + no_hp text, CHECK sales_profile_no_hp (bentuk kanonik 08…, sama dengan noo_toko_pribadi; NULL boleh).
--      toko_koordinat (cust_code PK = kode JKS, lat/lng double precision, diperbarui_pada/oleh), CHECK toko_koordinat_wilayah (Indonesia).
--   2. accapi_app: GRANT SELECT/INSERT/UPDATE toko_koordinat; REVOKE DELETE/TRUNCATE (unggah = upsert; tidak ada hapus). Role absen = dilewati.
--      Kolom baru sales_invoice/sales_profile tercakup hak tingkat tabel yang sudah ada (diperiksa VERIFIKASI).
--   3. VERIFIKASI (baca-saja) — semua `ok` harus true (NULL = role accapi_app tidak ada, tidak relevan). Baris "definisi persis" false =
--      CHECK diubah/dilemahkan.
-- Menjalankan ulang seluruh berkas = tanpa perubahan.
--
-- CARA UJI DI DB SINTETIS (BUKAN produksi; contoh container accapi-am040-pg):
--   AM040_DATABASE_URL=<url> npx tsx --test lib/supervisor-review/supervisor-review-pg.test.ts
--
-- ROLLBACK DARURAT: image lama tetap jalan dengan kolom/tabel ini. Biarkan (aditif). JANGAN DROP toko_koordinat tanpa keputusan owner
--   (unggahan Admin); kolom ringkas sales_invoice boleh diisi ulang kapan saja dengan backfill.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- 1. Kolom + tabel + CHECK (sama dengan entri migrate-pg "supervisor review (SR-1)" dan db/migrations/0036_supervisor_review.sql).
ALTER TABLE sales_invoice ADD COLUMN IF NOT EXISTS salesman_id bigint, ADD COLUMN IF NOT EXISTS qty_total numeric,
    ADD COLUMN IF NOT EXISTS jumlah_item integer, ADD COLUMN IF NOT EXISTS dpp numeric(18,2);
ALTER TABLE sales_profile ADD COLUMN IF NOT EXISTS no_hp text;
DO $sr1$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'sales_profile'::regclass AND conname = 'sales_profile_no_hp') THEN
    ALTER TABLE sales_profile ADD CONSTRAINT sales_profile_no_hp CHECK (no_hp ~ '^08[1-9][0-9]{7,10}$');
  END IF;
END $sr1$;
CREATE TABLE IF NOT EXISTS toko_koordinat (
    cust_code       text PRIMARY KEY,
    lat             double precision NOT NULL,
    lng             double precision NOT NULL,
    diperbarui_pada timestamptz NOT NULL DEFAULT now(),
    diperbarui_oleh text NOT NULL,
    CONSTRAINT toko_koordinat_wilayah CHECK (lat BETWEEN -11 AND 6 AND lng BETWEEN 95 AND 141)
);

-- 2. Hak role aplikasi. Default privileges (L1g) bisa saja sudah memberi DML penuh -> REVOKE eksplisit DELETE/TRUNCATE.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'accapi_app') THEN
        REVOKE DELETE, TRUNCATE ON toko_koordinat FROM accapi_app;
        GRANT SELECT, INSERT, UPDATE ON toko_koordinat TO accapi_app;
    END IF;
END $$;

COMMIT;

-- 3. VERIFIKASI (baca-saja).
SELECT cek, ok FROM (VALUES
    ('sales_invoice: salesman_id bigint, qty_total numeric, jumlah_item integer, dpp numeric(18,2) — nullable, tanpa default', (SELECT count(*) = 4
        FROM pg_attribute a JOIN (VALUES ('salesman_id', 'bigint'), ('qty_total', 'numeric'), ('jumlah_item', 'integer'), ('dpp', 'numeric(18,2)'))
            AS e(kol, tipe) ON a.attname = e.kol AND format_type(a.atttypid, a.atttypmod) = e.tipe
        WHERE a.attrelid = to_regclass('sales_invoice') AND NOT a.attisdropped AND NOT a.attnotnull AND NOT a.atthasdef)),
    ('sales_profile: no_hp text nullable', EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass('sales_profile') AND attname = 'no_hp'
        AND NOT attisdropped AND NOT attnotnull AND atttypid = 'text'::regtype)),
    ('toko_koordinat: PK (cust_code) + lat/lng/diperbarui_pada/oleh NOT NULL', (SELECT count(*) = 5 FROM pg_attribute a JOIN (VALUES
        ('cust_code', 'text'), ('lat', 'double precision'), ('lng', 'double precision'), ('diperbarui_pada', 'timestamp with time zone'),
        ('diperbarui_oleh', 'text')) AS e(kol, tipe) ON a.attname = e.kol AND format_type(a.atttypid, a.atttypmod) = e.tipe
        WHERE a.attrelid = to_regclass('toko_koordinat') AND NOT a.attisdropped AND a.attnotnull)
        AND EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass('toko_koordinat') AND contype = 'p'
            AND pg_get_constraintdef(oid) = 'PRIMARY KEY (cust_code)')),
    -- Definisi PERSIS (pg_get_constraintdef, bentuk PG 16): CHECK bernama sama tetapi dilemahkan (mis. CHECK (true)) = false.
    ('CHECK sales_profile_no_hp + toko_koordinat_wilayah (2) — definisi persis', (SELECT count(*) = 2 FROM pg_constraint c JOIN (VALUES
        ('sales_profile_no_hp', 'sales_profile', $d$CHECK ((no_hp ~ '^08[1-9][0-9]{7,10}$'::text))$d$),
        ('toko_koordinat_wilayah', 'toko_koordinat', $d$CHECK ((((lat >= ('-11'::integer)::double precision) AND (lat <= (6)::double precision)) AND ((lng >= (95)::double precision) AND (lng <= (141)::double precision))))$d$)
    ) AS e(nama, tabel, def) ON c.conname = e.nama AND c.conrelid = to_regclass(e.tabel) AND c.contype = 'c' AND pg_get_constraintdef(c.oid) = e.def)),
    ('accapi_app boleh SELECT/INSERT/UPDATE toko_koordinat', CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'accapi_app')
        THEN (SELECT bool_and(has_table_privilege('accapi_app', 'toko_koordinat', p)) FROM unnest(ARRAY['SELECT', 'INSERT', 'UPDATE']) AS p) END),
    ('accapi_app tanpa DELETE/TRUNCATE toko_koordinat', CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'accapi_app')
        THEN NOT (SELECT bool_or(has_table_privilege('accapi_app', 'toko_koordinat', p)) FROM unnest(ARRAY['DELETE', 'TRUNCATE']) AS p) END),
    ('prasyarat: accapi_app boleh SELECT/INSERT/UPDATE 4 kolom ringkas sales_invoice (sinkron) + SELECT/UPDATE sales_profile.no_hp', CASE
        WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'accapi_app')
        THEN (SELECT bool_and(has_column_privilege('accapi_app', 'sales_invoice', c, p))
              FROM unnest(ARRAY['salesman_id', 'qty_total', 'jumlah_item', 'dpp']) AS c, unnest(ARRAY['SELECT', 'INSERT', 'UPDATE']) AS p)
          AND (SELECT bool_and(has_column_privilege('accapi_app', 'sales_profile', 'no_hp', p)) FROM unnest(ARRAY['SELECT', 'UPDATE']) AS p) END),
    ('prasyarat: accapi_app boleh SELECT jks_master/ao_control_daily/kunjungan_luar_rute/noo_toko/customer/branch/accurate_employee/sales_code_merge', CASE
        WHEN to_regclass('jks_master') IS NULL OR to_regclass('ao_control_daily') IS NULL OR to_regclass('kunjungan_luar_rute') IS NULL
            OR to_regclass('noo_toko') IS NULL OR to_regclass('customer') IS NULL OR to_regclass('branch') IS NULL
            OR to_regclass('accurate_employee') IS NULL OR to_regclass('sales_code_merge') IS NULL THEN false
        WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'accapi_app')
        THEN (SELECT bool_and(has_table_privilege('accapi_app', t, 'SELECT')) FROM unnest(ARRAY['jks_master', 'ao_control_daily',
            'kunjungan_luar_rute', 'noo_toko', 'customer', 'branch', 'accurate_employee', 'sales_code_merge']) AS t) END)
) AS v(cek, ok);
