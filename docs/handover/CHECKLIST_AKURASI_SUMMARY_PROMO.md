<!--
Tujuan: Alat ukur (acceptance checklist) akurasi pipeline Summary Promo untuk SETIAP surat program baru.
        Tiap baris = kesalahan nyata yang pernah terjadi + akar + guard di kode + cara verifikasi.
Caller: Developer/agent SEBELUM menyatakan hasil sebuah surat "benar" & sebelum commit.
Kebijakan update: JANGAN tambah/ubah aturan tanpa revisi/koreksi eksplisit dari user (CV. Surya Perkasa).
        Kalau user bilang "ini salah / harusnya begini" -> baru tambahkan/koreksi baris checklist + tanggal.
Dependensi: python_backend/{routers/summary.py, shared.py, tier_parser.py, variant_resolver.py, variant_mapping.json}.
Side Effects: dokumen; tidak dieksekusi. Sinkronkan bila guard di kode berubah.
-->
# CHECKLIST AKURASI — Summary Promo (Alat Ukur per Surat)

> **Cara pakai:** untuk SETIAP surat program baru, jalankan pipeline lalu cek SEMUA baris di bawah
> terhadap output nyata (Excel + PDF), bukan cuma "pipeline jalan tanpa error".
> **Kebijakan update:** checklist ini hanya bertambah/berubah kalau user memberi revisi/koreksi baru.
> Terakhir diperbarui: 2026-10-07.

---

## 0. PRINSIP MATCHING WAJIB (dasar semua pengecekan)

- **Penentuan item = Nama Barang Principle × Nama Barang internal (baca per-pecahan: Nama KLP,
  Nama Sub KLP, Nama Sub KLP 2, Nama Aroma/Rasa, Nama Gramasi, Nama Jenis Kemasan) × nama di surat.**
  Ketiganya dipertimbangkan bersama, bukan satu saja.
- **Master menyingkat nama panjang** agar muat di nota saat print. Singkatan resmi = tetap identitas
  barang yang sama. Yang sudah diketahui: **SR = SERIES**, EDT = Eau De Toilette, EDP = Eau De Parfum,
  PMD = Pomade, COL/COLG = Cologne, WTR = Water, BAS = Based (lihat `tier_parser._SYNONYMS`).
- **Tier/trigger OTORITATIF dari POSISI tabel surat** (`tier_parser.parse_positional_tables`), BUKAN
  tebakan LLM. Ragu → jangan ditebak (no silent guess).
- **"Gate e2e lulus" ≠ output benar.** Kebenaran = cek manual atas Excel/PDF nyata. LLM
  non-deterministik (tiap run beda jumlah baris) → **wajib run live + cek manual**, replay offline saja
  tak cukup (kasus GLASS 2026-07-15 hanya muncul di run live).

---

## 1. CHECKLIST KESALAHAN (uji tiap surat)

