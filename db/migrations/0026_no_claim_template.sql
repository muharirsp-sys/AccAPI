-- =====================================================================
-- Templat format No Claim per principal (S4b, owner 8 Okt 2026).
--
-- Tiap principal bisa beda format nomor klaim. Bawaan tetap di kode
-- (lib/claim-workflow/no-claim-rules.ts); tabel ini hanya menyimpan templat
-- yang DIUBAH lewat API /api/claim-workflow/no-claim-templates. Pembacaan =
-- bawaan kode ditimpa baris DB (principle_code + variant_key).
-- Token pola: {seq} {month} {year4} {year2}.
--
-- Apply otomatis lewat scripts/migrate-pg.mjs saat container start. Manual:
--   docker exec -i accapi-postgres psql -U accapi -d accapi -v ON_ERROR_STOP=1 \
--     --single-transaction < db/migrations/0026_no_claim_template.sql
-- Idempoten dan aditif; tidak menyentuh data yang ada.
-- =====================================================================

CREATE TABLE IF NOT EXISTS no_claim_template (
    principle_code text NOT NULL,
    variant_key    text NOT NULL DEFAULT '',
    label          text NOT NULL,
    pattern        text NOT NULL,
    pad_width      integer,
    sequence_type  text NOT NULL DEFAULT 'number' CHECK (sequence_type IN ('number', 'text', 'roman')),
    updated_by     text,
    updated_at     timestamp NOT NULL,
    PRIMARY KEY (principle_code, variant_key)
);

-- Jejak perubahan templat: nilai lama -> baru + pelaku.
CREATE TABLE IF NOT EXISTS no_claim_template_log (
    id             bigserial PRIMARY KEY,
    principle_code text NOT NULL,
    variant_key    text NOT NULL DEFAULT '',
    action         text NOT NULL CHECK (action IN ('set', 'reset')),
    before         jsonb,
    after          jsonb,
    actor          text,
    created_at     timestamp NOT NULL
);
