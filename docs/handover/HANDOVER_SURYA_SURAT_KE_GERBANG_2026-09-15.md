# Handover — dari surat program sampai gerbang faktur (15 September 2026, sesi kedua)

Penerus: baca berkas ini lebih dulu, lalu `docs/CHECKLIST_ALUR_FAKTUR_PRINCIPLE.md` dan
`docs/handover/HANDOVER_SURYA_TARIF_2026-09-15.md` (sesi sebelumnya). Semua yang di sini
**sudah di `main` dan sudah berjalan di produksi**, kecuali yang disebut di bagian terakhir.

---

## Satu kalimat

Rantai dari surat program sampai gerbang yang menahan faktur kini utuh — surat diunggah,
dibaca (OCR bila hasil scan), dikoreksi, diterbitkan, lalu menjadi aturan yang benar-benar
menahan — dan tiga lubang uang yang selama ini terbuka sudah ditutup: ambang MSG, bonus tanpa
pembelian, dan order ganda.

## Rantainya sekarang

```
surat PDF ──► Mistral OCR 4.1 (kalau scan) ──► baris draft ──► KOREKSI MANUSIA ──► terbit
          └─► lapisan teks (kalau ada) ──────┘                                      │
                                                                                    ▼
                        promo_outlet ◄── lampiran daftar outlet          promo_rule (jembatan)
                              │                                                     │
                              └──────────────► GERBANG VALIDASI ◄──────────────────┘
                                               + Rekap Promo
```

---

## Yang berubah, dan kenapa

### 1. Ambang MSG dibaca dengan PPN (`a6af274`)

Surat MSG menulis "MINIMAL TRANSAKSI 1JT–1.99JT POTONGAN ON FAKTUR 20.000" — nilai yang
**dibayar outlet**. Kode membandingkannya dengan DPP, lalu menjatuhkan faktur ke tier di
bawahnya dan menuduh klaim yang benar.

Dibuktikan atas 15 faktur September: tier yang benar-benar diberi Kino cocok **15/15** dengan
ambang termasuk PPN, hanya 10/15 dengan DPP. Lima faktur yang tertuduh: TK. SAWI 12, TK. ASMA,
NOVA COSMETIK, APOTEK HUSADA FARMA, TRIPLE M.

### 2. Baris bonus 100% dikenali (`a6af274`)

`BP2609007713` (Resik V) dan `BP2609007664` (Ovale) bermekanisme **BONUS BARANG ON FAKTUR**.
Faktur mencatatnya sebagai baris tambahan berdiskon 100% **di posisi 1** (kolom distributor),
jadi tidak ada pencocokan persen yang bisa menemukannya — ke-30 aturannya tidak pernah
menjelaskan apa pun. `matchBonusRule` membacanya dan mengakuinya sebagai klaim principal sesuai
bunyi suratnya, meski 100%-nya duduk di posisi distributor.

### 3. Daftar outlet peserta (`f9d11d1`, migrasi `0014`)

Surat menyebut PESERTA, dan menyebutnya **dua arah**:

| Surat | Bunyi | Yang dipasang |
|---|---|---|
| BP2609007713 Resik V | "KHUSUS CHANNEL GT **PESERTA** LOYALTY" | INCLUDE (13 aturan) |
| BP2609007664 Ovale | "KHUSUS CHANNEL GT **PESERTA** LOYALTY" | INCLUDE (17 aturan) |
| BP2609006016 MSG | "KHUSUS CHANNEL GT **EXCLUDE** LOYALTY" | EXCLUDE (10 aturan) |

Aturan **menunjuk** daftar, tidak menyalin isinya: satu daftar dipakai tiga surat, dan
menyalinnya berarti 41 outlet × 3 surat yang harus berubah bersamaan tiap kuartal.

**Periode melekat pada ANGGOTA, bukan pada nama daftar.** Keanggotaan loyalty berganti tiap
kuartal sementara suratnya menyebut "LOYALTY" begitu saja; kalau kuartalnya ikut ke nama
daftar, seluruh aturan harus ditunjuk ulang tiap tiga bulan — pekerjaan yang pasti terlupakan
sekali, dan sekali itu cukup.

**Gagal tertutup**: nama daftar yang salah ketik membuat aturannya tidak berlaku untuk siapa
pun, bukan berlaku untuk semua orang.

