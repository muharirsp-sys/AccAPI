# Handover — jalur Summary Promo dibuka dari nol, dan sebelas cacat yang tak pernah bersuara (16 Sep 2026)

Penerus: baca berkas ini lebih dulu, lalu `HANDOVER_SURYA_PIPELINE_2026-09-15.md` untuk latar
belakangnya, lalu bagian **PIPELINE PENUH** dan **MEKANISME surat** pada
`docs/CHECKLIST_ALUR_FAKTUR_PRINCIPLE.md`.

Semua yang di sini **sudah di `main` dan sudah berjalan di produksi** (PR #67–#77).

---

## Satu kalimat

Jalur Summary Promo — satu-satunya jalur yang melewati simulasi dan dua pernyataan manusia —
ternyata tidak pernah bisa dipakai sekali pun di produksi; sebelas cacat berlapis dibuka satu
per satu sampai rantainya berjalan dari master sampai simulasi, dan yang tersisa adalah satu uji
dua surat yang belum sempat diulang setelah perbaikan terakhir.

---

## Keadaan produksi saat sesi ini ditutup

| | |
|---|---|
| `promo_rule` | **234 baris** — TIDAK BERUBAH sepanjang sesi. Tombol Muat tidak pernah ditekan |
| `promo_outlet` | `LOYALTY` 41 outlet, `BP2609007909` 2 outlet (INCLUDE, 105 aturan menunjuknya) |
| `principal_mapping` customer | **1.438** (naik dari 1.435) |
| Master Principle | `KINO NON FOOD` tersimpan, 101 kelompok terbaca |
| Gerbang kirim faktur otomatis | **TETAP TERTUTUP** |
| Migrasi baru | **TIDAK ADA** sepanjang sesi ini |

Batch `ORDER_DETAIL_20260912_20260912.xlsx` divalidasi ulang: **48 baris, 48 cocok, 0 ditinjau**
(13044=20, 13050=3, 13051=8, 13054=17).

---

## Yang dikerjakan di layar produksi

1. **Surat `BP2609007909` dimuat** lewat Aturan Promo → Daftar outlet peserta. 2 outlet
   (BAJI PAMAI `C-BA0003`, WANG MART `C-WA0012`), nol kode ditolak, 105 aturan ditunjuk ke
   daftarnya mode INCLUDE. Channel ke-105 aturan tetap **kosong** — peringatan BAJI PAMAI/MT
   terhormati.
2. **Tiga CUST_ID2 terakhir** masuk Mapping Principal: `52390254695`→`C-KOS005`,
   `2191200123409`→`C-KA0059`, `3210402085278`→`C-LO0019`. Ketiganya ada di master, channel GT.

**Jebakan yang memakan waktu dan wajib diingat:** `principal_mapping.targetCode` menyimpan kode
DASAR (`C-KOS005`), sedangkan `customer.customerNo` memakai akhiran cabang (`C-KOS005-KN`, dari
`BRANCH_SUFFIX` di `validate/route.ts`). Menanyakan kode dasar ke `/api/outlet-channel` menjawab
"tidak ada di master" untuk SETIAP outlet, termasuk yang jelas berjalan — terlihat persis seperti
master rusak.

---

## Sebelas cacat, dan kenapa tak satu pun pernah dilaporkan

Semuanya berbagi satu bentuk: **bagiannya benar, sambungannya tidak pernah terpasang, dan pesan
galatnya menyamarkan.** Diurutkan seperti ditemukannya — tiap perbaikan membuka cacat berikutnya.

| # | Cacat | Kenapa diam | PR |
|---|---|---|---|
| 1 | `data/masters` tidak pernah dibuat | unggah master mati HTTP 500, di layar berbunyi "Error jaringan" | #67 |
| 2 | Registry principle di path relatif, tabel tak pernah dibuat | `except:` telanjang menjawab "belum ada principle" — **sama persis dengan jawaban yang benar** | #67 |
| 3 | `datetime` tidak pernah di-import di `main.py` | tersembunyi di balik #1: `open()` mati satu baris di atasnya | #68 |
| 4 | `kode_barangs` kosong; `kelompok` berisi kalimat surat | `build_programs` menolak; grid tak punya pemilih SKU; koreksi tak memicu resolusi ulang | #69 |
| 5 | `outlet_mode`/`outlet_classes` dibuang saat draft disimpan | **gagal TERBUKA** — surat "KHUSUS PESERTA LOYALTY" tersimpan berlaku untuk semua | #70 |
| 6 | `reportlab` tidak pernah ada di requirements | "Gagal membuat output summary manual." tanpa sebab; `APP_DEBUG` mati di produksi | #71 |
| 7 | Jembatan hanya mengenal `review_detail`, bukan `rows` | publikasi pustaka "tanpa nomor surat" → gerbang menolak (BENAR), tapi jalurnya buntu | #72 |
| 8 | Kolom `periode` tak pernah ditulis siapa pun | kosong di **setiap** Form Summary yang pernah dicetak | #72 |
| 9 | Ambang beli `3021` dari "30 PCS OVALE **2IN1**" | `parse_number_id` mengeruk semua angka dari kalimat; aturan tersimpan rapi & tak pernah cocok | #72/#73 |
| 10 | Baris bonus & koma pembulatan ditahan | selisih yang memang WAJAR dituduh salah | #76 |
| 11 | `rows` tanggapan diubah artinya tanpa mengubah pembacanya | grid menghitung dua kali → 7 baris | #77 |

**Dua jebakan salinan mati**, keduanya memakan siklus deploy:

- `shared.process_summary_generation_job` — **nol pemanggil**, salinan ~250 baris pembuat Form
  Summary. Perbaikan `3021` sempat mendarat di sini dan tidak mengubah apa pun. Sudah ditandai
  di kepalanya; **belum dihapus** — hapus saja kalau menyentuh berkas itu lagi.
- `kino_extraction` didefinisikan **dua kali verbatim** di `routers/summary.py`. Sudah dihapus
  satu (#77).

**`python_backend` tidak punya gerbang lint di CI** — hanya `typecheck` TypeScript yang berjalan.
Kelas bug "nama global tak terdefinisi" (#3) tidak akan tertangkap siapa pun. Satu baris
`python -m pyflakes` di workflow menutupnya; belum dikerjakan karena di luar lingkup.

---

## Yang berubah pada alurnya, atas keputusan pengguna

### Koreksi tangan: lima → satu (#74, #75)

Aturannya: tidak menyebut varian tertentu = SEMUA varian; tidak menyebut gramasi tertentu =
SEMUA gramasi. Diterapkan di `baca_surat_rapi.rapikan_baris`:

| Kolom | Sekarang |
|---|---|
| `principle` | dari principle yang **dipilih orang di layar** — bukan tebakan model |
| `nama_program` | dipotong di penanda badan surat ("Kepada Yth", "Dengan hormat") |
| `variant` | `ALL VARIANT` bila bukan varian master |
| `gramasi` | `ALL GRAMASI` bila kosong |
| `kelompok` | **dikosongkan** bila bukan kelompok master; frasanya pindah ke `keterangan` |

**Kelompok sengaja TIDAK ditebak.** Pencocokan "mengandung" sempat dipasang dan langsung
terbukti berbahaya: dari "OVALE 2IN1 CLEANSER MIX VARIANT" ia memilih kelompok master `OVALE`
(satu-satunya yang terkandung) padahal yang benar `OVALE FACIAL LOTION`. Keduanya sah, jadi tidak
ada yang terlihat salah — yang berubah cuma barang mana yang dapat promo. **Jangan pasang lagi.**

### Satu Summary yang menumpuk (#74)

Per **principal + bulan**. Judul draft (`KINO NON FOOD - SEPTEMBER 2026`) sekaligus kuncinya —
sengaja, karena judul itulah yang dilihat orang di daftar draft tersimpan.

- Yang sudah `published` **tidak pernah disusul**: publikasi itu beku.
- Irisan `promo_rule` yang diganti dikunci per **principal + nomor surat**, bukan per publikasi.
  Tanpa ini menumpuk justru menggandakan. **Konsekuensinya: satu surat harus dimuat SEKALIGUS** —
  memuat sebagian barangnya akan mencabut sisanya.
- `append_rows` menolak program kembar; jati dirinya **surat + ketentuan + benefit** (bukan `id`,
  bukan kelompok — kelompok justru yang sedang dikoreksi orang).

### Dua selisih yang wajar berhenti ditahan (#76)

- **Baris bonus**: masuk Accurate sebagai baris berharga penuh lalu dipotong 100%; laporan
  principal menyebutnya BONUS jadi kolom diskonnya nol. Keduanya benar.
  Contoh: ALUBI KOSMETIK 396 PCS → berhak 13,2 → terima 13.
  *Tidak* dilonggarkan: kalau principal MELAPORKAN potongan pada baris bonus, tetap ditahan.
- **Toleransi nota Rp 100** (`TOLERANSI_NOTA`): RAMADHANI COS Rp 60.017,99 lawan Rp 60.000.
  Rp 100 masih jauh di bawah beda tier terkecil (Rp 20.000) — ia menyembunyikan koma, bukan tier.

---

## Rantai yang sudah terbukti jalan, dan di mana berhentinya

```
Master Principle (sekali)  ->  Summary Promo -> Gunakan Principle  ✅ 101 kelompok
   -> Ekstrak PDF (Mistral OCR)                                     ✅ 1 hal, 1-4 baris
   -> koreksi: TINGGAL KELOMPOK                                     ✅
   -> Simpan  -> kode_barangs + outlet_mode diturunkan              ✅ 18 kode, only+LOYALTY
   -> Generate Summary Final -> Form Summary PDF + Dataset Excel    ✅ TRIGGER_QTY 30 PCS,
                                                                       PERIODE SEPTEMBER 2026
   -> Terbitkan (publikasi beku)                                    ✅
   -> Aturan Promo -> Tarik dari Summary -> Simulasikan             ✅ berjalan, menolak
                                                                       dengan sebabnya
   -> Muat ke promo_rule                                            ⏸ DITAHAN
```

**Simulasi atas draft, lima dari enam saringan menahan** (sebelum #70):

| Skenario | Hasil |
|---|---|
| beli 30 PCS | bonus 1 PCS ✅ |
| beli 29 PCS | tidak ada ✅ |
| kelipatan 60 PCS | bonus 2 PCS ✅ |
| channel MT (surat GT) | tidak ada ✅ |
| barang di luar surat | tidak ada ✅ |
| tanggal di luar periode | tidak ada ✅ |
| outlet bukan peserta LOYALTY | **bonus 1 PCS** ❌ → diperbaiki #70, sesudahnya menahan |

---

## PEKERJAAN BERIKUTNYA — uji dua surat, diulang dari bersih

Uji ini sempat dijalankan dan menangkap dua cacat (#75, #77); **belum diulang setelah #77 naik.**

### Keadaan yang perlu dibereskan dulu

Draft `ef42a12a-f43c-4d15-8916-995939412b25` berjudul `KINO NON FOOD - SEPTEMBER 2026` masih ada
dan **tercemar**: 6 baris dengan `BP2609007664` dua kali. Karena sistem menumpuk ke draft
berjudul sama, surat berikutnya akan menyusul ke sana. **Ganti judulnya dulu** lewat
`PUT /fastapi/summary/library/{id}` (withdraw hanya untuk publikasi, menjawab 409).

Draft `5f69cafd…` sudah diganti judulnya jadi `ARSIP UJI - kelompok salah, jangan dipakai`.

### Urutannya

1. Summary Promo → pilih `KINO NON FOOD` → **Gunakan**.
2. Pengguna memilih `BP2609007664` → tekan **Ekstrak**.
3. Isi kelompok `OVALE FACIAL LOTION` → **Simpan**. Harap: 18 kode, `only`+LOYALTY, `issues: []`.
4. Pengguna memilih `BP2609007713` → tekan **Ekstrak**.
   **Harapan setelah #77: grid 5 baris (1 OVALE + 4 RESIK), TANPA kembar.**
5. Isi kelompok keempat baris RESIK V dari master → Simpan.
6. **Generate Summary Final** → satu Form Summary memuat **kedua** program, satu blok tanda tangan.
7. Terbitkan → Aturan Promo → Tarik dari Summary → **Simulasikan**.
8. **BERHENTI SEBELUM MUAT.**

### Yang wajib diperlihatkan sebelum Muat ditekan

`promo_rule` sekarang 234 baris, dan `BP2609007664` sudah punya **17 aturan** dari impor Excel
(`source` kosong). Jalur Summary menulis dengan `source='surat'` dan mencabut irisan per
**principal + surat** — jadi menekan Muat akan **mengganti** aturan surat itu, bukan menambah.
Bandingkan baris demi baris dan perlihatkan selisihnya lebih dulu.

Catatan: jalur Summary menghasilkan **18 kode** sedangkan Excel punya **17** — bedanya perlu
dijelaskan sebelum menimpa (Excel memuat `K1330001010010B`, kode bonus ber-awalan `B>`).

---

## Yang MASIH menggantung

1. **Uji dua surat** (di atas).
2. **Konfirmasi Kino**: Indomaret 3,1% vs 3% (Rp 8,13 juta menggantung).
3. **Multi-principal.** Jalur `promo_rule` baru tersambung untuk KINO NON FOOD.
4. **Baris SASHA HC pada batch 15 Sep** bertuliskan "Klaim principal Rp 4.189,19 tidak punya
   aturan promo terbit" — diskon D5 1,76% yang memang belum punya aturannya. Bukan selisih wajar;
   pengguna belum memutuskan.
5. **Gerbang lint Python di CI** (satu baris `pyflakes`).
6. **Hapus `shared.process_summary_generation_job`** (~250 baris, nol pemanggil).

---

## Prompt melanjutkan

> Lanjutkan pekerjaan Surya di `D:\AccAPI\_github_clean`, branch `feat/surya-workspace`. Baca
> `docs/handover/HANDOVER_SURYA_SUMMARY_2026-09-16.md`. Semua sudah di `main` dan berjalan di
> produksi (PR #67–#77); tidak ada migrasi baru. Pekerjaan utama: **ulangi uji dua surat dari
> bersih** sesuai bagian "PEKERJAAN BERIKUTNYA" — ganti dulu judul draft `ef42a12a…` yang
> tercemar, lalu `BP2609007664` dan `BP2609007713` sampai satu Form Summary memuat kedua program.
> **BERHENTI SEBELUM tombol Muat**, dan perlihatkan dulu selisih terhadap 17 aturan Excel yang
> sudah ada — Muat akan MENGGANTI, bukan menambah. Gerbang kirim faktur otomatis TETAP TERTUTUP.
> Jangan stage massal — working tree masih memuat pekerjaan rekonsiliasi dan dashboard-generator
> yang bukan milik alur ini.
