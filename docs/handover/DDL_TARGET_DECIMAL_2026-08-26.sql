-- Target EC/AO/IA boleh pecahan (file target nyata: Target IA = 204.8).
-- Kolom integer menolak seluruh upload: invalid input syntax for type integer: "204.8".
-- Aman & non-destruktif: integer -> double precision hanya melebarkan tipe.
-- Jalankan di produksi:
--   docker exec -i accapi-postgres psql -U accapi -d accapi -v ON_ERROR_STOP=1 \
--     -f - < DDL_TARGET_DECIMAL_2026-08-26.sql

ALTER TABLE sales_targets
    ALTER COLUMN target_ec TYPE double precision,
    ALTER COLUMN target_ao TYPE double precision,
    ALTER COLUMN target_ia TYPE double precision;

-- Verifikasi
SELECT column_name, data_type FROM information_schema.columns
WHERE table_name = 'sales_targets' AND column_name IN ('target_ec','target_ao','target_ia');
