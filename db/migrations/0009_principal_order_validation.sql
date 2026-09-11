-- =====================================================================
-- Hasil validasi tahap 1 pada baris laporan principal.
--
-- Kolom `*_resolved` menyimpan hasil terjemahan ke dunia Accurate (kode
-- barang, pelanggan per cabang, salesman). Disimpan, bukan dihitung ulang
-- saat kirim: mapping bisa berubah setelah batch divalidasi, dan faktur
-- harus memakai angka yang benar-benar ditinjau manusia.
--
-- `status`:
--   pending  = belum divalidasi
--   ok       = seluruh pemeriksaan lolos, boleh naik ke tahap kirim
--   review   = ada yang tidak cocok; wajib ditinjau admin
-- `findings` = daftar temuan per baris, apa adanya untuk ditampilkan.
--
-- Apply: docker exec -i accapi-postgres psql -U accapi -d accapi \
--          -v ON_ERROR_STOP=1 --single-transaction < db/migrations/0009_principal_order_validation.sql
-- Idempoten dan aditif.
-- =====================================================================

ALTER TABLE principal_order_line ADD COLUMN IF NOT EXISTS item_code        text;
ALTER TABLE principal_order_line ADD COLUMN IF NOT EXISTS customer_no      text;
ALTER TABLE principal_order_line ADD COLUMN IF NOT EXISTS salesman_internal text;
-- Harga menurut master Accurate untuk pelanggan ini; NULL = tidak ketemu.
ALTER TABLE principal_order_line ADD COLUMN IF NOT EXISTS expected_price   numeric(18, 4);
ALTER TABLE principal_order_line ADD COLUMN IF NOT EXISTS price_source     text;
-- Pecahan diskon menurut POSISI kolom: 1-3 distributor, 4-5 klaim principal, sisanya tak bertuan.
ALTER TABLE principal_order_line ADD COLUMN IF NOT EXISTS disc_distributor numeric(18, 2) NOT NULL DEFAULT 0;
ALTER TABLE principal_order_line ADD COLUMN IF NOT EXISTS disc_principal   numeric(18, 2) NOT NULL DEFAULT 0;
ALTER TABLE principal_order_line ADD COLUMN IF NOT EXISTS disc_unowned     numeric(18, 2) NOT NULL DEFAULT 0;
ALTER TABLE principal_order_line ADD COLUMN IF NOT EXISTS status           text NOT NULL DEFAULT 'pending';
ALTER TABLE principal_order_line ADD COLUMN IF NOT EXISTS findings         jsonb NOT NULL DEFAULT '[]'::jsonb;

CREATE INDEX IF NOT EXISTS idx_principal_order_line_status
    ON principal_order_line (batch_id, status);

ALTER TABLE principal_order_batch ADD COLUMN IF NOT EXISTS validated_at timestamptz;
ALTER TABLE principal_order_batch ADD COLUMN IF NOT EXISTS ok_count     integer NOT NULL DEFAULT 0;
ALTER TABLE principal_order_batch ADD COLUMN IF NOT EXISTS review_count integer NOT NULL DEFAULT 0;
