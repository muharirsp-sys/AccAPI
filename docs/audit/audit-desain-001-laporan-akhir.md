<!--
Tujuan: Laporan akhir Fase 4 audit desain 001: Delivery Gate antislop, verifikasi, tabel sebelum/sesudah per nomor, TODO owner.
Caller: Owner (keputusan push/PR dan butir TODO); agen yang melanjutkan audit desain.
Dependensi: docs/audit/audit-desain-001-2026-10-25.md (151 temuan), DESIGN.md, PRODUCT.md, docs/UI_DESIGN_SYSTEM.md.
Main Functions: Ringkasan hasil, Delivery Gate 4 blok, bukti verifikasi, tabel per nomor, TODO dan usulan di luar nomor.
Side Effects: Tidak ada; dokumen. Merged ke main lewat PR #228 (26 Okt 2026); usulan A, C, E, F lewat PR #229; kelompok 2-4 lewat
cabang fix/desain-audit-kelompok2-3.
-->
# Audit desain 001: laporan akhir (26 Okt 2026)

Owner menyetujui semua 151 nomor dengan syarat: logika bisnis yang sudah berjalan benar tidak berubah. Pekerjaan dibagi ke 7 slice
pembuat (fondasi, api-wrapper, uang, promo/klaim/halaman lama, OPC, lapangan, order/admin) + satu pass penyelesaian lintas area +
perbaikan integrasi oleh orkestrator. Setiap slice diperiksa orkestrator (pembuat ≠ pemeriksa) dengan pemeriksa mekanis "sidik request"
(baris fetch/URL/method/body/FormData dibandingkan dasar vs hasil), pembacaan fungsi tulis, dan satu peninjau independen untuk fondasi.

## Ringkasan

| Ukuran | Sebelum | Sesudah |
|---|---|---|
| Status 151 nomor | - | 118 SELESAI, 31 SEBAGIAN, 2 DITUNDA (4/4 Kritis selesai; Tinggi 45/52 selesai) |
| `npx impeccable detect` (aturan sama seperti audit) | 7 temuan | 0 |
| Halaman dashboard bertema lama (non-Fiori) | 7 (6 halaman + konsol api-wrapper) | 0 |
| Gulir menyamping halaman, 61 rute × 360/768/1280 | 0 | 0 |
| Target sentuh < 44 px di 360 px (nyata) | 46 | 0 (16 terukur = 3 kotak centang di dalam `label.fi-check` 44 px + 13 tautan jejak, diperbaiki cf5175ad) |
| Em dash tampil di layar (1280 px) | 23 di 13 rute | 1 (`/kasir`, pesan server `lib/kasir/hari.ts`) |
| `npx tsc --noEmit` | 0 galat | 0 galat |
| `npm run lint` | 0 galat / 94 peringatan | 0 galat / 91 peringatan |
| `npm test` | 1.254 / 1.010 lulus / 0 gagal / 244 dilewati | 1.255 / 1.011 lulus / 0 gagal / 244 dilewati (+1 tes baru) |
| Playwright (627 tes, tanpa DB, API di-mock) | - | 610 lulus, 13 dilewati, 4 gagal; keempatnya sudah gagal di kode dasar (lihat Verifikasi) |
| Berkas berubah | - | 246 (+6.617 / −6.377); `app/api`, `db`, `python_backend`, `proxy.ts`, auth, rbac, idempotensi: 0 |

## Jaminan logika bisnis

- Daerah logika tidak disentuh: `app/api/**`, `db/**`, `python_backend/**`, `proxy.ts`, `lib/auth*.ts`, `lib/rbac*`, idempotensi,
  `lib/kasir`, `lib/supervisor-review`. Tiga berkas `lib/` di daftar terlarang yang berubah terbukti tampilan saja:
  `lib/form-kontrol/noo-aturan.ts` (teks label status NOO; validasi memakai kunci, bukan teks), `lib/form-kontrol/fk-msm.test.ts` (tes),
  `lib/off-program-control/reconciliation-ui.ts` (kalimat penyebab di layar; ekspor Excel FAKTUR tidak memakainya).
- Sidik request per slice: perbedaan hanya pembungkus `.catch(...)`/`kirimTulis(...)` di sekitar `fetch` yang sama dan teks galat.
  Konsol api-wrapper: `handleExecute`, `handleFileUpload`, `handleDownloadTemplate` byte-identik; `kirimSalesReceipt`/`executeBulkPayload`
  hanya teks toast/log; override duplikat (dulu `window.prompt`) = ConfirmDialog dengan syarat sama (trim, min 15) ke `executeBulkPayload` yang sama.
- Uang: `tulisUang` → `tulisOpc` (pembayaran/refund OPC) terbukti setara pada 24 kasus fetch tiruan (200/409/500/504 HTML/bukan JSON).
  Form refund SPV disatukan dengan form SM/Keuangan: opsi, nilai bawaan, isian wajib, gerbang izin, dan pengurai nominal identik.
  Finance `posting.ts`: yang ditulis ke `accurate_post_error`/`resolution_note` tidak berubah (hanya kalimat yang tampil).
- Aksi tulis yang kini lewat ConfirmDialog: badan fungsi tulis dipindah utuh ke `onConfirm`; spec menegaskan nol POST sebelum konfirmasi
  (mis. api-wrapper Kirim, Finance Simpan tujuan).
- Yang SENGAJA tidak diubah karena menyentuh logika (lihat TODO): nilai bulan/tahun yang dikirim dari jam perangkat, isi ekspor
  (CSV Rekap, Excel log api-wrapper, retur), teks yang ditulis ke DB, body tanpa field alasan, pengurai nominal.

## Delivery Gate antislop

Dial (dari DESIGN.md, mode Operate; dinyatakan di laporan ini, DESIGN.md tidak diubah): ENERGY 1 (tenang), RHYTHM 2, MOTION 1.

### Blok 1: Hard Gate: **FAIL** (3 butir, semuanya di luar pagar perubahan ini)
- R-02 em dash: **FAIL**. Di layar tinggal 1 (pesan server `lib/kasir/hari.ts:82`), dari 23. Sisa di sumber: 46 pesan galat server
  (`app/api/**`, `lib/invoice-outbox-actions.ts`, `lib/accurate-write-attempt.ts`, `lib/sales-receipt-guard.ts`), `lib/pelunasan-wizard.ts`,
  `samarkanNik`, isi ekspor (Status Excel log api-wrapper, penyebab retur) dan teks yang ditulis ke DB. Butuh slice server + izin isi ekspor.
- R-03 mobile: PASS. 183 render: 0 gulir menyamping; target nyata < 44 px 46 → 0; spec ponsel 360/390 lulus.
- R-17 angka tanpa sumber: PASS. "(0)" saat galat, angka dari daftar terpotong ("dari N terbaru"), "Lunas" dari catatan sebagian, label perkiraan No 71.
- R-18 testimoni: PASS (tidak ada).
- R-23 aset: PASS (tidak ada aset dibuat).
- R-24 tautan ke halaman yang tidak ada: **FAIL**. `lib/chatbot/faq.json` menautkan "Buka Validator" ke `/validator` (tidak ada). Ditemukan di pass akhir; di luar 151 nomor.
  Pembaruan kelompok 1: **PASS** (Usulan A; uji `lib/chatbot/faq.test.ts` menolak href FAQ tanpa `page.tsx`).
- R-25 kontras: PASS. Token dihitung (`--primary-hover` gelap 5,38:1, `ink-disabled` tidak lagi untuk teks), mode gelap 12 tangkapan 0 di bawah AA, warna cetak dinaikkan.
- R-26 kontrol mati: PASS.
- R-27 keadaan: PASS. Memuat/kosong/galat dibedakan di halaman lama dan komponen bersama; ditegaskan spec.
- R-28 FAQ generik: **FAIL**. `lib/chatbot/faq.json` masih memuat konten tiga tema yang sudah pensiun. Butir yang sama dengan R-24.
  Pembaruan kelompok 1: **PASS** (jawaban tema = menu profil Mode/Kerapatan; SQLite → PostgreSQL).
- R-32 keyboard dan fokus: PASS. Input berkas fokusable, tombol nonaktif tetap di urutan Tab dengan alasan, fokus terlihat.
- R-33 tambalan skrip: PASS (semua di sumber).
- R-34 tema: PASS (mode gelap 6 rute × 2 lebar).
- R-35 dijalankan: PASS. tsc, lint, 1.255 unit test, 627 tes Playwright, 183 render, mode gelap. Batas: tanpa DB dan Accurate nyata.
- R-36 klaim karangan: PASS ("Bisa dipakai offline" dihapus).
- R-37 arah: PASS (DESIGN.md disetujui owner 25 Okt).
- R-38 konten karangan: PASS (data contoh generik; nilai awal yang menentukan request tetap, lihat No 79).

