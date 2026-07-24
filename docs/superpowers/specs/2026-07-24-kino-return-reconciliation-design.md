# Desain Rekonsiliasi Return KINO

## Tujuan

Menambahkan principle KINO ke divisi Return pada halaman rekonsiliasi lokal yang
sudah mendukung SHINZUI. Pengguna mengunggah dua laporan:

1. `Rincian Faktur Penjualan` dari Accurate.
2. `SALES_DETAIL` dari KINO.

Master mapping disimpan internal dan tidak perlu diunggah setiap proses.

## Sumber Data

- Accurate: sheet `Rincian Faktur Penjualan`.
- KINO: sheet `Sheet1`.
- Mapping: salinan persis workbook
  `FIX_FORM MASTER BARANG - KINO NON FOOD.xlsx`, disimpan sebagai
  `data/reconciliation/KINO_RETURN.xlsx`.
- Mapping produk KINO memakai sheet `Table Pvt 1` sebagai sumber utama:
  - `Kode Pcpl` = `PRODUCT_CODE` KINO.
  - `Kode Barang Win` = `KODE_BARANG` Accurate.
  - `SATUAN Fix Win` dan `ISI/CTN` hanya informasi mapping; kuantitas laporan
    sampel sudah dalam unit kecil sehingga tidak dikalikan isi karton.
- Kode principal yang tidak tersedia di `Table Pvt 1` dilengkapi dari
  `Fix Mapping` (`PCPL KODE 1..5` ke `KODE BARANG`). Pasangan yang konflik
  ditolak; parser tidak memilih kandidat pertama.

## Filter dan Normalisasi

### Accurate

- Hanya baris `JENIS_TRANSAKSI` yang memuat `RETUR PENJUALAN`.
- Nomor invoice KINO diambil dari tepat satu pola `1671-SRI-\d+` pada `REM`.
- Jika pola tidak ditemukan atau lebih dari satu, baris tetap ditampilkan
  sebagai `INVALID_DATA`; proses keseluruhan tidak gagal.
- Untuk `INVALID_DATA`, `NO_NOTA` dipakai sebagai nomor referensi tampilan.
- Kuantitas, DPP, pajak, dan jumlah dinormalisasi menjadi nilai absolut.

### KINO

- Hanya baris dengan `INVOICE_TYPE = RET01`.
- Baris total seperti `Total for ...` dan `Grand Total` diabaikan.
- Nomor invoice memakai `INVOICE_NO`.
- Pelanggan memakai `CUSTCODE2`.
- Produk memakai `PRODUCT_CODE`, lalu dipetakan ke kode Accurate melalui
  `Table Pvt 1`.
- Kuantitas, DPP, pajak, dan total dinormalisasi menjadi nilai absolut.
- DPP dihitung dari nilai bertanda:
  `INVOICE_GROSS - INVOICE_TOTALLINEDISC - INVOICE_PROMO - INVOICE_CASHDISC`,
  kemudian diabsolutkan.
- Pajak memakai `INVOICE_TAX`; total memakai `INVOICE_NET`.

## Kunci dan Rumus Rekonsiliasi

Kunci baris normal:

`nomor invoice KINO + kode pelanggan + kode produk Accurate hasil mapping`

Baris dengan kunci sama dijumlahkan terlebih dahulu.

- Selisih kuantitas:
  `qty Accurate - qty KINO`.
- Selisih DPP:
  `DPP Accurate - DPP KINO`.
- Kuantitas harus sama persis.
- DPP dianggap sama jika selisih absolut maksimal Rp1.
- Pajak dan total sesudah pajak ditampilkan sebagai informasi, tetapi tidak
  menentukan status.

Status memakai kontrak Return yang sudah ada:

- `MATCH`
- `QTY_MISMATCH`
- `VALUE_MISMATCH`
- `QTY_AND_VALUE_MISMATCH`
- `MISSING_ACCURATE`
- `MISSING_PRINCIPAL`
- `UNMAPPED`
- `INVALID_DATA`

Semua baris Accurate tetap diperiksa. Data Accurate yang pasangan
invoice+pelanggannya tidak ada di SALES_DETAIL KINO menjadi
`MISSING_PRINCIPAL` tanpa menebak produk. `UNMAPPED` hanya digunakan bila
invoice+pelanggan tersedia di KINO tetapi produk tidak dapat dipetakan. Data
tanpa nomor invoice KINO menjadi `INVALID_DATA`. Data tersebut tidak
disembunyikan.

## API dan UI

- Endpoint baru: `POST /api/reconciliation/kino/returns`.
- Field upload tetap `accurateFile` dan `principalFile`.
- Otorisasi tetap memakai permission `reconciliation.run`.
- Return principle selector berisi `SHINZUI` dan `KINO`.
- Memilih KINO mengubah label file principle menjadi `Sales Detail KINO`.
- Perubahan principle/divisi membersihkan file, hasil, filter, dan error lama.
- Hasil default fokus pada masalah jika ada.
- Tabel dan ekspor memakai kolom Return yang sama: invoice, pelanggan, kode
  produk kedua sumber, qty, DPP, pajak, total, penyebab, dan baris sumber.
- Nama ekspor membedakan principle, misalnya
  `rekonsiliasi-return-kino-YYYY-MM-DD.xlsx`.
- Faktur, Return SHINZUI, Pembelian pasif, dan tiga tema tidak boleh berubah.

## Acceptance Data Nyata

Dengan tiga workbook yang diberikan:

- 42 baris retur Accurate dibaca.
- 10 baris `RET01` KINO dibaca.
- 10 kode produk KINO berhasil dipetakan.
- Hasil yang diharapkan:
  - `MATCH = 10`
  - `MISSING_PRINCIPAL = 14`
  - `INVALID_DATA = 18`
  - status lain `0`
- Sepuluh baris yang cocok memiliki:
  - total qty `17`
  - total DPP `293828.8287`
  - total pajak `18655.4053`
  - total sesudah pajak `312484.2340`

## Batasan

- Tidak memakai tanggal sebagai kunci.
- Tidak mengabaikan baris Accurate hanya karena invoice tidak ada di file KINO.
- Tidak menambah dependency, database hasil, histori, atau halaman baru.
- Tidak mengubah divisi Pembelian.
- Semua pekerjaan dan commit hanya pada `main` lokal; tidak push ke GitHub.
