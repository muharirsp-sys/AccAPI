# Selisih sebelum tombol Muat — uji dua surat, 16 Sep 2026

Dibuat sebelum `Muat` ditekan, sesuai permintaan: **perlihatkan dulu selisihnya.** Tombol Muat
TIDAK ditekan. Gerbang kirim faktur otomatis tetap tertutup.

Publikasi yang diuji: `d086d243-4e59-44d8-ade8-9cb76e4bffde` — `KINO NON FOOD - SEPTEMBER 2026`,
status `published`, revisi 6, 5 program, 28 kode barang.

---

## 1. Yang sudah ada di `promo_rule` untuk kedua surat

`promo_rule` = **234 baris, SEMUANYA `source` kosong** (tidak ada satu pun baris `source='surat'`).

| Surat | `promo_group` | Baris | Channel |
|---|---|---|---|
| BP2609007664 | OVALE 2IN1 CLEANSER | 17 | kosong (semua channel) |
| BP2609007713 | RESIK V KHASIAT MANJAKANI | 6 | kosong |
| BP2609007713 | RESIK V MANJAKANI WHITENING | 3 | kosong |
| BP2609007713 | RESIK V KHASIAT RAMUAN MADURA WHITENING | 3 | kosong |
| BP2609007713 | RESIK V GODOKAN SIRIH | 1 | kosong |
| | **Jumlah** | **30** | |

Semuanya: `BONUS_QTY 1`, beban `PRINCIPAL`, ambang `30 PCS`, `LOYALTY/INCLUDE`,
periode 2026-09-01 s/d 2026-09-30.

---

## 2. Yang akan DITULIS Muat

26 baris (28 kode − 2 kode hantu yang ditahan di
[from-summary/route.ts:271](../../app/api/promo-rule/from-summary/route.ts)), semuanya dengan:

| Kolom | Nilai |
|---|---|
| `source` | `surat` |
| `source_ref` | `d086d243-4e59-44d8-ade8-9cb76e4bffde` |
| `surat_program` | **`BP2609007664` — SEMUANYA, termasuk 10 kode Resik V** |
| `promo_group` | **`OVALE FACIAL LOTION` — SEMUANYA** |
| `channel` | `GT` |
| sisanya | 30 PCS / BONUS_QTY 1 / PRINCIPAL / LOYALTY INCLUDE / Sept 2026 |

## 3. Yang akan DIHAPUS Muat

**Nol baris.** Irisan yang dicabut adalah `source='surat' AND principal AND surat_program IN (...)`,
dan tidak ada satu pun baris `source='surat'` di produksi. 30 baris Excel di atas **tetap hidup**.

`promo_rule` menjadi **234 → 260**.

Kunci uniknya `(principal, surat_program, promo_group, item_code, customer_code, tier_no)` — karena
`promo_group` berbeda (`OVALE 2IN1 CLEANSER` vs `OVALE FACIAL LOTION`), tidak ada tabrakan, jadi
kedua aturan hidup berdampingan tanpa galat.

---

## 4. Selisih per kode barang

### OVALE — Excel 17 lawan Summary 16 (dari 18)

| Kode | Excel | Summary | Sesudah Muat |
|---|---|---|---|
| 16 kode `K13300010…`–`K13300060 10010` | ada | ada | **dua aturan hidup** |
| `K1330001010010B` (kode bonus `B>`) | ada | **tidak** | tetap satu (Excel) |
| `K1330006006010`, `K1330006020010` | tidak | ada, **ditolak** — tidak ada di master Accurate | tidak ada |

Jadi beda "18 lawan 17" yang dicatat handover terjawab: jalur Summary sebetulnya menghasilkan
**16** kode yang bisa dimuat — sama persis dengan 16 kode Excel non-bonus. Bedanya tinggal satu:
**kode bonus `K1330001010010B` tidak pernah dibawa jalur Summary**, karena master barang principle
tidak memuatnya.

