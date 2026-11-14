-- DDL MANUAL GPS kunjungan Form Kontrol (owner 14 Nov 2026): titik check-out, status titik toko (radius 20/100 m), pengajuan lokasi ke IT.
-- Rujukan: db/schema.ts (aoControlDaily.checkout*, tokoKoordinat.status, pengajuanLokasi), scripts/migrate-pg.mjs (entri "gps kunjungan" = SQL sama
-- dengan db/migrations/0042_gps_kunjungan.sql), lib/form-kontrol/{gps,radius,lokasi,lokasi-db}.ts, lib/supervisor-review/{ringkasan,kontrol}.ts.
--
-- SIAPA & KAPAN (pola DDL_JKS_ITEM_SUPER): IT Support, SAAT DEPLOY, sebagai role PEMILIK tabel (accapi, bukan accapi_app), SESUDAH cadangan DB
-- dan SEBELUM image baru — hanya bila migrate-pg tidak berjalan (tanpa DATABASE_MIGRATION_URL). JANGAN dijalankan loop/agen ke produksi.
--
--   docker exec -i accapi-postgres psql -U accapi -d accapi -v ON_ERROR_STOP=1 < docs/handover/DDL_GPS_KUNJUNGAN.sql
--
-- KENAPA SEBELUM: image baru membaca/menulis kolom baru ao_control_daily + toko_koordinat dan tabel pengajuan_lokasi (Drizzle memilih semua kolom)
--   -> WAJIB ada sebelum image melayani. Image LAMA tidak terganggu: kolom nullable / ber-default konstanta, tabel baru tanpa pembaca lama.
-- KUNCI: ALTER = katalog saja, tetapi butuh ACCESS EXCLUSIVE sesaat. lock_timeout 5 dtk: bila tertahan, berkas gagal + ROLLBACK -> ulangi di luar
--   jam sibuk. Menjalankan ulang seluruh berkas = tanpa perubahan.
-- DEPLOY DI LUAR JAM KUNJUNGAN: halaman kunjungan versi lama yang masih terbuka di ponsel tidak mengirim GPS check-out -> ditolak sampai halaman
--   dimuat ulang. Minta salesman memuat ulang Form Kontrol sesudah deploy.
--
-- ROLLBACK DARURAT: image lama tetap jalan dengan kolom/tabel ini. Biarkan (aditif).

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

ALTER TABLE IF EXISTS ao_control_daily ADD COLUMN IF NOT EXISTS checkout_lat double precision,
    ADD COLUMN IF NOT EXISTS checkout_lng double precision, ADD COLUMN IF NOT EXISTS checkout_accuracy double precision;
ALTER TABLE IF EXISTS toko_koordinat ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'fix';
DO $tk$ BEGIN
  IF to_regclass('toko_koordinat') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_constraint
      WHERE conrelid = to_regclass('toko_koordinat') AND conname = 'toko_koordinat_status') THEN
    ALTER TABLE toko_koordinat ADD CONSTRAINT toko_koordinat_status CHECK (status IN ('fix', 'validasi'));
  END IF;
END $tk$;
CREATE TABLE IF NOT EXISTS pengajuan_lokasi (
    id               text PRIMARY KEY,
    sales_code       text NOT NULL,
    cust_code        text NOT NULL,
    principle        text NOT NULL,
    tanggal          text NOT NULL,
    tahap            text NOT NULL,
    lat              double precision NOT NULL,
    lng              double precision NOT NULL,
    akurasi          double precision NOT NULL,
    titik_lat        double precision NOT NULL,
    titik_lng        double precision NOT NULL,
    status_titik     text NOT NULL,
    jarak_m          integer NOT NULL,
    radius_m         integer NOT NULL,
    alasan           text NOT NULL,
    status           text NOT NULL DEFAULT 'menunggu',
    diajukan_oleh    text,
    diajukan_pada    timestamptz NOT NULL DEFAULT now(),
    diputuskan_oleh  text,
    diputuskan_pada  timestamptz,
    catatan_putusan  text,
    titik_dipindah   boolean NOT NULL DEFAULT false,
    CONSTRAINT pengajuan_lokasi_tahap CHECK (tahap IN ('checkin', 'checkout')),
    CONSTRAINT pengajuan_lokasi_status CHECK (status IN ('menunggu', 'disetujui', 'ditolak')),
    CONSTRAINT pengajuan_lokasi_alasan CHECK (btrim(alasan) <> '')
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pengajuan_lokasi_unik ON pengajuan_lokasi (sales_code, cust_code, principle, tanggal, tahap);
CREATE INDEX IF NOT EXISTS idx_pengajuan_lokasi_status ON pengajuan_lokasi (status, diajukan_pada);
DO $pl$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'accapi_app') THEN
    REVOKE DELETE, TRUNCATE ON pengajuan_lokasi FROM accapi_app;
    GRANT SELECT, INSERT, UPDATE ON pengajuan_lokasi TO accapi_app;
  END IF;
END $pl$;

COMMIT;

-- VERIFIKASI (baca-saja) — semua `ok` harus true (NULL = role accapi_app tidak ada, tidak relevan).
SELECT cek, ok FROM (VALUES
    ('ao_control_daily: 3 kolom GPS check-out nullable', (SELECT count(*) = 3 FROM pg_attribute WHERE attrelid = to_regclass('ao_control_daily')
        AND NOT attisdropped AND NOT attnotnull AND attname IN ('checkout_lat', 'checkout_lng', 'checkout_accuracy'))),
    ('toko_koordinat: status NOT NULL + CHECK', EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass('toko_koordinat')
        AND conname = 'toko_koordinat_status')),
    ('pengajuan_lokasi + indeks unik', EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_pengajuan_lokasi_unik')),
    ('accapi_app: pengajuan_lokasi SELECT/INSERT/UPDATE, tanpa DELETE', CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'accapi_app')
        THEN (SELECT bool_and(has_table_privilege('accapi_app', 'pengajuan_lokasi', p)) FROM unnest(ARRAY['SELECT', 'INSERT', 'UPDATE']) AS p)
            AND NOT has_table_privilege('accapi_app', 'pengajuan_lokasi', 'DELETE') END)
) AS v(cek, ok);
SELECT status, count(*) FROM toko_koordinat GROUP BY 1 ORDER BY 1;
