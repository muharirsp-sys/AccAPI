-- =====================================================================
-- Kasir ↔ Incaso (K2a, BL-59; owner 12 Okt 2026): setoran Giro WAJIB nomor BG + tanggal jatuh tempo.
--
--   kasir_setoran.giro_nomor       : nomor BG (teks, tidak boleh hanya spasi); NULL = bukan setoran giro.
--   kasir_setoran.giro_jatuh_tempo : tanggal jatuh tempo BG; NULL = bukan setoran giro.
-- Nullable: server (lib/kasir/hari.ts) menegakkan "giro > 0 -> keduanya wajib" (pola K1a: keputusan berubah tanpa DDL).
-- Tabel append-only (trigger K1a) tidak terpengaruh ADD COLUMN; hak accapi_app tingkat tabel ikut berlaku untuk kolom baru.
-- Nomor 0032: SESUDAH 0031_kasir_baca.sql.
--
-- Apply otomatis lewat scripts/migrate-pg.mjs (entri "kasir_setoran giro (K2a)") saat container start bila DATABASE_MIGRATION_URL
-- terpasang; selain itu docs/handover/DDL_K2A.sql SEBELUM image baru. Manual:
--   docker exec -i accapi-postgres psql -U accapi -d accapi -v ON_ERROR_STOP=1 \
--     --single-transaction < db/migrations/0032_kasir_setoran_giro.sql
-- Idempoten dan aditif; tidak menyentuh data yang ada.
-- =====================================================================

ALTER TABLE kasir_setoran ADD COLUMN IF NOT EXISTS giro_nomor text CONSTRAINT kasir_setoran_giro_nomor CHECK (btrim(giro_nomor) <> '');
ALTER TABLE kasir_setoran ADD COLUMN IF NOT EXISTS giro_jatuh_tempo date;
