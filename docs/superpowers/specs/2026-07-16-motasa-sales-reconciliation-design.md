# Desain Rekonsiliasi Faktur MOTASA

## Tujuan

Menambahkan principal MOTASA ke halaman rekonsiliasi faktur lokal yang sama dengan KINO, GODREJ, dan SHINZUI. Pengguna memilih MOTASA, mengunggah laporan Accurate dan Sales Order MOTASA, lalu melihat hasil yang fokus pada selisih beserta penyebab dan baris sumbernya.

## Batasan

- Lokal saja; tidak mengubah `main`, push, atau deploy.
- Tidak membuat halaman, engine, atau format ekspor baru.
- Tidak menambah dependency.
- Master mapping tidak diunggah pengguna. Aplikasi membaca salinan lokal `data/reconciliation/MOTASA.xlsx`.
- Customer dan salesman tidak menentukan status rekonsiliasi. Keduanya tetap dibaca untuk audit.
- Seluruh baris Accurate tetap diperiksa. Data Accurate yang tidak ada di laporan MOTASA menghasilkan `MISSING_PRINCIPAL` dan tidak diabaikan.

## Sumber Data

### Accurate

- File contoh: `rincian_faktur_penjualan_cvsuryaperkasa_260716100112.xlsx`.
- Sheet: `Rincian Faktur Penjualan`, header baris 1.
- 402 baris, 113 invoice/referensi, dan 9 SKU.
- Seluruh transaksi bertipe `1. Penjualan Bruto` dan bertanggal 14 Juli 2026.

### MOTASA

- File contoh: `SalesOrder-2026-07-14 08_37_47.xlsx`.
- Sheet: `Sheet1`, header baris 1.
- 14 baris, 4 nomor referensi, 4 customer, dan 6 SKU.
- Seluruh transaksi bertipe `SD` dan bertanggal 14 Juli 2026.
- `No.INV` berfungsi sebagai nomor order/referensi yang cocok dengan `REM` Accurate, bukan dengan `NO_NOTA` Accurate.

### Mapping

- File contoh: `FIX_FORM MASTER BARANG - MOTASA.xlsx`.
- Sumber authoritative adalah sheet `Form Fix`, header baris 5, data MOTASA baris 6-20.
- Gunakan `Kode BARANG Win2` sebagai kode SKU internal, `ISI/CTN` sebagai faktor konversi, dan `SATUAN Fix Win` sebagai satuan kecil.
- Seluruh kode diperlakukan sebagai teks agar leading zero tidak hilang.
- `Fix Mapping` dan `Query Map.BrgDoubleDms` tidak dipakai sebagai fallback karena merupakan hasil turunan yang tidak lengkap atau stale.

## Arsitektur

Gunakan parser MOTASA khusus di atas engine rekonsiliasi bersama yang sudah ada:

- Reuse parser Accurate, canonical sales line, agregasi, status, toleransi, upload handler XLSX, tampilan hasil, dan ekspor.
- Tambahkan hanya parser mapping MOTASA, parser Sales Order MOTASA, fungsi reconcile MOTASA, endpoint MOTASA, dan pilihan MOTASA pada UI.
- Jangan membuat engine MOTASA terpisah atau konfigurasi principal generik. Format principal yang sudah didukung masih memiliki aturan bisnis berbeda, sehingga generalisasi tersebut belum diperlukan.
- Nama kompatibilitas lama seperti `kinoLines` dan handler upload KINO tidak diubah karena tidak memengaruhi fungsi.

## Normalisasi dan Kunci Rekonsiliasi

- Ekstrak tepat satu token dengan pola `MK\d{10}` dari `No.INV` MOTASA dan `REM` Accurate.
- Teks tambahan seperti `<PF>` pada `REM` diabaikan setelah token ditemukan.
- Pencocokan menggunakan `token MK + kode SKU internal + kelas transaksi`.
- Kode produk MOTASA sudah memakai kode internal yang sama dengan `KODE_BARANG` Accurate; mapping kode principal tidak diperlukan untuk file ini.
- `SD` dipetakan ke kelas transaksi `NORMAL`. Tipe lain ditolak karena belum memiliki aturan yang disetujui.

## Quantity dan Satuan

- `SATUAN = KRT`: quantity kecil = `PRD_QTY x ISI/CTN`.
- `SATUAN = SCH`: quantity kecil = `PRD_QTY`.
- Satuan canonical memakai `SATUAN Fix Win` dari mapping dan harus cocok dengan `SATUAN_KECIL` Accurate bila pasangan Accurate tersedia.
- `ISI/CTN` wajib numerik dan lebih besar dari nol.
- SKU yang tidak ada dalam master menghasilkan `UNMAPPED_SKU`.
- `ISI/CTN` atau satuan yang tidak dapat dikonversi menghasilkan `UNIT_CONVERSION_ERROR`.

## Perhitungan Nilai

Kolom MOTASA yang wajib tersedia:

- Identitas: `Tipe`, `No.INV`, `TGL.INV`, `CODE CUST`, `CODE SALES`, dan `KODE PRODUK`.
- Quantity dan satuan: `PRD_QTY`, `SATUAN`, dan `Harga`.
- Diskon: `Disc. 1`, `Disc. 2`, `Disc. 3`, `Disc. 4`, `Disc. 5`, dan `FIX DISC. VALUE`.

Rumus canonical MOTASA:

