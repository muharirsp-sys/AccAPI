# Handover — pipeline surat sampai faktur, dan gerbang-gerbang yang menutupnya (15 Sep 2026, sesi ketiga)

Penerus: baca berkas ini lebih dulu, lalu bagian **PIPELINE PENUH** dan **MEKANISME surat** pada
`docs/CHECKLIST_ALUR_FAKTUR_PRINCIPLE.md`. Handover sesi sebelumnya
(`HANDOVER_SURYA_SURAT_KE_GERBANG_2026-09-15.md`) masih berlaku untuk latar belakangnya.

Semua yang di sini **sudah di `main`**, kecuali yang disebut di bagian terakhir.

---

## Satu kalimat

Rantai surat → aturan → gerbang kini punya pipeline yang tertulis dan enam lubang yang dulu
GAGAL TERBUKA sudah tertutup; yang tersisa bukan lagi soal kode, melainkan dua langkah yang
memang harus dikerjakan manusia di layar produksi.

---

## Yang berubah sesi ini, dan kenapa

### 1. Channel ditegakkan dari MASTER (`c0b32ad`, migrasi `0018`)

Surat menyebut channelnya sendiri ("KHUSUS CHANNEL GT"), tetapi `promo_rule` tidak punya tempat
menyimpannya, jembatan MEMBUANG `program.channel`, dan gerbang tidak pernah menanyakan kategori
outletnya. Jadi surat GT berlaku untuk outlet MT juga.

Bukan teori. Pada 10 outlet batch September produksi, satu sudah berselisih: **HINDA MART**
(`C-HIL009`) disebut "General Trade" oleh laporan Kino, master Accurate menyimpannya `MT`.

Channel outlet diturunkan dari `customer.category_name` — **bukan** dari laporan principal dan
**bukan** dari yang diketik pengirim order. Peta, keputusan pengguna: **GT = TT saja**. Kategori
lain dipakai apa adanya. Outlet tanpa kategori (378 di produksi) ikut ditahan.

### 2. EXCLUDE berhenti gagal terbuka (`c0b32ad`)

INCLUDE sudah aman sejak awal: daftar kosong berarti tidak ada yang berhak. EXCLUDE justru
sebaliknya — tidak ada yang dikecualikan dibaca sebagai "berlaku untuk semua". Salah ketik satu
huruf, atau keanggotaan kuartal yang belum diunggah, memberi potongan MSG kepada outlet yang
justru dikecualikan suratnya.

Daftar kosong bukan berarti "tidak ada yang dikecualikan"; ia berarti **kita tidak tahu siapa**.

### 3. Order Sales memastikan channel ke master (`4f576b3`)

Order Sales sudah menyaring per channel, tetapi channelnya datang dari badan permintaan — yang
DIAKUI, bukan yang TERBUKTI. Kini ditanyakan ke `GET /api/outlet-channel`.

**Ditanyakan, bukan disalin**, dan itu keputusan yang paling penting di sini: salinan lokal akan
basi tepat saat admin membetulkan kategori — yaitu justru tujuan fiturnya. Preseden sudah ada di
repo (`AUTH_VERIFY_URL`), begitu juga bekasnya (`sync-item-prices` tidak pernah masuk cron).

Tanpa kredensial baru: `CRON_SECRET` yang sudah ada, alamat internal diturunkan dari
`AUTH_VERIFY_URL`. Gagal tertutup di empat keadaan.

### 4. Ambang "beli minimal N" akhirnya menahan (`089d32c`)

Lubang terakhir yang sudah lama tercatat sebagai "masih keterangan". `trigger_qty` pada aturan
per barang non-bonus tidak pernah dibaca siapa pun, jadi "beli 30 pcs dapat 3%" yang diberikan
pada pembelian 5 pcs lolos sempurna.

Dinilai **per SO dan per kelompok**, bentuk yang sama persis dengan kuota bonus — karena suratnya
berkata "MIX VARIANT", dan memeriksa per barang akan MENAHAN pembelian yang sah. Baris bonus
tidak ikut dihitung sebagai pembelian. PCS dinilai pada satuan terkecil, RP termasuk PPN
(mengikuti bukti MSG), **KRT sengaja tidak ditebak**.