Di produksi: daftar `LOYALTY` berisi **41 outlet** (SILVER 27, GOLD 10, PLATINUM 4), periode
1 Jul – 30 Sep 2026. 38 diterjemahkan lewat `principal_mapping`; **tiga sisanya** —
`C-KOS005`, `C-KA0059`, `C-LO0019` — dimasukkan dengan kode internal karena CUST_ID2-nya belum
ada di `principal_mapping`. **Itu lubang yang masih terbuka: perbaiki di Mapping Principal**,
karena order dari ketiga toko itu juga tidak akan terbaca jalur batch.

### 4. Lampiran surat dibaca langsung (`cff069b`, `91ab896`, `f807436`, migrasi `0015`)

`BP2609007909` bertuliskan "LIST OUTLET TERLAMPIR", dan lampirannya memuat 300-an outlet
seluruh distributor nasional — dua di antaranya milik kita (`5191202075409` BAJI PAMAI,
`5191202076135` WANG MART di bawah KODE DIST `1201671`).

**Surat hasil scan dibaca Mistral OCR 4.1**, mesin yang sama dengan Summary Promo di produksi.
Delapan dari tiga puluh surat September memang scan murni. Disiplinnya sengaja disamakan dengan
`python_backend/summary_mistral.py` dan ditulis di kepala `lib/promo-letter-ocr.ts`: satu
panggilan per halaman, PDF dipecah lokal, nomor halaman dari permintaan kita bukan dari model,
dokumen dinyatakan UNTRUSTED, hasil parsial ditolak seluruhnya.

**Empat cacat yang hanya muncul di dokumen sungguhan** (ditemukan saat uji hidup, bukan tes unit):

1. pdf.js **mengambil alih buffer** yang diberikan padanya; sesudahnya OCR menerima berkas nol
   byte dan melapor "PDF rusak" — dan itu hanya terjadi pada surat scan, satu-satunya yang butuh OCR.
2. Mistral mengeluarkan tabel sebagai berkas terpisah dengan penanda `[tbl-0.md]`; pada surat
   URC **kop suratnya sendiri ada di dalam tabel**, jadi halaman satu terbaca nyaris kosong.
3. Label kop di-escape dua kali, sehingga polanya menuntut backslash sungguhan.
4. Akhiran cabang dianggap selalu `-KN`; `C-BRI002` di produksi hanya ada sebagai `C-BRI002-M2`.

Hasil uji hidup yang tersimpan: surat Priskila (scan murni) terbaca utuh dengan **nol baris
outlet** — dan itu jawaban yang benar, suratnya memang merujuk lampiran Excel terpisah. Surat
URC terbaca tepat: `C-BRI002` dan `C-ZEL790` dengan `kode_dist SUR030`.

Hasil OCR disimpan berkunci **hash isi berkas** (migrasi `0015`): OCR dibayar per halaman, dan
pesan galat kita sendiri menyuruh orang mencoba lagi dengan kode distributor yang dibetulkan.

### 5. Jembatan Summary → promo_rule (`ce10359`, migrasi `0016`)

Empat keputusan struktur, dan ini yang paling penting untuk dipahami penerus:

1. **Sumbernya PUBLIKASI, bukan draft.** Menerbitkan adalah satu-satunya tempat manusia
   menyatakan "saya sudah memeriksa ini", dan `publish_detail` sudah menolak yang belum lengkap
   lewat `readiness()`.
2. **Satu pemilik per tabel.** Next yang menulis `promo_rule`; Python tetap pemilik paket
   Summary. Kalau Python ikut menulis, bentuk barisnya hidup di dua bahasa.
3. **Server yang mengambil, bukan peramban.** Peramban hanya mengirim ID publikasi. Kalau ISI
   aturan datang dari peramban, gerbang "sudah diterbitkan" bisa dilewati.
4. **Tiap penulis hanya menyentuh irisannya sendiri** (`promo_rule.source`):

| `source` | Penulis | Ganti apa |
|---|---|---|
| `surat` | jembatan | baris milik **publikasi itu** (`source_ref`) |
| `excel` | impor sheet `Detail` | baris `excel` + baris lama tak bertanda |
| `tarif` | impor `Discount Reguler` | tarif outlet |
| `manual` | layar Aturan Promo | tidak pernah dihapus impor |

Tanpa ini, impor Excel akan menghapus aturan dari jembatan — dan **yang hilang tidak terlihat
sebagai galat**: gerbang cuma berhenti menahan.

`source_ref` = **id publikasi**, bukan nomor surat: satu surat punya banyak detail yang
diterbitkan sendiri-sendiri.

**Yang ditolak jembatan, beserta sebabnya** (rafaksi, dasar netto, ambang se-order, rantai
beberapa persen dalam satu strata, dua kelas outlet, barang di luar master). `Program` lebih
kaya daripada `promo_rule`; yang tidak bisa dinyatakan utuh **tidak dimuat separuh**.

