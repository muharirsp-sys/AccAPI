# Godrej Return Reconciliation Design

## Tujuan

Menambahkan GODREJ pada divisi Return di halaman rekonsiliasi lokal. Pengguna
mengunggah Rincian Faktur Penjualan Accurate (`.xlsx`) dan Sale Returns GODREJ
(`.csv`); aplikasi memakai master internal tanpa meminta file mapping ketiga.

## Keputusan data

- Accurate hanya memproses baris `JENIS_TRANSAKSI` yang memuat
  `RETUR PENJUALAN`.
- Nomor return Accurate harus tepat satu token `RB/BFG-\d+` dari `REM`.
  REM tanpa token atau dengan lebih dari satu token tetap tampil sebagai
  `INVALID_DATA`, bukan menggagalkan seluruh file.
- Customer Accurate memakai `KODE PELANGGAN INDUK`, dinormalisasi dengan
  membuang suffix `-GD`. Customer GODREJ harus memuat tepat satu kode
  `C-[A-Z0-9]+` pada kolom `CUSTOMER`.
- Sale Returns GODREJ hanya memproses `Sale Return State = approved`.
- Key rekonsiliasi adalah `nomor return | customer | kode produk Accurate`.
- Kuantitas GODREJ adalah magnitudo `Quantity(Units)`.
- `Amount` GODREJ terbukti termasuk pajak 11% pada keenam baris sampel:
  `total = abs(Amount)`, `DPP = total / 1.11`, dan `tax = total - DPP`.
- Qty harus sama persis. DPP dianggap cocok bila selisih absolut paling besar
  Rp1. Pajak dan total hanya informasional.

## Mapping produk

Master sumber disalin byte-for-byte menjadi
`data/reconciliation/GODREJ_RETURN.xlsx`; file Faktur GODREJ yang sudah ada
tidak ditimpa.

Urutan mapping:

1. Gunakan mapping kode `Kode Pcpl -> Kode BARANG Win2` dari `Pvt Map 1` bila
   kode awal `Skunit` tersedia dan menghasilkan satu kandidat.
2. Bila kode baru belum tersedia, bersihkan nama `Skunit` secara deterministik:
   buang kode awal beserta pemisah, pengulangan kode di akhir, anotasi `(x/y)`,
   tanda baca terminal, lalu normalisasi kapital dan spasi.
3. Cocokkan secara exact ke `Nama Barang Principle -> Kode BARANG Win2` pada
   `Form Fix`.
4. Nama yang tidak ditemukan menjadi `UNMAPPED`. Nama yang menunjuk ke lebih
   dari satu kode internal ditolak sebagai konflik. Tidak ada fuzzy matching
   atau tebakan berdasarkan kemiripan.

Fallback exact-unik tersebut mencakup 6/6 baris sampel. Enam pasang hasilnya:

| SKU Sale Return | Kode Accurate |
|---|---|
| 4502062 | G1267103000010 |
| 4502244 | G1267003000010 |
| 4502286 | G1264103000010 |
| 4502343 | G1264002000010 |
| 4502346 | G1264101000010 |
| 4104065 | G1071005040010 |

## Status dan tampilan

Core Return yang sama dengan SHINZUI dan KINO menghasilkan `MATCH`,
`QTY_MISMATCH`, `VALUE_MISMATCH`, `QTY_AND_VALUE_MISMATCH`,
`MISSING_ACCURATE`, `MISSING_PRINCIPAL`, `UNMAPPED`, atau `INVALID_DATA`.

Semua 33 baris Accurate harus tetap terlihat. Baris bermasalah ditampilkan
lebih dahulu. Tabel, penyebab, baris sumber, dan ekspor memakai label GODREJ
secara dinamis. Ekspor bernama `rekonsiliasi-return-godrej-YYYY-MM-DD.xlsx`.
Mengganti principal menghapus file, error, dan hasil lama.

## API dan keamanan

Endpoint baru adalah `POST /api/reconciliation/godrej/returns`, memakai field
multipart `accurateFile` untuk XLSX dan `principalFile` untuk CSV, permission
`reconciliation.run`, batas/validasi upload bersama, serta master internal.

Missing header GODREJ yang dikenal boleh dikembalikan sebagai error 422 yang
informatif. Nama header asing atau sensitif seperti `DATABASE PASSWORD` harus
tetap disamarkan sebagai error 500 umum. Input kosong, angka non-finite atau
negatif, customer ambigu, dan mapping konflik wajib ditolak.

## Acceptance nyata

Dengan tiga file yang diberikan:

- Accurate lines: 33.
- Principal approved lines: 6.
- `MATCH`: 6.
- `MISSING_PRINCIPAL`: 27.
- Semua status lain: 0.
- Matched qty: 42.
- Matched DPP Accurate: 483275.675670.
- Matched DPP GODREJ: 483275.675676.
- GODREJ tax informasional: 53160.324324.
- GODREJ total: 536436.

Regresi wajib menjaga Return SHINZUI/KINO, Faktur GODREJ/CUSSONS, Pembelian
pasif, tiga tema, fokus masalah, aksesibilitas, dan ekspor existing.

