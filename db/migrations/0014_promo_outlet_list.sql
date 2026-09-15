-- =====================================================================
-- Daftar outlet peserta program — butir 4.12 lanjutan.
--
-- Kenapa perlu: surat program menyebut PESERTA, bukan hanya barang. Tiga surat
-- September 2026 mengatakannya hitam di atas putih:
--   BP2609007713 (Resik V) : "PROGRAM INI KHUSUS CHANNEL GT PESERTA LOYALTY"
--   BP2609007664 (Ovale)   : "PROGRAM INI KHUSUS CHANNEL GT PESERTA LOYALTY"
--   BP2609006016 (MSG)     : "KHUSUS CHANNEL GT EXCLUDE LOYALTY DAN CONTRACTUAL"
-- Sampai sekarang gerbang tidak punya cara menyatakan itu, jadi bonus Resik V
-- akan sama sahnya di outlet mana pun — padahal daftarnya ada, hanya hidup di
-- Excel seorang admin.
--
-- Datanya sendiri sudah membuktikan aturan itu nyata. Atas 149 faktur September:
-- SETIAP outlet yang menerima bonus 100% adalah peserta loyalty, dan SETIAP
-- outlet yang menerima potongan MSG bukan peserta. Tidak ada satu pun kekecualian.
--
-- Kenapa TABEL TERSENDIRI, bukan disalin ke tiap aturan: satu daftar dipakai tiga
-- surat sekaligus. Menyalinnya berarti 41 outlet x 3 surat = 123 baris yang harus
-- diperbarui bersamaan tiap kuartal, dan satu yang tertinggal berarti dua jawaban
-- tentang outlet yang sama. Aturan MENUNJUK daftar; daftarnya satu.
--
-- Kenapa PERIODE ada di ANGGOTA, bukan di nama daftar: keanggotaan loyalty berganti
-- tiap kuartal sedangkan suratnya menyebut "LOYALTY" begitu saja. Kalau periodenya
-- ikut ke nama ("LOYALTY 2026-Q3"), seluruh aturan harus ditunjuk ulang tiap tiga
-- bulan — pekerjaan yang pasti terlupakan sekali, dan sekali itu cukup.
--
-- `outlet_list` KOSONG = aturan berlaku untuk semua outlet (perilaku lama, seluruh
-- 234 baris yang sudah termuat). Terisi = aturan hanya berlaku bagi peserta daftar
-- itu (INCLUDE) atau justru bagi yang BUKAN peserta (EXCLUDE).
--
-- Apply: docker exec -i accapi-postgres psql -U accapi -d accapi \
--          -v ON_ERROR_STOP=1 --single-transaction < db/migrations/0014_promo_outlet_list.sql
-- Idempoten dan aditif; tidak menyentuh satu baris data pun.
-- =====================================================================

CREATE TABLE IF NOT EXISTS promo_outlet (
    id bigserial PRIMARY KEY,
    -- Nama daftar TANPA periode, mis. "LOYALTY". Periodenya ada di baris anggota.
    list_name text NOT NULL,
    -- Kode internal Accurate TANPA akhiran cabang (C-WIN013), sama seperti kolom
    -- `promo_rule.customer_code`. Faktur membawa C-WIN013-KN, jadi dicocokkan
    -- dengan awalan — kode cabang tidak boleh ikut menentukan keanggotaan.
    customer_code text NOT NULL,
    customer_name text NOT NULL DEFAULT '',
    -- PLATINUM/GOLD/SILVER. KETERANGAN saja: tidak satu pun surat September
    -- membedakan tingkatnya, jadi ia tidak boleh ikut menentukan kecocokan.
    tier text NOT NULL DEFAULT '',
    -- CUST_ID2 milik principal, disimpan supaya baris ini bisa diadu kembali dengan
    -- `principal_mapping` saat daftarnya dimuat ulang kuartal depan.
    source_code text NOT NULL DEFAULT '',
    period_start date,
    period_end date,
    active boolean NOT NULL DEFAULT true,
    note text NOT NULL DEFAULT '',
    imported_by text NOT NULL DEFAULT '',
    imported_at timestamptz NOT NULL DEFAULT now()
);

-- Satu outlet hanya boleh tercatat sekali per daftar: dua baris untuk outlet yang
-- sama berarti dua pernyataan tentang keanggotaan yang sama.
CREATE UNIQUE INDEX IF NOT EXISTS idx_promo_outlet_key
    ON promo_outlet (list_name, customer_code);
CREATE INDEX IF NOT EXISTS idx_promo_outlet_list ON promo_outlet (list_name);

ALTER TABLE promo_rule ADD COLUMN IF NOT EXISTS outlet_list text NOT NULL DEFAULT '';
-- INCLUDE = hanya peserta daftar. EXCLUDE = semua KECUALI peserta daftar.
-- Kosong = tidak dibatasi daftar mana pun.
ALTER TABLE promo_rule ADD COLUMN IF NOT EXISTS outlet_list_mode text NOT NULL DEFAULT '';
