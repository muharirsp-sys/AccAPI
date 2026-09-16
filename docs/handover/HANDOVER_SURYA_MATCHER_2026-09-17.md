# Handover — pekerjaan yang sudah selesai sejak Juli, dan dua bulan yang dihabiskan menemukannya lagi (17 Sep 2026)

Penerus: baca berkas ini lebih dulu, lalu `HANDOVER_SURYA_SUMMARY_2026-09-16.md` untuk latar
belakangnya, lalu `SELISIH_MUAT_SUMMARY_2026-09-16.md` bila akan menekan tombol Muat.

**Belum ada satu pun yang di-commit.** Seluruhnya masih di pohon kerja. Produksi belum berubah:
`promo_rule` tetap 234 baris, gerbang kirim faktur otomatis tetap tertutup.

---

## Satu kalimat

Jalur Summary menghasilkan lembar yang salah bukan karena belum pernah benar, melainkan karena
seluruh matcher deterministik yang membuatnya benar — beserta kunci jawabannya — selesai dan
teruji pada Juli 2026 di cabang `feat/urc-deterministic-matcher`, lalu tidak pernah di-merge; dan
tidak ada satu pun alur CI yang menjalankan uji, sehingga tidak ada yang bisa memberi tahu.

---

## Akar masalahnya, dengan buktinya

### 1. CI tidak pernah menjalankan uji apa pun

`deploy.yml` hanya `npm run lint` dan `tsc --noEmit`, lalu membangun image dan men-deploy.
Repo ini punya **72 uji TypeScript dan 29 self-check Python**; nol dijalankan.

Akibat yang terukur saat sesi ini membuka gerbangnya:

