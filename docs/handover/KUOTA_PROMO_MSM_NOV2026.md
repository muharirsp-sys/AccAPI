# Kuota promo sell-in MSM — November 2026

Owner 1 Nov 2026: surat 110 (Amago), 278 (Lervia), 168 (Medicare) berlaku untuk penjualan November.

**Amago (110) DIKLAIM** ke MSM untuk porsi beban principal, tanpa kuota: suratnya tidak menyebut sell-in dan potongan beli botol
tidak sesuai surat. Porsi beban distributor (1,5% / 0,75%) biaya sendiri. **Lervia (278) dan Medicare (168) SELL-IN** (surat:
"Sell-In (Discount on invoice)"): diskonnya sudah diterima saat membeli dari MSM, tidak diklaim, dan DIBATASI per SKU:

> budget = qty dibeli dengan diskon sesuai surat − qty yang sudah keluar ke outlet dengan diskon yang sama (sebelum 1 Nov)

Setiap order (Order Baru, Order Sales, tarikan Web Sales) memotong budget. Baris yang qty-nya melebihi sisa **tidak mendapat
diskon**; bonus yang melebihi sisa tidak diberikan. Strata dan minimum dus di surat berlaku untuk qty order outlet.

## 1. Summary November (layar Summary Promo)

Unggah ketiga surat seperti biasa, lalu pada setiap baris:

- `periode_start` 2026-11-01, `periode_end` 2026-11-30.
- Lervia & Medicare: `keterangan` memuat **`kuota beli`** (penanda sell-in berkuota; tanpa frasa ini program berjalan tanpa batas
  dan dimuat sebagai klaim principal). Amago: **jangan** tulis `kuota beli`.
- Porsi **tanggungan distributor** ditandai **D** di benefit (`8+3+1.5D`); komponen lain = beban principal.
- `kode_barangs` dan ketentuan sebagai berikut (KRT = DUS):

| Surat | Barang (kode) | Ketentuan | Benefit |
|---|---|---|---|
| 110/MSM/SL/X/2026 REV 1 | Amago pouch 2L `M6141000200010`, 1,5L `M6141000100110` | Setiap pengambilan, tidak ada minimum | DISC_PCT 8+2 |
| | Botol 750 ml `M6141000075020` | sama | DISC_PCT 8+3+1.5D |
| | Botol 500 ml `M6141000050020` | sama | DISC_PCT 8+8.75+0.75D |
| | Botol 380 ml `M6141000038020` | sama | DISC_PCT 8+4.75+0.75D |
| | Botol 250 ml `M6141000025020` | sama | DISC_PCT 8+7 |
| 278/MSM/MKT/X/2026 | Sabun susu bar 80 gr `M603110[1-6]008010` | Beli 50 / 100 / 500 / 3000 KRT mix varian beda gramasi | DISC_PCT 3 / 4 / 5.5 / 7 |
| | 90 gr BD3 `M6031101009020`, `M6031102009020`, `M6031104009020` | Beli 20 KRT mix varian gramasi sama | DISC_PCT 8 |
| | Cair pouch 400 `M603120[4-9]040040` (6 varian, termasuk Almond Oats) | Beli 60 KRT mix varian gramasi sama | DISC_PCT 10 |
| | Cair botol 200 gr `M6031201025030`, `M6031202025030`, `M6031206025030` | Beli 20 KRT mix varian gramasi sama | DISC_PCT 10 |
| | Lotion 200 ml `M603210[1-3]020010` | Beli 15 KRT mix varian gramasi sama | DISC_PCT 10 |
| 168/MSM/MKT/VII/2026 | Sabun bar 80 gr @72 `M602110[1-5]008010` | Beli 3 KRT berlaku kelipatan | BONUS_QTY 1 KRT |
| | Multipack 60 gr `M602130[1-3]006040` | Beli 20 KRT mix varian gramasi sama | DISC_PCT 10 |
| | Cair pouch 400 ml `M602120[1-5]040020` | Beli 60 KRT mix varian gramasi sama | DISC_PCT 15 |
| | Cair botol 500 ml `M602120[1-5]050030` | Beli 60 KRT mix varian gramasi sama | DISC_PCT 10 |
| | Cair pouch 85 ml `M602120[1-5]008520` | Beli 40 KRT, kelipatan 5 KRT | BONUS_QTY 1 KRT |

Bonus Medicare dihitung per SKU dan otomatis masuk sebagai barang yang sama berdiskon 100%. Sales cukup mengetik qty beli.
"Lervia 90 gr @72" yang bukan BD3 belum punya kode di master MSM.

