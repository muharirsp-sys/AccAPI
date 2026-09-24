-- =====================================================================
-- Keputusan manusia atas potongan TAK BERTUAN pada faktur Accurate yang dibuat
-- DI LUAR web ini (menu Normalisasi Diskon, 2026-09-24).
--
-- Faktur yang diketik langsung di Accurate tidak pernah lewat gerbang validasi,
-- jadi potongannya sering tidak cocok aturan terbit mana pun — posisi rantai
-- yang dimampatkan ("2,25" di posisi 1), atau tarif lama. Rekap Promo menaruhnya
-- di "tak bertuan". Tabel ini mencatat keputusan pengguna: potongan itu KLAIM
-- principal atau TANGGUNGAN distributor.
--
-- Kuncinya baris faktur + posisi (`line_key`, `positions`): id baris Accurate
-- (`detailItem[].id`) tetap walau urutan baris berubah. `amount` disimpan dan
-- DIADU saat rekap: kalau fakturnya diubah sesudah diputuskan, keputusannya
-- tidak dipakai — keputusan diambil atas angka tertentu, bukan atas baris kosong.
--
-- Tidak menulis ke Accurate. Faktur di Accurate tetap apa adanya.
--
-- Apply otomatis lewat scripts/migrate-pg.mjs saat container start. Manual:
--   docker exec -i accapi-postgres psql -U accapi -d accapi -v ON_ERROR_STOP=1 \
--     --single-transaction < db/migrations/0022_discount_normalization.sql
-- Idempoten dan aditif; tidak menyentuh satu baris data pun.
-- =====================================================================

CREATE TABLE IF NOT EXISTS discount_normalization (
    line_key text NOT NULL,
    positions text NOT NULL,
    bucket text NOT NULL CHECK (bucket IN ('principal', 'distributor')),
    amount numeric(18,2) NOT NULL,
    percent numeric(9,4) NOT NULL DEFAULT 0,
    invoice_no text NOT NULL DEFAULT '',
    invoice_id text NOT NULL DEFAULT '',
    trans_date date,
    customer_no text NOT NULL DEFAULT '',
    item_code text NOT NULL DEFAULT '',
    note text NOT NULL DEFAULT '',
    decided_by text NOT NULL DEFAULT '',
    decided_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (line_key, positions)
);
CREATE INDEX IF NOT EXISTS idx_discount_normalization_date ON discount_normalization (trans_date);
