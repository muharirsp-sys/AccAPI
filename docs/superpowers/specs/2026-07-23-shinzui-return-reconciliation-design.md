# Shinzui Return Reconciliation Design

## Goal

Aktifkan pilot rekonsiliasi divisi Return untuk principal SHINZUI pada aplikasi lokal. User mengunggah dua laporan operasional; sistem memakai master mapping internal dan menampilkan hasil yang fokus pada penyebab selisih.

## Inputs

- Accurate: `Rincian Faktur Penjualan` berisi transaksi `2. (-) Retur Penjualan`.
- Principal: `PenjualanInvoice` berisi baris `Tipe Penjualan = RETUR`.
- Master internal: `data/reconciliation/SHINZUI.xlsx`, bersumber dari workbook `FIX FORM MASTER BARANG - SHINZUI.xlsx`, sheet `Fix Mapping`.
- User hanya mengunggah dua laporan; master tidak diunggah setiap proses.

## Scope

- Divisi Faktur tetap berperilaku seperti sekarang.
- Divisi Return menjadi aktif dan untuk pilot hanya menyediakan principal SHINZUI.
- Divisi Pembelian tetap belum aktif.
- Tidak ada histori, penyimpanan hasil ke database, dependency baru, atau perubahan GitHub.

## Filtering and Normalization

- Accurate hanya memproses `JENIS_TRANSAKSI` yang bermakna Retur Penjualan.
- Principal hanya memproses `TIPE PENJUALAN = RETUR`.
- Baris `PROMO`, termasuk promo negatif/nol, diabaikan.
- Nilai principal bertanda negatif dinormalisasi ke nilai absolut untuk perbandingan.
- Tanggal mentah tidak menjadi kunci karena dua laporan sampel berbeda satu hari.
- Nomor invoice principal diambil dari satu token `INVGTS...` pada `REM` Accurate.

## Mapping and Match Key

- Kode barang Accurate dipetakan melalui `Fix Mapping.KODE BARANG` ke salah satu `PCPL KODE 1..5`.
- Kunci baris: nomor invoice principal + kode produk principal + kode pelanggan.
- Baris berkunci sama diakumulasi sebelum dibandingkan agar partial/multiple line aman.

## Comparison Rules

- Kuantitas harus sama persis setelah normalisasi tanda.
- DPP sebelum pajak dibandingkan dengan toleransi absolut Rp1.
- Pajak dan total setelah pajak ditampilkan sebagai informasi dan tidak menentukan status.
- Sampel penerimaan: 11 baris Accurate dan 11 baris RETUR principal harus cocok; total qty 29 dan DPP Rp361.351,3503.

## Result Statuses

- `MATCH`: qty sama dan selisih DPP maksimal Rp1.
- `QTY_MISMATCH`: key cocok tetapi qty berbeda.
- `VALUE_MISMATCH`: key dan qty cocok tetapi selisih DPP di atas Rp1.
- `MISSING_PRINCIPAL`: retur Accurate tidak ditemukan di principal.
- `MISSING_ACCURATE`: retur principal tidak ditemukan di Accurate.
- `UNMAPPED`: kode barang Accurate tidak memiliki mapping produk principal.

Hasil default berfokus pada status selain `MATCH` dan menjelaskan invoice, pelanggan, barang, qty, DPP, serta besar selisih. User tetap dapat memilih semua status atau hanya yang cocok.

## API and UI

- Endpoint: `POST /api/reconciliation/shinzui/returns`.
- Multipart field tetap `accurateFile` dan `principalFile` agar handler upload yang ada dapat digunakan ulang.
- Autentikasi, izin `reconciliation.run`, validasi XLSX/ZIP, batas 10 MB, masking error, dan pesan master hilang mengikuti endpoint Faktur.
- Tab Return menampilkan dua upload, tombol proses, ringkasan, filter status, tabel detail, dan export hasil dengan copy khusus Return.
- Mengganti divisi atau principal mereset file, hasil, filter, dan error agar hasil antar-mode tidak tercampur.

## Error Handling

- Header wajib, invoice REM ambigu/kosong, angka tidak valid, file rusak, dan mapping konflik menghasilkan 422 dengan pesan aman.
- File master tidak ada menghasilkan 500 dengan pesan `Master mapping SHINZUI tidak tersedia.`
- Error internal lain tidak membocorkan path, stack, atau isi data.

## Verification

- Self-check engine memakai fixture sintetis untuk seluruh status dan workbook nyata untuk acceptance 11/11 MATCH.
- Route test mencakup izin, upload, master, error masking, dan parity respons.
- UI test mencakup aktivasi Return, SHINZUI-only, endpoint `/returns`, reset state, tiga tema, dan tetap menjaga Faktur/Pembelian.
- TypeScript, build, self-check rekonsiliasi, dan simulasi HTTP lokal harus lulus.
