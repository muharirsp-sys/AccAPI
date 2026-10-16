# HANDOVER — Summary Promo Oktober 2026 semua principal (14 Okt 2026)

**Status (diperbarui 14 Okt malam):** 9 principal punya Form Summary PDF yang lulus gerbang, **semuanya format ringkas**. Keputusan pemilik §4 butir 1-4 sudah dikerjakan (lihat §7). Cabang di-push dan dibuka PR, **belum di-merge** ke main (atas perintah pemilik).

## 0. BACA DULU
1. **Serahan:** `tmp/summary_okt26_lengkap/` (git-ignored). Isinya:
   - per principal: PDF, Dataset, `CATATAN.md`, `baris_summary_<P>.json`;
   - `DAFTAR_KEPUTUSAN.md`, yaitu semua pertanyaan untuk pemilik;
   - alat: `buat_summary.py`, `buat_summary_tanpa_bajak.py`, `BRIEF_SUMMARY.md`;
   - `skrip/`: pembangun baris per principal;
   - `cache_ocr/`: `store_<p>.sqlite3` hasil Mistral, supaya uji ulang tidak membayar OCR.
2. **Path skrip.** Skrip di `skrip/` menunjuk ke scratchpad sesi 14 Okt (`C:\Users\Muhar\AppData\Local\Temp\claude\...\scratchpad`), yang bisa hilang. Ganti path-nya ke `tmp/summary_okt26_lengkap/` sebelum dipakai.
3. **Cara baris disusun.** Baris Summary disusun **terkurasi** (agen per principal membaca surat dan memetakan ke master), lalu dicetak lewat generator resmi. Ini BUKAN keluaran otomatis pipeline. Pipeline otomatis hanya bersih untuk Kino, Vinda, dan Priskila Trade GT. Lihat §6.
4. **Push dan merge hanya atas izin pemilik.** Auto-merge dilarang di repo ini.

## 1. Kode
Cabang `fix/summary-okt26-rapikan`, worktree `.claude/worktrees/summary-okt26`, dari main `b99fc807`. Commit-nya:

| Commit | Isi |
|---|---|
| `9b1f38fe` | Vinda dedupe barcode + channel GT; Dahlia "Lusin" bukan grup; Priskila `surat_struktur.nomor_terbawa` (nomor surat untuk halaman tanpa kop) |
| `dbb6ea00` | Unggah surat sebagai foto JPG/PNG (`summary_mistral.foto_ke_pdf`, `Summary.tsx` accept) |
| `43bc12f5` | `kode_bentrok`: strata jumlah bertanda `s/d`/`UP` bukan bentrok V4 |
| `9667182e` | `label_rupiah`: label Form /NOTA, /BOX, /PCS mengikuti `per_unit`/"kelipatan" mesin |
| (handover) | dokumen ini |

Gerbang:
- `run_checks` 67 lulus;
- pyflakes bersih;
- eslint + `tsc --noEmit` hijau (`node_modules` sudah terpasang di worktree);
- peninjau independen: APPROVE.

## 2. Hasil per principal

| Principal | Hal | Baris | Format | Catatan utama |
|---|---|---|---|---|
| URC | 2 | 21 | ringkas | P> dibuang (keputusan pemilik 14 Okt) |
| Priskila | 7 | 72 | ringkas | master `rebuild_master`; NPD lengkap (Extrait); **butuh perbaikan variant_mapping §4.1** |
| Vinda | 10 → 3 | 36 | ringkas | 35 strata Claim lampiran + Lock Volume |
| Gondowangi | 8 → 2 | 16 | ringkas | master `rebuild_master/NATUR` (kode `1901…`); 3 produk belum (label master tertukar) |
| Fonterra | 6 → 4 | 42 | ringkas | master `rebuild_master` (79 kode) |
| Dahlia | 7 → 3 | 22 | ringkas | target per outlet MT Silver tidak bisa dimuat apa adanya; Core vs Heritage tidak digabung (P11) |
| Gumindo | 2 → 1 | 3 | ringkas | HET 1000 = 10GR (bukti harga faktur) |
| MSM | 2 → 1 | 10 | ringkas | master baru `master_barang_principle/MASTER BARANG MSM.xlsx` (dinormalisasi sesi ini) |
| Puratos | 2 → 1 | 15 | ringkas | dari 5 foto WA; 11 kode berakhiran N belum di master |

