# Penguatan Sistem Rekonsiliasi

Tanggal: 2026-08-05
Status: Disetujui secara konseptual, menunggu tinjauan spesifikasi tertulis

## Tujuan

Membuat rekonsiliasi Faktur, Pembelian, dan Return dapat berjalan dari instalasi bersih tanpa bergantung pada file master mapping di satu laptop, memiliki riwayat yang dapat diaudit, lebih mudah ditambah principle, dan mempunyai satu perintah test yang stabil.

Perubahan harus mempertahankan rumus dan parser rekonsiliasi yang sudah diuji. Penguatan dilakukan pada seam upload, penyedia mapping, pencatatan hasil, konfigurasi UI, dan test runner.

## Ruang Lingkup

1. Menyimpan master mapping berversi di PostgreSQL.
2. Mengganti pembacaan mapping dari filesystem pada seluruh 15 route dengan pembacaan mapping aktif dari database.
3. Menyimpan riwayat setiap proses rekonsiliasi, termasuk proses yang gagal setelah validasi upload.
4. Menyediakan pengelolaan mapping untuk admin pada halaman rekonsiliasi.
5. Memusatkan konfigurasi divisi dan principle yang saat ini tersebar di UI.
6. Menyediakan satu perintah test rekonsiliasi yang menjalankan seluruh test TypeScript.
7. Mempertahankan batas upload per file dan menambahkan batas total upload serta pencatatan durasi.
8. Mengimpor master mapping lokal yang tersedia ke database lokal tanpa memasukkan workbook tersebut ke Git.

## Bukan Ruang Lingkup

- Mengubah rumus pencocokan yang sudah ada.
- Menyatukan tiga mesin Faktur, Pembelian, dan Return menjadi satu mesin generik.
- Menyimpan file transaksi Accurate atau principle secara utuh.
- Menambahkan antrean/background worker sebelum ada bukti timeout atau kehabisan memori pada batas upload saat ini.
- Menambahkan principle atau kombinasi divisi-principle baru.

## Pendekatan Terpilih

Database menyimpan workbook master mapping asli sebagai `bytea`. Parser lama tetap menerima `Buffer`, sehingga perubahan route cukup mengganti adapter filesystem dengan adapter database. Mapping tidak dipecah ke tabel baris generik karena setiap principle memiliki struktur workbook dan aturan berbeda.

Riwayat menyimpan metadata input, ringkasan, dan baris bermasalah. Baris `MATCH` tidak disimpan agar ukuran database terkendali. File input asli juga tidak disimpan; SHA-256 memungkinkan pemeriksaan bahwa file yang sama digunakan tanpa menyimpan data transaksinya.

## Model Data

Perubahan schema dimulai dari migration SQL baru dan kemudian dicerminkan ke `db/schema.ts`.

### `reconciliation_mapping_version`

| Kolom | Tipe | Aturan |
|---|---|---|
| `id` | text | UUID, primary key |
| `division` | text | `sales`, `purchases`, atau `returns` |
| `principal_code` | text | Kode principle huruf besar |
| `version` | integer | Dimulai dari 1 per pasangan divisi-principle |
| `original_name` | text | Nama workbook saat diunggah |
| `mime_type` | text | MIME upload |
| `byte_size` | integer | Maksimal 10 MiB |
| `sha256` | text | Hash hexadecimal 64 karakter |
| `workbook` | bytea | Workbook asli |
| `uploaded_by` | text | Foreign key ke `user.id`, delete restricted |
| `is_active` | boolean | Tepat satu versi aktif per divisi-principle |
| `created_at` | timestamp | Waktu unggah |

Constraints dan index:

- Unique `(division, principal_code, version)`.
- Partial unique `(division, principal_code) WHERE is_active = true`.
- Index `(division, principal_code, created_at)`.
- Check division hanya menerima tiga nilai yang didukung.
- Check ukuran positif dan tidak melebihi 10 MiB.

Aktivasi mapping dilakukan dalam satu transaksi: versi lama dinonaktifkan, versi baru dimasukkan dan diaktifkan. Jika salah satu operasi gagal, seluruh transaksi dibatalkan.

### `reconciliation_run`

