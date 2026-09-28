-- =====================================================================
-- `promo_rule.first_po` — aturan yang hanya berhak untuk PO PERTAMA per outlet per barang.
--
-- Surat BP2609008707 (Kino, 22 Sep 2026): "NKA - INDOMARET LISTING & SUPPORT DISC 3% (FIRST PO)
-- ELLIPS ULTRA LIGHT, SASHA HAIR SHAMPOO". Tanpa penanda ini, 3%-nya membenarkan SETIAP PO
-- Indomaret untuk kedua barang itu selama 15 Sep - 31 Des, padahal surat hanya memberinya sekali.
--
-- Diisi jembatan Summary dari kata "PO pertama" / "FIRST PO" pada ketentuan atau keterangan baris.
-- Dibaca gerbang Order Principal dan Rekap Promo: faktur berikutnya yang membawa potongan yang
-- sama untuk outlet dan barang yang sama tidak dibenarkan aturan ini.
--
-- Aditif: baris lama terisi false, perilakunya tidak berubah. Dijalankan juga oleh
-- scripts/migrate-pg.mjs saat container start.
-- =====================================================================

ALTER TABLE promo_rule ADD COLUMN IF NOT EXISTS first_po boolean NOT NULL DEFAULT false;