## 3. Format ringkas (koreksi pemilik 14 Okt: "terlalu banyak halaman")
Acuan bentuk:
- `python_backend/output/summary_manual/d46df7ef-b194-4657-a07b-fbb03df87bba_Form_Summary_Program.pdf` (Priskila Maret, 53 baris / 7 halaman);
- `summary_manual_creat/<Principal>/<Principal> Jun'26.pdf` (manual bertanda tangan).

Aturannya ada di `BRIEF_SUMMARY.md` bagian "FORMAT RINGKAS":
- satu baris = (surat, channel, merek, ketentuan, benefit);
- ketentuan pendek, tetapi kata pemicu mesin tetap ada;
- syarat claim / keterangan kosong atau sangat pendek; rincian ke CATATAN;
- isi kode dibuktikan sama sebelum dan sesudah diringkas.

**Belum diterapkan** ke Vinda, Gondowangi, Fonterra, Dahlia, Gumindo, MSM, Puratos. Pemilik belum mengonfirmasi, tapi kemungkinan ingin. Untuk penggabungan per merek, master harus memakai "KLP - SUB" (" - "). Master URC dan master Priskila lama tidak memakainya, sehingga resolver memecah per kelompok.

## 4. Menunggu pemilik
1. **`python_backend/variant_mapping.json`: batasi pola per merek.** Perubahan ini ditolak pengaman izin ("Modify Shared Resources"), jadi minta izin eksplisit.
   - Masalahnya: `REGAZZA_EDT_REGULAR` memakai `\bedt\b`, yang membajak setiap baris EDT. Dengan master `rebuild_master` Priskila, baris Bellagio/Casablanca EDT diganti 15 kode REGAZZA FM - EDT.
   - Usulan: tambahkan lookahead di depan setiap pola —
     - `REGAZZA_EDT_SPORT` dan `REGAZZA_EDT_REGULAR`: `^(?=.*regazza).*(?: … )`;
     - `CASABLANCA_SPRAY_COLOGNE_SERIES`: `^(?=.*(?:casablanca|csbnca))`.
   - Uji yang perlu ditambahkan di `variant_resolver.py`: "BLAGIO HM - EDT", "Bellagio Eau de Toilette Sport 100ml", dan "CSBNCA HM - EDT" harus menghasilkan None; "REGAZZA FM - EDT" tetap R5+R6.
   - Sebelum perbaikan masuk, PDF Priskila dibuat dengan `buat_summary_tanpa_bajak.py` (kedua aturan dilepas di memori).
2. **Format ringkas untuk 7 principal lain** (§3).
3. **CTN = KRT di mesin.**
   - Faktur Accurate memakai "KRT"; `summary_rules` mencocokkan satuan persis.
   - Akibatnya program ber-CTN tidak pernah memotong. Ini terbukti di simulasi URC, Vinda, Gumindo, Puratos.
   - Jalur uang, jadi perlu izin.
4. **Push + PR** cabang ini.
5. Sisanya ada di `DAFTAR_KEPUTUSAN.md`:
   - daftar outlet yang perlu diunggah;
   - sub-channel GT Retail/Grosir/Star;
   - kode berakhiran N/B;
   - perbaikan master per principal;
   - tafsiran per principal.

## 5. Cara melanjutkan
- **Bangun ulang satu principal** (dari `.claude/worktrees/summary-okt26/python_backend`):
  `PYTHONIOENCODING=utf-8 python <tmp>/buat_summary.py <P> <tmp>/<P>/baris_summary_<P>.json "<master>" <outdir>`
  - Master per principal: lihat CATATAN tiap principal. Priskila, Gondowangi (NATUR), Fonterra, dan Gumindo (ADNA) memakai `python_backend/data/rebuild_master/`; sisanya `master_barang_principle/`.
  - Gerbang gagal bila: kolom wajib kosong, kode di luar master, kode dobel, ada baris ditahan `compile_programs`, atau PDF memuat "TIDAK ADA ITEM COCOK".
  - Selalu lihat `hal-N.png`.
- **Uji jalur otomatis** dengan OCR dari cache: `skrip/uji_okt26.py <P>` dengan `SUMMARY_STORE_PATH` = `cache_ocr/store_<p>.sqlite3`. Sesuaikan path di skrip.