1. `harga_bulat = round(Harga, 1)`.
2. `gross = PRD_QTY x harga_bulat`.
3. `saldo_persen` diperoleh dengan menerapkan `Disc. 1` sampai `Disc. 5` secara bertingkat pada saldo yang tersisa.
4. `discount = gross - saldo_persen + FIX DISC. VALUE`.
5. `DPP = saldo_persen - FIX DISC. VALUE`.
6. DPP tidak boleh negatif.
7. `PPN = DPP x 11%`.
8. `net = DPP + PPN`.

`TAX_PERC1` pada format contoh bernilai nol dan tidak dipakai sebagai tarif pajak karena seluruh pasangan Accurate menerapkan PPN 11%. Harga dibulatkan satu desimal sebelum gross agar sama dengan presisi harga Accurate dan tidak menghasilkan selisih palsu. Komponen uang dibulatkan ke skala empat desimal hanya setelah seluruh tahap perhitungan baris selesai, bukan pada setiap tahap diskon.

Setiap persentase diskon harus berada pada rentang 0-100. Quantity, harga, dan fixed discount tidak boleh negatif. Fixed discount tidak boleh membuat DPP negatif. Perbandingan antar sumber tetap menggunakan toleransi nilai Rp1 pada bruto, diskon, DPP, pajak, dan netto.

## Cakupan dan Status Hasil

Engine memakai union seluruh key dari kedua sumber:

- Pasangan lengkap dan sama: `MATCH`.
- Quantity berbeda: `QTY_MISMATCH`.
- Komponen nilai berbeda: `VALUE_MISMATCH`.
- Quantity dan nilai berbeda: `QTY_AND_VALUE_MISMATCH`.
- Hanya ada di MOTASA: `MISSING_INTERNAL`.
- Hanya ada di Accurate: `MISSING_PRINCIPAL`.
- Mapping/satuan/data bermasalah: status mapping yang sudah tersedia.

Pada file contoh, 14 baris MOTASA memiliki pasangan quantity dan nilai yang cocok. Sebanyak 388 baris Accurate di luar empat order MOTASA tetap ditampilkan sebagai `MISSING_PRINCIPAL`.

## API dan UI

- Tambah endpoint `POST /api/reconciliation/motasa/sales`.
- Endpoint memakai permission `reconciliation.run`, validasi `.xlsx`, batas ukuran, pemeriksaan ZIP, dan pesan parser aman yang sama dengan principal lain.
- Tambah `MOTASA` pada tipe dan selector principal.
- Label upload, endpoint, nama principal pada penyebab/baris sumber, filter, dan nama ekspor mengikuti pilihan MOTASA.
- Bila ada masalah, hasil default tetap `Hanya bermasalah` dan langsung menampilkan penyebab selisih.
- Ekspor tetap memuat seluruh hasil, bukan hanya filter layar, agar audit lengkap tidak hilang.
- Ekspektasi nama ekspor: `hasil-rekonsiliasi-motasa-YYYY-MM-DD.xlsx`.

## Penanganan Error

Hentikan seluruh permintaan dengan pesan aman HTTP 422 bila file principal tidak dapat dipercaya, termasuk:

- sheet atau header wajib tidak tersedia;
- `No.INV` MOTASA atau `REM` Accurate tidak memuat tepat satu token MK;
- tipe transaksi bukan `SD`;
- quantity, harga, diskon, atau fixed discount tidak valid;
- rumus menghasilkan DPP negatif.

Masalah yang hanya mengenai satu key tetap menjadi hasil HTTP 200 agar barang lain dapat dibandingkan, termasuk SKU tidak terpetakan, konversi satuan tidak dapat ditentukan, dan data yang hanya ada pada satu sumber. Master mapping lokal yang hilang menghasilkan HTTP 500 dengan pesan `Master mapping MOTASA tidak tersedia.` Pesan internal yang tidak dikenal tetap disamarkan.

## Verifikasi

- Tes parser/reconcile sintetis mencakup token MK dalam `REM` berakhiran `<PF>`, KRT x `ISI/CTN`, SCH langsung, harga satu desimal, diskon bertingkat, fixed discount, PPN 11%, dan strict union.
- Tes batas input membedakan file master hilang sebagai HTTP 500, SKU tidak ada sebagai `UNMAPPED_SKU`, `ISI/CTN` tidak positif atau unit asing sebagai `UNIT_CONVERSION_ERROR`, dan mapping konflik sebagai `INVALID_DATA`. Tipe selain `SD`, diskon di luar 0-100, dan nilai negatif ditolak sebagai input tidak valid.
- Acceptance tiga file nyata harus menghasilkan 402 hasil: 14 `MATCH`, 388 `MISSING_PRINCIPAL`, dan status lain nol.
- Tes UI terarah mencakup pilihan MOTASA, label upload, endpoint, fokus masalah, penyebab MOTASA, baris sumber, dan ekspor.
- Tes handler yang ada ditambah satu pemeriksaan pesan parser MOTASA yang aman; route tidak memerlukan suite duplikat.
- Jalankan lint pada file tersentuh dan build/typecheck yang tersedia. KINO, GODREJ, dan SHINZUI tidak boleh mengalami regresi.

## Di Luar Cakupan

- Deploy, push, atau perubahan `main`.
- Refactor nama/type lama yang hanya bersifat kosmetik.
- Engine atau halaman khusus MOTASA.
- Mapping fuzzy berdasarkan nama barang.
- Dukungan tipe transaksi selain `SD` atau tarif pajak selain aturan 11% yang telah disetujui.
