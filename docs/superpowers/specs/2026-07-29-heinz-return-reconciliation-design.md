# HEINZ Return Reconciliation Design

## Tujuan

Menambahkan HEINZ ke divisi Return pada rekonsiliasi lokal. Pengguna mengunggah tiga laporan operasional: Rincian Faktur Penjualan Accurate (`.xlsx`), HEADER HEINZ (`.csv`), dan DETAIL HEINZ (`.csv`). Master mapping HEINZ disimpan internal dan tidak diunggah pengguna.

## Batasan

- Hanya `main` lokal; tidak push atau mengubah GitHub.
- Tidak menambah dependency.
- Tidak memakai fuzzy matching.
- Perubahan mengikuti engine, keamanan upload, tampilan, dan ekspor Return yang sudah ada.
- Data sumber maksimal 10 MB per file.

## Sumber dan normalisasi

### HEADER HEINZ

Kolom wajib:

`credit_note_number`, `goods_return_note_number`, `sales_representative_code`, `retailer_code`, `retailer_name`, `credit_note_date`, `invoice_number`, `remarks`, `line_count`, `net_value`, `status`.

Hanya baris `status=Approved` yang direkonsiliasi. `credit_note_number` harus unik. Kode pelanggan Accurate diambil secara exact dari token akhiran `C-...` pada `retailer_name`; `retailer_code` tidak dipakai sebagai kunci karena sebagian berisi kode lama seperti `MKS-*` atau `MK*`.

### DETAIL HEINZ

Kolom wajib:

`credit_note_number`, `line_number`, `distributor_stock_keeping_unit`, `unit_quantity`, `unit`, `eaches_quantity`, `unit_price`, `gross_value`, `return_code`.

DETAIL digabung exact ke HEADER dengan `credit_note_number`. Baris tanpa HEADER Approved ditolak sebagai data invalid. Jumlah detail per credit note harus sama dengan `line_count`. Kuantitas pembanding adalah `eaches_quantity`.

Nilai principal:

- total = `gross_value`
- DPP = `gross_value / 1.11`
- pajak = `gross_value - DPP`

### Accurate

Hanya `JENIS_TRANSAKSI` yang memuat `RETUR PENJUALAN`. Nomor retur diambil dari tepat satu token `CN-\d+` pada `REM`. Baris tanpa token atau dengan lebih dari satu token menjadi `INVALID_DATA`.

Kuantitas memakai `QTY_SATUANKECIL`; nilai memakai `DPP`, `NILAI_PAJAK`, dan `JUMLAH`.

### Master mapping

Master internal disalin byte-for-byte ke `data/reconciliation/HEINZ_RETURN.xlsx`. Sheet `Fix Mapping` memetakan `PCPL KODE 1` sampai `PCPL KODE 5` ke `KODE BARANG`. Nilai `0` dan kosong diabaikan. Satu kode principal yang menunjuk ke lebih dari satu kode Accurate ditolak sebagai konflik.

## Kunci dan status rekonsiliasi

Kunci exact adalah:

`credit_note_number + kode pelanggan Accurate + kode barang Accurate hasil mapping`.

Tidak ada fallback ke nama barang, invoice lama, atau kemiripan teks. Baris principal tanpa mapping menjadi `UNMAPPED`. Status lain tetap memakai kontrak Return yang ada: `MATCH`, `QTY_MISMATCH`, `VALUE_MISMATCH`, `QTY_AND_VALUE_MISMATCH`, `MISSING_ACCURATE`, `MISSING_PRINCIPAL`, dan `INVALID_DATA`. Toleransi DPP adalah Rp1.

Contoh file nyata yang diberikan tidak memiliki irisan nomor CN: Accurate berisi 18 CN mulai `CN-024213`, sedangkan HEINZ berisi 15 CN `CN-024198`–`CN-024212`. Karena itu hasil yang benar adalah data tidak ditemukan pada kedua sisi; sistem tidak boleh memaksa pasangan palsu.

## API dan keamanan

Endpoint baru: `POST /api/reconciliation/heinz/returns`.

Multipart wajib berisi tepat satu `accurateFile`, `headerFile`, dan `principalFile` (DETAIL). Accurate wajib XLSX; HEADER dan DETAIL wajib CSV. Validasi extension, MIME, ukuran, file kosong/rusak, karakter NUL, field asing, dan duplikasi mengikuti handler aman yang sudah ada. Otorisasi `reconciliation.run` dilakukan sebelum multipart dibaca. Kesalahan parser yang dikenal ditampilkan secara aman; path, credential, dan pesan internal dimask.

## UI

HEINZ ditambahkan ke pilihan prinsip Return. Saat dipilih, halaman menampilkan tiga kartu upload:

1. Retur Penjualan Accurate
2. HEADER HEINZ
3. DETAIL HEINZ

Tombol hanya aktif jika ketiganya terisi. Pindah divisi/prinsipal mereset file, hasil, filter, dan error. Hasil tetap fokus pada masalah, menampilkan penyebab selisih, sumber baris, dan ekspor XLSX dengan kolom HEINZ.

## Pengujian

- Engine synthetic: MATCH, agregasi, filter Approved, mapping, konflik, join/header invalid, CN invalid, unmapped, missing, dan toleransi.
- Actual route: 401/403 sebelum parse; field hilang/duplikat/asing; extension/MIME/size/NUL/rusak; master hilang; masking error; success parity.
- UI Playwright: opsi HEINZ, input ketiga kondisional, request tiga file, tombol, hasil fokus masalah, ekspor, dan reset.
- Regresi: seluruh test Return lama, TypeScript, lint, production build.
- Simulasi nyata: empat file yang diberikan menghasilkan jumlah/status deterministik tanpa fuzzy match.

