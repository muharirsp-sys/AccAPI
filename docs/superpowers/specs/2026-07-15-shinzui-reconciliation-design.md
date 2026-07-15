# Desain Rekonsiliasi Faktur SHINZUI

## Tujuan

Menambahkan principal SHINZUI ke halaman rekonsiliasi faktur lokal yang sama dengan KINO dan GODREJ. Pengguna memilih SHINZUI, mengunggah laporan Accurate dan laporan principal, lalu melihat hasil yang fokus pada selisih beserta penyebab dan baris sumbernya.

## Batasan

- Lokal saja; tidak ada push atau deploy.
- Tidak membuat halaman atau tabel hasil baru.
- Tidak menambah dependency.
- Master mapping tidak diunggah pengguna. Aplikasi membaca salinan lokal `data/reconciliation/SHINZUI.xlsx`.
- Customer dan salesman tidak menentukan status pada tahap ini karena tidak ada master salesman dan skema kode antarsumber berbeda.

## Sumber Data

### Accurate

- File contoh: `rincian_faktur_penjualan_cvsuryaperkasa_260715100633.xlsx`.
- Sheet: `Rincian Faktur Penjualan`, header baris 1.
- 166 baris, 25 faktur, 49 SKU.
- Seluruh transaksi Accurate bertipe `1. Penjualan Bruto`.

### SHINZUI

- File contoh: `SHINZUI (2).xlsx`.
- Sheet: `PenjualanInvoice`, header baris 4.
- 181 baris, 30 invoice, 57 SKU.
- Tipe transaksi: 156 `JUAL`, 10 `PROMO`, 15 `RETUR`.

### Mapping

- File contoh: `FIX FORM MASTER BARANG - SHINZUI.xlsx`.
- Gunakan sheet statis `Pvt Map 1`, header baris 1.
- `Kode Pcpl` adalah SKU principal; wajib diperlakukan sebagai teks agar nol di depan tidak hilang.
- `Kode BARANG Win2` adalah SKU internal Accurate.
- `SATUAN Fix Win` adalah satuan kecil canonical.
- `ISI/CTN` wajib positif dan numerik pada baris mapping yang dipakai.
- Abaikan baris yang seluruh kolom pentingnya kosong, `0`, atau `(blank)`; mapping setengah terisi tetap ditolak.
- Banyak SKU principal boleh menuju satu SKU Accurate. Satu SKU principal menuju banyak SKU Accurate harus diselesaikan memakai konteks invoice dan produk Accurate; jika tidak tepat satu kandidat, baris tetap diproses sebagai hasil `INVALID_DATA` (HTTP 200).

## Normalisasi dan Kunci Rekonsiliasi

- Ekstrak tepat satu token invoice dengan pola `INVGTS\d+-\d+-\d+` dari `REM` Accurate dan `INV Num` SHINZUI.
- Pencocokan menggunakan `invoice token + SKU internal + kelas transaksi`.
- `JUAL` dan `PROMO` dipetakan ke `NORMAL`. Keputusan ini diperlukan karena 10 PROMO bernilai nol memiliki pasangan Accurate yang dicatat sebagai penjualan biasa.
- `RETUR` dipetakan ke `RETURN`. Qty dan nilai negatif dari sumber dipertahankan; jangan dinegatifkan lagi.

## Quantity dan Satuan

- Quantity canonical principal memakai `Qty Small`.
- Satuan canonical memakai `SATUAN Fix Win` dari mapping; `Uom Small` principal tidak dibandingkan mentah karena hanya berupa unit umum seperti PCS/PAK.
- Bandingkan satuan mapping dengan `SATUAN_KECIL` Accurate hanya bila pasangan Accurate tersedia.
- Satuan berbeda menghasilkan `UNIT_CONVERSION_ERROR`.
- Pasangan Accurate tidak tersedia tetap menghasilkan `MISSING_INTERNAL`, bukan kesalahan satuan.

## Nilai

Kolom principal yang wajib tersedia:

