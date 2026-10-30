---
name: AccAPI — Fiori Biru SP
description: Ruang kerja operasional distributor CV. Surya Perkasa di atas Accurate Online; padat, tenang, jujur soal status.
colors:
  primary: "#004c97"
  primary-hover: "#003f7e"
  primary-active: "#033265"
  on-primary: "#ffffff"
  brand-tint: "#e8f0fa"
  brand-tint-strong: "#d4e3f6"
  canvas: "#f4f6f9"
  surface: "#ffffff"
  surface-2: "#eef2f7"
  surface-3: "#e4e9f0"
  line: "#dde3ea"
  line-strong: "#c4cdd8"
  field-border: "#7d8a9b"
  ink: "#18212d"
  ink-muted: "#4a586a"
  ink-subtle: "#5f6d7e"
  ink-disabled: "#9aa5b3"
  pos: "#1b6b3a"
  pos-bg: "#e6f4ec"
  warn: "#8a4a00"
  warn-bg: "#fff2d9"
  neg: "#b3261e"
  neg-bg: "#fdeceb"
  info: "#4b3db8"
  info-bg: "#efedfc"
  neu: "#4a586a"
  neu-bg: "#edf0f4"
typography:
  display:
    fontFamily: "Plus Jakarta Sans, Segoe UI, system-ui, sans-serif"
    fontSize: "2rem"
    fontWeight: 600
    lineHeight: "2.5rem"
    letterSpacing: "-0.02em"
  kpi:
    fontFamily: "Plus Jakarta Sans, Segoe UI, system-ui, sans-serif"
    fontSize: "2.25rem"
    fontWeight: 700
    lineHeight: "2.5rem"
    fontFeature: "tnum"
  headline:
    fontFamily: "Plus Jakarta Sans, Segoe UI, system-ui, sans-serif"
    fontSize: "1.5rem"
    fontWeight: 700
    lineHeight: "2rem"
    letterSpacing: "-0.015em"
  title:
    fontFamily: "Plus Jakarta Sans, Segoe UI, system-ui, sans-serif"
    fontSize: "1.25rem"
    fontWeight: 650
    lineHeight: "1.75rem"
  title-small:
    fontFamily: "Plus Jakarta Sans, Segoe UI, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 650
    lineHeight: "1.5rem"
  body:
    fontFamily: "Plus Jakarta Sans, Segoe UI, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: "1.25rem"
  body-touch:
    fontFamily: "Plus Jakarta Sans, Segoe UI, system-ui, sans-serif"
    fontSize: "0.9375rem"
    fontWeight: 400
    lineHeight: "1.375rem"
  small:
    fontFamily: "Plus Jakarta Sans, Segoe UI, system-ui, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 400
    lineHeight: "1.125rem"
  label:
    fontFamily: "Plus Jakarta Sans, Segoe UI, system-ui, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 600
    lineHeight: "1rem"
  mono:
    fontFamily: "Geist Mono, ui-monospace, Cascadia Mono, Consolas, monospace"
    fontSize: "0.92em"
rounded:
  xs: "4px"
  sm: "6px"
  md: "8px"
  lg: "12px"
  xl: "16px"
  pill: "999px"
spacing:
  half: "2px"
  "1": "4px"
  "2": "8px"
  "3": "12px"
  "4": "16px"
  "5": "20px"
  "6": "24px"
  "8": "32px"
  "10": "40px"
  "12": "48px"
  "16": "64px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    rounded: "{rounded.md}"
    height: "32px"
    padding: "0 12px"
  button-primary-hover:
    backgroundColor: "{colors.primary-hover}"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.primary}"
    rounded: "{rounded.md}"
    height: "32px"
    padding: "0 12px"
  button-secondary-hover:
    backgroundColor: "{colors.brand-tint}"
  button-negative:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.neg}"
    rounded: "{rounded.md}"
    height: "32px"
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    height: "32px"
    padding: "0 10px"
  badge-pos:
    backgroundColor: "{colors.pos-bg}"
    textColor: "{colors.pos}"
    rounded: "{rounded.pill}"
    height: "22px"
  badge-neg:
    backgroundColor: "{colors.neg-bg}"
    textColor: "{colors.neg}"
    rounded: "{rounded.pill}"
    height: "22px"
  panel:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.lg}"
    padding: "16px"
