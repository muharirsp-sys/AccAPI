-- =====================================================================
-- Order kunjungan Form Kontrol (owner 14 Nov 2026): dua alur order salesman.
--
--   ao_control_daily      + order_ref text, order_dicatat_pada timestamptz (nullable TANPA default: hanya katalog; baris lama tetap NULL).
--                           Langkah Order kunjungan berstatus ORDER selesai = terisi. order_ref = 'websales:<id permintaan>' (salesman input di
--                           AccAPI: order masuk antrean Web Sales) atau 'principal' (salesman input di sistem principal: "Sudah input order",
--                           tidak mengirim apa pun ke Accurate).
--   stok_toko_kunjungan   (baru) stok toko saat kunjungan per barang + satuan dari riwayat pengambilan toko (faktur Accurate 3 bulan),
--                           diisi salesman di halaman order sebelum input order. Satu baris per (salesman, toko, principal, tanggal, barang,
--                           satuan); simpan ulang menimpa. accapi_app SELECT/INSERT/UPDATE, TANPA DELETE (jejak kunjungan).
--
-- EXPAND saja. Menjalankan ulang = tanpa perubahan. Entri migrate-pg: "order kunjungan". DDL manual: docs/handover/DDL_ORDER_KUNJUNGAN.sql.
-- =====================================================================
SET lock_timeout = '5s';
ALTER TABLE IF EXISTS ao_control_daily ADD COLUMN IF NOT EXISTS order_ref text, ADD COLUMN IF NOT EXISTS order_dicatat_pada timestamptz;
CREATE TABLE IF NOT EXISTS stok_toko_kunjungan (
    id               text PRIMARY KEY,
    sales_code       text NOT NULL,
    cust_code        text NOT NULL,
    principle        text NOT NULL,
    tanggal          text NOT NULL,
    kode_barang      text NOT NULL,
    nama_barang      text NOT NULL,
    satuan           text NOT NULL,
    stok             numeric(14,2) NOT NULL,
    rata_bulan       numeric(14,2),
    dibuat_oleh      text NOT NULL,
    diperbarui_pada  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT stok_toko_kunjungan_stok CHECK (stok >= 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_stok_toko_kunjungan_unik ON stok_toko_kunjungan (sales_code, cust_code, principle, tanggal, kode_barang, satuan);
DO $stk$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'accapi_app') THEN
    REVOKE DELETE, TRUNCATE ON stok_toko_kunjungan FROM accapi_app;
    GRANT SELECT, INSERT, UPDATE ON stok_toko_kunjungan TO accapi_app;
  END IF;
END $stk$;
RESET lock_timeout;