### Blok 2: Purpose-Gate: PASS
Diff: gradien 67 dihapus / 1 ditambah (penanda gulir subnav, tujuan tertulis), bayangan 72/9, glow 8/0, transisi 45/2, emoji 0 baru.
Pil "Riwayat" tanpa fungsi dihapus (f69badb6). Sisa lama di luar diff: gradien emas di `app/globals.css` (CSS tema mati), emoji di `error.tsx`/`global-error.tsx`.

### Blok 3: Liveliness: PASS
Dial dinyatakan di atas; titik fokus per layar dan tangga bobot terjaga (Fase 3 A); satu aksen Biru SP; motif identitas = header Object Page
+ alur status + badge ikon+label; whitespace struktural; Design Read = DESIGN.md.

### Blok 4: Craftsmanship & Quality Locks: PASS
C-1..C-5 tidak ada pelanggaran; tanpa templat AI (R-05); radius bervariasi 6/8/12/pil (R-11); label tombol kata kerja spesifik (R-15);
jargon pemasaran/slang dihapus ("Eksekusi brutal", "Self-Healing", "AI Assistant") (R-16); identitas = logo + Biru SP + pola Fiori pilihan
owner (R-20, R-30); mode gelap mengikuti sistem (R-21); palet 1 aksen + semantik (R-29); tiap keputusan tertaut ke DESIGN.md (R-31).

**Vonis: FAIL karena Blok 1 (R-02 sisa di sumber server/ekspor, R-24 dan R-28 di FAQ chatbot).** Menurut antislop, hasil dengan FAIL
tidak dikirim sebagai selesai. Ketiganya di luar nomor yang disetujui dan/atau di zona server, jadi butuh izin owner (Usulan A dan B).

**Pembaruan kelompok 1 (izin owner 26 Okt):** R-24 dan R-28 PASS lewat Usulan A. Blok 1 tinggal FAIL karena R-02 (Usulan B, zona server).

**Pembaruan kelompok 2-4 (keputusan owner 27 Okt, cabang `fix/desain-audit-kelompok2-3`):** R-02 PASS. Pemindai literal (komentar tidak
ikut) di app/lib/components/config: em dash 196 → 24, dan 0 di string yang sampai ke user. Sisa 24 sengaja: laporan CLI
`lib/principal/laporan.ts` (18, judul dikunci uji), isi fungsi trigger `lib/principal/penjaga.ts` (2, dibandingkan persis dengan
`pg_proc.prosrc`), prompt OCR `lib/promo-letter-ocr.ts` (3), komentar CSS di `app/(cetak)/layout.tsx` (1). En dash tersisa = rentang
(`1–20`, `${dari} – ${sampai}`). **Vonis Delivery Gate: PASS** (Blok 1-4).

## Pembaruan kelompok 2-4 (27-28 Okt 2026)

Owner menjawab semua sisa nomor pada 27 Okt ("sisanya lakukan berdasarkan keputusan terbaikmu, jangan sampai hasilnya slop") dan
mengizinkan perubahan logika/isi khusus untuk butir di bawah (termasuk `app/api/**`, satu tabel baru, `python_backend/**`, label
`lib/rbac.ts`, `DESIGN.md`, isi ekspor yang disebut). Empat pembuat (A1 UI, A2 kode mati, B1 endpoint, B2 server/api-wrapper), dua
peninjau independen (masing-masing REQUEST CHANGES → diperbaiki → APPROVE).

| No | Status | Sesudah |
|---|---|---|
| 6 | SELESAI | Terima sales dan Cabut (Verifikasi balik) wajib alasan 10-500 karakter; Cabut menyalin baris + alasan ke `pencabutan_log` dalam satu transaksi |
| 7, 78, 29 | SELESAI | api-wrapper: teks tugas tanpa em dash; log galat dan laporan Retur Manual lewat tombol, tidak terunduh otomatis; request ke Accurate identik (sidik-request) |
| 18 | SELESAI | Cabut konfirmasi order ganda wajib alasan (body DELETE), tercatat di `pencabutan_log` |
| 22 | SELESAI | Semua dialog tulis OPC: hasil tidak pasti → dialog ditutup, muat ulang, strip peringatan bertahan |
| 27 | SELESAI | GET `/api/off-program-control/periods`: status penutupan nyata (siapa, kapan WITA); Buka kunci hanya dari status segar |
| 30 | SELESAI | Catatan posting Finance dalam kalimat tugas; penanda "(HTTP 5xx)" dan cadangan lama dipertahankan karena dibaca `AMBIGUOUS_POST_ERROR` |
| 31 | SELESAI | Bulan/tahun yang dikirim dari WITA (`hariIniWita`) |
| 59, 108 | SELESAI (sengaja) | Label "Simpan N perubahan…" dan kaki Rekaman panjang dipertahankan; alasan di baris tabel |
| 65 | SELESAI | CSV Rekap Promo: Persen dan Rupiah koma desimal tanpa ribuan |
| 73, 79 | SELESAI | Batch SPV tanpa principal bawaan (wajib pilih), tanpa cadangan RECKITT/05/2026; Principal Mapping dari `PRINCIPAL_DIDUKUNG`; daftar outlet dari server |
| 80 | SELESAI | Satu VariantNote per layar (hanya Admin); catatan yang diturunkan tetap hanya Admin kecuali fakta tugas |
| 81 | SELESAI | FastAPI GET/POST `/summary/review/reference` (alias lama tetap); tombol berlabel bulan dari paket, nonaktif beralasan bila tidak ada |
| 87 | SELESAI | Riwayat principal menampilkan nama pelaku (`actorName`) |
| 88 | SELESAI | "Pembayaran dan SPPD"; istilah "user" di layar dan pesan server; label izin seragam ("Kelola", "Ekspor Audit"), kunci tetap |
| 91 | SELESAI | "Exception" → "Masalah" di layar dan riwayat wave |
| 98, 99 | SELESAI | Tema Surya lama, `workspace.css`, remap warna, font Geist dihapus; 244 tangkapan sebelum/sesudah identik di luar jam |
| 102, 112, 113, 137 | SELESAI | Dicek render 360/1280 px: tuntas |
| 104 | SELESAI | OPC OM/SM: kartu KPI → KeyValues kecil; angka inti di pilihan antrean |
| 109 | SELESAI | "Hari ini" Kasir/Finance dihitung ulang di klien dari jam server (WITA); tidak menimpa pilihan, draf, atau hasil belum pasti |
| 111 | SELESAI | OPC ponsel: buka batch → gulir + fokus ke judul detail (reduced-motion dihormati) |
| 122 | SELESAI | Isian rupiah teks + satu pengurai id-ID (mode ketat: titik hanya ribuan); angka polos saat fokus |
| 128 | SELESAI | `DESIGN.md`: "Kerapatan: Padat/Lega" |
| 135 | SELESAI | `TabelRincian` disatukan ke `ResponsiveTable` (`rincian`, `foot`) |
| 136 | SELESAI | Baris batch OPC (daftar, lonceng, Ringkasan Admin, Log audit) tautan nyata `?batch=` |
| 140, 141 | SELESAI | Wadah gulir tabel `role="group"` bernama; h1 kedua → h2 (Finance, Aturan Promo, OPC, Data Principal) |
| 142 | SELESAI | Pencarian OPC lewat "/", Ctrl K tetap cari menu shell |
| 390 | SELESAI | Baseline snapshot `kit-default-390` diperbarui |
| B, D, G | SELESAI | Em dash server/ekspor/DB (R-02; kalimat order ganda TS dan Python diubah bersamaan); kode mati; Kirim tab Excel nonaktif tanpa berkas |

Deploy: tabel `pencabutan_log` dibuat `scripts/migrate-pg.mjs` saat container start (butuh `DATABASE_MIGRATION_URL`, ada di produksi;
tanpa itu jalankan `db/migrations/0038_pencabutan_log.sql` sebagai pemilik lebih dulu). Tanpa tabel itu kedua Cabut gagal 500 tanpa menghapus apa pun.
Uji nyata (TODO 15) tetap butuh owner/lapangan.

## Verifikasi