- Identitas: `INV Num`, `INV Date`, `Id Produk`, `Id Pelanggan`, `Id Sales`, dan `Tipe Penjualan`.
- Quantity/harga: `Qty Trx-Inv`, `Qty Small`, dan `Harga`.
- Komponen nilai: `Value Excl Disc`, `Total Disc Inv`, `DPP Inv`, `PPN Inv`, dan `Total Inv`.
- Komponen diskon: `Disc 1 Inv`, `Disc 2a Inv`, `Disc 2b (Promo Dist.) Inv`, `Disc 2b (Manual) Inv`, `Disc 3 Inv`, `Disc 4 (Promo Dist.) Inv`, `Disc 4 (Manual) Inv`, dan `Disc 5 Inv`.

Gunakan nilai yang disediakan principal:

- Bruto: `Value Excl Disc`.
- Diskon: `Total Disc Inv`.
- DPP: `DPP Inv`.
- Pajak: `PPN Inv`.
- Netto: `Total Inv`.

Parser wajib memvalidasi:

- Seluruh identitas nilai divalidasi setelah pembulatan skala empat desimal, setara toleransi maksimum Rp0,0001. Toleransi ini hanya untuk konsistensi satu file dan terpisah dari toleransi rekonsiliasi Rp1.
- `Value Excl Disc = Qty Trx-Inv × Harga`.
- `Total Disc Inv = jumlah delapan kolom diskon`.
- `DPP Inv = Value Excl Disc - Total Disc Inv`.
- `PPN Inv = DPP Inv × 11%`.
- `Total Inv = DPP Inv + PPN Inv`.
- `JUAL` dan `PROMO` tidak boleh memiliki qty/nilai negatif.
- `PROMO` pada file contoh memiliki nilai nol tetapi qty tetap dipertahankan.
- `RETUR` boleh memiliki qty/nilai negatif.

Kode customer dan salesman mentah SHINZUI disalin ke field canonical internal yang sama. Tidak dibuat warning mapping customer/salesman pada tahap ini.

Perbandingan antar sumber tetap memakai toleransi nilai Rp1 dan lima komponen: bruto, diskon, DPP, pajak, dan netto.

## API dan UI

- Tambah endpoint `POST /api/reconciliation/shinzui/sales`.
- Endpoint memakai permission `reconciliation.run`, validasi `.xlsx`/ukuran/ZIP yang sama, serta pesan parser aman dengan HTTP 422.
- Tambah pilihan `SHINZUI` pada selector principal yang sama.
- Label upload, nama principal pada penyebab/baris sumber, endpoint, dan nama ekspor mengikuti pilihan SHINZUI.
- Hasil default tetap `Hanya bermasalah` bila ada temuan.
- KINO dan GODREJ harus tetap menjadi jalur yang sama seperti sekarang.

## Penanganan Error

- Sheet/header wajib hilang, invoice tidak valid, mapping rusak/tidak lengkap, nilai tidak konsisten, dan tanda transaksi tidak valid menghasilkan pesan aman 422. Mapping yang formatnya valid tetapi ambigu untuk satu invoice menjadi hasil `INVALID_DATA` dengan HTTP 200.
- File master lokal hilang menghasilkan HTTP 500 dengan pesan `Master mapping SHINZUI tidak tersedia.`
- Pesan asing/internal tetap disamarkan sebagai error 500 generik.

## Verifikasi

- Tes parser sintetis: leading-zero SKU, token invoice dalam REM berteks, PROMO→NORMAL, RETUR negatif, mapping ambigu, satuan salah, dan identitas nilai tidak konsisten.
- Tes route: auth, upload, master hilang, parser aman 422, dan success parity.
- Tes browser: selector SHINZUI, endpoint/label/ekspor dinamis, KINO/GODREJ tidak regresi.
- Acceptance file nyata pada localhost: tiga tema dan mobile.

Ekspektasi file contoh pada toleransi Rp1:

- 181 hasil.
- 130 `MATCH`.
- 35 `VALUE_MISMATCH`.
- 1 `QTY_AND_VALUE_MISMATCH`.
- 15 `MISSING_INTERNAL` (RETUR hanya ada di principal).
- Status lainnya 0.