### 6. Kuota bonus (`9ebb59f`)

Baris bonus adalah baris **tersendiri** berharga penuh lalu dipotong 100%; jumlah **belinya**
ada di baris lain. Memeriksa baris bonus sendirian sama saja tidak memeriksa apa pun — itulah
lubang yang membuat "beli 10 pcs dapat bonus 1 pcs" bisa lewat.

`bonusQuota()` menghitungnya **per faktur/SO** dan **per kelompok mix**, karena suratnya
berkata begitu: "SETIAP PEMBELIAN 30 PCS ... **MIX VARIANT**".

**Satuan diseragamkan ke satuan terkecil.** INV/2609/KN00453 beli 12 KRT isi 72 dan bonus 28
BTL pada barang yang sama; tanpa penyeragaman, 12 dibandingkan dengan ambang 30. Rekap memakai
`quantityDefault` milik Accurate; gerbang memakai `reportQty`.

Diadu dengan angka nyata: kelompok MANJAKANI beli 972 berhak 32 diberi 31 → lolos; kelompok
WHITENING beli 252 berhak 8 diberi 8 → lolos pas. **Penegakan ini tidak menahan satu pun bonus
yang sah pada data yang ada.**

### 7. Gerbang order ganda (`21e7992`, migrasi `0017`)

Order ganda yang identik masih mungkin ketahuan mata. Yang berbahaya yang **hampir** sama.

| Jalur | Titik | Perilaku |
|---|---|---|
| Order Principal | `api/principal-order/validate` | SO ditahan `review` |
| Order Sales | `POST /orders` | ditolak 409 |
| Order Masuk | pull Web Sales | `failed`, permintaan tetap `pending` |

**Containment, bukan Jaccard**: 3 barang di dalam 10 barang punya Jaccard 0,3 — terlihat tidak
mirip — padahal itu bentuk ketikan ulang paling khas. Ambang 0,5, dan parameternya bisa digeser.

**Jendelanya tanggal yang sama**, bukan tujuh hari: menahan pesanan rutin akan membuat
konfirmasinya ditekan tanpa dibaca. Jalur Python mempersempit lagi per channel.

**Diperiksa SETELAH ordernya terbukti sah**: order tidak valid ditolak karena tidak valid.

`lib/order-duplicate.ts` dan `python_backend/order_duplicate.py` **kembaran**, dikunci contoh
angka yang sama persis di kedua berkas ujinya.

---

## Dampak yang diukur atas 149 faktur September produksi

| | Sebelum | Sesudah |
|---|---:|---:|
| Tak bertuan | Rp 11.119.680 | **Rp 8.293.906** |
| Per Program | 1 program | **5 program** |
| MSG | 9 faktur, Rp 288.297 | **14 faktur, Rp 504.518** |

Sisa Rp 8.293.906 **disengaja**:

- **Rp 8.126.620** Indomaret — Kino memotong 3,1% di posisi 2, tarif termuat 3%. Ditahan atas
  keputusan pengguna sampai ada konfirmasi Kino. **Ini butir terbuka terbesar.**
- **Rp 125.553** TOKO SUKA MURAH MAMBO — klaim MSG-nya kurang Rp 636 dari tier 7. Temuan asli.
- **Rp 41.732** klaim 3% yang posisinya mampat pada faktur pra-perbaikan `e2bc57e`.

---

## Keadaan produksi saat ditutup

- Migrasi **0014, 0015, 0016, 0017 sudah dijalankan** dan diverifikasi.
- `promo_rule`: 234 baris, seluruhnya `source=''` (baris lama). 40 di antaranya menunjuk daftar
  `LOYALTY` (30 INCLUDE, 10 EXCLUDE).
- `promo_outlet`: daftar `LOYALTY`, 41 outlet.
- **Gerbang kirim faktur otomatis TETAP TERTUTUP.** Faktur hanya naik lewat tombol.
- `MISTRAL_API_KEY` ada di kedua container.

**Catatan keamanan:** kunci Mistral produksi ada di `D:\AccAPI\_github_clean\.env.local` mesin
pengembang (atas izin pengguna, untuk uji hidup OCR). Tidak ikut git. Hapus kalau tidak dipakai lagi.

---

## Yang MASIH menggantung — kerjakan dari sini