- Gate (HEAD f69badb6): tsc 0 galat; lint 0 galat / 91 peringatan; `npm test` 1.255 / 1.011 / 0 / 244.
- Playwright (dev server lokal, `LOCAL_AUTH_BYPASS`, API di-mock, 1 worker): 610 lulus, 13 dilewati, 4 gagal. Keempatnya gagal juga di kode
  dasar (baseline pembuat M0/M1/M4): `fiori-sesi-accurate:320` (butuh OAuth Accurate asli), `fiori-ui-kit:71` (snapshot 390 px usang
  sebelum audit), `local-off-auth-bypass:3` (menunggu tombol "Detail akses" yang tidak pernah dibangun), `workspace-redesign:97` (cek warna
  lama). `reconciliation-ui.spec.ts` tidak bisa dijalankan (butuh kredensial login asli).
- Regresi integrasi yang ditemukan dan diperbaiki (f0e1cb4d): alasan nonaktif tampil dua kali di 58 dialog (efek samping No 120), konteks
  "Gagal memuat …" hilang di Claim Workflow/OPC (bentrok perubahan `ambil` M5 dengan `pesanGalat` M3).
- Fase 3: Taste memeriksa antislop: tidak steril (titik fokus, tangga bobot, aksen hemat), 3 cacat diperbaiki (f69badb6); antislop memeriksa
  tambahan: bersih; mode gelap: lulus. `npx impeccable detect`: 7 → 0 (aturan sama); dengan konteks DESIGN.md: 79 advisory, hampir semuanya
  warna tema Surya di `globals.css`/`workspace.css` yang kini tidak dipakai halaman (Usulan D).

## TODO yang butuh keputusan atau data dari owner

Diputuskan owner 27 Okt dan dikerjakan (lihat "Pembaruan kelompok 2-4"), kecuali butir 15 (uji nyata).

1. No 65: format desimal CSV Rekap Promo (titik atau koma); mengubah isi ekspor.
2. No 87: nama pelaku riwayat Data Principal; butuh API `actorName`.
3. No 6: alasan wajib "Terima sales" (server sudah menerima `note`; layar mengirim `""`).
4. No 18: alasan Cabut konfirmasi order ganda; endpoint DELETE tidak punya field alasan.
5. No 7 / 78 / 29: izin mengubah teks di dalam `handleExecute`/`handleFileUpload` api-wrapper, unduhan otomatis log galat, dan teks kolom Status Excel log.
6. No 122: isian nominal berformat ribuan; perlu satu pengurai id-ID untuk uang yang disepakati.
7. No 27: status penutupan periode OPC dari server; butuh endpoint baca (BL-12).
8. No 31: bulan/tahun bawaan yang DIKIRIM masih dari jam perangkat (identik untuk perangkat WITA); ganti ke WITA atau biarkan.
9. No 73 / 79: nilai awal "RECKITT", "KINO NON FOOD", "LOYALTY" menentukan request/nomor; kosongkan atau biarkan.
10. No 80 / 104 / 22: catatan varian maks satu per layar, kartu OM/SM → Tile, dialog tertutup saat hasil tidak pasti: spec saat ini mengunci perilaku lama.
11. No 81: tombol "Buka paket rujukan September 2026" butuh endpoint dinamis.
12. No 91: istilah tunggal "Exception" atau "Masalah" (Rekapan Nota + Beranda).
13. No 88 sisa: label modul izin di `lib/rbac.ts`, menu "Pembayaran / SPPD" (memuat "/"), istilah "user".
14. No 109 / 111 / 136 / 142: hari ini dari jam server (Kasir/Finance), gulir otomatis FCL di ponsel, `ListItem` dengan `href` + `onClick`, pintasan Ctrl K OPC.
15. Uji nyata: cetak A4 hitam-putih di printer gudang (satuan 8 pt, `.kode-internal`), izin kamera ditolak di ponsel, penanda peta dengan data nyata,
    satu putaran dengan akun dan data produksi (Playwright di sini tanpa DB/Accurate).
16. Snapshot `fiori-ui-kit` 390 px yang sudah usang sebelum audit: perbarui atau biarkan.

## Usulan di luar 151 nomor (butuh izin; A, C, E, F dikerjakan di kelompok 1)

- A. `lib/chatbot/faq.json`: hapus tautan `/validator` dan konten tiga tema lama (menutup FAIL R-24/R-28). **SELESAI (kelompok 1).**
- B. Slice server: 46 pesan galat ber-em dash + `lib/kasir/hari.ts`, `lib/pelunasan-wizard.ts` (sebagian zona §3; menutup FAIL R-02). **SELESAI (kelompok 3).**
- C. `app/(dashboard)/error.tsx` dan `app/global-error.tsx` ke Fiori (emoji ⚠️, tombol amber). **SELESAI (kelompok 1).**
- D. Hapus kode mati: `components/ui/DatePickerField|Input|Select|AsyncState` (cek pemakai dulu) dan CSS tema Surya lama di `globals.css`/`workspace.css`. **SELESAI (kelompok 2).**
- E. Judul panel Saringan ke `--fs-title-3` (lebih berat dari judul panel data di halaman yang sama). **SELESAI (kelompok 1).**
- F. Antrean Faktur: galat yang sama diulang 8× saat sumber gagal → satu strip. **SELESAI (kelompok 1):** galat cukup sekali di tabel (Coba lagi); kartu status hanya "-".
- G. api-wrapper tab Excel tanpa berkas: Kirim memakai contoh payload bawaan endpoint (dialog kini menyebutnya); usulan nonaktifkan (logika → tracker AM). **SELESAI (kelompok 3):** Kirim nonaktif sampai berkas diunggah.

## Commit (merged ke `main` lewat PR #228, 6da35b0e, 26 Okt 2026)

1c2dcd60 dokumen + `lib/tampil.ts` · 76b15f6e M0 fondasi · 0e820a1c M1 api-wrapper · f949fb4f M3 promo/klaim/halaman lama · fc6019c7 M2 uang ·
83151435 M4 OPC · 18fa7f22 M6 order/admin · f7c20e9c M5 lapangan · 971fa622 penyelesaian lintas area · f0e1cb4d regresi integrasi ·
c4b8ebb1 SYSTEM_MAP · cf5175ad tautan jejak 44 px · f69badb6 Fase 3.

## Tabel sebelum/sesudah per nomor

Sumber: tabel per nomor di laporan tiap pembuat (M0..M6) + pass penyelesaian. "Sebelum" lengkap ada di tabel temuan
`docs/audit/audit-desain-001-2026-10-25.md`; kolom ini meringkas apa yang berubah.

