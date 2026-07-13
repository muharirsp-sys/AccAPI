# Desain UI Rekonsiliasi Faktur KINO

## Tujuan

Pengguna divisi Faktur dapat mengunggah laporan Accurate dan `SALES_DETAIL` KINO, menjalankan rekonsiliasi dengan master mapping KINO yang tersimpan di server, melihat hasil, memfilter status, dan mengunduh hasil Excel. Versi pertama tidak menyimpan riwayat ke database.

## Ruang Lingkup

- Halaman baru: `/reconciliation`.
- Divisi aktif: Faktur.
- Principal aktif: KINO.
- Input pengguna: satu file `.xlsx` Rincian Faktur Penjualan dan satu file `.xlsx` SALES_DETAIL.
- Master server: `data/reconciliation/Kino.xlsx`.
- Output: ringkasan status, tabel detail, filter status, dan unduhan Excel.
- Pembelian, Return, principal lain, riwayat batch, review, dan finalisasi belum dibuat.

## Alur Pengguna

1. Pengguna membuka menu **Rekonsiliasi**.
2. Halaman menampilkan konteks **Faktur · KINO**.
3. Pengguna memilih dua file XLSX.
4. UI menampilkan nama dan ukuran masing-masing file.
5. Tombol **Jalankan rekonsiliasi** aktif setelah kedua file dipilih.
6. Browser mengirim `multipart/form-data` ke API.
7. API memvalidasi sesi, permission, nama field, ekstensi, MIME, ukuran, dan master mapping.
8. API menjalankan `reconcileKinoSales` tanpa menyimpan file upload.
9. UI menampilkan ringkasan dan detail atau pesan kesalahan yang dapat ditindaklanjuti.
10. Tombol **Unduh Excel** membuat workbook dari hasil yang sedang tampil di browser.

## Arsitektur

### Halaman

`app/(dashboard)/reconciliation/page.tsx` menjadi client page tunggal untuk upload, status proses, ringkasan, filter, tabel, dan export. Tidak dibuat wizard atau state-management tambahan.

### API

`app/api/reconciliation/kino/sales/route.ts` menerima tepat dua file:

- `accurateFile`
- `principalFile`

Route membaca master mapping dari `data/reconciliation/Kino.xlsx`, memanggil engine murni yang sudah ada, dan mengembalikan JSON. Upload hanya berada di memori selama request.

### Master Mapping

Master `Kino.xlsx` dikelola di server, bukan diunggah pengguna Faktur. Jika file tidak tersedia atau invalid, API gagal dengan pesan yang jelas dan tidak menjalankan rekonsiliasi.

### Akses

Tambahkan modul permission `reconciliation` dengan aksi:

- `view`
- `run`
- `export`

Halaman memerlukan `reconciliation.view`; API memerlukan `reconciliation.run`. Preset awal mengikuti akses Faktur/staff dan admin, sedangkan pengaturan akhir tetap dapat diubah melalui Access Group.

## Validasi dan Keamanan

- Sesi Better Auth wajib.
- Permission route bersifat default-deny.
- Hanya dua file input yang dikenal.
- Ekstensi harus `.xlsx`.
- MIME yang diterima hanya MIME XLSX atau MIME generik browser yang sudah diketahui.
- Maksimal 10 MB per file untuk versi pertama.
- Buffer harus memiliki signature ZIP/XLSX dan struktur workbook harus lolos parser.
- Nama file tidak dipakai sebagai path dan file upload tidak ditulis ke disk.
- Pesan internal tidak membocorkan path server.
- Export menggunakan cell string biasa agar teks tidak dievaluasi sebagai formula.

## Desain Visual

Halaman mengikuti shell gelap Smart ERP yang sudah ada. Identitas khususnya adalah **jalur rekonsiliasi** horizontal: dua kartu sumber bertemu pada satu tombol proses lalu mengalir ke hasil. Ini menjelaskan pekerjaan pengguna tanpa wizard.

- Slate gelap sebagai permukaan utama.
- Indigo untuk Accurate.
- Cyan untuk KINO.
- Emerald untuk `MATCH`.
- Amber/rose untuk selisih dan error.
- Tipografi dan komponen mengikuti aplikasi agar tidak menciptakan design system kedua.
- Fokus keyboard, label input, status loading, dan tabel responsif wajib tersedia.

## Hasil

Ringkasan menampilkan total, `MATCH`, mismatch quantity/nilai, missing, unmapped, dan conversion error. Tabel menampilkan order, kode barang, jenis transaksi, quantity kedua sisi, selisih quantity, net kedua sisi, selisih net, status, warning, dan source row.

Filter versi pertama:

- Semua status
- Hanya cocok
- Hanya selisih/error
- Status spesifik
- Pencarian order atau kode barang

## Error Handling

- Error sebelum proses: ditampilkan di kartu upload terkait bila dapat diidentifikasi.
- Error workbook/baris: tampil sebagai panel error dengan pesan parser.
- Error server tak dikenal: pesan umum; detail hanya di log server tanpa data sensitif.
- Hasil sebelumnya dihapus ketika pengguna mengganti file atau memulai proses baru agar tidak tertukar.

## Pengujian

- Self-check engine existing tetap wajib lulus: 236 match dan 2 mismatch pada file contoh.
- Route tanpa sesi harus menghasilkan 401.
- Route tanpa permission harus menghasilkan 403.
- File kosong, tipe salah, terlalu besar, dan master tidak tersedia harus ditolak.
- Upload dua file contoh harus menghasilkan ringkasan yang sama dengan CLI.
- UI diuji untuk upload, loading, hasil, filter, error, export, keyboard, dan ukuran mobile.

## Batas Pengembangan Berikutnya

Setelah KINO stabil, principal kedua boleh menambahkan parser/aturan sendiri dan memakai bentuk hasil yang sama. Generalisasi baru dilakukan berdasarkan perbedaan nyata principal kedua. Database batch, finalisasi, Pembelian, dan Return dikerjakan dalam spesifikasi terpisah.
