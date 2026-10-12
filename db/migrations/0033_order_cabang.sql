-- =====================================================================
-- Order per cabang Accurate (O1, owner 12 Okt 2026): barang & pelanggan ditarik per cabang.
--
--   item.branch_id    : cabang barang dari tag divisi Accurate `charField2` (lib/order-cabang TAG_KE_CABANG, diisi lib/sync).
--                       NULL = tidak bisa diorder (non-jual / tanpa tag / tag tak dikenal). Pelanggan cabang X hanya boleh
--                       dipesankan barang ber-cabang X.
--   item.suspended    : barang suspended di Accurate (tidak bisa diorder).
--   item.char_field2  : teks tag divisi asli (audit pemetaan).
--   customer.suspended: pelanggan suspended di Accurate (tidak bisa dipilih untuk order baru).
--
-- EXPAND KOLOM saja (ADD COLUMN, DEFAULT konstan = tanpa tulis ulang tabel); tidak menyentuh data. Kolom baru kosong/false sampai sync
-- ulang barang + pelanggan sesudah image (docs/handover/DDL_O1.sql). Tanpa indeks: pencarian 32 rb pelanggan / 4 rb barang = seq scan
-- milidetik (ponytail; jalan naik pg_trgm GIN bila terbukti lambat).
-- Nomor 0033: SESUDAH 0032 (K2a kasir_setoran_giro, cabang paralel) — bila K2a memakai nomor lain, urutan berkas tetap aditif.
--
-- Apply otomatis lewat scripts/migrate-pg.mjs (entri "order cabang (item/customer O1)") saat container start bila
-- DATABASE_MIGRATION_URL terpasang; selain itu docs/handover/DDL_O1.sql SEBELUM image baru (role pemilik tabel). Manual:
--   docker exec -i accapi-postgres psql -U accapi -d accapi -v ON_ERROR_STOP=1 \
--     --single-transaction < db/migrations/0033_order_cabang.sql
-- Idempoten dan aditif.
-- =====================================================================

ALTER TABLE item ADD COLUMN IF NOT EXISTS branch_id bigint;
ALTER TABLE item ADD COLUMN IF NOT EXISTS suspended boolean NOT NULL DEFAULT false;
ALTER TABLE item ADD COLUMN IF NOT EXISTS char_field2 text;
ALTER TABLE customer ADD COLUMN IF NOT EXISTS suspended boolean NOT NULL DEFAULT false;
