-- =====================================================================
-- Kunjungan LUAR RUTE + konfirmasi masuk JKS (FK-MSM2, pilot Form Kontrol cabang, owner 12 Okt 2026).
--
--   kunjungan_luar_rute : satu baris per (salesman, toko, principal, tanggal) yang ditambahkan salesman ke kunjungan HARI INI walau toko
--                         tidak ada di rute JKS-nya (toko dicari dari pelanggan Accurate cabangnya; cust_code = customerNo LENGKAP).
--                         Alur kunjungan tetap di ao_control_daily / merchandising_check (kunci cust_code, tanpa kolom baru).
--                         konfirmasi: menunggu (bawaan; "nanti") -> jks (masuk JKS salesman: hari + pola minggu, jks_id = baris JKS) /
--                         tidak (jangan masukkan JKS) ; sudah_jks = toko sudah di JKS salesman ini pada hari lain (tanpa keputusan).
--                         JEJAK baris JKS hasil konfirmasi = baris ini (siapa/kapan dikonfirmasi_*, dari kunjungan `tanggal`); jks_master
--                         TIDAK diubah bentuknya.
--                         BATAL LUNAK (owner 13 Okt): dibatalkan_pada/oleh = kunjungan salah tambah dibatalkan salesman pemilik (hari itu,
--                         sebelum ada check-in/status/merchandising); baris tetap (jejak), keluar dari rute/daftar. UNIQUE hanya baris
--                         belum batal -> toko sama boleh ditambah ulang hari itu (baris baru).
-- Tabel BARU saja (EXPAND): tanpa trigger, tanpa data, tanpa pembaca lama. Hak accapi_app (SELECT/INSERT/UPDATE, TANPA DELETE: jejak) ada
-- di docs/handover/DDL_FK_MSM2.sql.
-- Nomor 0034: SESUDAH 0033 (O1 order cabang) dan 0032 (K2a kasir_setoran_giro, cabang paralel); urutan berkas tetap aditif.
--
-- Apply otomatis lewat scripts/migrate-pg.mjs (entri "kunjungan_luar_rute (FK-MSM2)") saat container start bila DATABASE_MIGRATION_URL
-- terpasang; selain itu docs/handover/DDL_FK_MSM2.sql SEBELUM image baru (role pemilik). Manual:
--   docker exec -i accapi-postgres psql -U accapi -d accapi -v ON_ERROR_STOP=1 \
--     --single-transaction < db/migrations/0034_kunjungan_luar_rute.sql
-- Idempoten dan aditif. Bentuk ini (kolom batal + indeks unik parsial) menggantikan draf 12 Okt yang TIDAK pernah dijalankan di produksi.
-- =====================================================================

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