Jebakan yang dihindari dan ditulis terang di `needsTriggerCheck`: ambang MSG dan bonus TIDAK
boleh ikut disaring di sini — keduanya punya pemeriksanya sendiri, dan kalau ikut tersaring
mereka hilang sebelum pemeriksanya melihat.

### 5. Simulasi sebelum tanda tangan, dan dua pernyataan manusia (`d203e33`, migrasi `0019`)

Yang menyusun Summary diminta menyatakan "program ini sudah benar dan bisa berjalan" — tanpa
pernah diperlihatkan apa yang akan dibaca sistem. Centang seperti itu tidak menambah keamanan;
ia memindahkan tanggung jawab ke orang yang tidak punya alat memikulnya.

`simulateLetter` menjawab tiga pertanyaan orang: aturan apa yang akan terbaca, apa yang ditolak
beserta sebabnya, dan **apa hasilnya atas baris faktur sungguhan** (2.000 baris terbaru yang
memuat barang surat itu). Ambangnya dihitung dengan cara yang sama persis dengan gerbangnya.

Lalu dua pernyataan yang sistem tidak bisa buat sendiri: **centang**, dan **bukti PDF surat
bertanda tangan OM dan tim**. Sistem bisa menilai apakah aturannya terbaca, tetapi tidak bisa
menilai apakah programnya memang disetujui yang berwenang.

### 6. Layar Aturan Promo dan tombol konfirmasi order ganda (`bc0f34b`, `6111c08`, `d95a182`)

Gerbang ganda sudah menahan di produksi tetapi tidak punya pintu keluar. Nama daftar outlet
sekarang memperlihatkan aturan mana yang menunjuknya. Isiannya dirapikan: tidak ada sel kosong
menganga, kotak isian punya cincin fokus, tombol Simpan menempel.

---

## Pipeline, ringkas

```
surat PDF ─► OCR/teks ─► draft ─► KOREKSI ─► terbit ─► SIMULASI ─► centang + bukti TTD
                                                                         │
                                          promo_outlet ◄── daftar peserta │
                                                    │                     ▼
                                                    └──► GERBANG ◄── promo_rule
                                                            │
                                    empat saringan per TANGGAL SO:
                                    periode · daftar peserta · channel · ambang beli
                                            │
                              cocok ────────┴──────── perlu ditinjau
                                │                          │
                          antrean faktur              admin review
```

Diagram penuh dan tabel "di mana pipeline bisa berhenti, apa artinya, siapa yang membetulkannya"
ada di `docs/CHECKLIST_ALUR_FAKTUR_PRINCIPLE.md` bagian **PIPELINE PENUH**.

---

## Keadaan produksi

- Migrasi **0018 sudah dijalankan dan diverifikasi**; `promo_rule` 234 baris, seluruhnya
  ber-`channel` KOSONG, jadi tidak satu pun keputusan gerbang atas data lama berubah.
- Migrasi **0019 lihat bagian terakhir** — harus dijalankan sebelum kode barunya naik.
- `promo_outlet`: `LOYALTY` (41 outlet) dan `BP2609007909` (2 outlet, INCLUDE, 105 aturan
  menunjuknya) — **dimuat 16 Sep 2026** dari suratnya sendiri.
- Order Sales: **nol order**. Penegakan channel di sana tidak menahan pekerjaan siapa pun.
- Gerbang kirim faktur otomatis **TETAP TERTUTUP**.

**Peringatan operasional:** BAJI PAMAI (`C-BA0003`) berkategori **MT** di master, dan ia salah
satu dari dua outlet lampiran `BP2609007909`. Jangan isi channel GT pada 105 aturan surat itu
kecuali suratnya memang menyebutnya — kalau diisi, SO 13044 berhenti dijelaskan.

---

## Yang MASIH menggantung — kerjakan dari sini