| ID | Gejala yang HARUS TIDAK terjadi | Akar (pernah terjadi) | Guard di kode | Cara verifikasi cepat |
|---|---|---|---|---|
| **A. Tier salah antar-gramasi** | 1 barang di gramasi tertentu dapat tier gramasi lain (mis. Body Spray 65ml=7+1 tapi ikut 14+1 gramasi 100/200ml) | `match_item_to_tablerow` Jaccard <0.5 + brand alias tak diterapkan → tak ada baris ter-match → tier LLM dipakai apa adanya | `tier_parser.match_item_to_tablerow`: coverage directional + gramasi hard-filter + guard ambiguitas; brand-alias di `_SYNONYMS` | Untuk tiap gramasi di 1 kelompok, tier di Excel = tier baris surat gramasi itu |
| **B. Item hilang / "PERLU REVIEW MANUAL" utk barang yang ADA di master** | Barang yang jelas ada di surat & master tak muncul / jadi flag review | `variant_mapping` rule brand-agnostik membajak baris brand lain (pattern `\bedt\b` cocok `BLAGIO HM - EDT`) → matched di-replace, barang asli hilang | `variant_mapping.json` pattern **brand-scoped** (lookahead `^(?=.*<brand>)`); regresi test di `variant_resolver.py` | Cari 0 baris "PERLU REVIEW MANUAL" untuk item yang mestinya cocok; barang headline surat ada di channel-nya |
| **C. Item ter-EXCLUDE bocor** | Barang yang aturannya DIKECUALIKAN tetap muncul (mis. Spray Cologne **GLASS** — hanya White SR + Black SR yang ikut) | LLM menaruh kode excluded langsung di `kode_barangs` → lolos klist-match & jalur fallback | drop-list global `shared._EXCLUDED_KELOMPOKS` (dari `exclude_kelompok` tiap rule) distrip di AWAL `_apply_native_kelompok` | 0 baris ber-kelompok di `exclude_kelompok`; cek nama_barang tak ada "GLASS/GLAS" untuk kasus Spray Cologne |
| **D. Varian tak lengkap (under-inclusion)** | "All Variant"/varian berpasangan tak lengkap (mis. Spray Cologne cuma White SR, Black SR hilang; atau 1 dari 8 varian) | Ekspansi All-Variant hanya tarik se-kelompok; kelompok pasangan beda → tak tertarik | `shared._apply_native_kelompok`: All-Variant seed-anchored dari MASTER + konsultasi `variant_mapping.resolve_to_kelompok` utk kelompok berpasangan | Jumlah varian di Excel = jumlah varian non-banded di master utk (kelompok, gramasi) itu |
| **E. Produk BANDED ikut klaim** | Item "… BTL BND" muncul di promo | — | exclude token "BND" di `_apply_native_kelompok` (ekspansi & fallback) | 0 baris nama_barang mengandung token "BND" |
| **F. Duplikat / data-loss lintas-baris** | 1 kode fisik muncul >1× di channel sama, ATAU kode valid hilang karena dianggap konflik | Baris mega-merge LLM tumpang-tindih → sama-tier tapi 2 baris | guard V4 di `summary.py`: **sama-tier → dedup** (simpan 1), **beda-tier → flag+drop** (ambigu) | 0 kode duplikat per channel; tak ada kode valid hilang tanpa alasan tier-konflik |
| **G. Channel hilang / ke-merge** | 1 channel (mis. GROSIR) hilang / datanya masuk channel lain | Header channel ter-markdown (`**3. … GROSIR:**`) → splitter gagal | `summary.py` `_hdr_re` toleran markdown + channel dipaksa dari HEADER chunk (bukan label LLM) | 4 channel (RETAIL/MTI/GROSIR/STAR) semua ada; barang tiap channel sesuai tabelnya |
| **H. Struktur output rusak / merge lintas-brand** | Urutan channel teracak, brand berbeda ke-gabung dalam 1 baris | Versi lama `regroup_rows_by_tier` merge lintas-brand & reorder | `regroup_rows_by_tier` **non-destruktif**: koreksi tier di tempat + pecah baris tier-campur; TANPA merge lintas-brand / reorder | Urut per-channel (RETAIL→MTI→GROSIR→STAR), per-brand, urutan surat; tak ada 2 brand dalam 1 baris |
| **I. Excel↔PDF tak simetris** | Baris no-match: PDF flag review tapi Excel kosong polos (atau sebaliknya) | — | `REVIEW_FLAG_TEXT` dipakai di PDF (kolom Kelompok) & Excel (NAMA_BARANG) + `PROMO_ACTIVE=False` | Baris tanpa item cocok: PDF & Excel sama-sama flag; Excel PROMO_ACTIVE=False |
| **J. File Excel corrupt walau "byte-identik"** | `Dataset_Diskon.xlsx` tak bisa dibuka | regex replace `\1`+digit ditafsir backreference/octal → core.xml rusak | `deterministic_output.py` `\g<1>`/`\g<2>` + self-check `load_workbook` ulang | File Excel benar-benar terbuka bersih (bukan cuma hash sama) |
| **L. Variant ditulis "-" padahal surat tak menyebut varian** | Kolom Variant kosong/"-" untuk kelompok yang seharusnya berlaku SELURUH varian | Renderer menulis "All Variant" hanya bila surat memuat frasa "MIX VARIANT"/"ALL VARIANT"; surat yang diam dianggap tanpa varian | Default kolom Variant = **"All Variant"**; varian spesifik hanya bila surat menyebutnya di luar nama kelompok | 0 baris Variant "-" atau kosong; bandingkan jumlah barang di Detail dgn varian non-banded master |
| **M. Detail barang ikut dicetak ke PDF** | Form Summary memuat halaman daftar barang per program | Detail diperlakukan sebagai lampiran Summary | Detail HANYA ke Excel (dipakai menyaring & menyandingkan per baris); PDF = Summary (+ tabel diskon distributor) | PDF tidak punya halaman "Detail barang"; sheet `Detail` ada di Excel |
| **N. Padanan merek surat -> master dikerjakan ulang tiap surat** | Merek yang sama ditanyakan lagi bulan berikutnya (mis. "OVALE 2IN1 CLEANSER") | Alias hanya hidup di skrip/ingatan, tidak tersimpan | `principal_mapping` kind=**'brand'** (migrasi 0010) + tab "Merek surat" di `/principal-mapping` | Sheet `Tidak_Cocok` kosong; tiap alias yang dipakai tercatat di kolom CATATAN Detail |
| **O. Gramasi dikarang dari surat** | Kolom Gramasi berisi ukuran yang tidak dijual, atau kosong | Surat menyebut merek, bukan ukuran | Gramasi diambil dari BARANG hasil match di master, diurutkan menaik ("50ML, 90ML & 200ML") | Tiap ukuran di kolom Gramasi ada pada minimal 1 baris Detail kelompok itu |
| **P. "All Variant" menelan varian milik baris lain** | Satu surat menyebut DUA program dalam satu kelompok master — yang umum dan yang bervarian (mis. `RESIK V KHASIAT MANJAKANI` dan `RESIK V MANJAKANI WHITENING`, keduanya kelompok `RESIK V MANJAKANI`) — lalu baris yang umum ikut menarik varian milik baris satunya, sehingga varian itu dapat bonus dua kali | Pemilih Varian di grid hanya menawarkan `ALL VARIANT` dan varian yang BERNAMA; barang bervarian kosong tidak bisa dipilih sendiri, jadi "non-whitening" tak bisa dinyatakan lewat layar. `_apply_native_kelompok` pun memperlakukan `ALL VARIANT` sebagai SELURUH kelompok | BELUM ADA. Untuk sekarang `kode_barangs` baris yang umum diisi tangan (resolver memakainya apa adanya bila terisi) | Keputusan pengguna 2026-09-16: **`ALL VARIANT` = semua varian KECUALI yang sudah diklaim baris lain pada kelompok yang sama di surat yang sama.** Jumlahkan barang tiap baris se-kelompok — tidak boleh ada kode yang muncul di dua baris |
| **Q. Satu frasa surat jadi dua baris ("varian dobel")** | Surat menyebut SATU produk ("ELLIPS HAIR VITAMIN BLISTER", "B&B ALL VARIANT") tetapi Summary mencetak dua baris berketentuan dan berbenefit sama persis, karena frasa itu mencakup dua kelompok master (`ELLIPS` + `ELLIPS - H.VIT BALI`; `B&B - HAIR BODY WASH` + `B&B - HAIR BODY WASH - ALL IN`) | `match_groups` membuat satu baris per kelompok master; konsolidasi renderer tidak melebur baris yang kedalaman nama kelompoknya berbeda | `kino_letter.match_groups`: satu frasa = satu baris, kelompok digabung " & ", kode disatukan, dipecah hanya per merek (awalan sebelum " - ", sama dengan `_apply_native_kelompok`); `format_kelompoks_human_readable` mencetak induk tanpa ekor sebagai kelompoknya sendiri | Keputusan pengguna 2026-10-07: **yang membedakan baris adalah KETENTUAN dan BENEFIT; beda kelompok di surat baru beda baris.** Tidak boleh ada dua baris se-surat dengan ketentuan+benefit identik; sel Kelompok memuat semua kelompok master yang tercakup |
| **R. "MIX VARIANT" dihitung lintas gramasi** | Ambang "30 PCS ... MIX VARIANT" terpenuhi dari 10 pcs 70ML + 20 pcs 900ML, lalu bonus keluar; teks ketentuan juga tidak menyebut gramasi | `mix` = seluruh kode kelompok dicampur di evaluator (`summary_rules.calculate`) dan gerbang mengunci ambang per (surat, kelompok) tanpa gramasi | Berlaku SEMUA principal: `summary_rules.LINTAS_GRAMASI`/`GRAMASI_SAMA`; `compile_programs(rows, period, items)` memecah program mix jadi satu program per gramasi (kelompok berakhiran gramasi) sehingga gerbang menghitung per ukuran; ketentuan mix yang diam soal gramasi DITOLAK saat disusun; parser Kino menulis "MIX VARIANT, GRAMASI SAMA" | Keputusan pengguna 2026-10-07: **mix variant = campur varian DALAM GRAMASI YANG SAMA**, kecuali surat menyebut beda gramasi. Tiap baris mix: ketentuan menyebut "gramasi sama" atau "beda gramasi"; aturan terbit per gramasi; faktur campur ukuran tidak berbonus |
| **S. Rentang minimal belanja hanya batas bawah** | Surat "1JT – 1.99 JT … 10JT UP" tercetak "Minimal belanja Rp 1.000.000" saja; batas atas tiap strata hilang | Regex `JUTA` sengaja menelan angka kedua | `kino_letter.JUTA` menangkap maksimum dan "UP": "Minimal belanja Rp 1.000.000 s/d Rp 1.999.999" (batas atas = minimum strata berikutnya − 1, revisi 2026-10-08), strata teratas "… Rp 10.000.000 UP"; pembaca ambang tetap memakai angka pertama | Keputusan pengguna 2026-10-07: rentang tiap strata dicetak seperti bunyi surat (semua principal). Tiap strata bernilai di PDF menyebut batas atasnya bila surat menyebutnya; tier yang dipilih mesin tidak berubah |
| **K. Cut price (MTI) salah** | MTI balas `[]` / cut price tak jadi DISC_RP | prompt tanpa contoh konkret Cut Price ("aturan 4b") | contoh Cut Price di prompt parse (jangan dihapus); MTI trigger "Beli 1", benefit DISC_RP | MTI ada isinya; benefit_type = DISC_RP, trigger Beli 1 |

