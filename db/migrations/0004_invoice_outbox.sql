-- =====================================================================
-- Antrean faktur Accurate (outbox) untuk order internal yang sudah dibekukan.
--
-- Kenapa antrean persisten, bukan panggil-langsung-dari-request: satu request
-- pengguna tidak boleh menunggu jaringan Accurate, dan status TIDAK PASTI
-- (timeout setelah kirim) harus bertahan melewati restart supaya tidak ada
-- yang membuat faktur ulang atas order yang mungkin SUDAH terbentuk di sana.
--
-- `payload` dibekukan saat order dimasukkan ke antrean: yang dikirim nanti
-- adalah angka yang sudah ditinjau, bukan hasil hitung ulang saat kirim.
--
-- Identitas dokumen = database Accurate + record id (`accurate_db_id` +
-- `accurate_id`). Nomor faktur (`accurate_number`) HANYA catatan: nomor bisa
-- dipakai ulang oleh Accurate setelah penghapusan, jadi tidak boleh jadi kunci.
--
-- Apply: docker exec -i accapi-postgres psql -U accapi -d accapi \
--          -v ON_ERROR_STOP=1 --single-transaction < db/migrations/0004_invoice_outbox.sql
-- Idempoten dan aditif; tidak menyentuh tabel lain.
-- =====================================================================

CREATE TABLE IF NOT EXISTS invoice_outbox (
    order_id        text        PRIMARY KEY,
    customer_no     text        NOT NULL,
    order_date      date        NOT NULL,
    -- queued | sending | posted | unknown | rejected. `unknown` = tidak ada jawaban
    -- dari Accurate; WAJIB diselesaikan manusia lewat rekonsiliasi charField1.
    state           text        NOT NULL DEFAULT 'queued',
    payload         jsonb       NOT NULL,
    queued_by       text        NOT NULL DEFAULT '',
    accurate_db_id  text        NOT NULL DEFAULT '',
    accurate_id     text        NOT NULL DEFAULT '',
    accurate_number text        NOT NULL DEFAULT '',
    attempts        integer     NOT NULL DEFAULT 0,
    last_error      text        NOT NULL DEFAULT '',
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Pengirim mengambil yang paling lama menunggu lebih dulu.
CREATE INDEX IF NOT EXISTS idx_invoice_outbox_state
    ON invoice_outbox (state, created_at);
