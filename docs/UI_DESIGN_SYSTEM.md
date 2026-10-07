# UI Design System — Fiori (Biru SP)

Sumber yang disetujui owner: UI kit Tahap 2 (aksen Biru SP, 6 Okt 2026) dan paket implementasi Tahap 4
(`scratch/fiori-redesign/tahap4/`, di luar repo). Dokumen ini **menggantikan** konvensi tema lama (Surya, Office Calm,
Neon, iOS) untuk setiap halaman yang sudah dimigrasi. Aturan kerja per layar tetap di `AGENTS.md` › UI/UX Rule.

Contoh hidup: `/dev/ui-kit` (hanya `npm run dev`; 404 di build produksi). Baseline visual: `tests/fiori-ui-kit.spec.ts`.

## Status migrasi

| Slice | Isi | Status |
|---|---|---|
| S0 | Token, font, mode/density, komponen inti, halaman kit, dokumen ini | selesai di cabang `feat/fiori-s0-fondasi` |
| S1 | Shell bar, navigasi dari izin, Beranda per peran; `ShellBar`, `SideNav` + navigasi bawah ponsel; pengalih tema lama diganti `SchemeSwitcher` | belum |
| S2–S7 | Per layar (urutan di paket Tahap 4) | belum |

Halaman yang belum dimigrasi tetap memakai tema lama (`html[data-theme]`, remap kelas Tailwind di `app/globals.css` dan
`app/workspace.css`). Jangan mencampur: halaman lama tidak memakai kelas `fi-*`; halaman Fiori tidak memakai kelas warna
Tailwind lama (`text-slate-*`, `bg-white/10`, `bg-[#…]`) yang diremap tema lama.

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
| Density | `--ctl-h`, `--ctl-px`, `--ctl-fs`, `--row-h`, `--cell-py/px`, `--li-py`, `--stack`, `--icon`, `--badge-h`, `--shell-h` |
| Lapisan | `--z-sticky`, `--z-header`, `--z-popover`, `--z-overlay`, `--z-dialog`, `--z-toast` |

Breakpoint: S < 600 · M 600–1023 · L 1024–1439 · XL ≥ 1440. Tabel memakai container query (lebar wadahnya, bukan layar).

## Mode dan density

- `SchemeSwitcher` (`interactive.tsx`): **Mode** Sistem / Terang / Gelap → `html[data-scheme="light|dark"]` (Sistem = tanpa
  atribut, mengikuti `prefers-color-scheme`). **Density** Otomatis / Compact / Cozy → `html[data-density="compact|cozy"]`
  (Otomatis = tanpa atribut: compact untuk mouse, cozy 44 px untuk `pointer: coarse`).
- Disimpan di localStorage `fiori-scheme` / `fiori-density`; diterapkan sebelum paint oleh skrip di `app/layout.tsx`
  (`components/fiori/scheme.ts`).
- Atributnya `data-scheme`, bukan `data-theme`, supaya tidak bentrok dengan pilihan tema lama selama migrasi.
- Tema Neon, Office Calm, dan iOS pensiun (keputusan owner 6 Okt 2026); pilihannya dicabut saat shell dimigrasi (S1).
  Sampai itu, halaman Fiori diuji dengan tema lama bawaan (Surya); di Neon/iOS beberapa aturan elemen lama (judul miring,
  warna input) masih bisa bocor ke `.fiori`.
- Logo resmi CV. Surya Perkasa tetap (`public/brand/surya-perkasa-logo-horizontal.png`). Warna PWA: `#004c97`.

## Komponen