| Kolom | Tipe | Aturan |
|---|---|---|
| `id` | text | UUID, primary key |
| `division` | text | Nilai yang sama dengan mapping |
| `principal_code` | text | Kode principle |
| `mapping_version_id` | text | Foreign key restricted ke mapping yang digunakan |
| `status` | text | `processing`, `success`, atau `failed` |
| `uploaded_by` | text | Foreign key restricted ke `user.id` |
| `input_files` | jsonb | Peran file, nama, MIME, ukuran, SHA-256 |
| `summary` | jsonb | Ringkasan status dan jumlah baris |
| `issues` | jsonb | Hanya hasil selain `MATCH` |
| `error` | text | Pesan aman jika gagal |
| `duration_ms` | integer | Lama proses |
| `started_at` | timestamp | Waktu mulai |
| `finished_at` | timestamp | Waktu selesai atau gagal |

Index:

- `(division, principal_code, started_at)`.
- `(uploaded_by, started_at)`.
- `mapping_version_id`.

## Penyedia Mapping

Satu module server menyediakan interface kecil:

- Membaca mapping aktif berdasarkan divisi dan principle.
- Mengunggah dan mengaktifkan versi mapping baru.
- Mengembalikan ID versi dan bytes workbook.

Seluruh route tetap memakai `createKinoSalesPostHandler`. Dependency `readMapping` diganti agar membaca database. Route tidak mengetahui struktur tabel atau cara aktivasi versi.

Mapping baru harus melewati validasi ekstensi, MIME, ukuran, SHA-256, dan parser principle terkait sebelum diaktifkan. Workbook yang gagal diparse tidak boleh tersimpan sebagai versi aktif.

## Alur Rekonsiliasi

1. Pengguna membuka halaman rekonsiliasi dan memilih divisi serta principle.
2. UI mengambil konfigurasi input dari registry tunggal.
3. Route mengautorisasi pengguna dan mempertahankan identitas aktor.
4. Upload divalidasi: field tepat, ekstensi, MIME, file tidak kosong, maksimal 10 MiB per file, dan maksimal 30 MiB total.
5. Route mengambil mapping aktif dari database. Jika belum ada, respons menjelaskan bahwa admin harus mengunggah mapping.
6. Metadata dan hash file dihitung, kemudian row riwayat dibuat dengan status `processing`.
7. Mesin rekonsiliasi lama memproses bytes input dan mapping.
8. Status riwayat diubah menjadi `success`, menyimpan summary, issues, jumlah baris, dan durasi.
9. Jika parser atau perhitungan gagal, riwayat diubah menjadi `failed` dengan pesan aman dan waktu selesai.
10. UI menampilkan hasil terbaru. Kegagalan pencatatan riwayat dianggap kegagalan request karena audit merupakan bagian wajib dari proses.

## Pengelolaan Mapping

Pada halaman rekonsiliasi tersedia panel admin sederhana:

- Menampilkan nama mapping aktif, versi, pengunggah, dan waktu unggah.
- Mengunggah workbook pengganti untuk divisi-principle yang sedang dipilih.
- Mengaktifkan versi baru hanya setelah validasi parser berhasil.
- Menampilkan riwayat versi secara baca-saja.

Endpoint pengelolaan mapping harus memakai pemeriksaan role admin yang sudah ada. Pengguna divisi biasa hanya dapat melihat identitas mapping aktif, tidak dapat menggantinya.

Import awal dilakukan melalui script satu kali yang menerima divisi, principle, dan path workbook secara eksplisit. Script menggunakan module aktivasi yang sama dengan endpoint admin. Path Downloads tidak ditulis ke source atau commit.

## Riwayat pada UI

Halaman menyediakan bagian `Riwayat` dengan pagination server-side:

- Filter divisi dan principle mengikuti pilihan aktif.
- Menampilkan waktu, pengguna, versi mapping, nama file, durasi, status, total, cocok, dan bermasalah.
- Pengguna dapat membuka detail issues yang tersimpan.
- Riwayat tidak menyediakan perubahan hasil; hasil merupakan audit immutable.

Jumlah default 20 run per halaman. Query tidak boleh mengambil seluruh riwayat sekaligus.

