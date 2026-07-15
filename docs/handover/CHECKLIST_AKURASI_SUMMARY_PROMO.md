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
> Terakhir diperbarui: 2026-07-15.

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
