-- =====================================================================
-- Simpanan hasil OCR surat program (Mistral OCR 4.1).
--
-- Kenapa perlu: OCR dibayar PER HALAMAN, dan mengunggah ulang surat yang sama
-- adalah hal yang wajar — pesan galat kita sendiri yang menyuruhnya ("kode
-- distributor 1209999 tidak ada di lampiran; yang ada: ..."), dan orang akan
-- membetulkan kodenya lalu mengunggah berkas yang sama sekali lagi. Tanpa
-- simpanan ini, tiap percobaan itu ditagih ulang untuk dokumen yang isinya
-- persis sama.
--
-- Kuncinya HASH ISI BERKAS, bukan nama berkasnya: surat yang sama sering
-- dikirim ulang dengan nama berbeda, dan nama berbeda dengan isi sama tidak
-- boleh membuat kita membayar dua kali. Model dan versi pipeline ikut jadi
-- kunci supaya ganti prompt/skema tidak diam-diam memakai hasil lama.
--
-- Isinya HASIL BACA, bukan dokumennya. Berkas suratnya sendiri tidak disimpan.
--
-- Apply: docker exec -i accapi-postgres psql -U accapi -d accapi \
--          -v ON_ERROR_STOP=1 --single-transaction < db/migrations/0015_promo_letter_ocr.sql
-- Idempoten dan aditif; tidak menyentuh satu baris data pun.
-- =====================================================================

CREATE TABLE IF NOT EXISTS promo_letter_ocr (
    source_hash text NOT NULL,
    model text NOT NULL,
    pipeline_version text NOT NULL,
    -- { pages: string[], rows: [...], warnings: string[], pageCount: number }
    result jsonb NOT NULL,
    page_count integer NOT NULL DEFAULT 0,
    created_by text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (source_hash, model, pipeline_version)
);