| No | Sev | Kategori | Status | Sebelum → Sesudah (ringkas, dari laporan pembuat) |
|---|---|---|---|---|
| 1 | Kritis | UX/alur | SELESAI | M1: Hasil parser = "Eksekusi Sukses" hijau → strip info "Berkas dianalisis, belum dikirim ke Accurate."; strip sukses "Accurate menerima kiriman." hanya untuk jawaban ber-`s: |
| 2 | Kritis | UX/alur | SELESAI | M1: Klik Eksekusi = langsung tulis → ConfirmDialog "Kirim N baris ke Accurate?" berisi endpoint, isi (N baris, tahap), sumber, database aktif (alias dari kartu sesi; tanpa re |
| 3 | Kritis | UX/alur | SELESAI | M3: galat muat hanya toast lalu layar "Belum ada master"; Mapping menyisakan baris principal lain → `ErrorState` (sebab + Coba lagi) bila belum ada data, strip "hasil sebelum |
| 4 | Kritis | Aksesibilitas | SELESAI | M1: `input type=file` `hidden` (tak bisa Tab) → `sr-only` di dalam `label.fi-btn` (fokus terlihat via `.fi-btn:has(input:focus-visible)` dari pembuat fondasi) · M3: `input type=file` `hidden` / `sr-only` tanpa fokus → master-barang: `label.fi-btn` + input `sr-only` (cincin fokus dari CSS M0, diuji dengan kibor); principles: input `.f |
| 5 | Tinggi | UX/alur | SELESAI | M6: Tambah anggota / Tambah ke grup langsung POST → ConfirmDialog "Tambahkan {user} ke {grup}?" (izin yang didapat, role identitas lama → baru, berlaku, riwayat), tombol "Tam |
| 6 | Tinggi | UX/alur | SEBAGIAN | M6: Terima sales / Cabut satu klik → ConfirmDialog dengan faktur, SO, selisih sales atau penjelasan yang dicabut. Alasan tertulis TIDAK ditambahkan (lihat DITUNDA) |
| 7 | Tinggi | UX/alur | SEBAGIAN | M1: Validasi JSON toast → strip `neg` di atas payload; "Periksa console log" → "Rincian per baris ada di Excel log galat yang diunduh otomatis"; tombol "Unduh ulang log galat |
| 8 | Tinggi | UX/alur | SELESAI | M1: `window.prompt` alasan override → ConfirmDialog `tone="negative"`: fakta blok, baris bertanda, nilai, invoice, pelanggan, total dikirim; `reason={{ label: "Alasan overrid |
| 9 | Tinggi | UX/alur | SELESAI | M3: pilih berkas langsung menulis daftar + menunjuk aturan → dua langkah: pilih berkas lalu ConfirmDialog (berkas, kode distributor, nama daftar, akibat), "Muat daftar"; bada |
| 10 | Tinggi | UX/alur | SELESAI | M3: `throw new Error(b.error)` tanpa isi, `r.json()` tanpa catch ("Unexpected token"), satu strip amber untuk semua → sebab dari status (`sebabHttp`), `.json().catch`, strip  |
| 11 | Tinggi | UX/alur | SELESAI | M2: "Simpan tujuan" langsung POST → `ConfirmDialog` "Simpan tujuan pembayaran {principal}?" dengan pemasok/rekening lama → baru, "berlaku untuk semua pengajuan berikutnya"; ` |
| 12 | Tinggi | UX/alur | SELESAI | M2: Bulan non-terpilih berbadge "Lunas", "Belum dibayar" saat tak ada utang → bulan lain "Catatan: n dari m lunas" tanpa badge Lunas; bulan terpilih tanpa utang "Tidak ada ya |
| 13 | Tinggi | UX/alur | SELESAI | M3: Finalisasi, Adaptasi Semua Master Lama, Simpan Kamus Kode satu klik + toast → ConfirmDialog dengan jumlah dan akibat; kalimat akibat Kamus Kode pindah ke dialog |
| 14 | Tinggi | UX/alur | SELESAI | M4: cek sesi gagal tampil "Anda belum memiliki akses … Hubungi admin" → `error` useSession dibaca: ErrorState "Sesi gagal diperiksa" + Coba lagi (`refetch`); EmptyState izin  |
| 15 | Tinggi | UX/alur | SELESAI | M6: Tarik sekarang satu klik → ConfirmDialog (jumlah menunggu, yang dibuat, tanpa harga), tombol "Tarik permintaan" |
| 16 | Tinggi | UX/alur | SELESAI | M3: `window.confirm` hapus master/mapping → ConfirmDialog negatif berisi nama principal, berkas, pemakai (Summary) |
| 17 | Tinggi | UX/alur | SELESAI | M3: "Muat" mengganti seluruh mapping tanpa dialog → dialog dengan principal, jumlah baris per jenis, "mengganti seluruh mapping" |
| 18 | Tinggi | UX/alur | SEBAGIAN | M6: Cabut, Segarkan harga, Validasi, Simpan batch satu klik → dialog (Cabut: SO, principal, dikonfirmasi oleh, catatan, akibat; Validasi/Segarkan: baris, SO, kode produk, aki |
| 19 | Tinggi | UX/alur | SELESAI | M3: Terbitkan untuk order hanya lewat satu centang → ConfirmDialog (program, surat, revisi paket, jumlah aturan siap, akibat); centang tetap syaratnya |
| 20 | Tinggi | UX/alur | SELESAI | M0: DataTable tanpa keadaan galat, kosong satu kalimat → props `error`/`onRetry` (ErrorState + Coba lagi), kosong "Belum ada data" vs "Tidak ada baris yang cocok"; gaya Fiori |
| 21 | Tinggi | UX/alur | SELESAI | M5: "Masukkan ke JKS" menulis data induk JKS dengan satu klik → ConfirmDialog (toko, jadwal, salesman, principal, JKS salesman lain); isi kiriman dan urutan panggilan sama |
| 22 | Tinggi | UX/alur | SELESAI | M4: dua helper (`tulisOpc`/`tulisUang`), dua kelas, dua redaksi, strip + muat ulang hanya di Keuangan → satu helper `tulisOpc` (+ `kirimTulis`), satu kelas `TulisTidakPasti`, |
| 23 | Tinggi | UX/alur | SELESAI | M4: "Menunggu Anda (0)", "0 batch", "Semua pengajuan (0)", "Tampilan (0)" saat memuat/galat → hitungan hanya bila daftar termuat |
| 24 | Tinggi | UX/alur | SELESAI | M4: batas 200 batch hanya di VariantNote (admin) → strip peringatan di Ringkasan, Tutup periode, Diajukan vs diklaim + subjudul "dari 200 batch terbaru" saat daftar ≥ 200; an |
| 25 | Tinggi | UX/alur | SELESAI | M4: fetch mentah: putus = teks peramban, 502/504 HTML mentah, gagal submit dinyatakan pasti → fetch tetap (init identik) dibungkus `kirimTulis`: putus/≥ 502/bukan JSON = "bel |
| 26 | Tinggi | UX/alur | SELESAI | M4: "Pengajuan bermasalah (6)" dan "Lewat SLA N peringatan" dengan daftar terpotong tanpa keterangan → "Perlu ditinjau admin: 6 teratas dari N", "10 teratas dari N peringatan |
| 27 | Tinggi | UX/alur | SEBAGIAN | M4: tanpa badge saat status tidak diketahui; deskripsi "tidak bisa diubah lagi" → badge "Status penutupan belum diketahui" + baris "Status penutupan: Belum diketahui (tidak d |
| 28 | Tinggi | UX/alur | SELESAI | M5: Simpan area per baris, Simpan isi per karton, dan Selesai (exception) langsung → ConfirmDialog ringkas (lama → baru, "berlaku untuk wave berikutnya"); footer "Simpan N ou |
| 29 | Tinggi | Copy | SEBAGIAN | M1: Em dash/"—" di label alasan tinjauan, toast/pesan log layar, nilai kosong → koma/titik, `KOSONG`; `SA` "Host —" → `KOSONG`. Em dash di isi Excel log (`STATUS`, "Gagal — t · M2: Em dash di judul strip/pesan/fakta + "—"/"–" sebagai kosong → titik/koma/titik koma/titik dua + `KOSONG` (lib/tampil). Sisa em dash hanya di komentar dan di 2 string yang · M3: em dash di teks UI (judul strip, opsi, alasan, fakta dialog) dan penanda kosong "–"/"—" → titik/koma/titik dua atau "-" dari `KOSONG`; en dash hanya tersisa untuk |
| 30 | Tinggi | Copy | SEBAGIAN | M1: `SA` "PT CONTOH (id 77)" → "PT CONTOH" dengan id di `title`; id hanya tampil bila nama kosong ("Tanpa nama (id …)") · M2: "(HTTP n)", "Command posting", "sales-receipt", "231 endpoint", enum/field mentah → `sebabHttp`, label kolom ISIAN, LABEL_TIPE/STATUS ("tidak dikenal"), "Penerimaan Penju · M3: `HTTP 5xx`, "Failed to fetch", `Unexpected token`, `[object Object]` (detail FastAPI), nama pembaca (engine), kode QC, enum status mentah → kalimat sebab (`sebabHttp`), p · M4: `labelStatus`/`labelAksiAudit` menampilk |
| 31 | Tinggi | Copy | SEBAGIAN | M2: Time Gone, "periode berjalan", periode bawaan dari jam perangkat → hari ini/bulan WITA (`hariIniWita`) · M3: tanggal tampil `6 Okt`/ISO/`toLocaleString` zona perangkat → `dd/mm/yyyy` dan `dd/mm/yyyy hh.mm` WITA (`tanggalWita`/`waktuWita`); "hari ini" bawaan WITA di Summary (tang · M4: `waktuWita` OPC duplikat → diekspor ulang dari lib/tampil (satu helper). Nilai awal bulan/tahun dari jam perangkat (KlaimClm, Spv batch baru) dan `type="month"` (saringan · M5: "6 Okt 09.40" tanpa tahun/WITA → `waktuWita` "06/10/2 |
| 32 | Tinggi | Copy | SELESAI | M2: tag "BL-05"/"BL-26", subtitle "BL-35"/"(BL-33)", kalimat "(D-05)"/"(D-06)"/"(AM-019)"/"(BL-49)" → nama tindakan / dihapus · M6: tag "BL-39/16/17", "(usulan BL-18/19)", "(BL-21)" → nama tindakan, kalimat tanpa kode; `bl=` VariantNote tetap |
| 33 | Tinggi | Copy | SELESAI | M0: "Install Smart ERP… Bisa dipakai offline" → "Pasang Ruang Kerja di perangkat" + "Tetap butuh koneksi untuk mengirim data ke Accurate", tombol Pasang/Nanti |
| 34 | Tinggi | Warna/kontras | SELESAI | M1: Neon (heksa, blur, glow, shadow-2xl, indigo/ungu, `neon-text-*`, layar "Menghubungkan ke Workspace…") → `FioriScope` + `fi-page`, `Section`, `FormField`, `Button`, `Messa |
| 35 | Tinggi | Warna/kontras | SELESAI | M1: `text-white/35..45`, `text-[10px]` kapital → `fi-label`/`fi-small`/`fi-muted`/`fi-subtle`; alasan duplikat = `StatusBadge tone="warn"`, "Rekomendasi" = `StatusBadge tone= |
| 36 | Tinggi | Warna/kontras | SELESAI | M3: `text-emerald-600`/`text-amber-600` tanpa remap (±3:1) → `StatusBadge` bernada token (ikon + label) |
| 37 | Tinggi | Warna/kontras | SELESAI | M2: Tile nonaktif `opacity .62` (alasan ikut pudar) → hanya ikon/judul diredupkan, alasan warna penuh |
| 38 | Tinggi | Warna/kontras | SELESAI | M0: gelap `--primary-hover:#3b7fd6` (4,04:1, lebih terang) → `#2c6abd` (5,38:1, menggelap) di dua blok; fiori.css tidak memasang ink-subtle di atas surface-3/brand-tint-stron |
| 39 | Tinggi | Warna/kontras | SELESAI | M0: baris keluar `--ink-disabled` 2,5:1 → `--ink-muted` 7,25:1 (coret tetap); badge "Keluar" per halaman milik area |
| 40 | Tinggi | Warna/kontras | SELESAI | M0: heksa/gradien/kaca di body, Toaster, AccessDenied, ChatWidget, DataTable, PWA, DatePicker → token (`--surface`, `--ink`, `--status-danger`, …); Toaster richColors diarahk |
| 41 | Tinggi | Warna/kontras | SELESAI | M5: Peta: 7 heksa → cincin `var(--pos-solid)` dkk; kamera: kelas indigo/emerald/rose/slate → token + `fi-btn`, galat memakai MessageStrip |
| 42 | Tinggi | Warna/kontras | SELESAI | M0: Select `bg-[#16181d]` + teks remap (±1,2:1), tanpa header → `fi-input`/`fi-label`/`fi-msg`, header doc (nol pemakai) |
| 43 | Tinggi | Warna/kontras | SELESAI | M5: Cetak (CSS saja): satuan 6,5pt → 8pt tebal; label kolom/paraf/jejak 6-6,5pt → 7pt; `.kode-internal` #9a9a9a → #595959 7,5pt; `.nol` #b0b0b0 → #767676. Hitungan halaman ti |
| 44 | Tinggi | Layout | SELESAI | M6: Laporan Sales berkerangka Tailwind (text-xl, input polos, opacity-70) → fi-page, fi-page-head + jejak, fi-page-bar, fi-input, fi-small fi-muted |
| 45 | Tinggi | Mobile/responsif | SELESAI | M0: target < 44 px → pointer kasar: chip hapus 44 px (::after), kotak pilih tabel dalam label 44 px, `.fi-segs` 44 px, subnav 44 px; ChatWidget/PWA/DataTable pakai `Button` ( · M4: subnav OPC ±35 px, segmented 28 px di layar sentuh → 44 px lewat CSS M0 (diverifikasi render layar sentuh 360 px, bagian 4); tanpa perubahan kode M4 · M6: chip izin AksesGrup (dan chip grup awal Pengguna) 28 px → 44 px di pointer kasar · Akhir: tautan jejak 44 px di layar sentuh (cf5175ad); sapuan 360 px: 46 → 0 target nyata < 44 px. |
| 46 | Tinggi | Mobile/responsif | SELESAI | M1: Area unggah `p-12 m-6`, tombol tanpa wrap → `p-4 sm:p-6`, `flex flex-wrap`, tombol Fiori (44 px di layar sentuh) |
| 47 | Tinggi | Mobile/responsif | SELESAI | M3: kontrol `py-2 text-xs`, checkbox `h-4 w-4`, teks 10-11 px → `Button`, `FormField`, `.fi-input`, `.fi-segs` (44 px di pointer kasar, isian 16 px) |
| 48 | Tinggi | Mobile/responsif | SELESAI | M2: Checkbox polos ±16 px di daftar ponsel → dibungkus `label.fi-check` setinggi `--ctl-h` (44 px di layar sentuh) · M4: kotak pilih item di daftar ponsel Keuangan 16 px polos → dibungkus `label.fi-check` (44 px di layar sentuh), aria-label tetap |
| 49 | Tinggi | Mobile/responsif | SELESAI | M5: "Toko baru (belum ada di Accurate)", "Tambah ke kunjungan hari ini", "Kirim status rute hari ini…", "Proses dan perbarui dashboard", "Cetak semua rekapan + TTF" → "Tambah |
| 50 | Tinggi | Aksesibilitas | SELESAI | M2: Alasan nonaktif hanya di `title` → teks terlihat (`fi-why`/MessageStrip); Kasir "Baca penuh" alasan dibetulkan; Rekonsiliasi tanpa izin: strip + kaki tetap tampil · M5: alasan nonaktif hanya di `title` → teks terlihat `fi-small fi-why` di dekat kontrol (bintang prioritas Rute, Simpan Hierarki, Simpan alasan Toko Tidak Order, tombol foto  · M6: alasan/info hanya di `title` → teks terlihat: sumber harga master, legenda "(lap. Dn)", alasan pencarian pelanggan/barang terkunci, "Semua" nonaktif, Terima sales; title  |
| 51 | Tinggi | Aksesibilitas | SELESAI | M1: Label Endpoint tak terikat, textarea tanpa label, 9 input placeholder-saja → `FormField` semua: "Endpoint API", "Payload JSON", "Akun kas/bank Tunai", "ID penomoran Tunai |
| 52 | Tinggi | Aksesibilitas | SELESAI | M3: tab aktif hanya warna → `.fi-segs` + `aria-pressed` |
| 53 | Tinggi | Aksesibilitas | SELESAI | M3: `outline-none` + cincin 1 px setengah transparan → fokus global `.fiori :focus-visible` |
| 54 | Tinggi | Aksesibilitas | SELESAI | M3: isian tanpa label terikat, tombol ikon tanpa nama → `FormField`, isian tabel ber-`aria-label` ("Nama hasil baris N", "Strata N minimum"), tombol ber-nama |
| 55 | Tinggi | Aksesibilitas | SELESAI | M0: fokus jatuh ke body, fokus Tab membuka kalender, tinggi 340 px, merah luar bulan 2,5:1 → fokus kembali ke isian, buka hanya klik/Enter/Spasi/Panah bawah, tinggi dari `off |
| 56 | Tinggi | Aksesibilitas | SELESAI | M5: penanda hanya beda warna → cincin berwarna + huruf E/T/B/F di penanda dan legenda; daftar teks fokusable "Lihat toko dan check-in sebagai daftar". Koordinat dan data tak  |
| 57 | Sedang | UX/alur | SELESAI | M3: Summary: lima tombol primary, Gerbang faktur di atas Surat; ClaimDetail: Simpan primary di tiap baris → bagian berurutan mengikuti Flow, hanya footer yang primary; Simpan |
| 58 | Sedang | UX/alur | SELESAI | M3: muat ulang tiap ketukan, jawaban lambat menimpa → kode principal/pencarian dijeda 300 ms + penanda permintaan terakhir |
| 59 | Sedang | UX/alur | SEBAGIAN | M2: Kaki "Belum ada perubahan konstanta" saat ada draf daftar → kaki menyebut "n daftar belum disimpan di seksinya". Label tombol "Simpan N perubahan…" dibiarkan (dipakai lua |
| 60 | Sedang | UX/alur | SELESAI | M0: LoadingState krem + aria-label di div + dua role status → FioriScope + kerangka judul/saringan/tabel, satu role status, komentar dikoreksi |
| 61 | Sedang | UX/alur | SELESAI | M6: Batal/jejak membuang isian diam-diam → ConfirmDialog "Buang isian order ini?" (pelanggan, barang terisi), "Buang isian"/"Lanjutkan mengisi" bila ada isian |
| 62 | Sedang | UX/alur | SELESAI | M6: butir "Salesman dipilih saat antre" selalu centang hijau → ikon info netral tanpa `data-ok` (keterangan, bukan pemeriksaan) |
| 63 | Sedang | UX/alur | SELESAI | M2: Empty-state menyuruh "cari dengan nomor SPPD" (fitur tidak ada) → "Kembali ke daftar … lalu pilih pengajuannya" |
| 64 | Sedang | UX/alur | SELESAI | M2: Kaki Simpan tanpa nilai lama → "N isian di M rekaman belum disimpan. LPB-x · Nilai invoice: lama → baru · +n lainnya"; tombol Rincian "Terapkan ke draf" (bila bisa diubah |
| 65 | Sedang | UX/alur | DITUNDA | M3: CSV titik koma tetapi desimal bertitik: format ekspor tidak diubah (dilarang brief). Hanya komentar diselaraskan dengan kodenya |
| 66 | Sedang | UX/alur | SELESAI | M6: galat opsi Tahun/Principal/Customer tampil sebagai dropdown kosong → strip warn per daftar + Coba lagi; customer belum dipilih diberi tahu di bantuan isian |
| 67 | Sedang | UX/alur | SELESAI | M3: Muat menutup dialog saat gagal, hasil di strip jauh → galat dilempar ke dialog (dialog tetap terbuka, daftar yang ditolak juga di strip), hasil digulirkan ke strip |
| 68 | Sedang | UX/alur | SELESAI | M0: galat signOut ditelan lalu pindah ke /login → tombol sibuk; gagal = MessageStrip "Keluar belum berhasil. Sesi mungkin masih aktif…" tanpa pindah; sukses tetap ke /login,  |
| 69 | Sedang | UX/alur | SELESAI | M5: gagal memuat jumlah NOO = tanpa lencana → tab Toko Baru berlencana "!" (nama aksesibel "jumlah yang menunggu gagal dimuat") dan strip peringatan di Dashboard SPV |
| 70 | Sedang | UX/alur | SELESAI | M5: Batal membuang isian NOO sekali ketuk → dialog "Buang isian toko baru?" yang sama dengan penjaga pindah halaman (satu dialog, dua pemicu). Draf di sessionStorage TIDAK di |
| 71 | Sedang | UX/alur | SELESAI | M5: "Hari kerja / bulan" dan "Kunjungan / hari" tanpa asal → label jujur ("menurut server" atau "perkiraan: total slot dibagi 20" / "asumsi 20; server tidak mengirim"); rumus |
| 72 | Sedang | UX/alur | SELESAI | M5: Simpan perubahan Penerima tanpa ringkasan → footer: "N baris diubah · belum disimpan · X ditambah · Y diganti · Z dinonaktifkan · penerima aktif a → b. Simpan menggantika |
| 73 | Sedang | UX/alur | SEBAGIAN | M4: CLM: principal bawaan "RECKITT BENCKISER, PT" → opsi "Pilih principal…" + syarat "Pilih principal dulu." (server menolak principal kosong, route.ts:495-496). SPV batch ba |
| 74 | Sedang | UX/alur | SELESAI | M4: nomor rakitan lokal "001/…" berlabel "(otomatis)" saat memuat/gagal → "Menunggu nomor dari server"/"Belum tersedia", label "(perkiraan)", judul dialog kirim tanpa nomor s |
| 75 | Sedang | UX/alur | SELESAI | M4: Hapus item/baris tertiary tanpa konfirmasi, CLM sampai nol baris → `negative`, dialog "Hapus item N?" bila item berisi, nonaktif beralasan untuk item terakhir (simpan mem |
| 76 | Sedang | UX/alur | SELESAI | M4: dua form Ajukan pengembalian (label, inputMode, pengurai, pesan beda) → satu komponen `AjukanRefund` untuk SPV/SM/Keuangan (prop `pembuka`), satu pengurai `parseCurrency` |
| 77 | Sedang | UX/alur | SELESAI | M5: dialog Terima usulan Tinggi menyebut 3 outlet + teks mati "lihat daftar" → daftar SEMUA outlet (kode, nama, area; gulir bila panjang) |
| 78 | Sedang | Copy | SEBAGIAN | M1: "Eksekusi brutal berhasil!", "Self-Healing Berhasil!", "dicekal… Penguraian Individu", "Auto-Correct", "SaaS & Internal IT Execution Dashboard", "AOL API Wrapper", "Uploa |
| 79 | Sedang | Copy | SEBAGIAN | M0: UiKit KINO/GODREJ/INV nyata/outlet/orang/`type=date` → PRINCIPLE A/B, OUTLET A–E, SALES A–C, INV/XXXX/000n, 0n/KODE-A/10/2026, Gudang CABANG A/B, isian tanggal dd/mm/yyyy · M2: Contoh VINDA/KINO NON FOOD/HENDRIK/M-FS → CABANG A/B, SM A, SALES A (+ placeholder PP Finance → PP/XXXX/0001) · M3: KINO/GODREJ/"PT. Unilever"/Camellia/`01/SUPER-KN`/C-AL0063/1201671/LOYALTY di contoh, placeholder, bantuan → PRINCIPLE A, PRODUK A, KODE-A, C-KODE-A, "Tujuh angka". Tidak |
| 80 | Sedang | Copy | SEBAGIAN | M0: tag "Perilaku hari ini · usulan BL-xx lewat tracker AM" → "Perilaku hari ini" (kode BL tetap di nama aksesibel, kotak hanya tampil untuk Admin). Isi catatan, satu per lay · M2: VariantNote di dialog Tandai lunas (BL-27/47), Simpan support (BL-33), Hapus rekaman (BL-33) → fakta hari ini di dialog; Time Gone di layar salesman → keterangan biasa; i · M3: catatan varian bersuara pengembang ("Usulan: …", "(AM-022)") dan kode BL di dalam dialog (tag "BL-15", "(usulan BL-14)", "(BL-08 belum)", "(BL-07)") → teks bahasa |
| 81 | Sedang | Copy | SEBAGIAN | M3: "Phase R5 Reporting / Export", "Payment Date From", "Exporting...", "voided", "Low confidence", "AI Regex", "node backend", "alur PEKA (EC/CN)", "D1+D2", "jalur webhook", |
| 82 | Sedang | Copy | SELESAI | M2: "AO TT", "Rata AO/sales", "IA/toko", "EC & ISQ", "Penyebut AO", "Time Gone" → ditulis lengkap ("Waktu berjalan (Time Gone)") |
| 83 | Sedang | Copy | SELESAI | M2: Paragraf 60–90 kata → ≤ 2 kalimat (+ `<details>` Penjelasan di Data periode, kalimat penjelas di bawah subtitle SPV/SM) |
| 84 | Sedang | Copy | SELESAI | M4: "Bottleneck terbesar", "Gagal submit refund.", "Refund berhasil disubmit.", "dari dropdown", "principle", "Mode lunak", "(layar lama)", "(matriks D-01)", "Claim" di pesan |
| 85 | Sedang | Copy | SELESAI | M0: semua tab "Smart ERP - Accurate Online", manifes Inggris → judul tab "{Menu} · Ruang Kerja SP" (generateMetadata layout dashboard), bawaan "Ruang Kerja CV. Surya Perkasa" |
| 86 | Sedang | Copy | SELESAI | M0: "AI Assistant"/"Rule-Based" 10 px, tautan ke Akses ditolak, ExternalLink, tanpa role log, bounce → "Asisten Bantuan" + "Menjawab dari daftar panduan, bukan AI", tautan di |
| 87 | Sedang | Copy | DITUNDA | M3: riwayat menulis "oleh {id akun}": `principal_log.aktor` adalah id, tidak ada nama di data klien; tidak menambah permintaan. TODO ditaruh di `aktorTeks` |
| 88 | Sedang | Copy | SELESAI | M0: "User & RBAC", "Kelola Akses Group", "AOL Form Engine", "Master Principle", "Kasir ↔ Incaso", short "Masuk", ikon kembar → "Pengguna dan Izin", "Kelola Akses Grup", "Form · Akhir: judul halaman = label menu; sisa label modul izin di lib/rbac.ts dan menu "Pembayaran / SPPD" (TODO). |
| 89 | Sedang | Copy | SELESAI | M5: slogan "AO 240", "Tugas SPV/SM bukan...", "Optimalkan cakupan..." dihapus; aturan kunjungan berlebih tetap satu kalimat |
| 90 | Sedang | Copy | SELESAI | M5: tab "Form AO Harian" → "Rute Hari Ini"; tab dan layar "Laporan Harian" (kunjungan ke SPV) → "Laporan Kunjungan"; "Buka laporan harian" → "Buka laporan ke SPV" |
| 91 | Sedang | Copy | SEBAGIAN | M5: "Over-visit", "Follow-up SM", "Unggah export", "Registered Outlet", "Quantity", "Qty", "Time at Outlet/Travel", "Menit di toko" → Indonesia. Tidak dikerjakan: "Exception" |
| 92 | Sedang | Copy | SELESAI | M4: strip info "Notifikasi untuk OM dibuat." + audit "Notifikasi OM dibuat" → strip warn "Notifikasi OM belum terkirim (tiruan)." + audit "Notifikasi OM dicatat (tidak dikiri |
| 93 | Sedang | Tipografi | SELESAI | M2: Nominal/persen tanpa `fi-tnum` (pop-in kolom sekunder tidak tabular) → `fi-tnum` |
| 94 | Sedang | Tipografi | SELESAI | M3: isian dan tombol ikon tanpa nama → lihat No 54 |
| 95 | Sedang | Warna/kontras | SELESAI | M1: CTA gradien indigo-ungu + glow → `Button variant="primary"` "Kirim ke Accurate…" (Biru SP) yang membuka ConfirmDialog |
| 96 | Sedang | Warna/kontras | SELESAI | M3: gradien, heksa, blur, blob, label kapital renggang, `animate-pulse`, tombol hijau → token Fiori, `Skeleton`, kartu QC bernada status |
| 97 | Sedang | Warna/kontras | SELESAI | M6: ambang 100/70 tanpa penjelasan → legenda di bawah tabel; ambang dan nada tidak diubah |
| 98 | Sedang | Warna/kontras | SEBAGIAN | M0: tombol utama lama dipaksa hijau, 3 div gradien di body → `.btn-primary/.ui-button-primary` Biru SP #004c97 (hover #003f7e), div gradien dihapus. Sisa (Geist vs Jakarta, i |
| 99 | Sedang | Warna/kontras | SEBAGIAN | M0: emerald/sky/indigo/purple/blue `/10` satu warna → token `--status-ok(-bg)`, `--status-info(-bg)`; sky = info nila, emerald = sukses; indigo/blue/purple (aksen lama) tetap |
| 100 | Sedang | Warna/kontras | SELESAI | M5: garis baris 0,4pt #d4d4d4 (1,5:1) → 0,5pt #8a8a8a; pemisah satuan putih → 0,75pt #555; kolom isian TTF 0,4pt → 0,75pt #555 |
| 101 | Sedang | Warna/kontras | SELESAI | M5: emoji status → `StatusBadge` (belum neutral, di toko info, sudah pos) |
| 102 | Sedang | Layout | SEBAGIAN | M0: (a) tile/kartu/pintasan terangkat saat hover → latar `surface-2`; (b) garis 3 px satu sisi list item aktif dihapus; (c) galat FormField/dialog berikon TriangleAlert. (d)  · M6: judul Beranda `fi-title-1` → `fi-display` |
| 103 | Sedang | Layout | SELESAI | M2: Nilai utama = setoran, selisih di meta → nilai = selisih/"Klop", judul "Incaso … · Kasir …", meta jumlah faktur |
| 104 | Sedang | Layout | SEBAGIAN | M0: `div.fi-kc` berpenunjuk + bayangan hover → penunjuk/hover hanya untuk a/button.fi-kc. Ganti KPI ke Tile/KeyValues di halaman OPC: milik area · M4: kartu `fi-kc` KPI 36 px di Ringkasan (admin 3, non-admin 5) → daftar label-nilai di grup bernama sama; angka inti = ubin per tahap. OM (7 kartu) dan SM (4 kartu) DITUNDA |
| 105 | Sedang | Layout | SELESAI | M4: Ringkasan admin campur baca/tindakan; "Pengajuan bermasalah" dipakai lonceng dan tabel untuk himpunan berbeda → lonceng + daftar SLA "Lewat SLA", tabel "Perlu ditinjau ad |
| 106 | Sedang | Layout | SELESAI | M6: kartu hampir dapat `borderLeft 3px warn` + Lightbulb → garis rambut + `StatusBadge warn` "Hampir dapat promo" |
| 107 | Sedang | Layout | SELESAI | M5: `minHeight: 44` / `height: 44` permanen → dihapus (tinggi mengikuti `--ctl-h`: 32 px mouse, 44 px layar sentuh) |
| 108 | Sedang | Mobile/responsif | SEBAGIAN | M2: Kaki Kasir dua alasan digabung → satu alasan, alasan setoran ke badan halaman. Kaki Rekaman sengaja memuat ringkasan lama → baru (No 64) sehingga bisa > 80 karakter; Pemb |
| 109 | Sedang | Mobile/responsif | SEBAGIAN | M2: 6 KPI 1 kolom di 360 px → 2 kolom (minmax 9rem, huruf judul 3 di < 640 px lewat variabel `--kpi-font`); kaki tidak lagi mengulang alasan OM/Admin. `hariIni` basi lewat te |
| 110 | Sedang | Mobile/responsif | SELESAI | M3: FilterBar: "Dari" di slot `search` (satu-satunya yang terlihat di ponsel) → kedua tanggal berpasangan (`fi-fpair`) di dalam lembar Saringan; Normalisasi menampilkan perio |
| 111 | Sedang | Mobile/responsif | SEBAGIAN | M0: kelas bantu `.fi-fcl-atas` (disembunyikan saat detail FCL terbuka di < 1024 px). Pemasangan di OpcApp/Bersama + lonceng: area OPC. Gulir otomatis ke detail DITUNDA · M4: di ponsel KPI/strip/Saringan tetap di atas detail; pencarian 18rem dan lonceng berlabel penuh di samping h1 → < 1024 px isi atas, pilihan tampilan, dan saringan disembuny |
| 112 | Sedang | Mobile/responsif | SEBAGIAN | M0: badge selalu nowrap → `StatusBadge wrap` (boleh turun baris, max-width 100%). Pemakaian di TautanSalesman: area admin · M6: badge panjang "Kode dipegang profil lama … — bisa dipindahkan" → badge "Bisa dipindahkan"/"Dipegang akun lain" (`wrap`), rincian di meta |
| 113 | Sedang | Mobile/responsif | SEBAGIAN | M0: subnav tanpa petunjuk potong → di < 600 px tepi kanan memudar (mask) + padding 32 px. Form Kontrol (FK) milik area · M5: bilah tab terpotong tanpa petunjuk → petunjuk gulir dari CSS M0 (tepi memudar) sudah aktif; verifikasi tangkapan 360 px di bagian 4 |
| 114 | Sedang | Mobile/responsif | SELESAI | M5: kartu KPI satu kolom di ponsel → 2 kolom, angka ukuran judul (Laporan Kunjungan 6 kartu, Laporan Harian 4 kartu, Rekapan Nota 4 kartu) |
| 115 | Sedang | Aksesibilitas | SELESAI | M1: Panel terkunci `opacity-40 pointer-events-none grayscale blur` (tetap bisa difokus) → `inert` + strip `warn` "Masuk Accurate dan buka database dulu." (tampil sesudah kart |
| 116 | Sedang | Aksesibilitas | SELESAI | M3: alasan Finance OFF di `title`, umur > 30 hari hanya warna → alasan sebagai `fi-sub`, `StatusBadge` "Lewat 30 hari" |
| 117 | Sedang | Aksesibilitas | SELESAI | M3: `<main>` bersarang, `<th>` aksi kosong, wadah gulir tak fokusable → `div`, kolom "Tindakan", `tabIndex=0` + caption; wadah gulir `position:relative` supaya teks sr-only d |
| 118 | Sedang | Aksesibilitas | SELESAI | M5: `role=tab` tanpa panah/id (SR) → tombol `aria-pressed` + region; `ul role=radiogroup` (TabNoo) → div radiogroup; dua langkah Flow `aria-current` (LH) → satu · M6: `role="tab"` tanpa kibor/roving → `nav.fi-subnav` + tautan `aria-current="page"` |
| 119 | Sedang | Aksesibilitas | SELESAI | M0: Tailwind remap, h2, tanpa alert, "users.view" mentah, "Kembali ke Dashboard" → FioriScope + pola ErrorState (ikon kunci, h1, role alert), kunci izin dipindah ke `title`,  |
| 120 | Sedang | Aksesibilitas | SELESAI | M0: `disabledReason` hanya title, tombol tak bisa difokus; ConfirmDialog alasan tersembunyi bawaan → tombol beralasan `aria-disabled` (tetap di urutan Tab, title = deskripsi  · M4: ±10 dialog OPC menyembunyikan alasan nonaktif → bawaan M0 `alasanTerlihat` kini menampilkannya di semua dialog OPC (Keuangan, KeuanganRefund, Klaim, Om, Sm); dialog baru  · Akhir: alasan nonaktif tidak lagi ganda di 58 dialog (f0e1cb4d). |
| 121 | Sedang | Aksesibilitas | SELESAI | M5: enam tombol "Foto" kembar → nama aksesibel "Foto bukti: {butir}"; galat kamera tanpa langkah → "Izin kamera ditolak atau kamera tidak ada. Izinkan kamera di pengaturan si |
| 122 | Rendah | UX/alur | SEBAGIAN | M2: `type="number"` rupiah (Support, Pengaturan) dan `type="month"` (Rangka) tidak diubah · M4: Nilai fix: petunjuk di placeholder, roda mouse mengubah nilai → petunjuk di `help`, roda mouse melepas fokus. `type="text"` + format ribuan DITUNDA |
| 123 | Rendah | UX/alur | SELESAI | M2: "Wajib dipilih." merah sejak render → tampil sesudah select disentuh (onBlur); alasan di kaki tetap |
| 124 | Rendah | UX/alur | SELESAI | M5: hash #luar-rute menetap di URL → dibuang dengan `history.replaceState` setelah fokus |
| 125 | Rendah | UX/alur | SELESAI | M5: breadcrumb `<a href>` (muat penuh) → `Link` |
| 126 | Rendah | Copy | SELESAI | M6: "lewat 2 jam" tertulis → dari `escalateAfterMinutes`; "tiap 5 menit" → `JEDA_TARIK_MENIT` (satu konstanta); PPN 11% tiga salinan → `PPN` dari lib/principal-validation; Ki |
| 127 | Rendah | Copy | SELESAI | M3: judul dialog bukan pertanyaan, "resolver" → "Tambah principal baru?", "Tambah varian ke X?", "Tambah alias ke X?", "pengenal nama principal"; lokasi di berkas area lain b · M6: "Selesaikan faktur tidak pasti" (bukan pertanyaan), Select principal satu opsi sah, Coverage tanpa izin = EmptyState, judul impor tanpa berkas, "Grup baru" → judul pertan |
| 128 | Rendah | Copy | SEBAGIAN | M0: "Density/Compact/Cozy", "Coba Lagi" → "Kerapatan: Otomatis/Padat/Lega", "Coba lagi". Beranda/auth: area lain. DESIGN.md/UI_DESIGN_SYSTEM.md masih "Density": permintaan ke · M6: "memuat…/semua beres" huruf kecil, "surel" vs "email", tiga centang identik di panel /login, "1 jam" tanpa sumber → "Memuat…/Semua beres", "email", tanpa ikon, catatan po |
| 129 | Rendah | Copy | SELESAI | M2: "Setoran…", "Pelunasan baru", "Restore backup…", "Unduh backup", "Auto-Fix nama principal…", "Filter status", "Prinsipal", opsi "LPB, CBD, NON_LPB" → "Catat setoran…", "M |
| 130 | Rendah | Copy | SELESAI | M4: Item/baris/Baris, tiga bentuk tombol Setujui, "Baca-saja." vs "Baca-saja:", "Menunggu tinjauan" vs "Menunggu Anda" → "Item" di semua form dan pesan galat, tombol "Setujui |
| 131 | Rendah | Tipografi | SELESAI | M0: kepala tabel lama 11 px kapital 800, judul 850, teks chat/kalender 10–11 px → 12 px/600 tanpa kapital, judul 700; chat/kalender ≥ 12 px; DataTable pakai `.fi-table th` |
| 132 | Rendah | Tipografi | SELESAI | M0: `body { font-family: Arial }` (+ gradien tersembunyi) → `var(--font-workspace)`, latar `var(--app-bg)` |
| 133 | Rendah | Warna/kontras | SELESAI | M2: Pemicu Hapus/Hapus realisasi/Tolak (+ Cabut) `tertiary` → `negative` |
| 134 | Rendah | Warna/kontras | SELESAI | M3: `text-slate-400` di `bg-blue-600` (input berkas) → input `.fi-input` bertoken (kotak dan `::file-selector-button` dari fiori.css) |
| 135 | Rendah | Layout | SEBAGIAN | M2: KPI `fontSize: 1.25rem` → `font: var(--fs-title-2)`. TabelRincian → ResponsiveTable butuh baris sisipan di komponen bersama (pembuat fondasi) |
| 136 | Rendah | Layout | SEBAGIAN | M4: "Batal" di dialog Tinggalkan, `primary` per baris lonceng, breadcrumb ganda, judul Object Page tak mono → "Tetap di sini", sekunder, breadcrumb Object Page/form dihapus,  |
| 137 | Rendah | Layout | SEBAGIAN | M0: KeyValues selalu rata kanan → prop `align="start"` + `ConfirmDialog factsAlign`. Footer ubin & jam sapaan Beranda: area lain · M6: footer ubin Kasir 70+ karakter + "kunci macet", jam sapaan tanpa keterangan → satu klausa ("perlu dibuka OM/Admin"), "proses terhenti", "· per hh.mm WITA" |
| 138 | Rendah | Layout | SELESAI | M5: pratinjau "Cetak semua" berjudul "Lembar picking" → "Cetak semua rekapan dan TTF"; wave tidak ditemukan = satu baris teks → EmptyState + "Kembali ke Rekapan Nota"; margin |
| 139 | Rendah | Mobile/responsif | SELESAI | M5: `fontSize: var(--fs-caption)` tidak sah → `font:`; Peta dan Rincian SR bertumpuk di bawah 1280 px; Hierarki 5 kolom mulai `lg` |
| 140 | Rendah | Aksesibilitas | SEBAGIAN | M0: (a) `ObjectPageHeader headingLevel`; (c) wadah gulir tabel dan Flow `tabIndex=0` (tanpa role region: 231 kueri `getByRole("region")` di spec, nama tabel sering sama denga · M6: (a) dua h1 di Akses Grup/User → Object Page `headingLevel={2}`; (b) "Jadikan {grup} grup utama" → "Jadikan utama: {grup}"; (d) tanda +/− `aria-hidden` saja → nama aksesib |
| 141 | Rendah | Aksesibilitas | SEBAGIAN | M2: `aria-label` di div tanpa role → `role="group"`; `<details role="region">` → tanpa role. Judul detail FCL Finance masih `h1` dari `ObjectPageHeader` (butuh `headingLevel` |
| 142 | Rendah | Aksesibilitas | SEBAGIAN | M4: Escape didengar di seluruh dokumen dan mengosongkan kueri → hanya saat isian pencarian fokus. Ctrl K OPC dipertahankan (bagian 3) |
| 143 | Rendah | Aksesibilitas | SELESAI | M4: `<p role="alert">` di dalam listbox; `<time>` membungkus badge; "Buka"/"Buka batch" berulang; `*` tanpa aria-required → pesan di luar listbox (listbox hanya opsi); `<span |
| 144 | Rendah | Motion | SELESAI | M0: `animate-in` dekoratif di PWA/Input/Select, bounce chat → dihapus; pemadam global reduced-motion dipertahankan; indikator chat punya teks status |
| 145 | Rendah | Komentar kode | SELESAI | M6: header antrean-faktur menceritakan halaman lama, header OrderBaru 19 baris naratif, JSDoc LangkahBatch 6-8 baris + "Sengaja TANPA dialog" yang kini salah → header format  |
| 146 | Rendah | Komentar kode | SELESAI | M3: header basi (tema office-calm/neon/ios, "warm luxury", "Phase R5", riwayat migrasi), `sr-only` "Master terpilih" → header format Tujuan/Caller/Dependensi/Main Functions/S |
| 147 | Rendah | Komentar kode | SELESAI | M2: Komentar basi (lebar select, panduan migrasi PphHeads/useExpandableRows, riwayat bug "dilaporkan user …") → disamakan dengan kode, satu baris "kenapa" |
| 148 | Rendah | Komentar kode | SELESAI | M0: header basi/hilang; ±1.040 baris CSS tema Neon/iOS/Office Calm mati; komentar riwayat 6 baris → header diperbarui/ditambah; aturan `html[data-theme="neon"/"ios"/"office-c |
| 149 | Rendah | Komentar kode | SELESAI | M0: AsyncSearchSelect nol pemakai (dicek ulang di app/components/lib) → berkas dihapus; package.json tidak diubah |
| 150 | Rendah | Komentar kode | SELESAI | M5: dua blok komentar "Garis di tr" bertentangan → satu; `Caller` TabAo/TabLaporan/TabNoOrder dibetulkan; semua tag "Peninjau B R-x"/"S-x" diganti alasan teknis |
| 151 | Rendah | Komentar kode | SELESAI | M4: 69 rujukan baris `old-opc.tsx`, blok KONTRAK untuk agen, 24 pemisah `// ──` → "kode lama (lihat git)", cara menulis modul peran dua kalimat, pemisah dihapus; kode tidak d |
