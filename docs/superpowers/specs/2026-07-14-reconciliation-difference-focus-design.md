# Desain Fokus Selisih Rekonsiliasi KINO

## Tujuan

Setelah rekonsiliasi selesai, divisi Faktur langsung melihat data bermasalah dan alasan angka tersebut dianggap selisih. Pengguna tidak perlu mencari dua baris masalah di antara ratusan data cocok.

Perubahan berlaku pada rekonsiliasi Faktur KINO di localhost 3000. Tidak ada dependency, halaman baru, drawer, chart, perubahan RBAC, perubahan master, atau perubahan struktur workbook ekspor.

## Keputusan UI

- Jika hasil memiliki masalah, filter awal otomatis menjadi `Hanya bermasalah`.
- Jika seluruh data cocok, filter awal tetap `Semua status` dan halaman menampilkan pesan `Semua data cocok`.
- Pengguna tetap dapat memilih `Semua status`, `Hanya cocok`, atau status tertentu.
- Ringkasan dan ekspor tetap menghitung seluruh hasil; filter hanya memengaruhi tabel.
- Judul hasil saat ada masalah menjadi `Temuan yang perlu diperiksa`, disertai jumlah masalah dan total perbandingan.

Kolom utama yang terlihat:

1. Status
2. Order
3. Produk
4. Penyebab selisih
5. Baris sumber

Kolom angka mentah dan informasi teknis tetap tersedia melalui menu `Kolom`, tetapi disembunyikan secara default agar penyebab menjadi fokus utama.

## Detail Penyebab

Setiap baris hanya menampilkan komponen yang benar-benar berbeda.

### Jumlah

Tampilkan nilai Accurate, nilai KINO, dan arah selisih dalam bahasa awam. Contoh:

`Jumlah: Accurate 3, KINO 6 — Accurate kurang 3`

### Nilai

Mesin sudah membandingkan lima komponen nilai. API menambahkan rincian terstruktur untuk komponen yang melewati toleransi:

- Nilai jual
- Diskon
- DPP
- Pajak
- Nilai bersih

Setiap rincian membawa nama komponen, nilai Accurate, nilai KINO, dan `Accurate - KINO`. Contoh:

`Nilai bersih: Accurate Rp60.000, KINO Rp120.000 — Accurate kurang Rp60.000`

Komponen yang masih dalam toleransi tidak ditampilkan sebagai penyebab. Field `valueDifference` lama tetap dipertahankan untuk kompatibilitas.

### Status non-perbandingan

- `MISSING_INTERNAL`: `Data tidak ditemukan di Accurate.`
- `MISSING_PRINCIPAL`: `Data tidak ditemukan di KINO.`
- `UNMAPPED_SKU`: `SKU KINO belum memiliki pasangan produk Accurate.`
- `UNIT_CONVERSION_ERROR`: `Konversi satuan gagal; periksa master KINO dan baris sumber.`
- `INVALID_DATA`: `Data tidak dapat dibandingkan; periksa format sumber.`
- Warning `UNMAPPED_CUSTOMER` dan `UNMAPPED_SALESMAN` diterjemahkan ke bahasa awam bila ada.

Baris sumber ditampilkan langsung, misalnya `Accurate: 3 · KINO: 6`, agar pengguna tahu lokasi yang harus diperiksa pada kedua file.

## Struktur Data

`ReconciliationResult` mendapat field tambahan `amountDifferences` berupa array. Setiap item berisi:

- `component`: `gross | discount | dpp | tax | net`
- `accurate`: nilai Accurate
- `kino`: nilai KINO
- `difference`: nilai Accurate dikurangi KINO

Field ini dihitung di fungsi rekonsiliasi yang sudah membandingkan pasangan nilai. Tidak ada perhitungan ulang di UI dan tidak ada endpoint baru.

## Alur Data

1. Parser dan agregasi berjalan seperti sekarang.
2. Mesin membentuk `amountDifferences` hanya untuk komponen yang melewati toleransi nilai.
3. API mengembalikan hasil dengan field tambahan tersebut.
4. Setelah respons berhasil, halaman memilih `ISSUES_ONLY` bila jumlah non-`MATCH` lebih dari nol; selain itu memilih `ALL`.
5. Renderer `Penyebab selisih` menyusun kalimat dari status, selisih jumlah, `amountDifferences`, warning, dan baris sumber.
6. Ekspor tetap memakai struktur dan cakupan lama.

## Kondisi Khusus

- Selisih negatif selalu dijelaskan sebagai `Accurate kurang`; selisih positif sebagai `Accurate lebih`.
- Nilai nol tidak dianggap penyebab kecuali salah satu sumber memang tidak memiliki data.
- Jika nilai bersih sama tetapi gross, diskon, DPP, atau pajak berbeda, komponen yang berbeda tetap terlihat.
- Jika tidak ada masalah, halaman tidak menampilkan empty state yang terkesan gagal.
- Search dan filter tetap bekerja pada seluruh row data yang tersedia.
- Tampilan mengikuti tiga tema existing dan tetap responsif; tidak ada komponen visual baru di luar tabel.

## File yang Disentuh

- `lib/off-program-control/sales-reconciliation.ts`
- `lib/off-program-control/sales-reconciliation.test.ts`
- `app/(dashboard)/reconciliation/page.tsx`
- `tests/reconciliation-ui.spec.ts`

`components/DataTable.tsx` tidak perlu diubah.

## Verifikasi

- Test mesin membuktikan rincian gross, diskon, DPP, pajak, dan net hanya muncul saat melewati toleransi.
- Test browser membuktikan hasil awal hanya menampilkan masalah, baris `MATCH` tersembunyi, penyebab dan baris sumber terlihat, serta pilihan `Semua status` masih menampilkan hasil lengkap.
- Test browser juga membuktikan kondisi semua cocok menampilkan pesan sukses yang tepat.
- TypeScript, ESLint terarah, route test, engine test, dan Playwright localhost 3000 harus lulus.
- Smoke test file nyata tetap menghasilkan 238 total, 236 cocok, 2 bermasalah, dan kedua penyebab tampil langsung.

## Batasan

- Tidak menambah expandable row atau detail drawer; kolom penyebab sudah mencukupi kebutuhan sekarang.
- Tidak mengubah workbook ekspor pada tahap ini.
- Tidak mengubah toleransi, mapping, atau aturan penentuan status.
