# UI Design System — konvensi yang BENAR-BENAR dipakai

Bukan rencana. Hanya yang sudah ada di kode dan harus dijaga. Aturan kerja UI: `AGENTS.md` › UI/UX Rule.

## Tema dan token

- Empat tema, dipilih pengguna (`components/ThemeSwitcher.tsx`, atribut `data-theme` pada `<html>`):
  **surya** (bawaan, terang/hijau, `app/workspace.css`), **office-calm** (terang/emas), **neon**
  (gelap/HUD), **ios** — sisanya di `app/globals.css`.
- Halaman ditulis dengan kelas Tailwind "gelap" (`text-slate-*`, `bg-white/10`, `border-white/10`);
  tiap tema MEMETAKAN ULANG kelas itu. Jangan menulis warna heksa di halaman.
- **Warna status = makna, bukan dekorasi.** Token per tema: `--status-danger`, `--status-warning`.
  - Bahaya / galat / tidak pasti: `text-red-200|300` (dipetakan ke `--status-danger`).
  - Peringatan / perlu ditinjau: `text-amber-200|300` (dipetakan ke `--status-warning`).
  - Berhasil / cocok: `text-emerald-300`. Info / tautan: `text-blue-300`, `text-sky-*`.
  - Netral: `text-slate-200` (utama), `text-slate-400` (sekunder), `text-slate-500` (metadata).
  - Cakupan bukan status: "semua KECUALI peserta" ditulis netral dengan kata kunci tebal, bukan merah.
- Status tidak boleh HANYA warna: sertakan kata ("lewat 2 jam", "berakhir", "belum mulai",
  "TIDAK PASTI").

## Tipografi

- `h1` judul halaman (`text-2xl` atau `text-lg font-semibold`), paragraf penjelas `text-sm text-slate-400`
  dengan `max-w-*` supaya tidak membentang selebar layar.
- `h2` judul seksi `text-lg font-semibold`. Di Neon hanya `h1` yang bergaya HUD (miring, kapital, pendar
  tunggal); `h2/h3` polos supaya angka di judul seksi terbaca.
- Angka: `tabular-nums`, rata kanan, `whitespace-nowrap` untuk nominal. Kode faktur/outlet `font-mono text-xs`.
- Tanggal tampil `dd/mm/yyyy` (helper `tgl()` lokal di halaman); input tanggal memakai `<input type="date">`
  bawaan dengan nilai ISO.

## Tombol

- Satu tombol **primer** per kelompok tindakan: `bg-blue-600` (dipetakan ke `--btn-primary-bg/text`
  tiap tema). Gradien primer TIDAK boleh berakhir di warna gelap bila teksnya gelap.
- Sekunder: `bg-white/10`. Destruktif: ikon/teks `text-red-300` + konfirmasi.
- Tombol ikon wajib `aria-label`. Tombol toggle (chip saringan) wajib `aria-pressed`.
- Tindakan yang tidak bisa ditarik (Kirim ke Accurate) duduk BERSAMA isian yang menentukan isinya, terpisah
  dari saringan.

## Saringan

- Satu baris `flex flex-wrap items-end gap-2|3`; label di atas kontrol. Dua kontrol yang menjawab satu
  pertanyaan (periode dari–sampai) = satu `role="group"` berlabel, masing-masing `aria-label`.
- Saringan yang bisa dikosongkan punya tombol hapus berlabel ("Hapus saringan periode").
- Teks bebas (Cari): jeda 300 ms sebelum meminta. Permintaan saringan memakai `AbortController` supaya
  jawaban lama tidak menimpa yang baru.

## Keadaan async (memuat / kosong / galat)

Pola di Normalisasi Diskon, Aturan Promo, Antrean Faktur, Rekap Promo:

- State `status: "memuat" | "siap" | "galat"` + pesan galat. Jangan menurunkan "kosong" dari array kosong
  selama memuat.
- **Muat awal:** `LoadingState embedded` (`components/ui/AsyncState.tsx`) di dalam badan tabel.
- **Muat ulang / ganti saringan:** data lama tetap tampil, kontainer `opacity-60` + `aria-busy`, tombol
  Muat ulang menjadi "Memuat…" dengan ikon berputar. Tidak mengosongkan layar.
- **Galat:** baris/panel `role="alert"` berisi sebab + "Coba lagi"; bila data lama masih ada, katakan
  bahwa yang tampil adalah hasil sebelumnya.
- **Kosong:** kalimat berbeda untuk "belum ada data" dan "tidak ada yang sesuai saringan".
- **Berpindah menu:** `app/(dashboard)/loading.tsx` (kerangka judul + tabel; sidebar tetap).

## Mutasi

- `busy` menonaktifkan tombol yang relevan saja, label berubah ("Menyimpan…", "Memproses…").
- Penjaga klik ganda dengan `useRef` (bukan hanya `disabled`, yang baru berlaku sesudah render).
- Gagal: pilihan pengguna TIDAK dikosongkan; sebab tampil inline (`role="alert"`) dan di toast.
- Keputusan yang menulis data penting meminta konfirmasi yang menyebut jumlah, nilai, dan dasarnya.
