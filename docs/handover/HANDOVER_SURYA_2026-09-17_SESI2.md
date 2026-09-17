# Handover — dari pohon kerja ke PR, dan jawaban atas satu pertanyaan mahal (17 Sep 2026, sesi 2)

Lanjutan `HANDOVER_SURYA_MATCHER_2026-09-17.md`. Baca itu dulu untuk latar belakangnya.

---

## Satu kalimat

Seluruh pekerjaan yang menggantung sudah di-commit dan dikirim sebagai
[PR #79](https://github.com/muharirsp-sys/AccAPI/pull/79); di sepanjang jalan gerbangnya sendiri
ternyata bohong — **59 uji melapor "OK" tanpa menjalankan satu assert pun** — dan uji ujung-ke-ujung
lima surat Kino September menemukan bahwa **aturan "All Variant" belum pernah ditegakkan**, yang
membuat barang whitening mendapat bonus dua kali dari satu surat yang sama.

---

## Jawaban untuk pertanyaan "kalau saya tembus ke promo_rule, aman?"

**Sebelum sesi ini: TIDAK AMAN.** Sesudah sesi ini: aman untuk `BP2609007664` dan `BP2609007713`,
dengan dua syarat yang harus dikerjakan lebih dulu (lihat "Syarat" di bawah).

Sebabnya bukan tebakan. Kelima surat dijalankan lewat rantai yang sebenarnya
(`python_backend/e2e_kino_sept.py`): baca → satu Summary → pilih kelompok → simpan →
`compile_programs` — gerbang yang **sama persis** dengan yang dipakai tombol Muat. Tidak satu baris
pun ditulis ke `promo_rule`.

### Apa yang ditemukan, dan kenapa itu mahal

Sebelum perbaikan, `BP2609007713` menghasilkan:

| Baris surat | Kelompok master | Kode |
|---|---|---|
| RESIK V KHASIAT MANJAKANI (ALL VARIANT) | RESIK V MANJAKANI | **6** — termasuk 3 kode whitening |
| RESIK V MANJAKANI WHITENING | RESIK V MANJAKANI | 3 — **kode yang sama** |

Tiga kode whitening dipegang DUA baris, jadi barang whitening mendapat **bonus dua kali** dari satu
surat. Checklist sudah menulis aturannya sebagai keputusan pengguna 16 September 2026 dan
menandainya **"BELUM ADA"**; sekarang ia ada (`shared._terapkan_all_variant_eksklusif`, dikunci
`test_all_variant_eksklusif.py`). Sesudahnya baris umum tinggal 3 kode non-whitening, dan tidak ada
satu kode pun muncul di dua baris.

Catatan penting: **13 aturan Excel `BP2609007713` yang hidup di produksi HARI INI masih
melanggarnya.** Aturan baru dari jalur Summary sudah benar; yang lama belum, dan Muat TIDAK
mencabutnya (lihat `SELISIH_MUAT_SUMMARY_2026-09-16.md` butir 1).

### Hasil akhir kelima surat

| Surat | Hasil | Keterangan |
|---|---|---|
| `BP2609007664` OVALE 2IN1 CLEANSER | ✅ **1 program, 18 kode** | `OVALE FACIAL LOTION`, 2026-09-01..30, GT, LOYALTY only, 30 PCS → bonus 1 PCS. Cocok dengan yang hidup di produksi |
| `BP2609007713` RESIK V (4 program) | ✅ **4 program, 10 kode** | MANJAKANI 3 + MANJAKANI WHITENING 3 + RAMUAN MADURA 3 + GODOKAN 1. Sama persis dengan "Summary 10" di `SELISIH_MUAT` |
| `BP2609007909` MTI CONSUMER PROMO ON PO | ✅ **DITOLAK, dan itu BENAR** | "Mekanisme Promo 'ADDITIONAL DISCOUNT' bukan on faktur; surat ini tidak boleh menjadi aturan order." Juga: "Surat punya 2 halaman lampiran yang TIDAK ikut dibaca" |
| `BP2609006016` MSG ALL BRAND | 🟡 10 baris, ditahan | Perlu keputusan: kelompok mana yang dicakup "HOME PERSONAL CARE"? Ini program tingkat NOTA (`DISC_RP`, Rp 1jt→20rb … Rp 10jt→200rb) |
| `BP2609008021` SMALL PACKAGE | 🟡 1 baris, ditahan | Perlu keputusan: daftar barang "small package"-nya mana? Suratnya merujuk kategori, bukan kelompok master |

Yang ditahan **ditahan dengan sebabnya** ("Baris N: kode barang belum dipilih"), bukan diloloskan
diam-diam. Itu perilaku yang benar.

### Syarat sebelum Muat ditekan

1. **Master Kino di mesin/produksi harus yang lengkap.** Master di mesin ini hanya memuat **113
   dari 606 barang**: `loop_master_builder` menyusunnya dari sheet `Form Fix`, yang 572 barisnya
   tidak punya `Nama KLP`, dan `_parse_master_barang_xlsx` MEMBUANG baris tanpa kelompok. Akibatnya
   master Kino tidak memuat RESIK V maupun OVALE sama sekali, dan surat September pulang tanpa satu
   kode pun — jalur Summary terlihat rusak padahal yang kurang datanya.
   Perbaikannya: `python python_backend/build_master_fixmapping.py "<workbook>"`, yang membaca sheet
   `Fix Mapping` (606 barang, 606 punya kelompok, kurasi manusia, dan kodenya cocok dengan yang
   sudah hidup di `promo_rule` produksi). **Pastikan master yang dipakai produksi juga yang ini.**
2. **Publikasi `d086d243…` harus diterbitkan ulang sesudah deploy.** Ia beku dengan bentuk LAMA
   (satu nomor surat untuk seluruh publikasi), jadi Muat atasnya akan tetap menaruh semua Resik V
   di bawah `BP2609007664`. Perbaikan jembatan multi-surat sudah ada tetapi publikasinya belum ikut.

Sesudah dua syarat itu, memuat `BP2609007664` + `BP2609007713` menambah aturan yang benar. Yang
tetap perlu diputuskan pengguna: **30 baris Excel lama tidak ikut tercabut**, jadi untuk sementara
akan ada dua set aturan hidup berdampingan — dan yang lama ber-`channel` kosong, artinya berlaku di
MT juga.

---

## Gerbangnya sendiri ternyata bohong

Ini temuan terpenting sesi ini, dan ia tidak dicari — ia muncul karena gerbangnya akhirnya
dijalankan di tempat lain.

### 1. Klona bersih: empat uji mati

Gerbangnya hijau di mesin ini dan **merah di klona bersih**: `test_e2e_live`, `test_urc_matcher`,
`test_urc_pipeline`, dan `test_generic_promo_matcher` menuntut master principal `*.xlsx` dan surat
asli yang SENGAJA tidak ikut git. Gerbang yang hanya hijau di satu mesin bukan gerbang.

Sekarang keempatnya **melewat dengan menyebut berkas yang kurang**, bukan mati dengan
`FileNotFoundError` — dan `run_checks.py` **menghitung yang melewat di ringkasannya**
("34 lulus, 4 MELEWAT: …"), supaya lewat tidak pernah bisa menyamar sebagai lulus.

### 2. 59 uji melapor "OK" tanpa menjalankan satu assert pun

CI menolak PR ini dengan `ModuleNotFoundError: No module named 'pytest'`, dan di balik galat itu
ada hal yang jauh lebih besar.

Berkas bergaya pytest — hanya `def test_*()`, tanpa `if __name__ == "__main__"` — **tidak
menjalankan apa pun** bila dipanggil `python berkas.py`. Python mengimpornya, mendefinisikan
fungsinya, lalu keluar dengan kode 0. Gerbangnya membaca 0 itu sebagai "OK".

**Sepuluh berkas berbentuk begitu**, dan ringkasan "38/38 self-check Python lulus" yang dilaporkan
sepanjang sesi kemarin diam-diam memuat 59 uji yang tidak dijalankan satu pun:

```
test_append_rows (1)        test_baca_surat_rapi (7)     test_draft_resolve_kode (6)
test_excel_trigger_qty (3)  test_label_periode (3)       test_principles_registry (2)
test_priskila_golden (4)    test_priskila_matcher (21)   test_priskila_pipeline (7)
test_urc_benefit_parser (5)
```

Termasuk `test_draft_resolve_kode` dan `test_priskila_golden` — dua uji yang JUSTRU ditulis untuk
mengunci cacat "kelompok kosong mencocok seluruh katalog". Mereka mengunci pintu yang tidak pernah
mereka datangi.

`run_checks.py` sekarang memilih cara memanggil per berkas, dan bila pytest tidak terpasang ia
GAGAL dengan sebabnya, bukan lulus diam-diam. **Dibuktikan bukan dipercaya**: satu assert dirusak
sengaja di `test_draft_resolve_kode`, dan gerbangnya berubah merah — sesuatu yang mustahil terjadi
sebelum ini.

---

## Yang dikirim di PR #79

| Commit | |
|---|---|
| `66483ac` | Matcher deterministik Juli akhirnya sampai (25 berkas + dua golden + `.gitignore`) |
| `304a37a` | Delapan cacat yang tak pernah bersuara, termasuk Excel corrupt sejak Juli |
| `857e5de` | CI menjalankan uji — pada PR dan sebelum deploy, langkah yang sama |
| `2a7ae3e` | Uji yang menuntut berkas di luar git MELEWAT dengan sebabnya, dan lewat dihitung |
| `d4abd49` | **Master Barang** dibawa dari cabang Juli, dan akhirnya DISAMBUNG |
| `318d5d0` | 59 uji yang melapor OK tanpa menjalankan apa pun |
| `514aab3` | `periode` dibaca dari kop surat, bukan dari tenggat klaim; draft Priskila dapat tanggalnya |
| `d38b9c7` | Aturan P ditegakkan — "ALL VARIANT" berhenti menelan varian milik baris lain |
| `aaefdee` | Panduan `ALUR_FAKTUR_PRINCIPAL.pdf` untuk meeting/training |

### Master Barang tidak pernah tersambung di cabang Juli

Ia mendaftarkan `master_barang` di `lib/rbac/registry.ts` saja, lalu berhenti: `lib/rbac.ts` tidak
mengenal modulnya, `/master-barang` tidak punya entri penjaga path, katalog navigasi tidak
memuatnya, `routers/master_barang.py` tidak pernah di-`include_router`, dan tabelnya tidak ada di
`db/schema.ts`. Layar yang tidak bisa dibuka adalah modul yang tidak ada. Semua itu disambung, plus
migrasi `0019_master_barang.sql`.

**Izin sengaja tidak dilebarkan**: hanya `admin` (lewat `allPermissions()`). Melebarkan akses
keputusan pengguna, bukan efek samping sebuah impor.

### periode: tiga lapis, dan lapisan terakhir yang menentukan

Blok MTI/Grosir/Star tidak mengulang periodenya, dan model mengisinya dari kalimat **batas klaim**:
satu surat Maret 2026 pulang dengan lima baris ber-`periode` "September" dan satu "31 Juni 2026" —
tanggal yang bahkan tidak ada di kalender.

1. Perintah "salin saja" dipertajam (periode dari KOP, kalimat "paling lambat …" milik `syarat_claim`).
2. `periode_surat.py` menerjemahkan teks yang SUDAH disalin jadi YYYY-MM-DD, dan **menolak** alih-alih
   menebak: "31 Juni 2026" ditolak karena 31 Juni bukan tanggal dan TIDAK digeser ke 30 Juni;
   "paling lambat tanggal 31 September 2026" ditolak karena angka hari di depan nama bulan
   membatalkan pembacaan "bulan penuh" — tanpa itu kalimat klaim lolos jadi September utuh.
3. `_satukan_periode` menegakkan **satu surat = satu periode**. Bila tidak ada satu baris pun yang
   terbaca, seluruhnya dibiarkan tanpa tanggal dan `compile_programs` menahannya — menebak akan
   menerbitkan aturan untuk bulan yang tidak pernah disebut surat.

Dengan `periode_start`/`periode_end`, draft Priskila **sekarang bisa** jadi `promo_rule`.

---

## Gerbang

| | Mesin pengembang | Klona bersih (= CI) |
|---|---|---|
| self-check Python | **41/41 lulus** | 37 lulus, 4 melewat dengan sebabnya |
| uji TypeScript | **277/277 lulus** | sama |
| `tsc --noEmit` | bersih | bersih |
| pyflakes nama tak terdefinisi | bersih | bersih |

---

## Yang MASIH menggantung

1. **Gerbang kirim faktur otomatis TETAP TERTUTUP.** Tidak disentuh sesi ini.
2. **`BP2609006016` dan `BP2609008021` butuh keputusan pengguna** — kelompok mana yang dicakup
   "HOME PERSONAL CARE", dan barang mana yang termasuk "small package".
3. **234 aturan produksi ber-`channel` kosong** — berlaku di MT juga. Aturan baru sudah benar.
4. **13 aturan Excel `BP2609007713` di produksi melanggar aturan P.** Aturan baru sudah benar;
   yang lama perlu dibetulkan atau dicabut secara sadar.
5. **Dua master Priskila berbeda di mesin ini** (259 barang tanpa tanda hubung vs 274 berpola
   `BRAND - JENIS`). Mana yang dipakai produksi perlu diputuskan.
6. **Publikasi `d086d243…` harus diterbitkan ulang** sesudah deploy (bentuk lama).
7. **`loop_master_builder` menghasilkan master tidak lengkap untuk principal lain juga** —
   Kino baru ketahuan karena diuji. Perlu disapu untuk 25 master di `data/rebuild_master/`.
8. **Uji e2e Kino (`e2e_kino_sept.py`) bukan bagian gerbang CI** — ia menuntut surat asli dan kunci
   API. Dijalankan tangan sebelum meeting, bukan tiap PR.

---

## Prompt melanjutkan

> Lanjutkan pekerjaan Surya di `D:\AccAPI\_github_clean`, branch `feat/surya-workspace`. Baca
> `docs/handover/HANDOVER_SURYA_2026-09-17_SESI2.md` lalu `HANDOVER_SURYA_MATCHER_2026-09-17.md`.
> PR #79 sudah di-merge ke main. Pekerjaan berikutnya: (1) sapu `loop_master_builder` untuk 25
> master di `data/rebuild_master/` — Kino hanya memuat 113 dari 606 barang dan principal lain
> belum diperiksa; (2) putuskan cakupan `BP2609006016` (HOME PERSONAL CARE) dan `BP2609008021`
> (small package) bersama pengguna; (3) 13 aturan Excel `BP2609007713` di produksi melanggar
> aturan P — dibetulkan atau dicabut secara sadar; (4) terbitkan ulang publikasi `d086d243…`
> sesudah deploy. Gerbang kirim faktur otomatis TETAP TERTUTUP.