1. ~~**Tombol konfirmasi order ganda di layar Order Principal.**~~ **SELESAI 15 Sep sesi
   lanjutan** (`bc0f34b`, PR #63). Lihat bagian *Sesi lanjutan* di bawah.
2. **Daftar `BP2609007909` belum dimuat di produksi.** Sengaja disisakan supaya pengguna
   mengunggah suratnya sendiri lewat Aturan Promo → Daftar outlet peserta → Unggah surat.
   Sampai itu dilakukan, 105 aturan 3% B&B masih berlaku untuk **semua** outlet.
   **Diperiksa 15 Sep:** kedua outlet lampirannya SUDAH ada di `principal_mapping`
   (`5191202075409` → `C-BA0003` BAJI PAMAI, `5191202076135` → `C-WA0012` WANG MART), jadi
   unggahannya akan menghasilkan daftar 2 outlet yang utuh — tidak ada kode yang akan ditolak.
3. **Tiga CUST_ID2 belum ada di `principal_mapping`**: KOSMETIK MUNAWARAH (52390254695),
   KAMIL STAND (2191200123409), LOLLYPOP BABY (3210402085278).
   **Diperiksa 15 Sep: masih menggantung**, tetapi datanya sudah ada di tangan — ketiganya
   tersimpan di `promo_outlet` lengkap dengan `source_code`-nya (`C-KOS005` ↔ 52390254695,
   `C-KA0059` ↔ 2191200123409, `C-LO0019` ↔ 3210402085278). Tinggal disalin ke Mapping
   Principal; tidak ada yang perlu dicari lagi.
4. **Konfirmasi Kino**: Indomaret 3,1% vs 3% (Rp 8,13 juta menggantung), dan keempat jaringan
   yang melaporkan potongan beban distributor di kolom klaim principal.
5. **Jembatan Summary belum pernah dijalankan ujung ke ujung dengan sesi login sungguhan.**
   Terbukti sampai dinding autentikasi saja (FastAPI menjawab 401 atas endpoint baru, jembatan
   melaporkannya dengan kalimat yang bisa ditindaklanjuti). Jalan penuhnya butuh publikasi
   Summary yang nyata.
6. **Validasi ulang batch 12 September belum pernah dijalankan** (warisan sesi sebelumnya).
   Butuh SATU KLIK di layar produksi; jalur ini tidak punya pintu selain sesi login, dan itu
   memang disengaja. Lihat *Sesi lanjutan* di bawah untuk hasil yang seharusnya keluar dan
   alasannya, baris demi baris.
7. **Multi-principal.** Jalur `promo_rule` baru tersambung untuk KINO NON FOOD. Folder
   `reference_surat_program/sept26` berisi surat 13 principal; pembaca lampirannya sudah
   digeneralisasi, tetapi mapping outlet/barang per principal belum.
8. **`triggerQty` pada aturan per barang non-bonus** masih keterangan: `matchItemRule`
   mencocokkan persennya saja. Yang sudah dijaga baru jalur BONUS_QTY.

---

## Sesi lanjutan, 15 September 2026 — tombol konfirmasi, layar Aturan Promo, dan bukti 12 Sep

### Yang dikerjakan

**Tombol konfirmasi order ganda** (`bc0f34b`). Yang dikonfirmasi adalah ORDER-nya, bukan
barisnya: temuan ganda melekat pada tiap baris SO, jadi dikelompokkan balik ke per-SO supaya
satu tombol melepas satu order. Konfirmasi yang sudah tercatat ikut ditampilkan — siapa, kapan,
catatannya — dan bisa dicabut; konfirmasi bertahan lintas validasi, dan yang tidak terlihat
adalah keputusan tak terlihat. Batch divalidasi ulang sesudah konfirmasi, karena status baris di
basis data masih memuat temuan lama sampai dihitung ulang.

Catatannya diketik di isian pada barisnya, **bukan lewat `prompt()`**: dialog bawaan peramban
bisa diblokir tanpa pesan apa pun, dan `prompt()` yang diblokir menjawab `null` — persis seperti
orang yang menekan Batal. Ini bukan kekhawatiran teoretis: peramban uji sesi ini menolak
`confirm()` diam-diam, dan tombol Cabut tidak melakukan apa pun sampai dialognya dibuang.

**Layar Aturan Promo** (`6111c08`). Nama daftar adalah satu-satunya tali antara aturan dan
pesertanya, dan talinya cuma teks yang diketik dua kali di dua layar. Isiannya kini menawarkan
promo yang sedang berjalan dan menyebut aturan mana yang menunjuk nama itu; nama yang belum
ditunjuk aturan mana pun diberi kotak peringatan. `TINGKAT` jadi `KETERANGAN` (tidak ada surat
yang membedakan tingkat). Tiga tab menggantikan satu kolom panjang.

### Batch 12 September: apa yang seharusnya keluar, dan kenapa

Keadaan tersimpan di produksi **sudah** 48 cocok / 0 ditinjau, tetapi angka itu ditulis oleh
validasi **12 Sep 08:23** — sebelum tarif Discount Reguler dimuat (14 Sep) dan sebelum gerbang
kuota bonus serta order ganda ada. Jadi ia bukan bukti; menjalankan ulang barulah bukti.

Diperiksa atas basis data produksi, keempat SO-nya:

| SO | Outlet | Baris | Potongan | Kenapa lolos |
|---|---|---:|---|---|
| 13044 | `5191202075409` → C-BA0003 | 20 | 5 baris 3% di posisi 4 | kelima barangnya punya aturan 3% `BP2609007909`, 1–30 Sep |
| 13050 | `322570636957` → C-SAT015 | 3 | 2% di posisi 1 | tarif outlet 2% DISTRIBUTOR, 15 Agu–31 Des |
| 13051 | `322570636956` → C-SAT016 | 8 | 2% di posisi 1 | tarif outlet 2% DISTRIBUTOR, 15 Agu–31 Des |
| 13054 | `2191200122557` → C-RIS035 | 17 | Rp 18.016,22 di posisi 5 | bukan peserta LOYALTY, jadi tier MSG `BP2609006016` (EXCLUDE) berlaku |

Sekalian menjawab butir 2 handover tarif: pemetaan SS DIAPERS **sudah** ada di
`principal_mapping` (`322570636956` → `C-SAT016`, `322570636957` → `C-SAT015`), bukan lagi
diturunkan dari nama pelanggan.

**Kedua gerbang baru tidak bisa mengubah hasilnya**, dan itu diperiksa bukan diandaikan:
batch ini **nol baris bonus** (kuota bonus tidak punya apa pun untuk dinilai), dan keempat SO-nya
duduk di **empat outlet berbeda** yang tak satu pun punya SO lain di batch mana pun (gerbang
ganda tidak punya pasangan untuk dibandingkan).

**Setelah surat `BP2609007909` diunggah**, SO 13044 tetap lolos: outletnya C-BA0003 BAJI PAMAI,
salah satu dari dua outlet kita di lampiran surat itu.

### Keadaan produksi saat sesi ini ditutup

- `promo_rule`: 234 baris — 105 aturan barang `BP2609007909`, 89 tarif outlet, 30 `BONUS_QTY`,
  10 tier `DISC_RP` MSG. Seluruhnya `active`.
- `promo_outlet`: hanya `LOYALTY` (41 outlet). `BP2609007909` **belum** dimuat.
- `order_dupe_ack`: kosong. Belum ada SO yang perlu dikonfirmasi.
- Gerbang kirim faktur otomatis **tetap tertutup**. Tidak ada env pengirim yang disentuh, dan
  tidak ada migrasi baru pada PR #63.

---

## Prompt melanjutkan

> Lanjutkan pekerjaan Surya di `D:\AccAPI\_github_clean`, branch `feat/surya-workspace`. Baca
> `docs/handover/HANDOVER_SURYA_SURAT_KE_GERBANG_2026-09-15.md`, terutama bagian *Sesi
> lanjutan*. Semua sudah di `main` dan berjalan di produksi; migrasi 0014–0017 sudah dijalankan
> dan PR #63 tidak menambah migrasi. Tombol konfirmasi order ganda SUDAH ada di layar Order
> Principal. **Dua langkah berikutnya keduanya di layar produksi dan butuh sesi login pengguna:**
> unggah surat `BP2609007909` lewat Aturan Promo → Daftar outlet peserta (kedua outletnya sudah
> terpetakan, tidak akan ada kode yang ditolak), lalu tekan Validasi pada batch
> `ORDER_DETAIL_20260912_20260912.xlsx` — targetnya tetap 48 lolos, alasannya baris demi baris
> ada di tabel *Sesi lanjutan*. Sesudah itu butir yang tersisa: tiga CUST_ID2 ke Mapping
> Principal (datanya sudah ada di `promo_outlet.source_code`), konfirmasi Kino soal Indomaret
> 3,1%, jembatan Summary ujung ke ujung, multi-principal, dan `triggerQty` non-bonus. Gerbang
> kirim faktur otomatis TETAP TERTUTUP. Jangan stage massal — working tree masih memuat
> pekerjaan rekonsiliasi dan dashboard-generator yang bukan milik alur ini.
