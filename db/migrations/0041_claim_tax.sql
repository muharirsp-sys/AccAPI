-- =====================================================================
-- Claim Workflow: klaim ber-PPN/PPh wajib disetujui tim Tax sebelum surat, kwitansi, dan rekap dicetak (owner 6 Nov 2026).
--
--   claim_workflow.tax_status    : NULL (belum dikirim / tanpa pajak) | 'menunggu' | 'dikembalikan' | 'disetujui'
--   claim_workflow.tax_status_at : kapan status Tax terakhir berubah (umur antrean Tax)
--   claim_workflow.tax_note      : catatan Tax (wajib saat dikembalikan)
--   claim_workflow.tax_sidik     : sidik nilai pajak item yang disetujui; nilai berubah sesudahnya = harus disetujui ulang
--
-- Apply otomatis lewat scripts/migrate-pg.mjs (entri "claim_workflow tax_*") saat container start bila DATABASE_MIGRATION_URL
-- terpasang; selain itu jalankan berkas ini sebagai role pemilik SEBELUM image baru:
--   docker exec -i accapi-postgres psql -U accapi -d accapi -v ON_ERROR_STOP=1 --single-transaction < db/migrations/0041_claim_tax.sql
-- Idempoten dan aditif: empat kolom nullable, tanpa UPDATE data. Klaim lama: tax_status NULL; yang sudah Siap dikirim atau lebih
-- tidak terkunci (aturan hanya berlaku saat Draf / Perlu revisi).
-- =====================================================================

ALTER TABLE claim_workflow ADD COLUMN IF NOT EXISTS tax_status TEXT;
ALTER TABLE claim_workflow ADD COLUMN IF NOT EXISTS tax_status_at TIMESTAMP;
ALTER TABLE claim_workflow ADD COLUMN IF NOT EXISTS tax_note TEXT;
ALTER TABLE claim_workflow ADD COLUMN IF NOT EXISTS tax_sidik TEXT;