## Letak diskon di faktur dan Rekap Promo (owner 1 Nov 2026)

- Sell-in di DEPAN (kolom 1..), mis. Lervia `3`. Bukan sell-in + tanggungan distributor di BELAKANG, rata kanan ke kolom 5:
  Amago 750 ml `0+0+1.5+8+3` (kolom 3 distributor, 4-5 principal). Kino, Dahlia, Forisa tetap seperti dulu.
- Aturan Promo dari Summary: satu aturan per komponen (tingkat 101, 102, ...), beban PRINCIPAL / DISTRIBUTOR; program `kuota beli`
  berbeban **SELLIN**.
- Rekap Promo: kartu **Sell-in (tidak diklaim)** terpisah dari Klaim principal; sell-in yang melewati kuota beli (mis. faktur
  diketik langsung di Accurate) = tak bertuan. Klaim principal dihitung sesudah potongan kolom sebelumnya (urutan rantai Accurate).

## 2. Budget (layar Order Masuk › Kuota promo, hanya Lervia & Medicare)

Per surat: unggah **Rincian Faktur Pembelian** dan **Rincian Faktur Penjualan** (keduanya ekspor Accurate dengan kolom `Diskon %`,
cabang MSM, penjualan mencakup sejak pembelian pertama sampai 31 Okt) → Hitung → periksa pola diskon per SKU → Simpan.

Aturan cocok diskon: rantai surat harus muncul berurutan di rantai faktur beli (8+2 cocok dengan 8+2+1; 10 cocok dengan 1+10)
dan di AWAL rantai faktur jual (10 cocok dengan 10+0.5; 3 tidak cocok dengan 6.5+3+1). Bonus "beli M gratis B" dikenali dari
diskon setara B/(M+B) (5+1 = 16,7%) atau baris 100%. Budget bonus = porsi gratisnya.

## Budget final (data 1 Nov 2026)

Sumber: `rincian_faktur_pembelian_cvsuryaperkasa_261101144342.xlsx` (22 Jul–26 Okt) dan
`rincian_faktur_penjualan_cvsuryaperkasa_261101152656.xlsx` (MSM, 24 Jul–31 Okt). Layar Kuota Promo menghitung ulang angka
yang sama dari dua berkas itu.

| SKU | Dibeli berdiskon surat | Sudah keluar | Budget November |
|---|---|---|---|
| Lervia 80 gr Goat Jojoba / Almond Vanilla | 200 / 200 KRT (4+1) | 63 / 60 KRT (7%) | **137 / 140 KRT** |
| Lervia 80 gr Goat Milk / Goat Avocado / Almond S.Butter | 0 (dibeli 1+6 / 1+6,5) | – | **0** |
| Lervia 90 gr BD3 Goat Milk / Goat Avocado / Alm Vanilla | 100 / 100 / 100 KRT (8) | 0 / 42 / 28 KRT | **100 / 58 / 72 KRT** |
| Lervia cair pouch 400 (GM / GA / GJ / AV / ASB) | 400 / 300 / 300 / 120 / 120 KRT | 197,8 / 132 / 96,8 / 27,5 / 28,5 KRT | **202,2 / 168 / 203,2 / 92,5 / 91,5 KRT** |
| Lervia cair botol 200 gr (Milk / Goat Avocado / Goat Jojoba) | 400 / 400 / 250 KRT | 36,5 / 32,3 / 37,3 KRT | **363,5 / 367,7 / 212,7 KRT** |
| Lervia lotion 200 ml (Milk / Avocado / Honey) | 15 / 238 / 247 KRT | 14,4 / 58,1 / 48,7 KRT | **15 BTL / 179,9 / 198,3 KRT** |
| Medicare bar 80 gr (3+1) | 0 (dibeli 1%, tidak ada 3+1) | bonus 100% sudah keluar | **0 — bonus tidak jalan** |
| Medicare multipack 60 gr (FC / GC / EL) | 147 / 126 / 125 KRT (10) | 0 | **147 / 126 / 125 KRT** |
| Medicare cair pouch 400 ml | 0 (dibeli 10%, surat 15%) | – | **0** |
| Medicare cair botol 500 ml (DC / FC / GC / EL / SF) | 18,75 / 41,6 / 17,75 / 8,1 / 39,25 KRT | 0 | sama |
| Medicare cair pouch 85 ml (bonus 5+1, budget = porsi gratis) | 112 / 536 / 512 / 16 / 24 PCH | 0 | sama |

Budget disimpan dalam satuan terkecil (PCS/PCH/BTL/PACK). Order ber-KRT dikonversi lewat rasio master Accurate.
