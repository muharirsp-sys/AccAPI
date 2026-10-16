-- =====================================================================
-- Kasir ↔ Incaso (K2a, BL-59; owner 12 Okt 2026): kolom Giro + aturan owner setoran ditegakkan JUGA di DB.
--
--   kasir_setoran.giro_nomor       : nomor BG (teks, tidak boleh hanya spasi); NULL = bukan setoran giro.
--   kasir_setoran.giro_jatuh_tempo : tanggal jatuh tempo BG; NULL = bukan setoran giro.
--   CHECK kasir_setoran_giro_wajib  : giro > 0 -> nomor BG + jatuh tempo terisi.
--   CHECK kasir_setoran_bukti_wajib : transfer > 0 -> bukti_transfer (nama berkas bukti) terisi.
--   CHECK kasir_setoran_form_wajib  : tunai + transfer + giro > 0 -> no_form_kasir terisi.
-- Server (lib/kasir/hari.ts) menegakkan hal yang sama lebih dulu (400 berkode); CHECK = jaring kedua (keputusan orkestrator sesudah tinjauan B;
-- tabel kosong sampai K2a karena belum ada route tulis -> ADD CONSTRAINT aman). Trigger append-only K1a tidak terpengaruh.
-- Nomor 0032: SESUDAH 0031_kasir_baca.sql.
--
-- Apply otomatis lewat scripts/migrate-pg.mjs (entri "kasir_setoran giro (K2a)") saat container start bila DATABASE_MIGRATION_URL
-- terpasang; selain itu docs/handover/DDL_K2A.sql SEBELUM image baru. Manual:
--   docker exec -i accapi-postgres psql -U accapi -d accapi -v ON_ERROR_STOP=1 \
--     --single-transaction < db/migrations/0032_kasir_setoran_giro.sql
-- Idempoten dan aditif; tidak menyentuh data yang ada.
-- =====================================================================

ALTER TABLE kasir_setoran ADD COLUMN IF NOT EXISTS giro_nomor text;
ALTER TABLE kasir_setoran ADD COLUMN IF NOT EXISTS giro_jatuh_tempo date;
DO $k2a$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'kasir_setoran'::regclass AND conname = 'kasir_setoran_giro_nomor') THEN
    ALTER TABLE kasir_setoran ADD CONSTRAINT kasir_setoran_giro_nomor CHECK (btrim(giro_nomor) <> '');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'kasir_setoran'::regclass AND conname = 'kasir_setoran_giro_wajib') THEN
    ALTER TABLE kasir_setoran ADD CONSTRAINT kasir_setoran_giro_wajib CHECK (giro = 0 OR (giro_nomor IS NOT NULL AND giro_jatuh_tempo IS NOT NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'kasir_setoran'::regclass AND conname = 'kasir_setoran_bukti_wajib') THEN
    ALTER TABLE kasir_setoran ADD CONSTRAINT kasir_setoran_bukti_wajib CHECK (transfer = 0 OR bukti_transfer IS NOT NULL);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'kasir_setoran'::regclass AND conname = 'kasir_setoran_form_wajib') THEN
    ALTER TABLE kasir_setoran ADD CONSTRAINT kasir_setoran_form_wajib CHECK ((tunai + transfer + giro) = 0 OR no_form_kasir IS NOT NULL);
  END IF;
END $k2a$;