1. ~~**Dua langkah di layar produksi.**~~ **SELESAI 16 Sep 2026**, dikerjakan di layar produksi
   dengan sesi login pengguna. Diperiksa, bukan dipercaya dari notifikasi layar:

   | Yang diperiksa | Hasil |
   |---|---|
   | Anggota daftar `BP2609007909` | **2** — `C-BA0003` BAJI PAMAI (`5191202075409`), `C-WA0012` WANG MART (`5191202076135`), keduanya aktif, nol kode ditolak |
   | Aturan yang menunjuk daftar itu | **105**, mode **INCLUDE** |
   | Channel ke-105 aturan | **kosong** — peringatan operasional BAJI PAMAI/MT terhormati |
   | Total `promo_rule` | tetap **234**; tidak ada aturan baru, hanya ditunjuk ke daftarnya |
   | `LOYALTY` | tidak tersentuh: 41 toko, ketiga talinya utuh |
   | Validasi ulang batch 12 Sep | `POST /api/principal-order/validate` → 200; **48 baris, 48 cocok, 0 perlu ditinjau** |
   | Per SO | 13044 = 20 · 13050 = 3 · 13051 = 8 · 13054 = 17 — sama persis dengan tabel handover sesi kedua |

   Yang dibuktikan menjalankan ulang: hasil 48 yang lama berasal dari 12 Sep, sebelum kuota
   bonus, order ganda, channel, dan ambang beli ada, dan sebelum daftar peserta dimuat. Kelima
   gerbang baru itu kini sudah melihat batch yang sama dan tidak satu pun menahannya. **SO 13044
   tetap dijelaskan** — outletnya BAJI PAMAI, kini peserta INCLUDE surat itu, jadi kelima baris
   3% di posisi 4 masih punya aturannya.
