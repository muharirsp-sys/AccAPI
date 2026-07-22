# Desain Ruang Faktur, Pembelian, dan Return

## Tujuan

Halaman rekonsiliasi di localhost 3000 memperlihatkan bahwa proyek ini memiliki tiga jenis pekerjaan: `Faktur`, `Pembelian`, dan `Return`. Untuk tahap sekarang, hanya Faktur yang aktif. Pembelian dan Return hanya diperlihatkan sebagai ruang yang akan dikembangkan kemudian.

Perubahan ini membantu pengguna memahami arah pengembangan aplikasi tanpa membuat fitur palsu atau menebak aturan rekonsiliasi yang belum dibahas.

## Keputusan Utama

- Tetap memakai satu halaman: `/reconciliation`.
- Tambahkan satu bar ringkas bernama `Jenis Rekonsiliasi` di atas area rekonsiliasi Faktur.
- Bar berisi tiga bagian dengan lebar seimbang:
  1. `Faktur` dengan status `Aktif`.
  2. `Pembelian` dengan status `Belum aktif`.
  3. `Return` dengan status `Belum aktif`.
- Faktur terlihat sebagai bagian yang sedang dipakai.
- Pembelian dan Return hanya berupa informasi, bukan tombol dan tidak dapat diklik.
- Seluruh alur Faktur yang sudah ada tetap berada di bawah bar tersebut dan tetap bekerja seperti sekarang.

## Susunan Tampilan

Urutan halaman setelah perubahan:

1. Judul dan penjelasan halaman rekonsiliasi yang sudah ada.
2. Bar `Jenis Rekonsiliasi`.
3. Penanda Faktur dan pilihan principal yang sudah ada.
4. Area unggah file Faktur.
5. Ringkasan dan hasil rekonsiliasi Faktur.

Bar tidak mengambil alih fungsi pilihan principal. `Jenis Rekonsiliasi` menunjukkan kelompok pekerjaan, sedangkan pilihan principal menentukan format laporan Faktur yang sedang diproses.

### Faktur

- Menggunakan warna aktif yang sesuai dengan tema.
- Menampilkan teks `Aktif`.
- Ditandai sebagai halaman yang sedang digunakan untuk pembaca layar, misalnya dengan `aria-current="page"`.
- Tidak memerlukan tombol atau perpindahan halaman karena pengguna memang sudah berada di rekonsiliasi Faktur.

### Pembelian dan Return

- Menggunakan tampilan lebih redup daripada Faktur, tetapi teks tetap mudah dibaca.
- Menampilkan teks `Belum aktif` secara langsung.
- Tidak memakai elemen tombol, tautan, `onClick`, atau fokus keyboard.
- Tidak menampilkan unggahan file, hasil contoh, tanggal rilis, atau aturan rekonsiliasi sementara.

## Perilaku pada Tiga Tema

Struktur dan isi bar selalu sama pada ketiga tema yang sudah tersedia. Yang berubah hanya warna sesuai sistem tema yang telah dipakai aplikasi.

- Status aktif harus jelas tanpa bergantung pada warna saja; teks `Aktif` tetap ditampilkan.
- Status belum tersedia juga dijelaskan dengan teks `Belum aktif`.
- Kontras tulisan harus tetap cukup pada setiap tema.
- Tidak menambah warna tetap yang hanya cocok pada satu tema.

## Tampilan Responsif

- Pada layar lebar, tiga bagian tampil dalam satu baris.
- Pada layar sempit, gunakan grid tiga kolom yang tetap berada dalam lebar halaman.
- Teks boleh membungkus bila ruang sempit.
- Tidak boleh menimbulkan geser horizontal.
- Tidak perlu membuat versi komponen terpisah untuk perangkat seluler.

## Alur Pengguna Saat Ini

1. Pengguna membuka `/reconciliation` di localhost 3000.
2. Pengguna melihat Faktur aktif serta Pembelian dan Return belum aktif.
3. Pengguna memilih principal Faktur.
4. Pengguna mengunggah file Accurate dan file principal sesuai aturan principal tersebut.
5. Sistem menjalankan rekonsiliasi Faktur dan menampilkan hasilnya seperti sekarang.

Tidak ada perubahan pada parser, mapping, rumus, status hasil, toleransi, ekspor, maupun API Faktur.

## Aturan Saat Jenis Baru Diaktifkan Nanti

Bagian ini hanya menjadi batas desain, bukan pekerjaan tahap sekarang.

Pembelian atau Return baru boleh diaktifkan setelah tersedia keputusan yang disetujui untuk:

- jenis dan jumlah file sumber;
- kolom wajib dari setiap file;
- kunci pencocokan data;
- perlakuan jumlah, satuan, diskon, pajak, dan nilai bersih;
- aturan tanda positif atau negatif;
- kebutuhan master mapping;
- toleransi selisih;
- daftar status hasil;
- batas tanggal atau periode laporan;
- contoh data nyata untuk pengujian.

Ketika perpindahan jenis rekonsiliasi benar-benar dibuat nanti, perubahan jenis wajib membersihkan kedua file unggahan, hasil lama, filter, dan pesan error agar data antarjenis tidak tercampur. Perilaku ini belum perlu dibuat selama Pembelian dan Return masih statis.

## Ruang Lingkup Implementasi

Perubahan paling kecil yang direncanakan:

- menambahkan bar `Jenis Rekonsiliasi` pada komponen halaman rekonsiliasi yang sudah ada;
- menambahkan pemeriksaan UI terarah untuk bar tersebut.

Tidak diperlukan:

- route baru;
- endpoint atau perubahan backend;
- mesin rekonsiliasi Pembelian atau Return;
- perubahan sidebar;
- perubahan RBAC atau hak akses;
- state global;
- dependency baru;
- perubahan CSS global;
- perubahan struktur hasil Faktur;
- perubahan pada branch `main`.

## Kriteria Penerimaan

- `/reconciliation` menampilkan label `Jenis Rekonsiliasi`.
- `Faktur`, `Pembelian`, dan `Return` terlihat bersamaan.
- Faktur ditandai `Aktif` dan sebagai pilihan saat ini.
- Pembelian dan Return ditandai `Belum aktif`.
- Pembelian dan Return tidak dapat diklik dan tidak masuk urutan fokus keyboard.
- Alur pemilihan principal, unggah, proses, filter, hasil, dan ekspor Faktur tetap bekerja.
- Bar tampil benar pada ketiga tema.
- Bar tidak menyebabkan geser horizontal pada layar sempit.
- Tidak ada perubahan backend atau aturan rekonsiliasi.

## Rencana Verifikasi

- Pemeriksaan komponen memastikan label kelompok dan ketiga jenis tampil.
- Pemeriksaan aksesibilitas memastikan Faktur memiliki penanda halaman aktif.
- Pemeriksaan memastikan Pembelian dan Return bukan tombol atau tautan.
- Test UI Faktur yang sudah ada tetap dijalankan untuk memastikan tidak ada fungsi lama yang rusak.
- Pemeriksaan visual dilakukan pada ketiga tema dan ukuran layar sempit.

## Batasan

- Istilah yang dipakai mengikuti keputusan pengguna: `Faktur`, `Pembelian`, dan `Return`.
- `Belum aktif` berarti fiturnya memang belum tersedia, bukan sedang error atau menunggu unggahan.
- Dokumen ini tidak menentukan rumus atau format file Pembelian dan Return.
- Implementasi hanya dilakukan di worktree dan branch lokal yang sedang digunakan. Branch `main` tidak disentuh.