| Temuan | |
|---|---|
| 4 self-check sudah RUSAK di `main` | `test_e2e_live`, `test_orders`, `test_order_duplicate_gate`, `test_websales_pull` |
| `test_e2e_live` mati sejak `main.py` dipecah | ia memanggil `main.summary_manual_parse_pdf_ai`, yang pindah ke `routers/summary.py`. Itu **satu-satunya uji yang benar-benar menghasilkan Form PDF dan Dataset Excel dari surat sungguhan** |
| 3 uji lain rusak oleh gerbang channel (PR #64) | ujinya tidak pernah ikut diperbarui |

### 2. Pekerjaan Juli tidak pernah sampai

**28 berkas non-uji** ada di `feat/urc-deterministic-matcher` dan tidak ada di jalur ini:
matcher Priskila/URC/generik, `golden_priskila_expected.json` (118 baris), `promo_grouping`,
`channel_map`, `self_correction`, dan **seluruh modul Master Barang** (halaman + API + lib + 6 uji).

Uji cabang itu dijalankan hari ini dan **lulus semua** — pekerjaannya tidak basi, ia cuma
tertinggal.

### 3. `.gitignore` sedang menelan kunci jawabannya

`python_backend/data/*.json` mencakup `golden_priskila_expected.json`. Acuan yang tidak ikut git
adalah acuan yang akan hilang lagi. Sudah dikecualikan, beserta `manual_cache/master_cache.json`.

---

## Yang sudah dikerjakan

### Gerbang

| | |
|---|---|
| `deploy.yml` | menjalankan `npm test`, `pyflakes` (nama tak terdefinisi), `run_checks.py` — pada **pull request** dan sebelum deploy. Uji merah = image tidak dibangun |
| `python_backend/run_checks.py` (baru) | 21 `test_*.py` + 8 self-check modul sebagai satu gerbang, tiap uji proses sendiri |
| Hasil | **38/38 self-check Python, 272/272 uji TypeScript, `tsc` bersih, pyflakes bersih** |

### Matcher deterministik dibawa masuk (25 berkas)

`priskila_matcher/pipeline/matching.json`, `urc_*`, `generic_promo_pipeline` (FONTERRA/NATUR/
ADNA/FORISA), `promo_grouping`, `channel_map`, `self_correction`, kedua golden, 9 berkas uji,
3 alat bantu.

`shared._apply_native_kelompok` sekarang memilih matcher dari **penanda baris** yang distempel
router (bukan model): `_gen_key` / `item_description` / `group_item_text`. Perbaikan id baris
bulan September **dipertahankan** — versi Juli masih memakai `is_first` yang bermasalah.

`surat_struktur.py` (baru) memegang perintah **"SALIN SAJA"** per principal. Model tidak lagi
diminta menafsirkan; ia hanya menyalin sel surat apa adanya (`group_item_text` / `item_description`
/ `product_line_text` + `paket`), dan matcher deterministik yang memetakan ke SKU master. Isi
perintahnya diambil langsung dari cabang Juli, bukan diketik ulang.

**Kino dan principal lain tidak berubah**: mereka tetap lewat `rapikan_baris` seperti sekarang,
dan seluruh ujinya hijau.

### Delapan cacat yang diperbaiki sepanjang jalan

| # | Cacat | Akibatnya |
|---|---|---|
| 1 | **Dataset Excel corrupt sejak Juli** — `\1` diikuti digit ditafsir escape oktal, tag `dcterms:created` berisi `2000-…` jadi `P20-…` | berkasnya **tidak bisa dibuka**. Perbaikannya sudah ada di cabang (0108690) dan tidak pernah sampai |
| 2 | **Pencocokan dijalankan DUA KALI** | 64 baris Priskila yang sudah benar jadi 64 baris "(TIDAK ADA ITEM COCOK DI MASTER)" |
| 3 | **Kelompok kosong mencocok SELURUH katalog** (`pool = master_items`) | satu baris sisa mengklaim semua kode di channelnya; `issues` kosong sehingga draftnya terlihat sah dan bisa diterbitkan. Satu draft membengkak 7 menjadi 607 baris hanya karena disimpan ulang |
| 4 | **Penjaga bentrok V4 melepas channel saat membuang** | satu bentrok di MTI menghapus kodenya dari RETAIL juga → PDF kosong, Excel penuh (ketidaksimetrisan baris I checklist) |
| 5 | **Gerbang determinisme tidak pernah bisa bilang "match"** | sidik jarinya ikut menandatangani `id` baris yang lahir baru tiap run |
| 6 | **Permintaan Web Sales yang ordernya sudah ada tak pernah ditandai `pulled`** | muncul lagi sebagai "dugaan order ganda" di setiap tarikan |
| 7 | `ocr_text_compare` memanggil `ocr_cache_key` dengan dua argumen | mati dengan TypeError, tak ada yang menjalankannya |
| 8 | Jembatan multi-surat (lihat `SELISIH_MUAT_…`) | seluruh aturan surat kedua tersimpan atas nama surat pertama |

Cacat 3 dan 4 dikunci uji baru (`test_draft_resolve_kode`, `test_summary_rules`).

---

## Bukti bahwa hasilnya benar

`test_e2e_live` hidup lagi: surat asli → OCR → Form PDF + Dataset Excel, dua run, **nol panggilan
API di run 2**, berkasnya byte-identik, golden `match`.

Halaman 1 keluaran hari ini lawan acuan `Form_Summary_NEW.pdf` (15 Juli):

| Kolom | Acuan Juli | Hari ini |
|---|---|---|
| Judul | `CV. SURYA PERKASA PERIODE MARET 2026` | sama |
| Surat Program | `002/PPM/NSPM/III/2026` | sama |
| Kelompok Barang | `BLAGIO HM - EDP PRESTIGE & EDT` | sama |
| Gramasi | `50ML & 100ML` | sama |
| Ketentuan | `Beli 7` | sama |
| Benefit | `1 PCS` | sama |
| Syarat Claim | `Boleh Mix Kelompok dan Gramasi Barang Sama` | sama |

Sebelum sesi ini: 6 baris digabung per channel, Periode/Ketentuan/Benefit/Syarat Claim **kosong
semua**, dan Excel-nya tidak bisa dibuka.

---

## Yang MASIH menggantung

1. **Belum di-commit, belum di-deploy.** Produksi masih menjalankan kode lama — termasuk Excel
   yang corrupt.
2. **Sisa berkas cabang**: modul **Master Barang** (halaman + API + lib + 6 uji) belum dibawa.
   Ia yang membuat master principal baru, jadi ia prasyarat untuk surat sept26 di luar Priskila.
3. **Periode salah baca pada blok non-Retail**: sebagian baris ber-`periode` `31 Juni 2026` dan
   `September` (tanggal pertama bahkan tidak ada). Model menyalin batas klaim, bukan periode
   program. Perintah "salin saja" untuk blok MTI/Grosir/Star perlu dipertajam.
4. **Baris struktur belum punya `periode_start`/`periode_end`** (format YYYY-MM-DD), jadi
   draft Priskila **belum bisa** menjadi `promo_rule` — `compile_programs` akan menolaknya.
   Untuk Form Summary dan Dataset Excel ia sudah utuh; untuk gerbang faktur belum.
5. **Satu baris Priskila tetap `(TIDAK ADA ITEM COCOK DI MASTER)`** — itu perilaku yang BENAR:
   ditandai untuk ditinjau, bukan ditebak.
6. **Dua master Priskila berbeda di mesin ini.** `master_barang_principle/MASTER BARANG
   PRISKILA.xlsx` (259 barang, kelompok tanpa tanda hubung) TIDAK cocok dengan matcher;
   yang benar 274 barang berpola `BRAND - JENIS`. Uji memakai `data/manual_cache/master_cache.json`.
   Master mana yang dipakai produksi perlu diputuskan.
7. **234 aturan produksi ber-`channel` kosong** — artinya berlaku di MT juga. Surat yang berbunyi
   "KHUSUS CHANNEL GT" belum tegak untuk baris lama. Aturan baru dari jalur Summary sudah benar.
8. **Uji dua surat Kino** (`BP2609007664` + `BP2609007713`) berhenti sebelum Muat, sesuai
   permintaan. Lihat `SELISIH_MUAT_SUMMARY_2026-09-16.md`.

---

## Aturan baru yang diputuskan pengguna

- **"All Variant" = semua varian KECUALI yang sudah diklaim baris lain** pada kelompok dan surat
  yang sama (kasus `RESIK V KHASIAT MANJAKANI` lawan `RESIK V MANJAKANI WHITENING`). Sudah jadi
  baris **P** di `CHECKLIST_AKURASI_SUMMARY_PROMO.md`. Catatan: 13 aturan Excel `BP2609007713`
  yang sudah ada MELANGGAR aturan ini.
- **Non-peserta LOYALTY** = semua yang tidak ada di daftar **dan** sesuai channel surat; MT tidak
  boleh dapat. Ini sudah terdokumentasi (`CHECKLIST_ALUR_FAKTUR_PRINCIPLE.md:687`) dan sudah
  terpasang (`outletAllowed && channelAllowed`). Yang kurang cuma butir 7 di atas.

---

## Prompt melanjutkan

> Lanjutkan pekerjaan Surya di `D:\AccAPI\_github_clean`, branch `feat/surya-workspace`. Baca
> `docs/handover/HANDOVER_SURYA_MATCHER_2026-09-17.md`. Seluruh perubahan masih di pohon kerja,
> BELUM di-commit dan BELUM di-deploy; gerbangnya hijau (38 self-check Python, 272 uji TS, tsc
> bersih) — jalankan `python python_backend/run_checks.py` dan `npm test` lebih dulu untuk
> memastikan. Pekerjaan berikutnya, berurutan: (1) commit + PR, karena produksi masih memakai
> Excel yang corrupt; (2) bawa modul Master Barang dari `feat/urc-deterministic-matcher`;
> (3) pertajam perintah "salin saja" untuk blok MTI/Grosir/Star supaya `periode` tidak terbaca
> dari batas klaim, dan tambahkan `periode_start`/`periode_end` supaya draft Priskila bisa jadi
> `promo_rule`. Gerbang kirim faktur otomatis TETAP TERTUTUP. Jangan stage massal — pohon kerja
> masih memuat pekerjaan rekonsiliasi dan dashboard-generator yang bukan milik alur ini.
