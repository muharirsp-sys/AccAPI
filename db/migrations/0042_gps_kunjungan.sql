-- =====================================================================
-- GPS kunjungan Form Kontrol (owner 14 Nov 2026).
--
--   ao_control_daily    + checkout_lat, checkout_lng, checkout_accuracy (double precision, nullable TANPA default — hanya katalog; baris lama
--                         tetap NULL). GPS WAJIB saat check-in dan check-out (route, lib/form-kontrol/gps.ts); titik check-in sudah ada sejak awal.
--   toko_koordinat      + status text NOT NULL DEFAULT 'fix' CHECK (fix | validasi): radius check-in/check-out 20 m (fix) / 100 m (validasi)
--                         (lib/form-kontrol/radius.ts). Titik yang ada = 'fix'; unggahan berkas selisih titik (sheet SANGAT BERBEDA / BERBEDA /
--                         ALAMAT KELIRU) menandai 'validasi'. Default konstanta = katalog saja di PG 11+.
--   pengajuan_lokasi    (baru) check-in/check-out DI LUAR radius = pengajuan ke IT; kunjungan tetap tersimpan, IT menyetujui (opsional
--                         memindah titik toko) atau menolak. Satu pengajuan per (salesman, toko, principal, tanggal, tahap); pengajuan ulang
--                         menimpa titik/alasan dan kembali 'menunggu'. accapi_app SELECT/INSERT/UPDATE, TANPA DELETE.
--
-- Menjalankan ulang = tanpa perubahan. Entri migrate-pg: "gps kunjungan". DDL manual: docs/handover/DDL_GPS_KUNJUNGAN.sql.
-- =====================================================================
SET lock_timeout = '5s';
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
RESET lock_timeout;