2. **Jembatan Summary: dicoba 16 Sep, dan sebabnya akhirnya ketahuan — bukan autentikasi.**
   Jalur ini tidak pernah bisa DICAPAI karena langkah **nol**-nya rusak di produksi. Diperiksa
   langsung di container, bukan disimpulkan dari layar:

   ```
   data/masters      -> tidak ada
   database.sqlite   -> 0 byte, tanpa tabel `principles`
   ```

   Dua kegagalan senyap bertumpuk: `MASTERS_DIR` tidak pernah dibuat (unggah master mati
   HTTP 500, di layar berbunyi "Error jaringan"), dan registrinya memakai path relatif
   terhadap cwd sehingga lahir di dalam image dan terhapus tiap deploy — tabelnya pun tidak
   pernah dibuat, jadi tiap pembacaan jatuh ke `except:` telanjang dan menjawab "belum ada
   principle". **Jawaban itu sama persis dengan jawaban yang benar ketika memang belum ada**,
   dan itulah kenapa tidak ada yang pernah curiga.

   **Sudah diperbaiki** (`3f363d0`): registry pindah ke `data/principles.sqlite3` (satu-satunya
   folder yang terbukti bertahan antar deploy), tabel dan folder dipastikan ada, kedua fungsi
   registry MELEMPAR alih-alih menelan, unggahan yang registrinya gagal membersihkan berkasnya
   sendiri, dan layar membawa status aslinya. Ada tesnya: `test_principles_registry.py`.

   **Yang masih menggantung: perbaikan ini belum naik ke produksi.** Sesudah ia naik, urutan
   percobaannya: Master Principle (nama HARUS persis `KINO NON FOOD`, berkasnya
   `master_barang_principle/MASTER BARANG KINO NON FOOD.xlsx` — dua kandidat lain gagal dibaca
   parser) → Summary Promo → Gunakan Principle → unggah PDF surat → koreksi → terbitkan →
   simulasi. **Berhenti di simulasi** (keputusan pengguna 16 Sep): tiap surat KINO yang ada
   sudah punya aturannya dari impor Excel (`source` kosong), sedangkan jalur Summary menulis
   dengan `source='surat'` dan hanya mengganti irisannya sendiri — jadi ia MENAMBAH set kedua,
   bukan mengganti.

   **Dijalankan 16 Sep sesudah perbaikan naik. Langkah nol akhirnya lolos; rantainya berhenti
   satu langkah kemudian, dan sebabnya sudah pasti.** Yang BERHASIL: master tersimpan dan
   terbaca (101 kelompok), OCR jalan (1 baris dari 1 halaman — PDF-nya memang 1 halaman), dan
   **ekstraksi maknanya bagus** — periode 2026-09-01..30, channel GT, BONUS_QTY 1 PCS, ambang
   30 PCS, dan yang paling penting `outlet_mode: "only"` + `outlet_classes: "LOYALTY"`, persis
   bentuk yang butir 4.60 sekarang bisa terbitkan.

   Yang MENGHENTIKAN, empat cacat, semuanya di editor Summary:

   | # | Cacat | Akibat |
   |---|---|---|
   | a | Parser mengembalikan **`kode_barangs: ""`** | `build_programs` menolak: "Baris 1: kode barang belum dipilih"; **0 aturan tersusun** |
   | b | Parser menaruh frasa surat ("OVALE 2IN1 CLEANSER MIX VARIANT") ke **`kelompok`**, padahal itu bukan kelompok master | resolusi SKU tidak punya pegangan; kelompok yang benar = `OVALE FACIAL LOTION` |
   | c | Membetulkan kelompok di layar **tidak memicu resolusi ulang** — resolusi hanya berjalan di server saat parse | manusia tidak bisa menyelamatkan draf dari UI; grid juga tidak punya pemilih SKU |
   | d | `MultiSelect` tidak bisa membuang nilai teks-bebas yang tidak ada di master (tidak ada checkbox untuknya) | nilai bogus dari OCR menempel selamanya; satu-satunya jalan adalah menghapus barisnya |

   Bukti bahwa (b) fatal: `master/options` dengan kelompok gabungan menjawab hanya `ALL VARIANT`,
   sedangkan dengan `OVALE FACIAL LOTION` menjawab 7 varian (ANTI ACNE, EXTRA MILD, LEMON,
   LUMI YAMBEAN, PAPAYA, PORE MIN) — persis nama barang pada 17 aturan Excel surat ini.

   Cacat kecil ikut tercatat: periode draf tersimpan **2026-08-31 / 2026-09-16** padahal diisi
   2026-09-01 / 2026-09-30 — awalnya tergeser zona waktu (WITA→UTC), akhirnya tidak terbaca
   sama sekali.

   **Jalur kedua juga tertutup:** `/summary/settings` (paket review, yang `publish_detail`-nya
   benar-benar menyuapi jembatan) meminta **impor berkas paket**, artefak terpisah yang tidak
   dihasilkan editor draf.

   Jadi urutan kerja berikutnya bukan lagi mencoba-coba di layar: **perbaiki (a)+(c) lebih
   dulu** — entah dengan meresolusi `kode_barangs` dari kelompok/varian/gramasi saat draf
   disimpan, atau dengan memberi grid pemilih SKU. Sebelum itu, tidak ada surat KINO mana pun
   yang bisa melewati editor ini.

   **Diselesaikan 16 Sep, PR #69 + #70.** Keempat cacat itu ternyata SATU akar:
   `_apply_native_kelompok` sudah lama benar — ia yang membuat Form Summary punya kolom
   *Kelompok Barang* yang rapi — tetapi hanya dipanggil saat men-generate PDF. Resolusi
   dipindahkan ke titik SIMPAN, jadi (a) `kode_barangs` terisi, (b) `kelompok` ditulis ulang
   dengan nama master sehingga kalimat surat yang nyasar hilang sendiri, dan (c) koreksi
   manusia akhirnya berpengaruh. (d) dapat tombol "Bersihkan pilihan". Efek yang diminta
   pengguna ikut didapat: draft dan PDF Summary kini lewat resolver yang SAMA.

   **Diuji di produksi pada draft OVALE yang kemarin mati**, dimuat ulang persis dalam keadaan
   gagalnya: kelompok dibetulkan → **18 kode barang** (seluruhnya `K13300…` OVALE FACIAL LOTION)
   → "1 aturan tersusun", `issues: []`.

   **Simulasi atas draft — lima dari enam saringan menahan:**

   | Skenario | Hasil | |
   |---|---|---|
   | beli 30 PCS | bonus 1 PCS | ✅ |
   | beli 29 PCS | tidak ada | ✅ ambang menahan |
   | kelipatan 60 PCS | bonus 2 PCS | ✅ |
   | channel MT (surat bilang GT) | tidak ada | ✅ |
   | barang di luar surat | tidak ada | ✅ |
   | tanggal 15 Okt (di luar periode) | tidak ada | ✅ |
   | **outlet BUKAN peserta LOYALTY** | **bonus 1 PCS** | ❌ **gagal terbuka** |

   Baris terakhir itu cacat KELIMA, ditemukan justru karena empat yang pertama sudah beres:
   `outlet_mode`/`outlet_classes` dibuang penyaring kunci saat draft disimpan (tidak ada di
   `FIELDS`), padahal pembaca surat dan `build_programs` sama-sama sudah menanganinya. Surat
   "KHUSUS PESERTA LOYALTY" tersimpan sebagai berlaku untuk SEMUA outlet, tanpa satu galat pun.
   **Diperbaiki di PR #70** (`BARIS_DRAFT`, satu daftar kunci untuk dua tempat).

   **Draft SENGAJA belum diterbitkan.** Menerbitkan membekukan isinya, dan isi draft ini masih
   kehilangan pembatasan LOYALTY sampai #70 naik — membekukan yang sudah diketahui salah adalah
   kebalikan dari yang dijaga rantai ini. Urutan sesudah #70 naik: simpan ulang draft (supaya
   kelayakan outletnya ikut tersimpan), terbitkan, lalu simulasi penuh butir 4.58 di layar
   *Tarik dari Summary*, lalu dua pernyataan manusia.

   **Keadaan produksi tidak berubah sedikit pun:** `promo_rule` tetap **234**, `promo_outlet`
   tetap `LOYALTY:41` dan `BP2609007909:2`. Dua draf Summary tertinggal di pustaka sebagai
   bukti (`f0348cef…`, `bdd8b9c9…`), keduanya berstatus draft dan tidak memengaruhi gerbang.
