-- =====================================================================
-- Principal resmi + varian + alias (S7-0 BL-64, owner 11 Okt 2026).
--
-- Satu tabel resmi menggantikan pencocokan teks bebas antar sumber (konstanta OPC,
-- Master Barang, principal_mapping, rekening bank, Master Summary, surat).
-- KINO NON FOOD / Forisa MT-GT / Heinz HZ-BS = VARIAN satu principal.
--   principal         : code = kode OPC/Klaim (^[A-Z0-9_-]{1,20}$), name = nama resmi.
--   principal_variant : variant_key '' = tanpa varian (bentuk = no_claim_template.variant_key); name (tampilan), is_active.
--   principal_alias   : id PK; alias_norm unik per kelompok (kode Master Barang | selain itu)
--                       -> principal (+ varian bila terisi).
--                       alias_norm WAJIB hasil normalizer baku S7-2 (lib/principal), bukan
--                       normalizer TS master-barang / Python principle_matcher.
-- Tabel saja: TANPA benih (S7-2: laporan matched/ambiguous dulu, lalu benih manual).
-- principal.code TETAP sesudah dibuat (kunci teks OPC/Klaim/no_claim_template): trigger penolak
-- ada di docs/handover/DDL_S7_0.sql saja (pola repo: trigger = DDL manual), bukan di berkas ini.
--
-- Apply otomatis lewat scripts/migrate-pg.mjs (entri "principal (+variant, +alias)") saat
-- container start bila DATABASE_MIGRATION_URL terpasang; selain itu docs/handover/DDL_S7_0.sql
-- SEBELUM image baru. Manual:
--   docker exec -i accapi-postgres psql -U accapi -d accapi -v ON_ERROR_STOP=1 \
--     --single-transaction < db/migrations/0027_principal.sql
-- Idempoten dan aditif; tidak menyentuh data yang ada.
-- =====================================================================

-- Bentuk 893f8cbf (PK alias_norm, tanpa kolom id; hanya pernah ada di DB evaluasi) tidak bisa diubah secara aditif:
-- berhenti jelas alih-alih diam-diam mempertahankan PK global. docs/handover/DDL_S7_0.sql mengubahnya (tabel kosong).
DO $guard$
BEGIN
    IF to_regclass('principal_alias') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM information_schema.columns
           WHERE table_schema = current_schema() AND table_name = 'principal_alias' AND column_name = 'id') THEN
        RAISE EXCEPTION 'S7-0: principal_alias berbentuk lama 893f8cbf (PK alias_norm) — jalankan docs/handover/DDL_S7_0.sql';
    END IF;
END $guard$;

CREATE TABLE IF NOT EXISTS principal (
    id         text PRIMARY KEY DEFAULT gen_random_uuid()::text,
    code       text NOT NULL,
    name       text NOT NULL,
    is_active  boolean NOT NULL DEFAULT true,
    created_by text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_by text,
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT principal_code_format CHECK (code ~ '^[A-Z0-9_-]{1,20}$'),
    CONSTRAINT principal_name_isi CHECK (btrim(name) <> '')
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_principal_code ON principal (code);

CREATE TABLE IF NOT EXISTS principal_variant (
    principal_id text NOT NULL,
    variant_key  text NOT NULL DEFAULT '',
    created_by   text,
    created_at   timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT principal_variant_pkey PRIMARY KEY (principal_id, variant_key),
    CONSTRAINT principal_variant_principal_fk FOREIGN KEY (principal_id) REFERENCES principal (id) ON DELETE RESTRICT,
    CONSTRAINT principal_variant_key_format CHECK (variant_key ~ '^[A-Z0-9_-]{0,20}$')
);
-- B-SEDANG-2: nama tampilan varian (opsional, mis. "KINO NON FOOD") + aktif. ALTER (bukan kolom CREATE TABLE) agar DB
-- yang sudah punya tabel varian bentuk 893f8cbf ikut lengkap dan urutan kolom sama di semua jalur.
ALTER TABLE principal_variant ADD COLUMN IF NOT EXISTS name text;
ALTER TABLE principal_variant ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;

-- variant_key NULL = alias menunjuk principal utuh (FK komposit MATCH SIMPLE tidak diperiksa);
-- terisi = harus varian milik principal yang sama.
CREATE TABLE IF NOT EXISTS principal_alias (
    id           text NOT NULL DEFAULT gen_random_uuid()::text,
    alias_norm   text NOT NULL,
    principal_id text NOT NULL,
    variant_key  text,
    alias_asli   text NOT NULL,
    jenis        text NOT NULL,
    sumber       text NOT NULL,
    created_by   text,
    created_at   timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT principal_alias_pkey PRIMARY KEY (id),
    CONSTRAINT principal_alias_principal_fk FOREIGN KEY (principal_id) REFERENCES principal (id) ON DELETE RESTRICT,
    CONSTRAINT principal_alias_variant_fk FOREIGN KEY (principal_id, variant_key)
        REFERENCES principal_variant (principal_id, variant_key) ON DELETE RESTRICT,
    CONSTRAINT principal_alias_norm_isi CHECK (btrim(alias_norm) <> ''),
    CONSTRAINT principal_alias_asli_isi CHECK (btrim(alias_asli) <> ''),
    CONSTRAINT principal_alias_sumber_isi CHECK (btrim(sumber) <> ''),
    CONSTRAINT principal_alias_jenis CHECK (jenis IN
        ('nama', 'kode_master_barang', 'label_mapping', 'nama_bank', 'nama_summary', 'nama_surat'))
);
-- Unik per kelompok (B-SEDANG-1): kode Master Barang 2 karakter terpisah dari nama/label/kode OPC. Tabrakan nama yang
-- sah tetap DITOLAK (masuk laporan ambiguous S7-2) — JANGAN PERNAH ON CONFLICT DO UPDATE (alias diam-diam pindah principal).
CREATE UNIQUE INDEX IF NOT EXISTS uq_principal_alias_kode_mb ON principal_alias (alias_norm) WHERE jenis = 'kode_master_barang';
CREATE UNIQUE INDEX IF NOT EXISTS uq_principal_alias_nama ON principal_alias (alias_norm) WHERE jenis <> 'kode_master_barang';
CREATE INDEX IF NOT EXISTS idx_principal_alias_principal ON principal_alias (principal_id, variant_key);