## 6. Temuan sistem (untuk pekerjaan parser berikutnya)
- **Surat Oktober yang tidak terbaca otomatis:**
  - URC: format AL baru, mekanisme dalam kalimat;
  - Gondowangi: benefit/ketentuan mentah, periode kosong;
  - Fonterra: kalimat mekanisme masuk ke kelompok;
  - Dahlia 546: tabel GT Grosir format baru;
  - Gumindo dan Puratos: kode tidak cocok master;
  - MSM: OCR Mistral sekali mengembalikan 0 baris secara acak.
- **Resolver** memecah baris per merek (awalan sebelum " - "). Mix lintas merek dihitung per merek.
- **Penjaga V4 belum mengenal `outlet_mode`.** Diskon NOO tambahan untuk kode yang sama ditolak sebagai bentrok (Gondowangi 006).
- **`_label_periode`** mencetak nama bulan untuk periode sebagian bulan (mis. 05–15 Okt). Ini dikunci oleh `test_label_periode`. Tanggal pastinya ditulis di keterangan.

## 7. Lanjutan 14 Okt malam (keputusan pemilik §4 butir 1-4)
- **variant_mapping (c0f97fc1, 0d3ccfb5, 44e1f214).** Lookahead merek saja TIDAK cukup: diuji pada 72 baris Priskila, 6/22 kunci tetap rusak (baris "REGAZZA FM - EDT & ..." tetap diganti seluruhnya). Kedua aturan REGAZZA dihapus (pemilahan EDT vs Sport dari teks surat sudah di `priskila_matcher`); Spray Cologne diberi lookahead merek. Peninjau lalu menemukan dua bug laten yang terbuka: ekspansi "All Variant" saat Simpan mencampur Sport dan biasa (kini ikut qualifier benih), dan aturan P buta channel (kini kunci + channel). Priskila lewat `buat_summary.py` biasa: 824 = 824 kode, 0 kunci beda; golden 118 baris: 0 pasangan dua-ambang, 0 kode berubah sesudah Simpan. `buat_summary_tanpa_bajak.py` tidak diperlukan lagi.
- **CTN = KRT (6ce41767, 3978ebd4).** `summary_rules.satuan()` di `calculate`/`suggestions`/unit bonus; `triggerReached` (TS) memperlakukan CTN seperti KRT (gagal tertutup, bukan 5 PCS = 5 karton). Sejak deploy, aturan terbit ber-CTN yang selama ini mati akan mulai memotong order baru.
- **Format ringkas 7 principal.** Isi angka dibuktikan sama (bukti kode 0 beda + program `compile_programs` identik); rincian kolom pindah ke bagian "Format ringkas (14 Okt)" di tiap CATATAN. Pertanyaan baru: Vinda benefit berantai seperti Juni?; Vinda/Fonterra halaman terakhir pendek cukup?; Puratos "(tanpa minimum)"?; Dahlia P11 Core+Heritage boleh campur?
- **Temuan terbuka (belum dikerjakan):** `tier_of` membaca "tidak kelipatan" sebagai kelipatan (Dahlia F617TK, belum berdampak); baris Casablanca "Spray Cologne Series" menggandakan diri tiap Simpan (53 → 61 → 77 di simulasi golden).

## 8. Keputusan pemilik 16 Okt
- **Judul di setiap halaman** (semua principal, `350d09e9`): "SUMMARY PROGRAM ON FAKTUR BEBAN PRINCIPLE (COKLAT)" / "PRINCIPLE <NAMA> PERIODE <PERIODE>" / "CV. SURYA PERKASA". Halaman terakhir pendek boleh, asal tidak terpotong.
- **"Setiap Pengambilan" = tanpa minimum, satuan apa pun** (`605c915e`). Puratos memakainya; URC/MSM "Tidak ada minimum pembelian" ikut terbaca SEMUA satuan (dulu terkunci 1 PCS sehingga faktur KRT tidak terpotong).
- **Vinda:** benefit = rantai Disc-1 + Bgt DB + Claim (mis. "15+5+20"); Bgt DB beban distributor (Keterangan). Rincian dan selisih hitungan rantai vs lampiran di `VINDA/CATATAN.md`.
- **Dahlia:** Core/Fresh Signature tidak boleh dicampur dengan Heritage (baris tetap terpisah).
- Ke-9 Form dibangun ulang (`skrip/bangun_semua_16okt.sh`), semua lulus gerbang. Dataset vs sebelumnya: hanya TRIGGER_UNIT tanpa-minimum (URC 66, MSM 8, Puratos 30 baris -> SEMUA) dan benefit Vinda (35 baris) yang berubah; 5 principal lain identik.
