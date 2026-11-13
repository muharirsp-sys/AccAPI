-- DDL MANUAL JKS Web-LL + dua tipe sales + Item Super (owner 13 Nov 2026).
-- Rujukan: db/schema.ts (jksMaster, salesProfile.sumberOrder, itemSuper, tawaranItemSuper), scripts/migrate-pg.mjs (entri "jks web-ll + item super"
-- = SQL sama dengan db/migrations/0041_jks_item_super.sql), lib/form-kontrol/{item-super,jks-webll}.ts, lib/supervisor-review/kontrol*.ts.
--
-- SIAPA & KAPAN (pola DDL_SUPERVISOR_REVIEW): IT Support, SAAT DEPLOY, sebagai role PEMILIK tabel (accapi, bukan accapi_app), SESUDAH cadangan DB
-- dan SEBELUM image baru. JANGAN dijalankan loop/agen ke produksi.
--
--   docker exec -i accapi-postgres psql -U accapi -d accapi -v ON_ERROR_STOP=1 < docs/handover/DDL_JKS_ITEM_SUPER.sql
--
-- KENAPA SEBELUM: image baru membaca kolom baru jks_master/sales_profile (Drizzle memilih semua kolom) -> kolom WAJIB ada sebelum image melayani.
--   Image LAMA tidak terganggu: kolom nullable / ber-default, tabel baru tanpa pembaca lama.
-- KUNCI: ALTER jks_master/sales_profile = katalog saja (kolom nullable tanpa default; sumber_order ber-default konstanta = katalog di PG 11+), tetapi
--   butuh ACCESS EXCLUSIVE sesaat. lock_timeout 5 dtk: bila tertahan, berkas gagal + ROLLBACK seluruhnya -> ulangi di luar jam sibuk.
-- NILAI AWAL sumber_order: SEKALI saat kolom dibuat (principal KINO/RECKITT/GODREJ/HEINZ/MOTASA/CUSSONS = 'principal'); menjalankan ulang tidak
--   menimpa pilihan Admin di Hierarki. Periksa hasilnya di VERIFIKASI baris terakhir (jumlah per nilai).
-- Menjalankan ulang seluruh berkas = tanpa perubahan.
--
-- ROLLBACK DARURAT: image lama tetap jalan dengan kolom/tabel ini. Biarkan (aditif).

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

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

COMMIT;

-- VERIFIKASI (baca-saja) — semua `ok` harus true (NULL = role accapi_app tidak ada, tidak relevan).
SELECT cek, ok FROM (VALUES
    ('jks_master: 8 kolom JKS Web-LL nullable', (SELECT count(*) = 8 FROM pg_attribute WHERE attrelid = to_regclass('jks_master') AND NOT attisdropped
        AND NOT attnotnull AND attname IN ('urutan', 'kategori', 'kelas_a', 'target_toko', 'omzet_rata', 'status_jks', 'sales_sebelum', 'lokasi_dari'))),
    ('sales_profile: sumber_order NOT NULL + CHECK', EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass('sales_profile')
        AND attname = 'sumber_order' AND attnotnull AND NOT attisdropped)
        AND EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass('sales_profile') AND conname = 'sales_profile_sumber_order')),
    ('item_super + tawaran_item_super + indeks unik', (SELECT count(*) = 2 FROM pg_indexes WHERE indexname IN ('idx_item_super_unik', 'idx_tis_unik'))),
    ('accapi_app: item_super SELECT/INSERT/DELETE, tanpa UPDATE', CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'accapi_app')
        THEN (SELECT bool_and(has_table_privilege('accapi_app', 'item_super', p)) FROM unnest(ARRAY['SELECT', 'INSERT', 'DELETE']) AS p)
            AND NOT has_table_privilege('accapi_app', 'item_super', 'UPDATE') END),
    ('accapi_app: tawaran_item_super SELECT/INSERT/UPDATE, tanpa DELETE', CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'accapi_app')
        THEN (SELECT bool_and(has_table_privilege('accapi_app', 'tawaran_item_super', p)) FROM unnest(ARRAY['SELECT', 'INSERT', 'UPDATE']) AS p)
            AND NOT has_table_privilege('accapi_app', 'tawaran_item_super', 'DELETE') END)
) AS v(cek, ok);
SELECT sumber_order, principle, count(*) FROM sales_profile GROUP BY 1, 2 ORDER BY 1, 2;