| Komponen | Berkas | Aturan |
|---|---|---|
| `Button` | core | `primary` (satu per kelompok aksi), `secondary`, `tertiary`, `negative`, `icon` (wajib `aria-label`); label kata kerja; `busy` = ikon berputar + nonaktif; `disabledReason` = alasan nonaktif (juga tulis di `FooterToolbar`) |
| `StatusBadge` | core | selalu ikon + label + tone `pos/neg/warn/info/neu`; tidak pernah warna saja; `busy` untuk proses berjalan |
| `MessageStrip` | core | `neg` = `role="alert"`, lainnya `role="status"`; info yang harus terbaca di halaman |
| Toast | `sonner` (`toast.success`) | hanya sukses singkat yang tidak perlu ditindaklanjuti; galat validasi tidak pernah lewat toast. Toaster global masih bergaya lama sampai S1 |
| `ConfirmDialog` | interactive | semua aksi tulis: judul berupa pertanyaan, `tag`, `facts` (jumlah, nilai, tujuan), `reason` bila alasan wajib (maker-checker lunak), tombol berlabel aksi; penjaga klik ganda; Escape/Tutup diabaikan selama aksi berjalan; galat tampil di dialog dan isian tidak dikosongkan; dialog native `<dialog>` (`components/ui/Dialog`) |
| `FormField` | interactive | label terikat, tanda wajib, `help`, `error` lewat `aria-describedby`; isi = render prop yang menerima atribut a11y untuk `<input|select|textarea className="fi-input">` |
| `FilterBar` | interactive | saringan di desktop; di ponsel `search` tetap terlihat dan sisanya pindah ke bottom sheet (tombol menyebut jumlah saringan aktif); chip saringan aktif dengan hapus per chip dan "Hapus semua". Saringan tersimpan (BL-36) belum |
| `ResponsiveTable` | core | tabel di wadah ≥ 600 px, kolom `secondary` pindah ke bawah kolom pertama di < 760 px, `mobileItem` (biasanya `ListItem`) di < 600 px; pilih massal (hanya di tampilan tabel; daftar ponsel belum bisa memilih), urut (`aria-sort`); keadaan memuat/kosong/galat bawaan (lihat di bawah); gulir menyamping hanya di wadah tabel. Model TanStack (`DataTable`) bisa dipakai pemanggil untuk menyusun `rows` |
| `ListItem` | core | baris daftar ponsel dan item worklist FCL: nomor dokumen (mono), nilai, judul, meta, badge; `current` = `aria-current` |
| `ObjectPageHeader` + `Flow` + `AnchorBar` | core | jejak halaman, judul (`h1`), badge status, indikator "Draf belum disimpan", atribut kunci (`dl`), langkah status (`aria-current="step"`); anchor bar lengket. Header tidak menciut saat digulir (belum dibutuhkan) |
| `FooterToolbar` | core | aksi final kanan bawah, lengket; `message` = alasan tombol nonaktif / status draf |
| `FlexibleColumnLayout` | core | 2 kolom ≥ 1024 px; di bawahnya satu kolom daftar ↔ detail dengan tombol "Kembali ke daftar" |
| `Tile` | core | Beranda per peran; angka besar (`value`) hanya bila angkanya inti tugas |
| `KeyValues` | core | daftar label–nilai (`dl`), nilai rata kanan tabular |
| `EmptyState`, `ErrorState`, `Skeleton` | core | tiga keadaan yang selalu berbeda |
| `useUnsavedGuard` | interactive | peringatan peramban saat meninggalkan halaman dengan draf |

Belum dibangun (dibangun di slice yang memakainya): `ShellBar`, `SideNav` + navigasi bawah ponsel (S1), `ValueHelp`
(form pertama yang merujuk data master), menciutnya header Object Page.

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
3. Bahasa tugas Indonesia; kode status mentah, nama model, dan endpoint tidak tampil.
4. Tanggal dan jam WITA (`Asia/Makassar`), tampil `dd/mm/yyyy`; jangan `toISOString()` untuk tanggal lokal.
5. Angka: `fi-tnum` (digit tabular); kolom nominal di tabel `align: "end"` (rata kanan, tanpa patah); nomor dokumen `fi-mono`.
6. Fokus terlihat (`--focus`), target sentuh 44 px di pointer kasar (density Otomatis), `prefers-reduced-motion` dihormati,
   isian ≥ 16 px di layar sentuh (Safari iOS tidak memperbesar).
7. Desktop dan ponsel 360–400 px tanpa gulir menyamping halaman.
8. Mutasi: `busy` hanya pada tombol yang relevan; penjaga klik ganda dengan `useRef`; saat gagal, pilihan pengguna tidak
   dikosongkan. Keputusan yang menulis data penting dikonfirmasi dengan jumlah, nilai, dan dasarnya.
9. Logic bisnis (BL) tidak ditulis di cabang UI; selama logic belum ada di main, layar menampilkan perilaku hari ini.