### RESIK V — Excel 13 lawan Summary 10

| Kode | Excel | Summary | Sesudah Muat |
|---|---|---|---|
| `K1370000005010/9010/20010` (Manjakani polos) | 1× | 1× | 2 aturan |
| `K1370001005010/9010/20010` (Manjakani WHITENING) | **2×** (ikut grup KHASIAT MANJAKANI *dan* grup WHITENING) | 1× | **3 aturan** |
| `K1390001005010/9010/20010` (Ramuan Madura) | 1× | 1× | 2 aturan |
| `K1360001010010` (Godokan Sirih) | 1× | 1× | 2 aturan |

---

## 5. Empat akibat yang wajib dibaca sebelum Muat

1. **Muat MENAMBAH, bukan mengganti.** Handover menulis sebaliknya. Yang benar: ia hanya mencabut
   irisannya sendiri (`source='surat'`), dan irisan itu kosong. 30 baris Excel selamat.
2. **Pembatasan channel GT jadi tak berarti.** Baris Summary ber-`channel='GT'`, tetapi baris Excel
   ber-`channel=''` tetap hidup dan berlaku di channel mana pun — termasuk MT. Yang longgar menang.
3. **`BP2609007713` HILANG dari `promo_rule`.** Seluruh 10 kode Resik V tercatat sebagai milik surat
   `BP2609007664`, kelompok `OVALE FACIAL LOTION`. Akibat lanjutannya: memuat Summary yang hanya
   berisi `BP2609007664` di kemudian hari akan **mencabut aturan Resik V**, karena irisannya dikunci
   per principal + nomor surat.
4. **Varian whitening dapat tiga aturan.** Dua di antaranya dari data Excel yang sudah ada, yang
   melanggar aturan **P** yang baru diputuskan (lihat `CHECKLIST_AKURASI_SUMMARY_PROMO.md`).

### Akar nomor 3

`PublishedLetter` hanya punya SATU `suratProgram` dan SATU `promoGroup`
([lib/summary-bridge.ts:66-70](../../lib/summary-bridge.ts)), diambil dari **baris pertama**
publikasi (`letterOf`, [from-summary/route.ts:107-111](../../app/api/promo-rule/from-summary/route.ts)),
lalu dipasang ke SETIAP baris (`bridgeRows`, summary-bridge.ts:223 & 226). Bentuk itu sah ketika satu
publikasi = satu surat. Keputusan #74 (satu Summary menumpuk banyak surat per principal + bulan)
membuatnya tidak sah lagi, dan jembatannya tidak pernah ikut diubah.

Terbukti di produksi: `GET /api/promo-rule/from-summary?simulate=d086d243…` menjawab
`suratProgram: "BP2609007664"` dengan **satu** grup `promoGroup: "OVALE FACIAL LOTION"` berisi
seluruh 28 kode. Layar simulasi juga menyebutnya: *"28 — 1 bentuk berbeda"*.

Perbaikan yang sesuai bentuk datanya: pindahkan `suratProgram` dan `promoGroup` dari
`PublishedLetter` ke `SummaryProgram` (per program), dan susun `suratDimuat` dari nilai per-baris
yang sudah ada di `content.rows[*].surat_program`.

---

## 6. Tiga cacat lain yang ditemukan sepanjang uji ini

