# RECKITT Purchase Reconciliation Design

## Scope

Tambahkan principal RECKITT pada divisi Pembelian di halaman rekonsiliasi
lokal. Pengguna mengunggah Rincian Faktur Pembelian Accurate berformat XLSX
dan `TXN_COMPINV_DTL.csv`. Master mapping RECKITT disimpan internal.

## Exact matching

- Nomor dokumen Accurate adalah tepat satu nomor sepuluh digit dengan pola
  `210\d{7}` dari kolom `REM`.
- Nomor dokumen RECKITT memakai `Invoice No`.
- Produk RECKITT dipetakan exact dari `Product Code` melalui sheet
  `Pvt Map 1`, kolom `Kode Pcpl -> Kode BARANG Win2`.
- Kunci hasil adalah `nomor dokumen + kode barang internal`.
- Tidak ada fuzzy matching atau pencocokan nama.
- Kode mapping tanpa kandidat menjadi `UNMAPPED`; kode dengan lebih dari satu
  barang internal menjadi `INVALID_DATA` pada baris terkait.

## Quantity and amount rules

- Accurate wajib memakai satuan `KRT`.
- Qty Accurate memakai kolom `QTY`.
- Qty RECKITT memakai `Received Product Quantity`.
- `Received Product Quantity` wajib sama dengan `Invoice Quantity UOM`.
- `UOM Code` hanya menerima `CAR` atau `PAC`, dan `Default UOM` wajib `EA`.
- DPP Accurate memakai `DPP`.
- DPP RECKITT memakai `Net Amount`.
- Formula `Net Amount` wajib sama dengan
  `Product List Price × Received Product Quantity` dikurangi
  `Customer Discount Amount`, `Purchase Discount Amount`,
  `No Return Discount Amount`, dan `Discount Allowance Amount`, toleransi Rp1.
- `Total Tax Amount` wajib sama dengan
  `Net Amount × Tax Percentage / 100`, toleransi Rp1.
- Total tiap sumber adalah DPP ditambah pajak. Status perbandingan utama
  memakai qty exact dan DPP dengan toleransi default Rp1.
- Kesalahan baris principal menjadi `INVALID_DATA`; baris valid lain tetap
  diproses.

## Source-specific details

- CSV RECKITT memakai delimiter `|`.
- Nilai kosong numerik yang bersifat diskon/pajak dibaca sebagai nol; qty,
  invoice, produk, harga, dan Net Amount wajib tersedia.
- Kolom PPN Accurate adalah pajak tingkat dokumen yang berulang pada setiap
  baris. Pajak Accurate dialokasikan proporsional berdasarkan DPP pada setiap
  `NO. PEMBELIAN`; satu dokumen wajib memiliki satu nilai PPN konsisten.
- Master internal disimpan sebagai
  `data/reconciliation/RECKITT_PURCHASE.xlsx`.
- SHA-256 master sumber adalah
  `19E3C171FDB48F06A58DA8C4572491218FE4723D9264F8691663C6B09A26CEBB`.

## Output, API, and UI

Output memakai kontrak status Pembelian yang sudah ada:
`MATCH`, `QTY_MISMATCH`, `VALUE_MISMATCH`,
`QTY_AND_VALUE_MISMATCH`, `MISSING_ACCURATE`,
`MISSING_PRINCIPAL`, `UNMAPPED`, dan `INVALID_DATA`.

Endpoint `POST /api/reconciliation/reckitt/purchases` menerima tepat satu
`accurateFile` XLSX dan satu `principalFile` CSV. Otorisasi
`reconciliation.run` terjadi sebelum multipart dibaca. Pesan error format
file unggahan yang dikenal dapat menjadi 422, sedangkan kegagalan master
internal tetap dimask sebagai 500.

Pada divisi Pembelian, pilihan principal berisi GODREJ dan RECKITT. GODREJ
tetap default. RECKITT memakai label `TXN_COMPINV_DTL RECKITT`, hasil masalah
ditampilkan lebih dahulu, dan ekspor bernama
`rekonsiliasi-pembelian-reckitt-YYYY-MM-DD.xlsx`.

## Acceptance

- Accurate: 16 dokumen dan 118 baris.
- RECKITT: 58 dokumen dan 792 baris.
- Seluruh 16 dokumen Accurate overlap dengan tepat 118 baris pada kedua
  sumber.
- Hasil nyata adalah 118 `MATCH`, 674 `MISSING_ACCURATE`, status lain nol,
  dan total 792 hasil.
- Seluruh hasil memiliki nomor baris sumber.
- Engine, route, TypeScript, lint, build, dan test UI lulus.
- Tidak ada dependency baru, fuzzy matching, perubahan `.codex/`, atau push
  ke GitHub.
