-- =====================================================================
-- Penjelasan manusia atas SELISIH verifikasi balik faktur (Antrean Faktur,
-- 2026-09-28).
--
-- Faktur yang cocok saat terkirim bisa berselisih belakangan karena dua sebab
-- yang sah, dan keduanya diselesaikan TERPISAH:
--   - jenis 'sales': sales diganti di Accurate (pemetaan sales lama sudah pindah
--     divisi). Cukup diterima.
--   - jenis 'isi'  : isi faktur dikoreksi saat pengiriman (barang, qty, harga,
--     baris). Wajib ada penjelasan.
-- Faktur ganda tidak bisa dijelaskan di sini; itu dibereskan di Accurate.
--
-- `sidik` = temuan persis yang dijelaskan. Verifikasi balik membandingkannya
-- dengan temuan saat ini: kalau fakturnya berubah lagi, penjelasannya tidak
-- berlaku dan selisihnya terbuka kembali.
--
-- Tidak menulis ke Accurate dan tidak mengubah antrean.
--
-- Apply otomatis lewat scripts/migrate-pg.mjs saat container start. Manual:
--   docker exec -i accapi-postgres psql -U accapi -d accapi -v ON_ERROR_STOP=1 \
--     --single-transaction < db/migrations/0024_invoice_verify_note.sql
-- Idempoten dan aditif; tidak menyentuh satu baris data pun.
-- =====================================================================

CREATE TABLE IF NOT EXISTS invoice_verify_note (
    order_id text NOT NULL,
    jenis text NOT NULL CHECK (jenis IN ('sales', 'isi')),
    sidik text NOT NULL,
    note text NOT NULL DEFAULT '',
    decided_by text NOT NULL DEFAULT '',
    decided_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (order_id, jenis)
);