---

## 2. PROSEDUR VERIFIKASI PER SURAT BARU (urut)

1. **Diagnosa offline dulu** (hemat biaya): replay `python_backend/data/debug_ai.txt` (output OCR+LLM run
   terakhir, di-overwrite tiap run) melalui `_apply_native_kelompok` → `regroup_rows_by_tier` →
   (opsional) simulasi guard generate. Cek baris A–K di atas.
2. **Blast-radius check** tiap perubahan matching: bandingkan jumlah SKU & distribusi tier sebelum/sesudah.
3. **Run live** `test_e2e_live.py` (`$env:SUMOPOD_API_KEY=…`) — bukti determinisme (run2 0-API, 0-byte-diff)
   DAN regenerasi artefak nyata. LLM non-deterministik → hal yang tak muncul di replay bisa muncul live.
4. **Cek manual** `data/e2e_live_output/Dataset_Diskon.xlsx` + `Form_Summary.pdf` vs surat asli, lewati
   SEMUA baris A–K. Ground-truth = mata manusia atas output nyata.
5. **Commit** hanya setelah user setuju (branch baru; user jalankan git).

---

## 3. ATURAN YANG TAK BOLEH DILANGGAR (pelajaran mahal)

- JANGAN buat `regroup_rows_by_tier` merge lintas-brand / reorder (user menolak keras).
- JANGAN kosongkan `klist` All-Variant → fallback string-match = ledakan SKU (207→2866).
- JANGAN pakai placeholder "review manual" sebagai solusi data hilang — selesaikan akar matching.
- JANGAN edit `main.py` untuk logic summary (ada di `routers/summary.py`, refactor F10).
- JANGAN commit tanpa izin; JANGAN tulis/terima API key di chat.
- `max_tokens` SAJA untuk gpt-4.1-mini (jangan barengi `max_completion_tokens` → HTTP 400).

