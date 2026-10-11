-- =====================================================================
-- Grup utama per user (S7-0 BL-63, owner 11 Okt 2026: BINTANG grup utama).
--
-- Opsional; maksimal satu bintang per user (indeks unik parsial). Izin tetap
-- gabungan semua grup; bintang menentukan Beranda (dan, sampai AM-026, user.role
-- untuk grup preset — logika itu di S7-1, bukan di skema).
-- ADD COLUMN dengan DEFAULT: baris lama false seketika (tanpa rewrite tabel).
-- TANPA backfill di sini: "user tepat 1 grup -> berbintang" = bagian BACKFILL
-- docs/handover/DDL_S7_0.sql (manual, IT Support).
--
-- Apply otomatis lewat scripts/migrate-pg.mjs (entri "user_group.is_primary") saat
-- container start bila DATABASE_MIGRATION_URL terpasang; selain itu docs/handover/DDL_S7_0.sql
-- SEBELUM image baru (image baru menulis kolom ini pada setiap INSERT user_group). Manual:
--   docker exec -i accapi-postgres psql -U accapi -d accapi -v ON_ERROR_STOP=1 \
--     --single-transaction < db/migrations/0028_user_group_primary.sql
-- Idempoten dan aditif; tidak menyentuh data yang ada.
-- =====================================================================

ALTER TABLE user_group ADD COLUMN IF NOT EXISTS is_primary boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX IF NOT EXISTS uq_user_group_primary ON user_group (user_id) WHERE is_primary;
