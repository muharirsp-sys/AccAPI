# Godrej Purchase Reconciliation Design

## Scope

Aktifkan divisi Pembelian untuk prinsipal GODREJ pada halaman rekonsiliasi
lokal. Pengguna mengunggah dua file: Rincian Faktur Pembelian Accurate
berformat XLSX dan GRN Status Report GODREJ berformat CSV. Master produk tetap
internal dan tidak diunggah pengguna.

## Sources and exact matching

- Nomor dokumen Accurate diambil dari tepat satu `DMS Bill <angka>` pada
  kolom `REM`.
- Nomor dokumen GODREJ memakai `Invoice_Number`; `Bill_No` harus sama.
- Kunci hasil adalah nomor dokumen dan produk internal hasil mapping.
- Mapping memakai master `data/reconciliation/GODREJ_RETURN.xlsx`, yang
  byte-identik dengan file master yang diberikan pengguna.
- Produk GODREJ dipetakan hanya dari nama yang sama setelah normalisasi
  deterministik: huruf besar, spasi/tanda baca dinormalkan, dan kode SKU
  numerik di akhir `Sku_Name` dibuang. Tidak ada fuzzy matching.
- Mapping tanpa kandidat menjadi `UNMAPPED`; kandidat lebih dari satu menjadi
  `INVALID_DATA`.

## Quantities and amounts

- Accurate wajib memakai satuan `KRT`.
- Qty Accurate dalam unit adalah `QTY × ISI/CTN`.
- Qty GODREJ adalah `Qty_Approved`.
- `Quantity_in_Cases × ISI/CTN`, `Quantity_in_Units`, dan `Quantity_Uploaded`
  divalidasi terhadap `Qty_Approved`; ketidakkonsistenan menjadi
  `INVALID_DATA`.
- Hanya status GRN `Approved` yang dapat dibandingkan. Status lain menjadi
  `INVALID_DATA`.
- DPP Accurate memakai kolom `DPP`.
- Total GODREJ memakai `Amount_Uploaded`; DPP GODREJ adalah
  `Amount_Uploaded / 1.11`, dan pajaknya adalah selisih total dengan DPP.
- Kolom PPN Accurate adalah nilai tingkat dokumen yang berulang, sehingga
  tidak dijumlahkan per baris. Untuk tampilan, pajak Accurate dihitung
  `DPP × 11%` dan total dihitung `DPP × 1.11`.
- Qty harus sama persis. DPP memakai toleransi default Rp1.

## Output and UI

Kontrak hasil memakai status yang sama dengan rekonsiliasi Return:
`MATCH`, `QTY_MISMATCH`, `VALUE_MISMATCH`,
`QTY_AND_VALUE_MISMATCH`, `MISSING_ACCURATE`,
`MISSING_PRINCIPAL`, `UNMAPPED`, dan `INVALID_DATA`.

Tab Pembelian di halaman yang sama hanya menampilkan prinsipal GODREJ.
Label memakai istilah pembelian: dokumen pembelian, supplier, Rincian Faktur
Pembelian, dan GRN Status Report. Hasil bermasalah ditampilkan terlebih
dahulu dan dapat diekspor menjadi
`rekonsiliasi-pembelian-godrej-YYYY-MM-DD.xlsx`.

## API and validation

Endpoint `POST /api/reconciliation/godrej/purchases` menerima tepat satu
`accurateFile` XLSX dan satu `principalFile` CSV. Endpoint menggunakan izin
`reconciliation.run`, batas ukuran dan validasi multipart yang sudah ada.
Kesalahan format data dikembalikan sebagai 422 tanpa membocorkan stack trace
atau path lokal.

## Acceptance

- Dataset nyata dapat diproses tanpa perubahan manual.
- Tujuh nomor dokumen yang beririsan menghasilkan 368 baris sumber pada
  masing-masing laporan sebelum agregasi.
- Delapan dokumen yang hanya ada pada salah satu sumber tetap muncul sebagai
  temuan data tidak ditemukan.
- Setiap hasil menyimpan nomor baris sumber.
- Test engine, route, UI, TypeScript, lint, build, dan simulasi HTTP lokal
  lulus.
- Tidak ada dependency baru dan tidak ada perubahan/push ke GitHub.
