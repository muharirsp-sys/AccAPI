# UI/UX Audit — ruang kerja dashboard (Oktober 2026)

Diperiksa pada halaman yang DIRENDER (dev server + DB sintetis), tema **Neon HUD** (dipakai operator,
lihat tangkapan layar pengguna) dan **Surya** (bawaan), di 1920×1080, 1440×900, 1366×768, 1024×768 dan
390×844. Layar utama: Normalisasi Diskon, Aturan Promo, Antrean Faktur. Bukti: `docs/ui-baseline/`
(sebelum) dan `docs/ui-after/` (sesudah).

Prioritas: **P0** risiko operasional, **P1** masalah alur/keterbacaan berarti, **P2** konsistensi,
**P3** kosmetik opsional. Status: **FIXED** (sudah diperbaiki di cabang ini) atau **OPEN**.

## P0 — risiko operasional

### P0-1 Teks status merah/kuning tidak terbaca di tema terang — FIXED
- **Current:** di Surya (bawaan) peringatan "lewat 2 jam", status `TIDAK PASTI`, dan seluruh kolom
  "Jawaban Accurate" (alasan faktur ditolak) tampil merah muda/kuning pucat di atas putih
  (`docs/ui-baseline/antrean-faktur-surya-1920.png`).
- **Problem:** kelas Tailwind `text-red-200/300`, `text-amber-200/90` dirancang untuk latar gelap dan
  tidak dipetakan ulang di tema terang.
- **Why it matters:** operator tidak bisa membaca kenapa faktur ditolak atau faktur mana yang nasibnya
  tidak pasti — dua informasi yang menentukan tindakan berikutnya.
- **Change:** token `--status-danger` / `--status-warning` per tema; kelas merah/kuning muda dipetakan ke
  token itu (`app/globals.css`, blok "Warna STATUS semantik").
- **Verify:** `docs/ui-after/antrean-faktur-surya-1920.png` — alasan penolakan, `TIDAK PASTI`, dan
  peringatan terbaca.

### P0-2 "Sedang memuat" dan "gagal" tampil sebagai "kosong" — FIXED (layar prioritas + 3 layar lain)
- **Current:** Antrean Faktur menulis "Tidak ada faktur yang menggantung." selama memuat dan setelah
  gagal; Normalisasi Diskon "Tidak ada potongan tak bertuan"; Aturan Promo "Tidak ada aturan yang cocok";
  Order Principal "Belum ada batch" (galatnya bahkan ditelan tanpa pesan); Principal Mapping "Belum ada
  mapping" saat gagal. Rekap Promo tidak menampilkan apa pun selama hitungan yang bisa puluhan detik.
- **Why it matters:** kesimpulan "tidak ada masalah" yang salah — persis kesimpulan yang tidak boleh
  diambil di layar antrean dan normalisasi.
- **Change:** tiga keadaan terpisah (`memuat | siap | galat`), kerangka `LoadingState` untuk muat awal,
  tabel lama diredupkan (bukan dikosongkan) saat memuat ulang, galat `role="alert"` + "Coba lagi".
  `app/(dashboard)/loading.tsx` memberi kerangka saat berpindah menu.
- **Verify:** `tests/normalisasi-aturan-promo.spec.ts` (memuat ≠ kosong, galat terlihat, kosong
  berbeda dari "tidak cocok saringan").

### P0-3 Normalisasi bisa digolongkan tanpa dasar — FIXED
- **Current:** potongan tak bertuan bisa dijadikan Disc Claim / Disc Distributor dengan satu klik, tanpa
  aturan apa pun.
- **Change:** wajib memilih aturan promo yang berlaku (lihat `docs/UI_UX_CHANGELOG.md` dan
  `SYSTEM_MAP.md` › "Aturan Promo, Rekap Promo & Normalisasi Diskon").

## P1 — alur dan keterbacaan