---

<!--
Tujuan: Arah visual tunggal (DESIGN.md, format google-labs-code/design.md) untuk agen dan skill desain.
Caller: Impeccable (detect/critique/audit), Taste, antislop, dan siapa pun yang membuat layar baru.
Dependensi: nilai token dari app/fiori.css; aturan komponen dan enam keadaan di docs/UI_DESIGN_SYSTEM.md.
Main Functions: token (frontmatter), arah, aturan bernama, larangan.
Side Effects: Tidak ada. Bila app/fiori.css berubah, frontmatter ini ikut diperbarui.
-->

# Design System: AccAPI — Fiori Biru SP

## Overview

**Creative North Star: "Buku Besar yang Tenang"**

AccAPI adalah meja kerja, bukan etalase. Setiap layar dipakai berjam-jam oleh fakturist, kasir, admin klaim, finance,
dan supervisor untuk memindahkan dokumen yang berakibat akuntansi nyata di Accurate. Karena itu sistemnya tenang dan
padat: satu aksen biru logo, permukaan putih di kanvas abu-abu dingin, tipografi Plus Jakarta Sans yang rapat, dan angka
tabular. Ekspresi merek ada di presisi, bukan dekorasi. Acuannya pola SAP Fiori (List Report, Object Page, Worklist,
Flexible Column Layout) yang disetujui owner pada 6 Okt 2026.

Yang paling keras dalam sistem ini adalah kejujuran status: memuat, kosong, dan galat tidak pernah tampil sama; status
selalu ikon + label + warna; aksi tulis selalu lewat dialog yang menyebut jumlah, nilai, dan tujuannya. Penolakan visual
yang sudah dikonfirmasi owner: tema Neon, Office Calm, dan iOS pensiun (6 Okt 2026); pola dasbor AI generik dilarang
(`CLAUDE.md` › UI/UX Rule).

**Key Characteristics:**
- Satu aksen (Biru SP `#004c97`), semantik terpisah dari merek.
- Padat di mouse (kontrol 32 px), lega di layar sentuh (44 px) lewat kerapatan Otomatis.
- Datar; kedalaman dari garis rambut dan permukaan berlapis, bayangan hanya untuk lapisan mengambang.
- Angka tabular dan nomor dokumen mono; nominal rata kanan.
- Terang dan gelap setara; mode mengikuti sistem kecuali dipilih.

## Colors

Palet dingin dan tertahan: satu biru logo, netral abu-biru, dan lima nada semantik yang tidak pernah dipinjam merek.

### Primary
- **Biru SP** (`primary`): warna logo CV. Surya Perkasa. Tombol utama (satu per kelompok aksi), tautan, cincin fokus,
  langkah aktif. Hover dan tekan menggelap (`primary-hover`, `primary-active`).
- **Biru Kabut** (`brand-tint`, `brand-tint-strong`): latar hover tombol sekunder/tersier, baris terpilih, navigasi aktif.

### Neutral
- **Kanvas Abu Dingin** (`canvas`): latar halaman di belakang panel.
- **Kertas** (`surface`), **Kertas Bayang** (`surface-2`, `surface-3`): panel, sel kepala tabel, isian baca-saja.
- **Tinta** (`ink`), **Tinta Redup** (`ink-muted`), **Tinta Halus** (`ink-subtle`): teks utama, label, meta.
  `ink-disabled` hanya untuk kontrol nonaktif, tidak untuk teks yang harus dibaca.
- **Garis Rambut** (`line`, `line-strong`, `field-border`): pemisah, tepi panel, tepi isian (≥ 3:1 terhadap latar).

