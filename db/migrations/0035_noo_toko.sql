-- =====================================================================
-- NOO — toko baru (New Open Outlet) dari kunjungan salesman (owner 13 Okt 2026; brief scratch/fiori-redesign/briefs/NOO-brief-toko-baru.md).
--
--   noo_toko : satu baris per pengajuan toko yang BELUM ada di Accurate. Salesman mengisi toko + pemilik + KTP (NIK, nama, foto) + foto toko
--              + GPS; SPV tim (atau SM di atasnya / grup Admin) menyetujui atau menolak (alasan wajib); Admin mendaftarkan pelanggan di
--              Accurate SECARA MANUAL lalu menautkan pelanggan hasil sync (customer_id/customer_no, cabang sama) -> `terdaftar`.
--              Aplikasi TIDAK menulis ke Accurate.
--              status: menunggu_spv -> disetujui | ditolak (final) ; disetujui -> terdaftar.
--              duplikat_dengan/alasan_duplikat = pengajuan ulang "pemilik sama" (NIK/No. HP sama dengan NOO lain yang belum ditolak);
--              menyetujuinya WAJIB konfirmasi eksplisit pemutus (duplikat_dikonfirmasi).
--              DATA PRIBADI: nik + foto_ktp (nama berkas acak di data/private/noo/, BUKAN folder publik). Retensi: SIMPAN SELAMANYA
--              (owner 14 Okt 2026; tanpa hapus otomatis); satu kolom nama berkas per foto.
--   Kunjungan NOO = baris kunjungan_luar_rute BIASA (cust_code = kode NOO, customer_id NULL) -> tabel lama TIDAK diubah bentuknya.
-- Tabel BARU saja (EXPAND): tanpa trigger, tanpa data, tanpa pembaca lama. Hak accapi_app (SELECT/INSERT/UPDATE, TANPA DELETE: jejak) di
-- docs/handover/DDL_NOO.sql. Metabase TIDAK diberi (whitelist eksplisit db/metabase_readonly.sql).
-- Nomor 0035: SESUDAH 0034 (FK-MSM2 kunjungan_luar_rute).
--
-- Apply otomatis lewat scripts/migrate-pg.mjs (entri "noo_toko (NOO)") saat container start bila DATABASE_MIGRATION_URL terpasang; selain
-- itu docs/handover/DDL_NOO.sql SEBELUM image baru (role pemilik). Idempoten dan aditif.
-- =====================================================================

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
