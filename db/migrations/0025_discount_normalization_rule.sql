-- =====================================================================
-- Normalisasi Diskon wajib menyebut ATURAN PROMO dasarnya (2026-10-01).
--
-- Sebelumnya potongan tak bertuan bisa digolongkan jadi Disc Claim atau Disc
-- Distributor tanpa dasar apa pun. Sekarang keputusan menunjuk satu baris
-- `promo_rule` yang berlaku untuk potongan itu (principal, periode, outlet,
-- barang, beban) — dipilih di layar, diperiksa ulang saat simpan, dan diperiksa
-- lagi oleh Rekap Promo setiap kali rekap dihitung.
--
-- NULL-able dan TANPA foreign key, sengaja:
--   - keputusan lama (sebelum kolom ini ada) tetap tersimpan, tetapi Rekap Promo
--     TIDAK memakainya: tanpa rujukan program ia tidak sah (keputusan pengguna
--     2 Okt 2026). Potongannya kembali tak bertuan sampai diputuskan ulang;
--   - impor aturan MENGGANTI irisannya (hapus + sisip, id baru). FK akan
--     menahan impor itu atau ikut menghapus keputusannya. Karena itu keputusan
--     merujuk lewat KUNCI aturan; yang kuncinya hilang tidak dipakai rekap.
--
-- Apply otomatis lewat scripts/migrate-pg.mjs saat container start. Manual:
--   docker exec -i accapi-postgres psql -U accapi -d accapi -v ON_ERROR_STOP=1 \
--     --single-transaction < db/migrations/0025_discount_normalization_rule.sql
-- Idempoten dan aditif; tidak menyentuh satu baris data pun.
-- =====================================================================

ALTER TABLE discount_normalization ADD COLUMN IF NOT EXISTS promo_rule_id bigint;
-- Rujukan UTAMA: kunci alami aturan (principal, surat, kelompok, barang, outlet, tingkat) =
-- kolom indeks unik idx_promo_rule_key, disimpan sebagai teks JSON (lib/promo-recap `kunciAturan`).
-- Impor yang mengganti id aturan tidak memutus keputusan selama kuncinya sama; isi aturannya tetap
-- dinilai ulang tiap rekap. promo_rule_id tetap disimpan sebagai jejak.
ALTER TABLE discount_normalization ADD COLUMN IF NOT EXISTS promo_rule_key text;