### Semantik (bukan merek)
- **Hijau Lunas** (`pos`): selesai, cocok, lunas. **Jingga Tunda** (`warn`): perlu perhatian, draf, lewat batas.
  **Merah Tolak** (`neg`): galat, ditolak, tindakan merusak. **Nila Info** (`info`): informasi netral berjalan.
  **Abu Netral** (`neu`): belum mulai, nonaktif. Masing-masing punya `-bg` (latar badge/strip) dan `-solid` (ikon, grafik).

### Named Rules
**The One Voice Rule.** Biru SP adalah satu-satunya aksen. Tidak ada gradien, tidak ada aksen kedua, tidak ada ungu
dekoratif. Nila `info` hanya muncul sebagai nada status.

**The Brand ≠ Status Rule.** Status tidak pernah memakai biru merek, dan tombol tidak pernah memakai hijau/merah kecuali
aksi merusak (`negative`).

**The No-Hex Rule.** Halaman tidak menulis warna heksa atau kelas warna Tailwind mentah; hanya token.

## Typography

**Body Font:** Plus Jakarta Sans (fallback Segoe UI, system-ui)
**Label/Mono Font:** Geist Mono (fallback ui-monospace, Cascadia Mono, Consolas)

**Character:** Satu keluarga sans yang hangat tapi rapat untuk semua hal; mono hanya untuk identitas dokumen. Hierarki
dibangun dari bobot (600–700) dan ukuran, bukan dari warna.

### Hierarchy
- **Display** (600, 2rem/2.5rem, −0.02em): judul Beranda saja.
- **KPI** (700, 2.25rem/2.5rem, tabular): angka tile hanya bila angka itu inti tugas.
- **Headline** (700, 1.5rem/2rem, −0.015em): `h1` Object Page dan judul halaman.
- **Title** (650, 1.25rem/1.75rem) dan **Title small** (650, 1rem/1.5rem): judul seksi dan panel.
- **Body** (400, 0.875rem/1.25rem; 0.9375rem/1.375rem di layar sentuh): isi, sel tabel, isian.
- **Small** (400, 0.8125rem/1.125rem): bantuan isian, meta daftar.
- **Label** (600, 0.75rem/1rem, `ink-muted`): label isian, kepala kolom, `dt`.
- **Mono** (0.92em): nomor faktur/SO/klaim, kode barang, kode outlet.

### Named Rules
**The Tabular Rule.** Semua angka yang dibandingkan memakai digit tabular; nominal di tabel rata kanan dan tidak patah.

**The 16 px Touch Rule.** Isian di layar sentuh minimal 16 px supaya Safari iOS tidak memperbesar halaman.

## Layout

Grid 4 px (`spacing`). Breakpoint: S < 600, M 600–1023, L 1024–1439, XL ≥ 1440. Tabel memakai container query (lebar
wadah, bukan layar): < 760 px kolom sekunder pindah ke bawah kolom pertama, < 600 px tabel menjadi daftar.

Pola halaman Fiori: **List Report** (saringan + tabel), **Worklist** (tile = saringan + daftar), **Object Page** (header
dengan atribut kunci, alur status, anchor bar lengket, footer aksi lengket kanan bawah), **Flexible Column Layout**
(daftar + detail berdampingan ≥ 1024 px, satu kolom di bawahnya), **Wizard** (langkah di header, aksi di footer).

Kerapatan: Padat (kontrol 32 px, baris 36 px) untuk mouse; Lega (44/48 px) otomatis untuk `pointer: coarse` (pilihan Otomatis).
Nama teknisnya `html[data-density="compact|cozy"]`; label di layar selalu Otomatis / Padat / Lega. Ponsel
360–400 px tidak boleh menggulir menyamping; gulir menyamping hanya di dalam wadah tabel.

## Elevation & Depth

Datar secara bawaan. Kedalaman di permukaan diam berasal dari garis rambut 1 px dan perbedaan kanvas/kertas; bayangan
hanya untuk benda yang mengambang di atas isi. Di mode gelap bayangan diganti garis.