| ID | Temuan | Status |
|---|---|---|
| P1-1 | Kuning (peringatan) dipetakan ke aksen dekoratif `--luxury-soft`: tampil **cyan** di Neon dan hijau-abu di Surya. "Ditolak Accurate", "Perlu ditinjau", "Sebab" tak bertuan tidak terbaca sebagai peringatan. | FIXED (token status) |
| P1-2 | Antrean Faktur: tombol **Kirim ke Accurate** (tidak bisa ditarik) terbungkus ke baris sendiri di kiri, jauh dari **Tanggal faktur** yang menentukan isinya, bergaya chip tipis seperti saringan. | FIXED — dua kelompok: saringan (kiri) / kirim + tanggal (kanan), tombol primer |
| P1-3 | Gradien tombol primer berakhir gelap (`--luxury-bronze`) dengan teks gelap: ujung kanan label ±1,3:1 di Neon (navy di atas navy) dan Office Calm. | FIXED — ekor gelap dibuang |
| P1-4 | Aturan Promo: Cari mengirim satu permintaan per huruf, tanpa pembatalan; jawaban lama bisa menimpa yang baru. | FIXED — jeda 300 ms + `AbortController` |
| P1-5 | Rekap Promo: tidak ada tanda memuat untuk kueri yang lambat; galat hanya toast. | FIXED |
| P1-6 | Aturan Promo belum punya saringan periode; 250+ aturan tiga bulan bercampur. | FIXED — saringan Periode (bersinggungan) |

## P2 — konsistensi

| ID | Temuan | Status |
|---|---|---|
| P2-1 | Neon: h2/h3 miring + kapital + pendar ganda — angka di judul seksi ("Tak bertuan · Rp 82.273,68") sulit dibaca dan menyaingi tabel. | FIXED — h2/h3 polos; h1 tetap gaya HUD dengan pendar tunggal |
| P2-2 | Tanggal tabel ISO (`2026-10-01`) sementara Accurate dan surat memakai dd/mm/yyyy. | FIXED di 3 layar prioritas; OPEN di layar lain |
| P2-3 | Aturan Promo: cakupan "semua KECUALI peserta" berwarna merah — terbaca "aturan rusak". | FIXED — netral, kata kunci tebal |
| P2-4 | Chip status Antrean Faktur berwarna walau jumlahnya 0; tanpa `aria-pressed`. | FIXED |
| P2-5 | "Lewat 2 jam" hanya disampaikan lewat warna baris. | FIXED — label teks "· lewat 2 jam"; Aturan Promo "berakhir" / "belum mulai" |
| P2-6 | Tombol ikon (salin, hapus) Aturan Promo tanpa nama aksesibel. | FIXED — `aria-label` |
| P2-7 | Panel galat bersama (`.ui-state-panel--error`) merah muda tetap — menyilaukan di Neon. | FIXED — memakai token status |
| P2-8 | Dua gaya tombol primer: `bg-blue-600` (dipetakan tema) dan `.ui-button-primary` (`--luxury-teal`; di Neon hijau terang dengan teks putih). | OPEN — 11 berkas memakai `.ui-button-primary`; satukan bila menyentuh layar itu |
| P2-9 | Layar lain dengan pola memuat lemah: `summary/settings` (daftar kosong selama memuat), `summary/realization` (pesan baru muncul sesudah selesai), `orders`, `sales`, `finance`. | OPEN — belum diperiksa satu per satu di peramban |

## P3 — opsional

- Konfirmasi memakai `window.confirm` (Kirim, normalisasi, hapus). Berfungsi dan bisa dengan papan
  ketik; tidak diganti.
- Tabel ditulis tangan per halaman walau `@tanstack/react-table` dan `components/DataTable.tsx` ada.
  Tidak dimigrasi: kebutuhan layar saat ini (kepala lengket, centang, rincian) terpenuhi.
- Neon: ornamen sudut HUD dan grid latar adalah identitas tema yang dipilih pengguna; tidak diubah.

## Responsif

Tidak ada gulir horizontal tingkat halaman di 1024 dan 390 px untuk ketiga layar (diukur:
`scrollWidth − clientWidth = 0`). Tabel menggulir di dalam kontainernya sendiri, seperti sebelumnya.
Di 1366 px saringan Aturan Promo membungkus "Cari" ke baris kedua — masih utuh.