---

## 4. RIWAYAT REVISI (isi hanya saat user beri koreksi baru)

- **2026-07-15** — checklist dibuat dari 4 bug matching (A/B, C/D, F) + guard existing (E,G,H,I,J,K).
  Aturan domain dari user: SR=Series; Casablanca Spray Cologne Series = White SR + Black SR, GLASS excluded;
  matching = principle × internal (per-pecahan) × surat.
- **2026-09-11** — koreksi user atas Summary Kino September 2026 (4 surat): tambah baris **L** (Variant
  wajib "All Variant" bila surat tidak menyebut varian — "aturan yang sudah ku setting dari awal"),
  **M** (Detail barang ke Excel saja, bukan PDF), **N** (padanan merek disimpan di `principal_mapping`
  kind='brand', bukan diulang tiap surat: *Ovale 2 in 1 = Ovale Facial Lotion*, *Resik V cair = semua
  Resik V*), dan **O** (Gramasi dari master, bukan dari surat).
  Juga ditegaskan: **Summary ≠ detail yang dibariskan** — satu baris per KELOMPOK BARANG, tingkatan
  digabung ke satu baris (MSG 10 tingkat -> "Min. belanja Rp 1 jt s/d 10 jt UP"), dan kolom identik
  di-span di renderer sesuai aturan 2026-07-17.
  **Surat berlapis teks (Kino) TIDAK di-OCR**: `kino_letter.py` deterministik lebih dulu, Mistral hanya
  untuk surat hasil scan — OCR pada surat berteks hanya menambah biaya dan risiko salah baca.

