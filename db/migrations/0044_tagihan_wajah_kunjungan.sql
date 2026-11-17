-- =====================================================================
-- Tagihan + validasi wajah kunjungan Form Kontrol (owner 16 Nov 2026).
--
--   ao_control_daily  + tagih_status text, tagih_nominal numeric(18,2), tagih_alasan text, tagih_catatan text: toko dengan nota belum lunas
--                       -> salesman mencatat hasil tagih di langkah Status ('tertagih' + nominal | 'tidak_tertagih' + alasan). NULL = toko
--                       tanpa nota / baris lama. Incaso membaca kunjungan 'tidak_tertagih' + tidak order (GET /api/form-kontrol/tagihan).
--                     + wajah_status text, wajah_skor double precision: selfie check-in dicocokkan dengan wajah acuan salesman
--                       (cocok | beda | tanpa_wajah | acuan_baru | tidak_terbaca). Tidak pernah menolak kunjungan; beda = ditinjau SPV.
--                       Semua kolom nullable TANPA default (hanya katalog). CHECK ditambah NOT VALID: baris lama semuanya NULL, tanpa
--                       pindai tabel di bawah kunci.
--   wajah_acuan       (baru) satu sidik wajah (128 angka SFace dari FastAPI /wajah/sidik) per salesman. Terisi dari check-in pertama
--                       yang berwajah; Admin/SPV bisa mengosongkannya (DELETE) di Hierarki supaya check-in berikut menjadi acuan baru.
--                       accapi_app SELECT/INSERT/UPDATE/DELETE.
--
-- EXPAND saja. Menjalankan ulang = tanpa perubahan. Entri migrate-pg: "tagihan wajah kunjungan". DDL manual:
-- docs/handover/DDL_TAGIHAN_WAJAH.sql.
-- =====================================================================
SET lock_timeout = '5s';
ALTER TABLE IF EXISTS ao_control_daily
    ADD COLUMN IF NOT EXISTS tagih_status text,
    ADD COLUMN IF NOT EXISTS tagih_nominal numeric(18,2),
    ADD COLUMN IF NOT EXISTS tagih_alasan text,
    ADD COLUMN IF NOT EXISTS tagih_catatan text,
    ADD COLUMN IF NOT EXISTS wajah_status text,
    ADD COLUMN IF NOT EXISTS wajah_skor double precision;
DO $tgh$ BEGIN
  IF to_regclass('ao_control_daily') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ao_control_daily_tagih') THEN
    ALTER TABLE ao_control_daily ADD CONSTRAINT ao_control_daily_tagih CHECK (
      (tagih_status IS NULL AND tagih_nominal IS NULL AND tagih_alasan IS NULL)
      OR (tagih_status = 'tertagih' AND tagih_nominal > 0 AND tagih_alasan IS NULL)
      OR (tagih_status = 'tidak_tertagih' AND tagih_nominal IS NULL AND btrim(coalesce(tagih_alasan, '')) <> '')
    ) NOT VALID;
  END IF;
  IF to_regclass('ao_control_daily') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ao_control_daily_wajah') THEN
    ALTER TABLE ao_control_daily ADD CONSTRAINT ao_control_daily_wajah CHECK (
      wajah_status IS NULL OR wajah_status IN ('cocok', 'beda', 'tanpa_wajah', 'acuan_baru', 'tidak_terbaca')
    ) NOT VALID;
  END IF;
END $tgh$;
CREATE TABLE IF NOT EXISTS wajah_acuan (
    sales_code   text PRIMARY KEY,
    sidik        double precision[] NOT NULL,
    foto_url     text NOT NULL,
    sumber       text NOT NULL,
    dibuat_pada  timestamptz NOT NULL DEFAULT now(),
    dibuat_oleh  text,
    CONSTRAINT wajah_acuan_sidik CHECK (cardinality(sidik) = 128),
    CONSTRAINT wajah_acuan_sumber CHECK (sumber IN ('checkin'))
);
DO $wjh$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'accapi_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON wajah_acuan TO accapi_app;
  END IF;
END $wjh$;
RESET lock_timeout;
