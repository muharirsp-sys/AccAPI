-- =====================================================================
-- Tabel terjemahan kode principal -> kode internal.
--
-- Kenapa satu tabel untuk tiga jenis, bukan tiga tabel: bentuknya sama
-- (kode sana -> kode sini) dan tiga tabel berarti tiga importir, tiga
-- endpoint, dan tiga layar untuk hal yang persis sama. `unit` dan
-- `pack_size` hanya terisi untuk kind='item'.
--
-- Sumbernya hari ini adalah KINO.xlsx (sheet Mapping_Prd / Mapping_Customer
-- / Mapping_Sls) yang dipakai Power Query admin. Dibuktikan 2026-09-11 dari
-- isi Power Query berkas itu:
--   * item     : Kode Alias (PRD_ID Kino) -> KODE ITEM internal, + Satuan & ISI
--   * customer : Code Kino -> Code Internal (faktur memakai kode + '-KN')
--   * salesman : SLSMAN_ID -> Code Internal
--
-- `pack_size` (ISI per karton) BUKAN hiasan: aturan satuan yang berjalan
-- sekarang adalah "naikkan ke KRT hanya bila QTY habis dibagi ISI, lalu
-- harga dikali ISI". Tanpa angka itu satu baris bisa salah 36x atau 72x.
--
-- Apply: docker exec -i accapi-postgres psql -U accapi -d accapi \
--          -v ON_ERROR_STOP=1 --single-transaction < db/migrations/0007_principal_mapping.sql
-- Idempoten dan aditif.
-- =====================================================================

CREATE TABLE IF NOT EXISTS principal_mapping (
    principal   text        NOT NULL,
    kind        text        NOT NULL CHECK (kind IN ('item', 'customer', 'salesman')),
    source_code text        NOT NULL,
    target_code text        NOT NULL,
    -- Khusus kind='item'. NULL untuk jenis lain.
    unit        text,
    pack_size   numeric(12, 3),
    note        text        NOT NULL DEFAULT '',
    updated_by  text        NOT NULL DEFAULT '',
    updated_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (principal, kind, source_code)
);

-- Pencarian balik: dari kode internal ke kode principal (dipakai saat menelusuri selisih).
CREATE INDEX IF NOT EXISTS idx_principal_mapping_target
    ON principal_mapping (principal, kind, target_code);
