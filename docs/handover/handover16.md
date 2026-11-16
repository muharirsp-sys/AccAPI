# HANDOVER — handover16.md (Form Kontrol: nota belum lunas, tagihan kunjungan → Incaso, validasi wajah, merchandising nonaktif, kunci tanggal)

**Status per 16 Nov 2026:** worktree `D:\Coding\AccAPI\wt-laporan-harian`, branch **`feat/fk-nota-kunjungan`** (dari `origin/main` b841ced8).
Belum di-merge. Merge ke `main` = deploy produksi (lihat handover14 §0: skrip `scratch/gh-api.mjs` + `scratch/tunggu-ci.mjs`, berkas CRLF).
**Skema 0044 = zona §3 → butuh review manusia sebelum merge.**

## 1. Permintaan owner (16 Nov 2026) dan keputusan

| Permintaan | Keputusan owner (dipilih dari opsi) |
|---|---|
| Nota belum lunas di Form Kontrol: umur, jumlah nota, umur per nota, pembayaran, "berapa yang keluar, berapa yang tertagih", real time dari Incaso | keluar = nilai faktur, tertagih = sudah dibayar (pelunasan yang diinput Incaso di Accurate), sisa = primeOwing; dibaca LANGSUNG dari Accurate saat kunjungan dibuka |
| Munculkan ke Incaso: toko dikunjungi tapi tidak tertagih dan tidak order | Salesman mengisi hasil tagih di langkah Status bila toko bernota (Tertagih + nominal / Tidak tertagih + alasan) |
| Foto check-in + validasi wajah, kompatibel semua HP? | Cocokkan di server (HP hanya memotret → semua HP yang bisa membuka Form Kontrol) |
| Wajah tidak cocok | Lanjut, tandai SPV (tidak pernah menahan kunjungan) |
| Merchandising nonaktifkan dulu: check-in, order atau tidak, check-out | `MERCHANDISING_AKTIF = false` (constants.ts) |
| Salesman tidak boleh input apa pun mundur tanggal | Server menolak tanggal ≠ hari ini WITA untuk akun salesman; Order Sales tanggal hanya-baca + FastAPI menolak |

## 2. Yang dibangun

| Bagian | Isi |
|---|---|
| Skema **0044** | `ao_control_daily.tagih_status/tagih_nominal/tagih_alasan/tagih_catatan` + `wajah_status/wajah_skor` (nullable, CHECK NOT VALID), tabel `wajah_acuan` (sidik 128 angka per salesman, accapi_app boleh DELETE untuk reset). `db/migrations/0044_tagihan_wajah_kunjungan.sql`, entri migrate-pg "tagihan wajah kunjungan", `docs/handover/DDL_TAGIHAN_WAJAH.sql` |
| Nota | `lib/form-kontrol/nota.ts` (murni) + `nota-db.ts`: `GET /api/form-kontrol/nota` → `pelangganCabang` (diekstrak dari limitToko) → Accurate `sales-invoice/list.do` (`filter.customerId` + `outstandingFilter=true`, ≤ 3 halaman, 8 dtk) → cadangan cache `sales_invoice` ("sinkron"); pembayaran per nota dari cache Kasir ↔ Incaso. Rute hari ini: ringkasan dari cache di kartu toko |
| Tagihan | Langkah Status: `IsianTagihan` (wajib bila nota > 0; toko tutup bernota otomatis "Toko tutup"); `POST ao-control` `tagihan` (`periksaTagihan`). Incaso: menu Keuangan › **Tagihan Kunjungan** (`/tagihan-kunjungan`, izin `pelunasan.kirim` ∨ `kasir.view` ∨ `form_kontrol.manage` — tanpa SQL preset baru) |
| Wajah | Check-in = selfie kamera depan. `checkin` route → `periksaWajahCheckin` (sesudah check-in tersimpan) → FastAPI `POST /wajah/sidik` (OpenCV YuNet + SFace; model ONNX diunduh saat build `Dockerfile.backend`, sha256 terkunci, commit opencv_zoo 48b10fa5) → kosinus vs acuan (≥ 0,363 cocok). Acuan = selfie berwajah pertama; Hierarki: lihat foto + Kosongkan. Dashboard SPV: tanda "Wajah tidak cocok" / "Wajah tidak terlihat" |
| Merchandising | Langkah tidak tampil (4 langkah); TIDAK ORDER tidak lagi menjawab item super; halaman order kembali ke check-out. Kode + tabel tetap (nyalakan lagi = satu konstanta) |
| Kunci tanggal | `galatTanggalSalesman` di check-in/check-out/ao-control/merchandising/order-kunjungan/reports (409 `TANGGAL_BUKAN_HARI_INI`); tab Laporan: laporan kemarin hanya dilihat; Order Sales tanggal hanya-baca + FastAPI `/websales/orders` 409 bila `order_date` ≠ hari ini WITA |

## 3. Uji

- `npm test` hijau (pg dilewati). `tsc --noEmit` + eslint berkas berubah bersih. Python: `test_wajah`, `test_websales_pull`, `test_rbac_parity` OK.
- Playwright baru `tests/fiori-form-kontrol-nota-tagihan.spec.ts` (4 uji); spec lama disesuaikan (4 langkah, selfie, laporan kemarin). Uji merchandising
  lama di `fiori-lapangan-salesman.spec.ts` = `test.skip` (nyalakan bila `MERCHANDISING_AKTIF` kembali true).

## 4. Belum / risiko

1. **`outstandingFilter=true` belum dibuktikan live** (dari dokumentasi Accurate). Bila diabaikan diam-diam, daftar tetap benar (sisa ≤ 0,5 dibuang) tetapi lebih
   panjang; > 300 baris = "terpotong" tampil di layar. Cek pertama di produksi: buka kunjungan toko yang diketahui punya nota.
2. **Validasi wajah belum diuji dengan foto ponsel nyata / di image produksi** (model lokal + gambar contoh opencv_zoo saja). Ambang 0,363 = anjuran OpenCV;
   pantau tanda "Wajah tidak cocok" minggu pertama. Acuan diambil otomatis dari selfie pertama — SPV/Admin perlu memeriksa foto acuan di Hierarki.
3. Python `/wajah/sidik` hanya mensyaratkan sesi login (Python belum mengenal modul izin `form_kontrol`; `shared.py` sengaja tidak diubah). Izin
   `form_kontrol.submit` ditegakkan route check-in Next.
4. Foto check-in disapu cron 90 hari → foto acuan di Hierarki bisa hilang (sidiknya tetap).
5. Kelengkapan tagihan (wajib bila bernota) dijaga layar; server memeriksa format saja (nota langsung dari Accurate, cache server bisa tertinggal).
6. Supervisor Review (layar) belum menampilkan tagihan/wajah; Dashboard SPV sudah (tanda wajah).
7. Uji Postgres 0044 belum pernah jalan (sama dengan 0041–0043).
