# HANDOVER — Summary Promo Oktober 2026, lanjutan 17–19 Okt (ABC PI + revisi Fonterra)

**Status:** 10 principal punya Form Summary yang lulus gerbang. Kode mesin sampai 16 Okt **sudah di produksi** (#182 + #188, main `e23c7ed3`). Perubahan 17–19 Okt ada di **PR #196 — OPEN, CI hijau, peninjau APPROVE, JANGAN di-merge tanpa perintah pemilik** (merge ke main = deploy produksi).

Dokumen sebelumnya: `HANDOVER_SUMMARY_OKT26_2026-10-14.md` (§7–§8 = 14–16 Okt).

## 0. BACA DULU
1. **Serahan** (git-ignored): `tmp/summary_okt26_lengkap/<PRINCIPAL>/` — `Form_Summary_<P>.pdf`, `Dataset_Summary_<P>.xlsx`, `baris_summary_<P>.json` (masukan final), `CATATAN.md` (tafsiran + pertanyaan), `rows_resolved.json`. Principal: URC, PRISKILA, VINDA, GONDOWANGI, FONTERRA, DAHLIA, GUMINDO, MSM, PURATOS, **ABCPI**.
2. **Bangun ulang semua:** `bash tmp/summary_okt26_lengkap/skrip/bangun_semua_16okt.sh` (memakai kode worktree `.claude/worktrees/summary-okt26/python_backend`; untuk Fonterra/ABC PI pakai cabang `fix/summary-mix-merek` sampai #196 masuk main). Gerbang = `buat_summary.py` exit 0; lihat `hal-N.png`.
3. **Verifier Form:** `python tools/verify_form_summary.py --form <pdf> --master <xlsx> --rows python_backend/output/summary_manual/<file_id>_rows.json` (sidecar generator; cari berkas `_rows.json` terbaru dengan `principal` yang cocok).
4. Worktree `.claude/worktrees/summary-okt26` sedang di cabang `fix/summary-mix-merek` (bersih, sudah di-push).

## 1. PR #196 `fix/summary-mix-merek` (base main) — isinya
| Bagian | Perilaku |
|---|---|
| "Mix Merek/Mix Produk" | Ketentuan berisi `mix/campur/lintas/beda` + `merek/produk` (tanpa negasi dalam ±25 karakter) **tidak dipecah resolver per merek** → satu baris Form, satu ambang. `compile_programs` juga menyatukan baris bertanda yang datang sudah terpecah (kunci = sidik varian+gramasi; isu bila strata terbelah, beda benefit, atau dua baris surat dengan `source_quote` beda). |
| Aturan P | `_terapkan_all_variant_eksklusif` dikunci per kelompok master (sel "A & B" dipecah), jadi varian bernama tetap mencabut kode dari baris ALL VARIANT lintas merek. |
| Label sel | `label_kelompok` / `label_gramasi` (bidang draft baru di `BARIS_DRAFT`) mengganti TEKS sel Form saja; kode/Dataset/aturan tetap dari `kode_barangs`. Ikut kunci konsolidasi Form; dibuang dari pecahan bila baris tetap dipecah. Sidecar `label: true`; verifier melewati sel berlabel dan penanda `ALL KELOMPOK BARANG`. |
| Daftar outlet | Nama `<nomor surat>-<nama>` (mis. `F148SP-LSM`) diterima di `outlet_rule_of` dan validator `Program` — satu surat beberapa daftar. |

Bukti: uji baru di `test_summary_rules.py` (`check_mix_merek`), `test_all_variant_eksklusif.py`, `test_keterangan_merge.py`, `test_verify_form_summary.py` (tiap pengaman terbukti gagal bila dirusak); `run_checks` 67 lulus; verifier Fonterra 0 FAIL. Commit terakhir `71cb96f0`.

**Catatan rilis #196:** surat lain yang ketentuannya memuat "Mix Produk" (mis. URC "MIX PRODUK Piattos, Poppins & KING") ikut dihitung sekeranjang lintas merek begitu diterbitkan ulang — sesuai bunyi surat, tetapi berbeda dari sebelumnya.

## 2. ABC PI (17 Okt) — `tmp/summary_okt26_lengkap/ABCPI/`
- Surat **550/EXT/TM/SLS/X/2026** (salinan di `reference_surat_program/okt26/`), Program Strata Diskon Channel GT, Okt 2026, budget Rp 6.403.068, klaim paling lambat 10 Des 2026.
- Beverages (exc paperpack) = NU-* + KIN DAIRY (30 kode): 2-9 / 10-49 / 50-99 / 100 UP KRT = 1/2/3/5%, ketentuan "Mix Merek dan Variant, Beda Gramasi". Food (Bag) = NDB + NDB - GURIMI (22 kode): 20-49 / 50-149 / 150-499 / 500 UP = 1/2/3/5%.
- Form 8 baris / 1 halaman (dengan #196). Pembangun: `skrip/abcpi_build_rows.py`.
- **Pertanyaan pemilik (belum dijawab):** (1) SIAPI = status outlet (perlu daftar) atau status distributor? (2) strata kumulatif sebulan vs mesin per order; (3) paperpack = NU TEA 225ML "PO" (2 kode) benar dikecualikan? (4) Food (Bag) hanya mie bag (tanpa cup, mangkok, kecap)?

## 3. Revisi Fonterra (19 Okt) — `tmp/summary_okt26_lengkap/FONTERRA/`
42 → 21 baris tercetak, 2 halaman. Cadangan sebelum revisi: `baris_summary_FONTERRA_SEBELUM_19OKT.json`.
- GT Provision (6 RTG Rp 3.000) dan Hanger permanent (12/4/6 RTG) = satu baris lintas merek, gramasi dilabel unik "20GR, 22GR, 24GR & 25GR".
- Apotik 3%/5% = label "ALL KELOMPOK BARANG POWDER BOX, KECUALI SACHET" / "ALL GRAMASI, KECUALI SACHET (20GR, 22GR, 24GR & 25GR)", kode 47 BIB. "POWDER BOX" ditambahkan karena "semua kecuali sachet" di master juga memuat UHT, keju, Anlene Total 10 kaleng, polybag.
- MT F148SP: blok "PROMO MTI LSM" (stickpack/polybag + Anlene Gold 825GR — surat: hanya LSM) daftar `F148SP-LSM`; blok "PROMO MTI LMM & LSM" (sisanya) daftar `F148SP-LMM,F148SP-LSM`; keduanya Hanya List.

## 4. Menunggu pemilik
1. **Merge #196** (atas perintah). Sesudah merge: bangun ulang Fonterra & ABC PI dari main.
2. **Unggah daftar outlet**: `F148SP-LSM`, `F148SP-LMM` (MTI Fonterra) dan `F149SP` (peserta hanger/grosir SKP). Tanpa itu program "Hanya List" tidak berlaku untuk siapa pun (gagal tertutup).
3. **Fonterra hanger (pra-ada):** 4/6/12 RTG pada barang+daftar sama digabung sebagai SATU program bertingkat — beli 12 RTG hanya dapat Rp 25.000 (bukan + Rp 50.000 + Rp 10.000). Tanyakan apakah "tambahan" berarti dijumlah.
4. Pertanyaan ABC PI §2.
5. Dari 16 Okt: Vinda — pastikan "Disc. Strata Reguler" tidak ikut terpotong lagi saat aturan dimuat (Disc-1 menggantikannya); antrean Web Sales sebelum deploy sudah tidak relevan (#182/#188 sudah live).

## 5. Temuan terbuka
- `NEGASI_MEREK` bisa negasi palsu ("Mix Merek tidak kelipatan") — gagal tertutup, dibiarkan.
- Simulasi Summary (tanpa `rasio`) tidak menampilkan konversi lintas satuan; order nyata memakai rasio Accurate.
- Label sel belum punya kolom di grid UI Summary; draft yang disunting lewat layar bisa kehilangan label (cek perilaku grid sebelum mengandalkannya di produksi).
