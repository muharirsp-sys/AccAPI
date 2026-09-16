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
- `promo_outlet`: hanya `LOYALTY` (41 outlet). `BP2609007909` **belum** dimuat.
- Order Sales: **nol order**. Penegakan channel di sana tidak menahan pekerjaan siapa pun.
- Gerbang kirim faktur otomatis **TETAP TERTUTUP**.

**Peringatan operasional:** BAJI PAMAI (`C-BA0003`) berkategori **MT** di master, dan ia salah
satu dari dua outlet lampiran `BP2609007909`. Jangan isi channel GT pada 105 aturan surat itu
kecuali suratnya memang menyebutnya — kalau diisi, SO 13044 berhenti dijelaskan.

---

## Yang MASIH menggantung — kerjakan dari sini

1. **Dua langkah di layar produksi, keduanya butuh sesi login pengguna** (warisan dua sesi):
   unggah `BP2609007909` lewat Aturan Promo → Daftar outlet peserta (kedua outletnya sudah
   terpetakan), lalu tekan **Validasi** pada batch `ORDER_DETAIL_20260912_20260912.xlsx`.
   Target tetap 48 lolos; alasannya baris demi baris ada di handover sesi kedua.
2. **Jembatan Summary belum pernah dijalankan ujung ke ujung dengan sesi login sungguhan.**
   Terbukti sampai dinding autentikasi saja. Gerbang persetujuan yang baru SUDAH terbukti
   lengkap di lokal (kedelapan keadaannya), tetapi jalur penuhnya butuh publikasi Summary nyata.
3. **Tiga CUST_ID2 belum ada di `principal_mapping`** — datanya sudah ada di
   `promo_outlet.source_code`, tinggal disalin ke Mapping Principal.
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
