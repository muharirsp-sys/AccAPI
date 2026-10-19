-- =====================================================================
-- Supervisor Review (owner 16 Okt 2026; spec docs/superpowers/specs/2026-10-16-supervisor-review-design.md §3.1).
--
--   sales_invoice.salesman_id/qty_total/jumlah_item/dpp : ringkasan rincian faktur (masterSalesmanId, Σ qty satuan terkecil, jumlah baris,
--                         Σ DPP) diisi lib/sync.ts (ringkasFaktur) + scripts/backfill-ringkas-faktur.mjs. NULL = rincian belum terbaca.
--   sales_profile.no_hp : No HP salesman (WhatsApp), bentuk kanonik 08… (CHECK sama dengan noo_toko_pribadi); NULL boleh.
--   toko_koordinat      : titik toko per kode JKS (unggah Admin), CHECK wilayah Indonesia.
--
-- EXPAND saja: kolom nullable TANPA default (hanya katalog, tanpa tulis ulang tabel), tabel baru tanpa pembaca lama.
-- `ALTER TABLE IF EXISTS sales_invoice`: uji PG modul lain membuat skema sekali-pakai TANPA sales_invoice lalu memasang berkas ini agar
--   sales_profile punya no_hp (Drizzle memilih semua kolom). Di produksi tabelnya selalu ada; DDL manual memakai bentuk tanpa IF EXISTS.
--
-- Apply otomatis lewat scripts/migrate-pg.mjs (entri "supervisor review (SR-1)") saat container start bila DATABASE_MIGRATION_URL terpasang;
-- selain itu docs/handover/DDL_SUPERVISOR_REVIEW.sql SEBELUM image baru (role pemilik tabel; juga memberi hak accapi_app). Idempoten.
-- =====================================================================

ALTER TABLE IF EXISTS sales_invoice ADD COLUMN IF NOT EXISTS salesman_id bigint, ADD COLUMN IF NOT EXISTS qty_total numeric,
    ADD COLUMN IF NOT EXISTS jumlah_item integer, ADD COLUMN IF NOT EXISTS dpp numeric(18,2);
ALTER TABLE sales_profile ADD COLUMN IF NOT EXISTS no_hp text;
DO $sr1$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'sales_profile'::regclass AND conname = 'sales_profile_no_hp') THEN
    ALTER TABLE sales_profile ADD CONSTRAINT sales_profile_no_hp CHECK (no_hp ~ '^08[1-9][0-9]{7,10}$');
  END IF;
END $sr1$;
CREATE TABLE IF NOT EXISTS toko_koordinat (
    cust_code       text PRIMARY KEY,
    lat             double precision NOT NULL,
    lng             double precision NOT NULL,
    diperbarui_pada timestamptz NOT NULL DEFAULT now(),
    diperbarui_oleh text NOT NULL,
    CONSTRAINT toko_koordinat_wilayah CHECK (lat BETWEEN -11 AND 6 AND lng BETWEEN 95 AND 141)
);