### Shadow Vocabulary
- **Rambut** (`--shadow-1`: 1–2 px samar + cincin 1 px `line`): panel dan kartu diam.
- **Mengambang** (`--shadow-2`: 8/24 px): popover, menu, bottom sheet.
- **Dialog** (`--shadow-3`: 20/52 px): dialog modal di atas scrim.
- **Bilah** (`--shadow-bar`): footer aksi dan navigasi bawah yang lengket.

### Named Rules
**The Flat-At-Rest Rule.** Panel diam tidak terangkat; hover tidak menambah bayangan.

## Shapes

Lengkung lembut dan konsisten: kontrol 8 px (`md`), isian 6 px (`sm`), panel 12 px (`lg`), sheet 16 px (`xl`), badge
pil. Tidak ada tepi tebal berwarna di satu sisi kartu; penekanan memakai badge atau strip pesan.

## Components

Aturan perilaku lengkap (varian, keadaan, a11y) ada di `docs/UI_DESIGN_SYSTEM.md` › Komponen dan › Enam keadaan per
layar; implementasinya `components/fiori/core.tsx` dan `components/fiori/interactive.tsx`. Ringkasnya:

### Buttons
- **Shape:** 8 px, tinggi = `--ctl-h` (32/44 px).
- **Primary:** Biru SP, teks putih, satu per kelompok aksi; label kata kerja.
- **Secondary / Tertiary:** kertas + garis kuat / transparan; hover Biru Kabut.
- **Negative:** teks merah di kertas, hanya untuk aksi merusak.
- **Busy / Disabled:** ikon berputar; nonaktif selalu disertai alasan tertulis.

### Chips (badge status)
- **Style:** pil, latar `-bg`, teks nada, selalu ikon + label. Tidak pernah warna saja.

### Cards / Containers
- **Corner Style:** 12 px. **Background:** kertas. **Shadow Strategy:** Rambut. **Internal Padding:** 16 px.

### Inputs / Fields
- **Style:** garis `field-border`, 6 px, label di atas (Label), tanda wajib merah.
- **Focus:** garis + cincin 1 px Biru SP. **Error:** garis merah + garis bawah 2 px + pesan berikon.

### Navigation
- Shell bar 52/56 px dengan logo resmi, cari menu (Ctrl K), menu profil (Mode, Kerapatan, Bantuan, Keluar); navigasi
  samping berkelompok dari izin; ponsel: drawer + navigasi bawah (Beranda + 3 pintasan peran + Menu).

### Message Strip (signature)
- Strip berikon dengan nada semantik untuk informasi yang harus terbaca di halaman; galat `role="alert"`.

### Confirm Dialog (signature)
- Semua aksi tulis: judul berupa pertanyaan, fakta (jumlah, nilai, tujuan), alasan bila wajib, tombol berlabel aksi.

## Do's and Don'ts

### Do:
- **Do** bangun layar dari komponen `components/fiori/*` di dalam `<FioriScope>`.
- **Do** tampilkan memuat, kosong, dan galat sebagai tiga keadaan yang berbeda; muat ulang tidak mengosongkan data lama.
- **Do** tulis tanggal `dd/mm/yyyy` WITA, nominal rata kanan tabular, nomor dokumen mono.
- **Do** pakai bahasa tugas Indonesia; istilah Accurate dan principal dipertahankan apa adanya.
- **Do** pakai data contoh generik (PRINCIPLE A, CABANG A, SALES A) di templat, mock, dan kit.

### Don't:
- **Don't** pakai gradien, glassmorphism, neon, glow, atau aksen ungu/sian dekoratif (tema Neon sudah pensiun).
- **Don't** pakai `window.confirm`, `alert`, atau toast untuk galat validasi.
- **Don't** tampilkan kode status mentah, nama model AI, atau endpoint ke pengguna.
- **Don't** campur kelas warna Tailwind lama (`text-slate-*`, `bg-[#…]`) di halaman Fiori, atau kelas `fi-*` di halaman lama.
- **Don't** tambah tepi tebal satu sisi, animasi pantul, atau angka KPI besar yang bukan inti tugas.
