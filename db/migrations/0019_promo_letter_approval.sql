-- =====================================================================
-- PERSETUJUAN SURAT sebelum publikasi Summary boleh menjadi aturan promo.
--
-- Sampai sekarang jembatan Summary -> `promo_rule` hanya menuntut satu hal:
-- detailnya sudah DITERBITKAN. Menerbitkan memang pernyataan "saya sudah
-- memeriksa ini", tetapi yang memeriksanya satu orang, di layar, tanpa jejak
-- apa pun di luar sistem. Aturan yang lahir dari situ menahan faktur sungguhan
-- dan mengesahkan potongan sungguhan.
--
-- Dua syarat baru, dan keduanya diminta pengguna 2026-09-15:
--
--   1. CENTANG bahwa programnya sudah benar dan bisa berjalan. Bukan tombol
--      "terbitkan" yang sudah ada, melainkan pernyataan terpisah SESUDAH orang
--      melihat simulasinya — apa yang akan terbaca sistem, dan apa yang akan
--      ditolaknya. Yang dicentang tanpa melihat simulasi tidak menambah apa pun.
--
--   2. BUKTI TANDA TANGAN: PDF surat yang sudah ditandatangani OM dan tim.
--      Inilah yang membedakan "programnya benar menurut sistem" dari
--      "programnya memang disetujui orang yang berwenang". Sistem tidak bisa
--      menilai yang kedua, jadi ia menyimpan buktinya dan menolak berjalan
--      tanpa itu.
--
-- Berkasnya disimpan di kolom `bytea`, bukan di cakram container: container
-- dibuat ulang tiap deploy dan berkas di dalamnya ikut hilang. Polanya sudah
-- dipakai tabel lain di basis data ini. Dibatasi 15 MB oleh route-nya.
--
-- KUNCINYA `draft_id` (id publikasi), BUKAN nomor surat: satu surat punya
-- banyak detail yang diterbitkan sendiri-sendiri, dan tiap detail adalah
-- keputusan sendiri. Kunci per nomor surat berarti menyetujui satu detail
-- diam-diam menyetujui seluruh sisanya.
--
-- Apply: docker exec -i accapi-postgres psql -U accapi -d accapi \
--          -v ON_ERROR_STOP=1 --single-transaction < db/migrations/0019_promo_letter_approval.sql
-- Idempoten dan aditif; tidak menyentuh satu baris data pun.
-- =====================================================================

CREATE TABLE IF NOT EXISTS promo_letter_approval (
    draft_id        text PRIMARY KEY,
    surat_program   text NOT NULL DEFAULT '',
    principal       text NOT NULL DEFAULT '',

    -- Centang manusia. `confirmed_at` ikut disimpan supaya "disetujui sebelum
    -- atau sesudah simulasinya berubah" bisa dijawab tanpa menebak.
    confirmed       boolean NOT NULL DEFAULT false,
    confirmed_by    text NOT NULL DEFAULT '',
    confirmed_at    timestamptz,
    note            text NOT NULL DEFAULT '',

    -- Bukti tanda tangan.
    file_name       text NOT NULL DEFAULT '',
    file_hash       text NOT NULL DEFAULT '',
    file_size       integer NOT NULL DEFAULT 0,
    file_bytes      bytea,
    uploaded_by     text NOT NULL DEFAULT '',
    uploaded_at     timestamptz
);

CREATE INDEX IF NOT EXISTS idx_promo_letter_approval_surat
    ON promo_letter_approval (surat_program);