3. ~~**Tiga CUST_ID2 belum ada di `principal_mapping`.**~~ **SELESAI 16 Sep** (butir 4.63),
   di produksi: `52390254695`→`C-KOS005`, `2191200123409`→`C-KA0059`, `3210402085278`→`C-LO0019`.
   Diperiksa ulang ke `promo_outlet.source_code` sebelum ditulis, dan dipastikan belum ada — baik
   lewat kode Kino maupun kode internalnya — supaya upsert tidak menimpa pemetaan yang benar.
   Customer mapping 1.435 → **1.438**; ketiganya ada di master dan ber-channel **GT**.
4. **Konfirmasi Kino**: Indomaret 3,1% vs 3% (Rp 8,13 juta menggantung).
5. ~~**`readiness()` menolak surat yang membatasi peserta.**~~ **SELESAI 16 Sep** (butir 4.60).
   `peserta()` memetakan `include_tags`/`exclude_tags`/`outlet_codes`/`outlet_list_required` ke
   `outlet_mode`/`outlet_classes`; jembatan dan `promo_rule.outlet_list` memang sudah siap sejak
   awal, jadi tidak ada kolom baru dan tidak ada migrasi. Arah EXCLUDE **tidak perlu lagi dibalik
   tangan**, dan "LIST OUTLET TERLAMPIR" kini menambatkan aturannya ke daftar bernama nomor
   suratnya sendiri — kosong, jadi menahan, sampai lampirannya diunggah di Daftar outlet peserta.
6. **Multi-principal.** Jalur `promo_rule` baru tersambung untuk KINO NON FOOD.
7. ~~**Order Sales**: kolom channel masih teks bebas.~~ **SELESAI 16 Sep** (butir 4.61).
   Bukan jadi pilihan, melainkan jadi JAWABAN: Order Sales dan Order Masuk menanyakannya ke
   `GET /api/outlet-channel` begitu kode pelanggan diisi, lalu memperlihatkannya. Daftar pilihan
   masih menyisakan cara untuk salah, dan satu-satunya nilai yang sah memang cuma kata master.

---

## Prompt melanjutkan

> Lanjutkan pekerjaan Surya di `D:\AccAPI\_github_clean`, branch `feat/surya-workspace`. Baca
> `docs/handover/HANDOVER_SURYA_PIPELINE_2026-09-15.md`, lalu bagian **PIPELINE PENUH** dan
> **MEKANISME surat** pada `docs/CHECKLIST_ALUR_FAKTUR_PRINCIPLE.md`. Semua sudah di `main`;
> migrasi 0014–0019 sudah dijalankan di produksi. **Dua langkah pertama ada di layar produksi dan
> butuh sesi login pengguna**: unggah surat `BP2609007909` lewat Aturan Promo → Daftar outlet
> peserta, lalu tekan Validasi pada batch `ORDER_DETAIL_20260912_20260912.xlsx` (target 48 lolos).
> Sesudah itu butir yang tersisa ada di bagian "Yang MASIH menggantung". Gerbang kirim faktur
> otomatis TETAP TERTUTUP. Jangan stage massal — working tree masih memuat pekerjaan rekonsiliasi
> dan dashboard-generator yang bukan milik alur ini.
