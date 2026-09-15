-- =====================================================================
-- Konfirmasi manusia bahwa sebuah order BUKAN order ganda.
--
-- Gerbang kemiripan order (lihat `lib/order-duplicate.ts`) menahan order yang
-- outletnya sama dan barangnya MIRIP tetapi tidak persis sama — bentuk ketikan
-- ulang yang paling sering lolos. Yang ditahan hanya bisa dilepas oleh manusia
-- yang menyatakan sudah memeriksanya, dan pernyataan itu harus BERTAHAN:
-- validasi batch dijalankan berulang kali, dan konfirmasi yang hilang tiap kali
-- divalidasi ulang sama saja dengan tidak punya konfirmasi.
--
-- Kuncinya (principal, so_no) dan BUKAN id batch: berkas laporan yang sama bisa
-- diunggah ulang dengan id batch baru, sedangkan SO-nya tetap SO yang itu juga.
-- Mengunci ke batch berarti admin harus mengonfirmasi hal yang sama berkali-kali,
-- dan konfirmasi yang terlalu sering diminta akan ditekan tanpa dibaca.
--
-- Apply: docker exec -i accapi-postgres psql -U accapi -d accapi \
--          -v ON_ERROR_STOP=1 --single-transaction < db/migrations/0017_order_dupe_ack.sql
-- Idempoten dan aditif; tidak menyentuh satu baris data pun.
-- =====================================================================

CREATE TABLE IF NOT EXISTS order_dupe_ack (
    principal text NOT NULL,
    so_no text NOT NULL,
    -- Alasan yang ditahan saat dikonfirmasi, disimpan apa adanya: yang membaca
    -- jejak ini nanti perlu tahu APA yang sudah diperiksa orang itu, bukan hanya
    -- bahwa ada yang menekan tombol.
    reason text NOT NULL DEFAULT '',
    note text NOT NULL DEFAULT '',
    confirmed_by text NOT NULL DEFAULT '',
    confirmed_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (principal, so_no)
);