| # | Cacat | Bukti |
|---|---|---|
| 12 | **Simpan dengan `kelompok` kosong meledakkan draft ke SELURUH katalog.** `_apply_native_kelompok` memakai `pool = master_items` bila kelompok kosong, dan juga bila kelompoknya tidak ada di master ([shared.py:4640-4646](../../python_backend/shared.py)) — lalu memecah baris itu jadi satu baris per kelompok, masing-masing dengan kode barang nyata. `issues` jadi KOSONG, sehingga draftnya terlihat sah dan bisa diterbitkan. Gagal TERBUKA, sekeluarga dengan #5. | Draft `ef42a12a` berubah **7 baris → 607 baris** hanya karena disimpan ulang untuk mengganti judulnya. Keadaan "kelompok kosong" itu persis keadaan tiap baris SESUDAH Ekstrak |
| 13 | **Pemilih Varian tidak bisa menyatakan "varian kosong".** Untuk kelompok `RESIK V MANJAKANI` layar hanya menawarkan `ALL VARIANT` dan `WHITENING`; tiga barang yang variannya kosong tidak bisa dipilih sendiri | Diuji langsung; jalan keluarnya untuk sekarang mengisi `kode_barangs` lewat API |
| 14 | **Kolom `Syarat Claim` kosong di SETIAP baris Form Summary**, padahal kolomnya dicetak | Form Summary `2f54b6b9…` |

Dua hal kecil: daftar "Tarik dari Summary" menampilkan **`tanpa nomor`** dan periode `—` untuk
publikasi yang nomor suratnya jelas ada (pembaca daftar masih membaca `review_detail`, bukan `rows`),
dan blok tanda tangan Form Summary tumpah sendirian ke halaman 2.

---

## 7. Keadaan yang ditinggalkan

| | |
|---|---|
| `promo_rule` | **234 baris — TIDAK BERUBAH.** Muat tidak ditekan |
| Publikasi | `d086d243…` `published` rev 6, 5 program, 28 kode |
| Draft tercemar `ef42a12a` | judulnya diganti jadi `ARSIP UJI 16 Sep - tercemar BP2609007664 dua kali, jangan dipakai`; isinya ikut meledak jadi 607 baris (cacat #12) |
| Gerbang Muat | masih menuntut catatan + unggahan surat bertanda tangan + pernyataan "Program ini sudah benar" |
| Gerbang kirim faktur otomatis | **TETAP TERTUTUP** |

---

## 8. Jembatan multi-surat SUDAH DIPERBAIKI (belum di-deploy)

Nomor surat dan kelompok pindah dari tingkat PUBLIKASI ke tingkat PROGRAM.

| Berkas | Perubahan |
|---|---|
| `python_backend/summary_rules.py` | `Program` dapat bidang `surat_program` + `kelompok`; `compile_programs` mengisinya dari barisnya sendiri, dan **nomor surat ikut jadi kunci pengelompokan** supaya dua surat tidak pernah melebur jadi satu program |
| `lib/summary-bridge.ts` | tiap program memakai asalnya sendiri, mundur ke nilai publikasi bila kosong; program tanpa nomor surat ditolak SENDIRIAN, bukan menjatuhkan seluruh publikasi; `outletLists` dikembalikan supaya daftar outlet dibuat satu per surat |
| `app/api/promo-rule/from-summary/route.ts` | `promo_outlet` ditulis per nama daftar yang benar-benar ditunjuk aturannya; tanggapan menyebut semua surat yang dimuat |
| `lib/summary-simulation.ts` | `suratProgram` = semua surat yang benar-benar akan ditulis |
| `python_backend/routers/summary_review.py` | daftar "Tarik dari Summary" membaca nomor surat & periode dari program/baris, bukan hanya `review_detail` — "tanpa nomor" dan "—" hilang |

`suratDimuat` dan irisan yang dicabut sudah disusun dari nilai per-baris, jadi keduanya otomatis
mencakup kedua surat tanpa diubah.

Uji: `python_backend/test_summary_rules.py` (8/8) dan `npx tsx --test lib/summary-bridge.test.ts`
(15/15, 4 di antaranya baru) — termasuk kasus publikasi beku yang programnya belum punya asal
sendiri, yang harus tetap terbaca seperti dulu.

**Publikasi `d086d243…` harus diterbitkan ulang sesudah deploy.** Ia beku dengan bentuk lama, jadi
Muat atasnya akan tetap menaruh semuanya di bawah `BP2609007664`.