- **2026-09-16** — uji dua surat (BP2609007664 + BP2609007713) di produksi. Tambah baris **P**:
  keputusan pengguna atas `RESIK V KHASIAT MANJAKANI` vs `RESIK V MANJAKANI WHITENING` — **"All Variant"
  berarti semua varian KECUALI yang sudah diklaim baris lain pada kelompok yang sama**. Berlaku untuk
  kasus serupa berikutnya, bukan hanya Resik V. Catatan: 13 aturan Excel BP2609007713 yang sudah ada
  MELANGGAR aturan ini (`RESIK V KHASIAT MANJAKANI` memuat 6 kode, termasuk 3 kode whitening yang juga
  dipegang baris `RESIK V MANJAKANI WHITENING`) — perlu dibetulkan jadi 3 kode.

- **2026-10-01** — uji empat surat Kino Oktober 2026 (BP2610008789, 009052, 009096, 009097). Koreksi pengguna:
  **"Eskulin Cologne Gel Rejuvenation" = seluruh kelompok `ESKULIN - COLOGNE`**. Ini relaunch "ECG DAY ..."
  menjadi "ESK CG <warna>", dan nama GEL lama yang masih ada di master tetap ikut. Pengguna juga meminta
  **semua kolom terisi otomatis** (surat, periode, kelompok, varian, gramasi, dll.). Diterapkan di
  `kino_letter.match_groups` + `ALIAS_KELOMPOK`. Dua bug ikut diperbaiki di `_apply_native_kelompok`:
  (1) varian master yang dipilih kini dicocokkan persis, karena dulu "GEL ENCHANTING" ikut menarik
  "ENCHANTING WHITE"; (2) kemasan baris kini mengikat saat Form dibuat, karena dulu Excel ELLIPS BLR memuat
  kode JAR padahal `promo_rule` tidak. Cek baru: **kode di Dataset Excel = kode di aturan promo, per surat**.

- **2026-10-07** — revisi pengguna atas Summary Kino Oktober 2026 (Form_Summary_Program (14).pdf), berlaku
  SEMUA principal sebagai acuan: tambah baris **Q** (satu frasa surat = satu baris; yang membedakan baris
  adalah ketentuan + benefit, beda kelompok di surat baru beda baris — `ELLIPS` dan `ELLIPS - H.VIT BALI`
  satu baris), **R** ("MIX VARIANT" = campur varian dalam GRAMASI YANG SAMA kecuali surat menyebut beda
  gramasi; aturan terbit dipecah per gramasi, ketentuan mix tanpa sebutan gramasi ditolak saat disusun),
  dan **S** (rentang minimal belanja dicetak dengan batas atasnya seperti bunyi surat: "Rp 1.000.000 s/d
  Rp 1.990.000", teratas "Rp 10.000.000 UP").
- **2026-10-08** — revisi baris **S**: batas atas tiap strata = **minimum strata berikutnya dikurangi satu**
  ("Rp 1.000.000 s/d Rp 1.999.999"), bukan angka "1.99 JT" tertulis. Angka surat meninggalkan celah
  (belanja Rp 1.992.000 tampak tak tercakup), sedangkan "di bawah Rp 2.000.000" membuat angka 2.000.000
  muncul di dua strata. Strata terakhir tetap "UP".
