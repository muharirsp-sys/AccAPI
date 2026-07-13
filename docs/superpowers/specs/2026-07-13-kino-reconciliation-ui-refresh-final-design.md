# Desain Final Penyegaran UI Rekonsiliasi KINO

## Tujuan dan Batasan

Merapikan halaman Rekonsiliasi Faktur KINO agar mudah digunakan divisi Faktur dan konsisten pada tema Office Calm, Neon HUD, serta iOS Liquid Glass.

Perubahan hanya berlaku pada worktree lokal branch `codex/kino-reconciliation-ui`. Branch `main`, server port 3000, database utama, API, mesin rekonsiliasi, format ekspor, dan RBAC tidak termasuk ruang lingkup.

## Keputusan

- Alur bertahap: sebelum proses, halaman hanya berfokus pada upload. Ringkasan, filter, ekspor, dan tabel baru muncul setelah hasil tersedia.
- Ketiga tema memakai struktur dan perilaku yang sama; visual mengikuti token tema existing.
- Tidak menambah dependency, sistem tema, chart, dropzone, wizard, selector tema global, atau abstraksi spekulatif.
- Reuse `DataTable`, Lucide icons, native file input, dan `.btn-primary`.

## Struktur Halaman

### Header

Header memuat konteks `Faktur / KINO`, judul `Rekonsiliasi Faktur`, dan penjelasan satu kalimat tanpa dekorasi yang bersaing dengan area kerja.

### Area Upload

Dua kartu tampil berdampingan pada desktop dan bertumpuk pada layar kecil:

- `Rincian Faktur Penjualan (Accurate)`
- `Sales Detail KINO`

Setiap kartu menampilkan format `.xlsx`, batas 10 MB, nama serta ukuran file terpilih, dan tombol hapus berlabel aksesibel. Native file input tetap dipakai.

Footer upload berisi live status di kiri dan tombol `.btn-primary` `Jalankan rekonsiliasi` di kanan. Tombol nonaktif hingga kedua file tersedia. Spinner loading menghormati `prefers-reduced-motion`.

### Hasil Bertahap

Sebelum hasil tersedia, kartu angka nol, filter, tabel kosong, dan pagination tidak dirender.

Setelah berhasil, urutan informasi adalah:

1. pesan selesai;
2. indikator utama `Total`, `Cocok`, dan `Bermasalah`;
3. rincian masalah sekunder;
4. filter dan ekspor;
5. tabel hasil.

Rumus indikator bersifat eksplisit:

- `Total = result.results.length`
- `Cocok = summary.MATCH`
- `Bermasalah = Total - Cocok`, yaitu seluruh status selain `MATCH`, termasuk `INVALID_DATA`, `UNMAPPED_SKU`, dan `UNIT_CONVERSION_ERROR`
- `Selisih jumlah/nilai = QTY_MISMATCH + VALUE_MISMATCH + QTY_AND_VALUE_MISMATCH`
- `Data tidak ditemukan = MISSING_INTERNAL + MISSING_PRINCIPAL`

Tidak ada chart karena angka dan status sudah cukup untuk keputusan operasional versi ini.

## Bahasa Status

Status mesin tetap dipertahankan pada data/API, tetapi UI memakai label berikut:

| Status mesin | Label UI |
| --- | --- |
| `MATCH` | Cocok |
| `QTY_MISMATCH` | Selisih jumlah |
| `VALUE_MISMATCH` | Selisih nilai |
| `QTY_AND_VALUE_MISMATCH` | Selisih jumlah dan nilai |
| `MISSING_INTERNAL` | Data Accurate tidak ditemukan |
| `MISSING_PRINCIPAL` | Data KINO tidak ditemukan |
| `UNMAPPED_SKU` | SKU belum dipetakan |
| `UNIT_CONVERSION_ERROR` | Konversi satuan gagal |
| `INVALID_DATA` | Data tidak valid |

Status ditampilkan memakai teks dan ikon, bukan warna saja. Filter memakai label UI yang sama.

## Tabel

- Kolom utama yang terlihat: Status, Order, Produk, Qty Accurate/KINO, Selisih Qty, Net Accurate/KINO, dan Selisih Net.
- `transactionClass`, `warnings`, dan `sourceRows` disembunyikan secara default tetapi tersedia melalui menu `Kolom`.
- Angka rata kanan dan memakai `tabular-nums`.
- State dan copy pilihan baris dihapus karena tabel tidak mempunyai checkbox pemilihan.
- Pagination tidak menampilkan `Halaman 1 dari 0` ketika hasil filter kosong.
- Empty state filter menjelaskan bahwa tidak ada hasil untuk filter tersebut.

## Tiga Tema

Implementasi memakai key resmi dan token existing dari `app/globals.css`:

- `data-theme="office-calm"`: permukaan hangat, teks gelap, aksen emas/teal.
- `data-theme="neon"`: permukaan navy, garis dan aksen biru/cyan, efek HUD existing.
- `data-theme="ios"`: permukaan terang transparan, border lembut, bayangan ringan.

Literal yang tidak dikenali theme bridge, terutama `bg-[#16181d]/80` dan opacity `/15`, diganti dengan token atau kelas existing yang sudah dipetakan. Tombol utama memakai `.btn-primary`. Tidak ditambahkan selector tema global baru.

## Error, Aksesibilitas, dan Responsif

- Error tampil dekat tindakan utama dengan `role="alert"`; status proses memakai live region.
- Tombol, input, dan select mempunyai fokus keyboard terlihat.
- Tombol ikon mempunyai nama aksesibel dan target klik memadai.
- Copy memakai bahasa awam dan menjelaskan tindakan koreksi.
- Toolbar bertumpuk pada layar kecil tanpa horizontal overflow.
- Tabel tetap memakai scroll horizontal karena data memiliki banyak kolom.
- Tombol utama memenuhi lebar pada mobile dan kembali proporsional pada desktop.

## Implementasi Minimum

- `app/(dashboard)/reconciliation/page.tsx`: progressive disclosure, copy, status label, KPI, default visibility kolom, dan aksesibilitas.
- `components/DataTable.tsx`: perbaikan literal surface, konfigurasi visibilitas awal, penghapusan selection state mati, dan pagination kosong.

## Verifikasi

- TypeScript dan ESLint untuk file yang disentuh.
- Test route dan engine existing tetap lulus.
- Pemeriksaan browser pada port 3001 untuk `office-calm`, `neon`, dan `ios`.
- Pada setiap tema, periksa keterbacaan/kontras status, tombol, input, tabel, dan fokus keyboard.
- Periksa state sebelum upload, file terpilih, loading, error, sukses, filter kosong, ekspor, serta viewport kecil.