## Registry Rekonsiliasi

Satu nilai konfigurasi TypeScript menjadi sumber UI untuk:

- Daftar principle per divisi.
- Endpoint `sales`, `purchases`, atau `returns`.
- Jumlah dan peran file input.
- Ekstensi/MIME yang diterima.
- Label file dan deskripsi.
- Kebutuhan tiga file khusus HEINZ Return.

Registry tidak memuat fungsi parser atau logika bisnis. Route Next.js tetap berupa file fisik agar routing dan otorisasi tetap eksplisit.

## Test

Ditambahkan script `npm run test:reconciliation` yang menjalankan seluruh `lib/off-program-control/*.test.ts` dengan `tsx`.

Delapan test yang memakai top-level `await` dibungkus dalam fungsi async dan memiliki penanganan rejection. `package.json` tidak diubah menjadi global ESM karena berisiko memengaruhi script dan konfigurasi Next.js lain.

Test baru menggunakan siklus RED-GREEN untuk membuktikan:

1. Mapping aktif dibaca berdasarkan divisi-principle.
2. Aktivasi versi baru menonaktifkan versi lama secara atomik.
3. Mapping invalid tidak menjadi aktif.
4. Route gagal jelas saat mapping belum tersedia.
5. Run sukses menyimpan summary dan issues tanpa baris MATCH.
6. Run gagal tercatat sebagai `failed`.
7. Total upload di atas 30 MiB ditolak sebelum `arrayBuffer()`.
8. Registry memuat tepat 15 kombinasi yang memiliki route.
9. Pagination riwayat tidak mengambil seluruh data.

Verifikasi akhir:

- Seluruh test rekonsiliasi.
- TypeScript `--noEmit`.
- ESLint pada file yang berubah.
- Build Next.js.
- Simulasi browser Faktur, Pembelian, dan Return.
- Simulasi data nyata minimal satu principle per divisi dan mapping dari database.
- Pemeriksaan clean checkout tidak membutuhkan workbook mapping dari Git.

## Migrasi dan Peluncuran Lokal

1. Buat dan tinjau migration SQL.
2. Terapkan migration ke PostgreSQL lokal.
3. Impor mapping yang tersedia dari source pengguna ke database lokal.
4. Pastikan 15 kombinasi memiliki mapping aktif; kombinasi yang memakai workbook sama tetap mempunyai versi sendiri agar audit per divisi jelas.
5. Jalankan test dan simulasi.
6. Hapus ketergantungan runtime terhadap `data/reconciliation/*.xlsx` setelah seluruh mapping aktif tersedia.
7. Workbook lokal tetap diabaikan Git.

Migration tidak otomatis diterapkan ke database production. Penerapan production memerlukan `DATABASE_URL` target dan verifikasi terpisah.

## Risiko dan Mitigasi

- **Database membesar:** mapping dibatasi 10 MiB dan immutable; hasil MATCH serta file input tidak disimpan.
- **Dua mapping aktif:** dicegah transaksi dan partial unique index.
- **Riwayat kehilangan referensi:** foreign key memakai delete restricted.
- **Mapping salah:** parser principle dijalankan sebelum aktivasi.
- **Route drift dari registry:** test memastikan 15 konfigurasi mempunyai route fisik.
- **Regresi rumus:** mesin rekonsiliasi tidak direstrukturisasi; seluruh test lama tetap dijalankan.
- **Timeout:** durasi dicatat dan ukuran dibatasi; queue baru dipertimbangkan jika data menunjukkan masalah nyata.

## Kriteria Selesai

- Tidak ada route rekonsiliasi yang membaca mapping dari filesystem.
- Seluruh 15 kombinasi mempunyai mapping aktif di database lokal.
- Instalasi bersih dapat dikonfigurasi melalui migration dan import mapping tanpa force-add Excel ke Git.
- Setiap proses sukses/gagal tercatat dan dapat dilihat dari UI.
- Satu registry mengendalikan daftar dan kontrak upload pada UI.
- `npm run test:reconciliation`, TypeScript, ESLint, dan build lulus.
- Simulasi browser dan data nyata untuk ketiga divisi lulus.
