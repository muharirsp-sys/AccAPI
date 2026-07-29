# CUSSONS Return Reconciliation Design

## Tujuan

Menambahkan CUSSONS ke divisi Return pada rekonsiliasi lokal. Pengguna mengunggah Rincian Faktur Penjualan Accurate (`.xlsx`) dan `TXN_NOTEPRD_CPM.csv`; master CUSSONS disimpan internal.

## Batasan

- Hanya `main` lokal; tidak push atau mengubah GitHub.
- Tidak menambah dependency atau fuzzy matching.
- Reuse engine Return, parser mapping CUSSONS, handler upload, hasil, dan ekspor yang sudah ada.
- Maksimal 10 MB per file.

## Normalisasi

### Accurate

Hanya baris `JENIS_TRANSAKSI` yang memuat `RETUR PENJUALAN`. Nomor credit note diambil dari tepat satu token standalone `CN\d+` pada `REM`. Nol atau lebih dari satu token menjadi `INVALID_DATA`.

Kolom nilai:

- produk = `KODE_BARANG`
- qty = `QTY_SATUANKECIL`
- DPP = `DPP`
- pajak = `NILAI_PAJAK`
- total = `JUMLAH`

### TXN_NOTEPRD CUSSONS

Kolom wajib:

`Credit Note No`, `Customer Code`, `Route Code`, `Product Code`, `Product Description`, `UOM code`, `Selling Type`, `Prd Qty`, `UOM List Price`, `Gross Amount`, `Discount Amount`, `Total Amount After SKU`, `Customer Discount Amount`, `Total Tax Amount`, `Total Net Amount`, `Tax Code`, dan `Tax Percentage 1`.

Aturan:

- credit note = tepat satu token `CN\d+`
- produk = `Product Code`
- qty kecil = `Prd Qty` untuk EA; untuk CS dikali `caseSize` master
- DPP = `Total Amount After SKU - Customer Discount Amount`
- pajak = `Total Tax Amount`
- total = `Total Net Amount`

Validasi sumber dengan toleransi Rp1:

- `Gross Amount = Prd Qty × UOM List Price`
- `Total Amount After SKU = Gross Amount - Discount Amount`
- `Total Tax Amount = DPP × Tax Percentage 1 / 100`
- `Total Net Amount = DPP + pajak`
- `Selling Type = S`, `Tax Code = PPN_Output`, pajak = 11%

Angka kosong, negatif, non-finite, formula tidak konsisten, atau unit selain EA/CS menjadi `INVALID_DATA`. CS tanpa `caseSize` valid menjadi `UNMAPPED`.

### Master mapping

Master disalin byte-for-byte ke `data/reconciliation/CUSSONS_RETURN.xlsx`. Reuse `parseCussonsMappings`, yang membaca sheet `Form Fix` mulai header baris 5:

`Kode Pcpl → Kode BARANG Win2`, beserta `ISI/CTN` dan `SATUAN Fix Win`.

Mapping konflik/invalid tidak ditebak dan menghasilkan `UNMAPPED`.

## Kunci dan hasil

Kunci exact:

`Credit Note No + kode barang internal`.

Customer tidak dipakai dalam kunci karena CSV menggunakan `CT...`/`SP1C-...`, sedangkan Accurate menggunakan `C-...`, dan tidak ada master customer. Untuk mencegah penggabungan silang, satu CN dengan lebih dari satu customer dalam sumber yang sama menjadi `INVALID_DATA`.

Status memakai kontrak Return yang ada dengan toleransi DPP Rp1. Nilai pajak tetap ditampilkan untuk pemeriksaan, tetapi status nilai mengikuti DPP seperti prinsipal Return lain.

File nyata memberi acceptance tetap:

- Accurate: 28 baris
- CUSSONS: 21 baris
- `MATCH`: 21
- `MISSING_PRINCIPAL`: 7
- status lain: 0

## API, UI, dan keamanan

Endpoint: `POST /api/reconciliation/cussons/returns`, dengan tepat satu `accurateFile` XLSX dan `principalFile` CSV. Otorisasi `reconciliation.run` dilakukan sebelum multipart dibaca. Validasi extension, MIME, ukuran, field asing/duplikat, file rusak/NUL, master hilang, dan masking pesan internal mengikuti handler aman yang sudah dipakai route lain.

UI menambahkan CUSSONS pada pilihan Return. Input principal berlabel `TXN_NOTEPRD CUSSONS` dan menerima CSV. Tidak ada input ketiga; input HEADER khusus HEINZ tetap tidak berubah. Pindah prinsipal mereset file, hasil, filter, dan error.

## Pengujian

- Engine synthetic: match, agregasi, diskon, toleransi, EA/CS, formula invalid, CN invalid, customer ganda, mapping invalid, missing.
- Actual route: auth-before-parse, permission, file/field/MIME/size/NUL, master, safe parser 422, masking, success parity.
- Playwright: opsi CUSSONS Return, CSV accept, endpoint/form data, hasil fokus masalah, ekspor, reset.
- Regresi seluruh Return lama, TypeScript, scoped lint, build, real-file simulation, dan Playwright penuh.

