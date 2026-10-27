# UI Design System — Fiori (Biru SP)

Sumber yang disetujui owner: UI kit Tahap 2 (aksen Biru SP, 6 Okt 2026) dan paket implementasi Tahap 4
(`scratch/fiori-redesign/tahap4/`, di luar repo). Dokumen ini **menggantikan** konvensi tema lama (Surya, Office Calm,
Neon, iOS) untuk setiap halaman yang sudah dimigrasi. Aturan kerja per layar tetap di `AGENTS.md` › UI/UX Rule.

Contoh hidup: `/dev/ui-kit` (hanya `npm run dev`; 404 di build produksi). Baseline visual: `tests/fiori-ui-kit.spec.ts`.

## Status migrasi

| Slice | Isi | Status |
|---|---|---|
| S0 | Token, font, mode/density, komponen inti, halaman kit, dokumen ini | di `feat/fiori` (PR #116) |
| S1a | Shell: shell bar (logo resmi, cari menu Ctrl K, menu profil berisi Mode/Kerapatan, Bantuan, Keluar), navigasi samping dari izin, drawer + navigasi bawah ponsel per peran; tema lama pensiun | PR #118 |
| S1b | Beranda per peran: Perlu tindakan (tile dari endpoint yang ada, galat per sumber), Pintasan, Pantauan, Semua aplikasi | cabang `feat/fiori-s1-beranda` |
| S2 | Rekapan Nota: Wave harian (kartu ringkas pool/exception/outlet tanpa area, dialog Unggah + Wave baru), Object Page wave (alur status, exception baca-saja, grup cetak, Isi wave dengan Lepas beralasan, pool dengan cari/saring, Riwayat, footer Rilis/Konfirmasi/Batalkan), Nota kanvas (per salesman, dialog Tandai semua + Nihil), Mapping area (saring keyakinan, draf area final, dialog Terima usulan Tinggi). Komponen baru `Section`, `VariantNote`; `ConfirmDialog` menerima isian tambahan; `ResponsiveTable.selectableRow` | cabang `feat/fiori-s2-rekapan` |
| S3 | Laporan Harian (wizard Unggah → Tinjau → Penerima → Kirim di footer; Riwayat kirim dari `GET /api/laporan-harian/runs` baru, Kirim ulang run gagal, run macet berlabel BL-29), Penerima laporan (`/laporan-harian/mapping`: List Report, Nonaktifkan lewat dialog, draf + Simpan di footer; item menu baru), Rekonsiliasi (wizard Jenis → Mapping → Berkas → Hasil; helper murni dipindah ke `lib/off-program-control/reconciliation-ui.ts`; galat mapping/riwayat eksplisit), History penjualan (saringan + cari produk, galat di halaman, Impor lewat dialog). Kasir dan Incaso (BL-59) tidak dibangun di slice ini | cabang `feat/fiori-s3-laporan` |
| S4a | Promo: Summary (Object Page siklus Dibaca → Ditinjau → Terbit → Disetujui → Dimuat, Terbitkan dengan centang pembanding PDF, Cabut publikasi, koreksi baca dan hapus baris lewat dialog; persetujuan + Muat ke gerbang faktur dipindah dari Aturan Promo ke `summary/LangkahGerbang.tsx`), Aturan Promo (FCL daftar + detail, status Aktif/Nonaktif/Berakhir/Belum mulai, dialog Hapus/Salin/Impor; impor dipindah dari Rekap, principal wajib + pratinjau), Daftar outlet (3 confirm → dialog), Rekap Promo (Overview; kartu Tak bertuan → Normalisasi), Normalisasi Diskon (worklist tiga kelompok, dialog Golongkan/Batalkan). Kosakata beban satu: Klaim principal / Beban distributor (`lib/promo-ui.ts`). `ResponsiveTable.rowLabel` | cabang `feat/fiori-s4-alur` |
| S4b | Claim Workflow: daftar (List Report, tile = saringan, kolom No Claim, umur sejak dikirim, tautan baris ke workflowId) dan detail (Object Page dengan anchor bar: Item, No Claim & dokumen, Pembayaran, Penutupan, Riwayat, Alur dokumen; aksi tahap di footer; semua transisi lewat dialog; konflik versi item dengan muat ulang baris; pemilih berkas untuk pembayaran/penutupan bila multi-berkas). BL-07/08/14/15/33/35/42 = VariantNote | cabang `feat/fiori-s4b-claim` |
| S4c | Insentif Sales: halaman 4.386 baris dipecah jadi enam rute — Dashboard (Overview: Taksiran sales+SPV+SM, capaian per SPV dengan warna+ikon+teks laju, alasan Rp 0, galat ≠ kosong per tabel), Insentif saya (salesman, ponsel), Pembayaran (Worklist: ubin 12 bulan, pilih semua di saringan, dialog Tandai lunas, terkunci bila sumber gagal dimuat), Data periode (wizard Jenis → Unggah → Pratinjau → Terapkan, kode mirip, SPV tidak sinkron), Support principal (draf + simpan sekaligus), Pengaturan (Object Page: konstanta terkunci bila gagal dibaca, hierarki, akun belum ditautkan). Navigasi antarhalaman `.fi-subnav` dari izin + identitas hierarki (server); saringan periode di URL. BL-26/27/33/47/48, AM-045 = VariantNote | cabang `feat/fiori-s4c-insentif` |
| S4d | OFF Program Control: halaman 10.992 baris diganti FCL — antrean per peran (kolom 1) + Object Page batch (kolom 2) untuk SPV, SM, Klaim, OM, Keuangan, Ringkasan admin, Log audit; alur 7 tahap Draf → SM → Klaim → OM → Bayar → Final → Selesai (`lib/opc-ui.ts`); semua aksi tulis lewat dialog (alasan wajib untuk Kembalikan/Batalkan/Tolak refund); aksi terkunci bila daftar/detail usang atau gagal dimuat ulang; jawaban server tidak pasti (putus/≥502/bukan JSON) disebut tidak pasti; `?tab=`/`claimView`/`batch`/`mock` lama tetap. `ObjectPageHeader.title` kini ReactNode, `ConfirmDialog.cancelLabel`. BL-06..13, 33–35, D-01 = VariantNote | cabang `feat/fiori-s4d-opc` |
| S5 | Lapangan (ponsel dulu, target 44 px): Rute hari ini (kunjungan berjalan paling atas, "N hari order bulan ini", Kirim status rute lewat dialog), wizard Kunjungan (Kembali di tiap langkah, checkbox asli, galat di langkahnya, tanpa sinyal foto tetap), Order Sales (pemilih toko rute, harga + 409 per baris, nomor permintaan) + Order saya, Dashboard SPV (admin memilih SPV, Tandai sudah dibaca), JKS (dialog Terapkan + templat), Kontrol SM (isian tersimpan dimuat), Briefing, Frekuensi, Hierarki. Tanggal hari ini WITA. Tab Merchandising tersembunyi dihapus. BL-18/28/32/43, it05 #4/#15 = VariantNote | cabang `feat/fiori-s5-lapangan` |
| S6–S7 | Layar sisanya per paket Tahap 4 (order, faktur, antrean, Kasir dan Incaso, pelunasan, pembayaran, Finance, admin, Data Principal, master) | selesai: semua rute `app/(dashboard)` di dalam `FioriScope` |
| Audit desain 001 | Perbaikan lintas layar dari `docs/audit/audit-desain-001-2026-10-25.md`: satu format tanggal dan nilai kosong (`lib/tampil.ts`), nama halaman = label menu, tanpa em dash di teks UI, alasan tombol nonaktif terlihat, Toaster bertoken, `DataTable` keadaan galat, data contoh generik | cabang `feat/desain-audit-gabungan` (26 Okt 2026) |

Semua halaman `app/(dashboard)` sudah Fiori. Remap tema Surya (`html[data-theme="surya"]` statis di root layout; kelas Tailwind lama
di `app/globals.css` dan `app/workspace.css`) tinggal untuk sisa markup lama; yang diketahui: `app/(dashboard)/error.tsx`. Jangan
mencampur: halaman Fiori tidak memakai kelas warna Tailwind lama (`text-slate-*`, `bg-white/10`, `bg-[#…]`) yang diremap tema lama.

## Cara memigrasikan satu halaman

1. Bungkus isi halaman dengan `<FioriScope>` (`components/fiori/Scope.tsx`). Token dan font hanya berlaku di dalamnya.
2. Bangun layar dari komponen di `components/fiori/core.tsx` dan `components/fiori/interactive.tsx`. Tata letak (grid, gap,
   padding) boleh memakai utilitas Tailwind; warna hanya lewat token (`var(--ink-muted)`) atau utilitas token
   (`text-ink-muted`, `bg-surface`, `border-line` — didefinisikan di `@theme inline` globals.css, hanya bermakna di dalam `.fiori`).
3. Hapus remap tema lama yang hanya dipakai halaman itu (bertahap, tidak big-bang).
4. Selesai = enam keadaan berfungsi, `npm run lint`, `npx tsc --noEmit`, `npm test`, `npm run build` hijau,
   tangkapan Playwright sebelum/sesudah, PR dibaca manusia.

## Token (`app/fiori.css`)

Nilai apa adanya dari UI kit Tahap 2. Di-scope ke `.fiori`, bukan `:root`, karena tema lama sudah memakai `--surface`/`--surface-2`
di `:root`. Setelah halaman terakhir dimigrasi, kelas `.fiori` dipindah ke `<body>`.

| Kelompok | Token |
|---|---|
| Brand | `--brand-50..900` (600 = `#004C97` logo), `--brand`, `--brand-tint`, `--brand-tint-strong` |
| Aksi | `--primary`, `--primary-hover`, `--primary-active`, `--on-primary`, `--link`, `--focus` |
| Permukaan & tinta | `--bg`, `--surface`, `--surface-2`, `--surface-3`, `--ink`, `--ink-muted`, `--ink-subtle`, `--ink-disabled`, `--line`, `--line-strong`, `--field-bg`, `--field-border`, `--scrim` |
| Semantik (terpisah dari brand) | `--pos/-bg/-solid`, `--neg/-bg/-solid`, `--warn/-bg/-solid`, `--info/-bg/-solid`, `--neu/-bg/-solid` |
| Tipografi | `--font-sans` (Plus Jakarta Sans), `--font-mono` (Geist Mono), `--fs-display`, `--fs-kpi`, `--fs-title-1..3`, `--fs-body`, `--fs-small`, `--fs-caption`; kelas `fi-display`, `fi-title-1..3`, `fi-small`, `fi-caption` |
| Ruang & bentuk | `--sp-half`, `--sp-1..16` (grid 4 px), `--r-xs..xl`, `--r-pill`, `--shadow-1..3`, `--shadow-bar` |
| Gerak | `--dur-fast/base/slow` (150/200/250 ms; 0 saat `prefers-reduced-motion`), `--ease-standard/enter/exit` |
| Kerapatan (density) | `--ctl-h`, `--ctl-px`, `--ctl-fs`, `--row-h`, `--cell-py/px`, `--li-py`, `--stack`, `--icon`, `--badge-h`, `--shell-h` |
| Lapisan | `--z-sticky`, `--z-header`, `--z-popover`, `--z-overlay`, `--z-dialog`, `--z-toast` |

Breakpoint: S < 600 · M 600–1023 · L 1024–1439 · XL ≥ 1440. Tabel memakai container query (lebar wadahnya, bukan layar).

## Mode dan kerapatan

- `SchemeSwitcher` (`interactive.tsx`): **Mode** Sistem / Terang / Gelap → `html[data-scheme="light|dark"]` (Sistem = tanpa
  atribut, mengikuti `prefers-color-scheme`). **Kerapatan** Otomatis / Padat / Lega → `html[data-density="compact|cozy"]`
  (Otomatis = tanpa atribut: padat untuk mouse, lega 44 px untuk `pointer: coarse`). Label tampil Indonesia; nilai atribut tetap
  `compact`/`cozy`.
- Disimpan di localStorage `fiori-scheme` / `fiori-density`; diterapkan sebelum paint oleh skrip di `app/layout.tsx`
  (`components/fiori/scheme.ts`).
- Atributnya `data-scheme`, bukan `data-theme`, supaya tidak bentrok dengan pilihan tema lama selama migrasi.
- Tema Neon, Office Calm, dan iOS pensiun (keputusan owner 6 Okt 2026): pengalih tema lama dihapus di S1, `data-theme`
  selalu `surya`. CSS ketiga tema itu sudah dihapus dari `app/globals.css` (audit desain 001 No 148).
- Pengalih Mode/Kerapatan ada di menu profil shell (`SchemeSwitcher`). Mode mengubah semua isi di dalam `.fiori`; sisa markup
  lama (lihat Status migrasi) tetap terang.
- Logo resmi CV. Surya Perkasa tetap (`public/brand/surya-perkasa-logo-horizontal.png`). Warna PWA: `#004c97`.

## Komponen

| Komponen | Berkas | Aturan |
|---|---|---|
| `Button` | core | `primary` (satu per kelompok aksi), `secondary`, `tertiary`, `negative`, `icon` (wajib `aria-label`); label kata kerja; `busy` = ikon berputar + `disabled` asli (penjaga kirim ganda); nonaktif dengan `disabledReason` = `aria-disabled` (tetap bisa difokus Tab), alasan di `title`, klik/Enter/ketuk menampilkan gelembung alasan dan tidak memanggil `onClick` (juga menahan submit form); alasan yang sudah tertulis di dekat tombol diikat `aria-describedby` dan tidak diulang di gelembung. Aksi utama: tulis alasannya juga di `FooterToolbar` |
| `StatusBadge` | core | selalu ikon + label + tone `pos/neg/warn/info/neu`; tidak pernah warna saja; `busy` untuk proses berjalan; `wrap` = label panjang boleh turun baris di kolom sempit |
| `MessageStrip` | core | `neg` = `role="alert"`, lainnya `role="status"`; info yang harus terbaca di halaman |
| Toast | `sonner` (`toast.success`) | hanya sukses singkat yang tidak perlu ditindaklanjuti; galat validasi tidak pernah lewat toast. `Toaster` dipasang di `app/(dashboard)/layout.tsx` di dalam `.fiori`, bergaya token (permukaan, tinta, nada `pos`/`neg`) dan ikut mode gelap |
| `ConfirmDialog` | interactive | semua aksi tulis: judul berupa pertanyaan, `tag`, `facts` (jumlah, nilai, tujuan), `reason` bila alasan wajib (maker-checker lunak), tombol berlabel aksi; penjaga klik ganda; Escape/Tutup diabaikan selama aksi berjalan; galat tampil di dialog dan isian tidak dikosongkan; alasan tombol konfirmasi nonaktif tampil sebagai teks di kaki dialog secara bawaan (`alasanTerlihat={false}` hanya bila kalimat yang sama sudah terlihat di isian); `factsAlign="start"` untuk fakta rata kiri; dialog native `<dialog>` (`components/ui/Dialog`) |
| `FormField` | interactive | label terikat, tanda wajib, `help`, `error` (berikon) lewat `aria-describedby`; isi = render prop yang menerima atribut a11y untuk `<input|select|textarea className="fi-input">` |
| `FilterBar` | interactive | saringan di desktop; di ponsel `search` tetap terlihat dan sisanya pindah ke bottom sheet (tombol menyebut jumlah saringan aktif); chip saringan aktif dengan hapus per chip dan "Hapus semua". Saringan tersimpan (BL-36) belum |
| `ResponsiveTable` | core | tabel di wadah ≥ 600 px (wadah gulir bisa difokus, `role="group"` bernama caption), `rincian` = baris sisipan lewat tombol "Rincian <nama>", `foot` = baris total, kolom `secondary` pindah ke bawah kolom pertama di < 760 px, `mobileItem` (biasanya `ListItem`) di < 600 px; pilih massal (hanya di tampilan tabel; daftar ponsel belum bisa memilih), urut (`aria-sort`); keadaan memuat/kosong/galat bawaan (lihat di bawah); gulir menyamping hanya di wadah tabel. Model TanStack (`DataTable`) bisa dipakai pemanggil untuk menyusun `rows` |
| `DataTable` | `components/DataTable.tsx` | model TanStack (urut, cari, kolom, paginasi) bergaya `.fi-table`; `error` + `onRetry` = `ErrorState` dengan Coba lagi; kosong dibedakan "Belum ada data" dan "Tidak ada baris yang cocok" |
| Input berkas | pola, bukan komponen | `<label className="fi-btn fi-btn--secondary">` berisi ikon, label kata kerja, dan `<input type="file" className="sr-only">`; cincin fokus lewat `.fi-btn:has(input:focus-visible)`. Di dalam dialog boleh `FormField` + `<input type="file" className="fi-input">` |
| `ListItem` | core | baris daftar ponsel dan item worklist FCL: nomor dokumen (mono), nilai, judul, meta, badge; `current` = `aria-current`; `href` + `onClick` = tautan nyata (tab baru bisa), klik biasa ke callback |
| `ObjectPageHeader` + `Flow` + `AnchorBar` | core | jejak halaman, judul (`h1`; `headingLevel={2}` bila halaman sudah punya h1, mis. kolom kedua FCL), badge status, indikator "Draf belum disimpan", atribut kunci (`dl`), langkah status (`aria-current="step"`); anchor bar lengket. Header tidak menciut saat digulir (belum dibutuhkan) |
| `FooterToolbar` | core | aksi final kanan bawah, lengket; `message` = alasan tombol nonaktif / status draf |
| `FlexibleColumnLayout` | core | 2 kolom ≥ 1024 px; di bawahnya satu kolom daftar ↔ detail dengan tombol "Kembali ke daftar" |
| `Tile` | core | Beranda per peran; angka besar (`value`) hanya bila angkanya inti tugas |
| `KeyValues` | core | daftar label–nilai (`dl`), nilai rata kanan tabular; `align="start"` untuk rata kiri |
| `EmptyState`, `ErrorState`, `Skeleton` | core | tiga keadaan yang selalu berbeda |
| `useUnsavedGuard` | interactive | peringatan peramban saat meninggalkan halaman dengan draf |

Shell (`components/SidebarLayout.tsx`, S1a): shell bar dengan logo resmi (lockup; tanda SP di ponsel; versi putih di mode gelap
lewat token `--logo-full`/`--logo-mark`), cari menu (Ctrl K; OPC tetap memakai quick jump sendiri), menu profil (Mode, Kerapatan,
Bantuan = Asisten Bantuan yang menjawab dari daftar panduan, bukan AI; Keluar: gagal = pesan di menu, tidak pindah halaman), navigasi samping berkelompok dari izin, drawer ponsel, navigasi bawah = Beranda + 3 pintasan
profil peran (`ROLE_PROFILES` di `config/workspace-navigation.ts`; `profileFor` = ★ grup utama, fallback tebakan izin, S7-3) + Menu.
Belum: pencarian nomor dokumen lintas modul (BL-38) dan lonceng Kotak Tugas (BL-34) — menunggu logic di tracker AM.
Favorit menu dan sidebar ciut (rail) dari shell lama tidak ada di desain yang disetujui dan dihapus.
Nama halaman satu sumber: label menu di `config/workspace-navigation.ts` dipakai apa adanya untuk judul tab peramban
(`generateMetadata` di `app/(dashboard)/layout.tsx`, "{Menu} · Ruang Kerja SP"), `h1`, jejak, dan teks yang merujuk halaman itu.

Beranda (`app/(dashboard)/Beranda.tsx` + `lib/beranda.ts`, S1b): tile per profil peran dari endpoint GET yang sudah ada,
satu permintaan per sumber, galat per sumber (tile itu sendiri + strip, sisanya tetap tampil), nol = "semua beres".
Tile yang butuh logic baru di tracker AM tidak tampil: posting/antrean tidak pasti (AM-014/015/047), webhook dan Kotak Tugas
(BL-34), capaian/insentif (cakupan BL-26), rute dan kunjungan salesman (BL-28), Transfer menunggu (FastAPI hanya per tanggal),
outlet tanpa area, sync Accurate. "Lanjutkan pekerjaan" (draf) belum: belum ada pencatatan draf. Pratinjau peran lain di
development: `/?peran=fakturist|gudang|sm|claim|finance|admin|salesman`.

Belum dibangun (dibangun di slice yang memakainya): `ValueHelp` (form pertama yang merujuk data master), menciutnya header
Object Page.

## Enam keadaan per layar

| Keadaan | Pola |
|---|---|
| Default | data tampil; satu aksi utama |
| Memuat | muat awal: `Skeleton` di tempat isi. Muat ulang: data lama tetap tampil (`aria-busy`, redup), tidak mengosongkan layar |
| Kosong | `EmptyState` dengan kalimat berbeda untuk "belum ada data" dan "tidak ada yang sesuai saringan" |
| Galat | muat awal gagal: `ErrorState` (`role="alert"`, sebab + Coba lagi). Muat ulang gagal: data lama tetap + strip "Yang tampil adalah hasil sebelumnya". Galat tidak pernah tampil sebagai kosong |
| Sukses | `MessageStrip tone="pos"` di halaman dan/atau toast singkat; status dokumen di badge ikut berubah |
| Draf | indikator di header, alasan di `FooterToolbar`, `useUnsavedGuard`; Simpan nonaktif dengan alasan bila tidak ada perubahan |

## Aturan lintas layar

1. Tidak ada warna heksa di halaman; hanya token. Semantik terpisah dari brand.
2. Tidak ada `window.confirm` / `window.prompt` / `alert` di rute yang dimigrasi — pakai `ConfirmDialog`.
3. Bahasa tugas Indonesia; kode status mentah, nama model, dan endpoint tidak tampil. Tanpa em dash di teks UI (titik, koma,
   titik dua, kurung); nilai kosong = `KOSONG` ("-") dari `lib/tampil.ts`; sebab galat HTTP = `sebabHttp`. Pengecualian: teks yang
   disimpan ke server atau ditulis ke berkas ekspor tidak diubah demi tampilan.
4. Tanggal dan jam WITA (`Asia/Makassar`) lewat `lib/tampil.ts`: `tanggalWita` → `dd/mm/yyyy`, `waktuWita` → `dd/mm/yyyy hh.mm`
   (pemanggil menambah " WITA" di kalimat). Jam tanpa tanggal hanya untuk kejadian hari ini; rentang check-in–check-out memakai
   `rentangWita` (Form Kontrol). Nilai awal isian tanggal = `hariIniWita()`; jangan `toISOString()` untuk tanggal lokal. Tidak ada
   formatter tanggal lokal per halaman.
5. Angka: `fi-tnum` (digit tabular); kolom nominal di tabel `align: "end"` (rata kanan, tanpa patah); nomor dokumen `fi-mono`.
6. Fokus terlihat (`--focus`), target sentuh 44 px di pointer kasar (kerapatan Otomatis), `prefers-reduced-motion` dihormati,
   isian ≥ 16 px di layar sentuh (Safari iOS tidak memperbesar).
7. Desktop dan ponsel 360–400 px tanpa gulir menyamping halaman.
8. Mutasi: `busy` hanya pada tombol yang relevan; penjaga klik ganda dengan `useRef`; saat gagal, pilihan pengguna tidak
   dikosongkan. Keputusan yang menulis data penting dikonfirmasi dengan jumlah, nilai, dan dasarnya.
9. Logic bisnis (BL) tidak ditulis di cabang UI; selama logic belum ada di main, layar menampilkan perilaku hari ini.
