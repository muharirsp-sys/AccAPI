# UI/UX Changelog

## 2026-10-01 — Normalisasi beraturan, Periode Aturan Promo, keadaan async, warna status

Cabang `feat/ui-ux-normalisasi-aturan`. Temuan lengkap: `docs/UI_UX_AUDIT.md`. Tangkapan layar:
`docs/ui-baseline/` (sebelum) dan `docs/ui-after/` (sesudah), DB sintetis, tidak ada data nyata.

### Normalisasi Diskon wajib menunjuk aturan promo
- **Before:** centang potongan → "Jadikan Disc Claim" / "Jadikan Disc Distributor" → tersimpan, tanpa dasar.
- **After:** centang → **Jenis normalisasi** → **Aturan promo dasar** (hanya aturan yang berlaku untuk
  SEMUA potongan terpilih; yang nilainya sama dengan potongan didahulukan, ditandai "nilai sama"; kotak
  cari muncul bila calon > 8) → **Simpan sebagai …**. Tiap baris tak bertuan menyebut berapa aturan yang
  berlaku per golongan. Tabel "Sudah dinormalisasi" menyebut aturan dasarnya.
- **Aturan "berlaku"** = satu fungsi `alasanTakBerlaku()` (`lib/promo-recap.ts`), dipakai untuk calon di
  layar, penjaga API, dan penerapan di rekap: principal = cabang faktur, tanggal faktur dalam periode,
  outlet diizinkan daftar peserta / tarif milik outlet, bentuk potongan (tingkat faktur ↔ aturan
  seluruh nota; per barang ↔ aturan barang itu atau tarif outlet), PO pertama, dan beban (Disc Claim =
  PRINCIPAL, Disc Distributor = DISTRIBUTOR). Nilai/posisi sengaja tidak dicocokkan — selisih itulah
  yang diputuskan.
- **Backend:** `POST /api/promo-recap/normalisasi` wajib `promoRuleId` (400 tanpa itu); aturan hilang
  atau nonaktif → 409; tidak berlaku → 422 dengan sebab. `GET /api/promo-recap` menambah `calonAturan`
  per baris tak bertuan, `aturanId` pada baris yang dinormalisasi, dan daftar `aturan` yang dirujuk
  (aditif; kolom lama tidak berubah). Rekap TIDAK memakai keputusan yang aturannya sudah hilang,
  nonaktif, dimuat ulang (id baru), atau tidak lagi berlaku — sebabnya ditulis di kolom Sebab.
- **Skema:** `db/migrations/0025_discount_normalization_rule.sql` — `promo_rule_id bigint` NULL-able,
  tanpa FK; juga terdaftar di `scripts/migrate-pg.mjs` (otomatis saat container start).
- **Keputusan lama** (tanpa aturan) TIDAK dipakai lagi — keputusan pengguna 2 Okt 2026: tanpa rujukan
  program ia tidak sah. Barisnya tetap tersimpan; potongannya kembali ke Tak bertuan dengan sebab
  "keputusan lama tanpa aturan promo dasar — putuskan ulang". **Akibat:** angka Rekap Promo bulan yang
  memuat keputusan lama berubah (Klaim principal / Tanggungan distributor turun, Tak bertuan naik)
  sampai diputuskan ulang dengan aturan.
- **Why:** golongan klaim/beban adalah keputusan uang; tanpa dasar ia tidak bisa dipertanggungjawabkan.
- **Verification:** `lib/promo-recap.test.ts` (24/24; mutasi penjaga beban dan periode membuat uji
  gagal); `tests/normalisasi-aturan-promo.spec.ts` (Playwright, API dipalsukan); E2E nyata ke dev
  server + DB sintetis: 17/17 PASS (tanpa aturan → 400 untuk kedua golongan, beban salah → 422, di luar
  periode → 422, id tak dikenal → 409, principal lain → 422, aturan berlaku → 200 dengan id kanonik
  tersimpan, rekap memakai keputusan, aturan dinonaktifkan → keputusan tidak dipakai, keputusan lama
  tanpa aturan → tidak dipakai).

### Aturan Promo: saringan Periode
- **Before:** Principal, Berlaku untuk, Tanggungan, Cari.
- **After:** + **Periode berlaku** (dari–sampai, bisa dihapus). Semantik BERSINGGUNGAN: surat
  15 Sep–15 Okt ikut tampil di saringan September; aturan tanpa tanggal akhir tampil di periode mana pun.
  Disaring di server (`?dari=&sampai=`), bergabung dengan semua saringan lain; rentang terbalik → 400.
  Tanggal di tabel kini dd/mm/yyyy dengan keterangan "berakhir" / "belum mulai".
- **Verification:** uji `bersinggungan()`; Playwright (parameter gabungan, hapus periode); E2E nyata:
  periode + principal, + berlaku untuk + tanggungan, + cari.

### Keadaan memuat / kosong / galat
- **Before:** layar kosong atau "tidak ada …" selama memuat dan setelah gagal (Antrean Faktur,
  Normalisasi, Aturan Promo, Order Principal, Principal Mapping); Rekap Promo tanpa tanda memuat.
- **After:** pola `memuat | siap | galat` (lihat `docs/UI_DESIGN_SYSTEM.md`): kerangka saat muat awal,
  data lama diredupkan saat muat ulang, galat dengan "Coba lagi", kosong dibedakan dari "tidak sesuai
  saringan". `app/(dashboard)/loading.tsx` untuk perpindahan menu. Penjaga klik ganda pada simpan/cabut
  normalisasi.
- **Verification:** Playwright — memuat tidak tampil sebagai kosong, galat terlihat dan bisa dicoba
  lagi, klik ganda Simpan → satu POST.

### Warna status dan kontras (global)
- **Before:** amber dipetakan ke aksen dekoratif (cyan di Neon); merah/kuning muda tak terbaca di Surya;
  gradien tombol primer berakhir gelap di bawah teks gelap (Neon, Office Calm); panel galat bersama
  merah muda tetap.
- **After:** token `--status-danger` / `--status-warning` per tema; gradien primer tanpa ekor gelap;
  panel galat memakai token. Neon: h2/h3 tanpa miring/kapital/pendar (h1 tetap gaya HUD).
- **Verification:** tangkapan layar Surya dan Neon sebelum/sesudah; warna terhitung tombol primer Neon:
  teks `#021024` di atas `#3ed0ff → #1f8fff` (sebelumnya berakhir di `#0b3263`).

### Antrean Faktur
- **Before:** Kirim (tidak bisa ditarik) terbungkus ke baris sendiri, terpisah dari Tanggal faktur;
  chip status berwarna walau 0; peringatan lewat 2 jam berupa kotak dua paragraf; lewat 2 jam hanya warna.
- **After:** saringan di kiri, kelompok kirim (tanggal + tombol primer) di kanan; chip berwarna hanya
  bila ada isinya, `aria-pressed`; peringatan satu kalimat (penjelasan di `title`), tombolnya berubah
  "Sedang ditampilkan"; label "· lewat 2 jam"; tanggal dd/mm/yyyy. Logika kirim tidak diubah.

### Instruksi agen
- `AGENTS.md`: ditambah bagian **UI/UX Rule** di akhir (isi lama utuh). `CLAUDE.md` dibuat (ringkas,
  menunjuk `AGENTS.md` dan berisi aturan yang sama).
