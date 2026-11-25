-- =====================================================================
-- Jejak unggahan Pelunasan (pemilik 25 Nov 2026: libatkan Hermes untuk akurasi pelunasan).
--
--   pelunasan_unggah  (baru) satu baris per pratinjau berkas di /pelunasan; `baris` jsonb = ringkasan per baris berkas
--                     (faktur, nominal per jenis, rekening yang diharapkan, status, nomor pelunasan). Ditulis POST/PATCH
--                     /api/pelunasan/unggah; dibaca Hermes (hermes_ro, ~/.hermes/scripts/jaga-pelunasan.py) dan dicocokkan
--                     dengan cache pelunasan Accurate kasir_pelunasan(_faktur).
--
-- accapi_app SELECT/INSERT/UPDATE, TANPA DELETE (jejak). EXPAND saja. Menjalankan ulang = tanpa perubahan.
-- Entri migrate-pg: "pelunasan unggah". Tanpa DATABASE_MIGRATION_URL jalankan berkas ini sebagai owner SEBELUM image.
-- =====================================================================
SET lock_timeout = '5s';
CREATE TABLE IF NOT EXISTS pelunasan_unggah (
    id            text PRIMARY KEY,
    database_id   text NOT NULL,
    tanggal       date NOT NULL,
    nama_berkas   text NOT NULL,
    dibuat_oleh   text NOT NULL,
    dibuat_pada   timestamptz NOT NULL DEFAULT now(),
    dikirim_pada  timestamptz,
    baris         jsonb NOT NULL,
    CONSTRAINT pelunasan_unggah_baris_array CHECK (jsonb_typeof(baris) = 'array')
);
CREATE INDEX IF NOT EXISTS idx_pelunasan_unggah_tanggal ON pelunasan_unggah (database_id, tanggal);
DO $pu$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'accapi_app') THEN
    REVOKE DELETE, TRUNCATE ON pelunasan_unggah FROM accapi_app;
    GRANT SELECT, INSERT, UPDATE ON pelunasan_unggah TO accapi_app;
  END IF;
END $pu$;
RESET lock_timeout;
