-- =====================================================================
-- JKS Web-LL + dua tipe sales + Item Super di Form Kontrol (owner 13 Nov 2026).
--
--   jks_master          + urutan, kategori, kelas_a, target_toko, omzet_rata, status_jks, sales_sebelum, lokasi_dari — nullable TANPA default
--                         (hanya katalog; JKS lama tetap NULL). Pola minggu bertambah m1..m4 (siklus 4 minggu; kolom teks tanpa CHECK) dan hari
--                         boleh beberapa hari "Senin, Kamis" (F8) — keduanya tanpa perubahan DDL.
--   sales_profile       + sumber_order text NOT NULL DEFAULT 'accapi' CHECK (accapi | principal). Nilai awal SEKALI saat kolom dibuat: principal
--                         KINO / RECKITT / GODREJ / HEINZ / MOTASA / CUSSONS = 'principal' (owner 13 Nov: sales principal itu input order di sistem
--                         principal); sesudahnya Admin mengatur per salesman di tab Hierarki — menjalankan ulang TIDAK menimpa pilihan Admin.
--   item_super          daftar saran item super per principal × channel (+ daftar MT per sales); unggahan menggantikan per principal.
--   tawaran_item_super  hasil penawaran item super per kunjungan (ditawarkan / dipesan / alasan).
--
-- EXPAND saja. Hak accapi_app: item_super SELECT/INSERT/DELETE (daftar acuan diganti utuh, jejaknya di kontrol_audit_log);
-- tawaran_item_super SELECT/INSERT/UPDATE TANPA DELETE (jejak kunjungan). Kolom baru jks_master/sales_profile tercakup hak tabel yang ada.
-- Apply otomatis lewat scripts/migrate-pg.mjs (entri "jks web-ll + item super") bila DATABASE_MIGRATION_URL terpasang; selain itu
-- docs/handover/DDL_JKS_ITEM_SUPER.sql SEBELUM image baru (role pemilik). Idempoten.
-- =====================================================================

ALTER TABLE IF EXISTS jks_master ADD COLUMN IF NOT EXISTS urutan integer, ADD COLUMN IF NOT EXISTS kategori text, ADD COLUMN IF NOT EXISTS kelas_a boolean,
    ADD COLUMN IF NOT EXISTS target_toko numeric(18,2), ADD COLUMN IF NOT EXISTS omzet_rata numeric(18,2), ADD COLUMN IF NOT EXISTS status_jks text,
    ADD COLUMN IF NOT EXISTS sales_sebelum text, ADD COLUMN IF NOT EXISTS lokasi_dari text;

DO $so$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'sales_profile'::regclass AND attname = 'sumber_order' AND NOT attisdropped) THEN
    ALTER TABLE sales_profile ADD COLUMN sumber_order text NOT NULL DEFAULT 'accapi';
    UPDATE sales_profile SET sumber_order = 'principal' WHERE upper(principle) ~ '(KINO|RECKITT|GODREJ|HEINZ|MOTASA|CUSSONS)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'sales_profile'::regclass AND conname = 'sales_profile_sumber_order') THEN
    ALTER TABLE sales_profile ADD CONSTRAINT sales_profile_sumber_order CHECK (sumber_order IN ('accapi', 'principal'));
  END IF;
END $so$;

CREATE TABLE IF NOT EXISTS item_super (
    id            text PRIMARY KEY,
    principle     text NOT NULL,
    channel       text NOT NULL,
    sales_code    text NOT NULL DEFAULT '',
    kode_barang   text NOT NULL,
    kode_lain     text[] NOT NULL DEFAULT '{}'::text[],
    nama_barang   text NOT NULL,
    peringkat     integer NOT NULL,
    kontribusi    numeric(9,6),
    omzet_rata    numeric(18,2),
    jumlah_toko   integer,
    periode       text NOT NULL,
    diunggah_oleh text NOT NULL,
    diunggah_pada timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT item_super_channel CHECK (channel IN ('GT', 'MT', 'NKA'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_item_super_unik ON item_super (principle, channel, sales_code, kode_barang);

CREATE TABLE IF NOT EXISTS tawaran_item_super (
    id              text PRIMARY KEY,
    sales_code      text NOT NULL,
    cust_code       text NOT NULL,
    principle       text NOT NULL,
    tanggal         text NOT NULL,
    kode_barang     text NOT NULL,
    nama_barang     text NOT NULL,
    ditawarkan      boolean NOT NULL,
    dipesan         boolean,
    alasan          text,
    catatan         text,
    dibuat_oleh     text NOT NULL,
    diperbarui_pada timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT tawaran_item_super_isi CHECK ((ditawarkan AND dipesan IS NOT NULL) OR (NOT ditawarkan AND dipesan IS NULL)),
    CONSTRAINT tawaran_item_super_alasan CHECK (dipesan IS TRUE OR alasan IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tis_unik ON tawaran_item_super (sales_code, cust_code, principle, tanggal, kode_barang);
CREATE INDEX IF NOT EXISTS idx_tis_sales_tanggal ON tawaran_item_super (sales_code, tanggal);

DO $tis$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'accapi_app') THEN
    REVOKE UPDATE, TRUNCATE ON item_super FROM accapi_app;
    GRANT SELECT, INSERT, DELETE ON item_super TO accapi_app;
    REVOKE DELETE, TRUNCATE ON tawaran_item_super FROM accapi_app;
    GRANT SELECT, INSERT, UPDATE ON tawaran_item_super TO accapi_app;
  END IF;
END $tis$;
