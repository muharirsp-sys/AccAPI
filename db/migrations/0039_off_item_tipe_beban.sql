-- =====================================================================
-- OFF Program Control: alasan tipe "Lainnya" dan beban per item (owner 3 Nov 2026).
--
--   type_note : alasan wajib bila tipe program "Lainnya"; untuk data lama yang tipenya tidak dikenali berisi tipe asalnya.
--   beban     : 'CL' = ditagih ke principal lewat Claim Workflow | 'DM' = beban distributor (dana marketing/SDS),
--               tidak dibuat klaim dan tidak wajib No Claim saat verifikasi final. NULL = data lama = CL.
--
-- Apply otomatis lewat scripts/migrate-pg.mjs (entri "off_batch_item.type_note + beban") saat container start bila
-- DATABASE_MIGRATION_URL terpasang; selain itu jalankan berkas ini sebagai role pemilik SEBELUM image baru:
--   docker exec -i accapi-postgres psql -U accapi -d accapi -v ON_ERROR_STOP=1 \
--     --single-transaction < db/migrations/0039_off_item_tipe_beban.sql
-- Idempoten dan aditif: dua kolom nullable, tanpa UPDATE data, tidak menyentuh tabel lain.
-- =====================================================================

ALTER TABLE off_batch_item ADD COLUMN IF NOT EXISTS type_note TEXT;
ALTER TABLE off_batch_item ADD COLUMN IF NOT EXISTS beban TEXT;
