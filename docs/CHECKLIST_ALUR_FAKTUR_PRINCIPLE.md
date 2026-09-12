# Checklist alur: laporan principal → validasi → Accurate → error → daily closing

Disusun 2026-09-11 dari alur yang dijelaskan pengguna. Tujuannya satu: memastikan **tiap
langkah benar-benar bisa dijalankan**, bukan sekadar terdaftar sebagai rencana.

Status: ✅ ada dan terbukti · 🟡 ada sebagian · ❌ belum ada · ❓ butuh keputusan pengguna

---

## Langkah 1 — Sales input di sistem principal (Kino)

| # | Yang harus benar | Status | Catatan |
|---|---|---|---|
| 1.1 | Input terjadi di sistem Kino, bukan di web kita | ✅ | Di luar lingkup sistem kita |
| 1.2 | Peran halaman Order Sales / Order Internal kita jadi apa | ❓ | **Pertanyaan 1.** Tahap 1–3 membangun entri order internal + Web Sales. Kalau sumber kebenaran adalah sistem Kino, kedua halaman itu tidak dipakai untuk Kino. Dipakai untuk principal lain, atau dipensiunkan? |

## Langkah 2 — Admin menarik laporan integrasi dari sistem principal

| # | Yang harus benar | Status | Catatan |
|---|---|---|---|
| 2.1 | Laporan bisa diunduh manual sebagai xlsx | ✅ | Terbukti: `ORDER_DETAIL_20260903`, 49 kolom |
| 2.2 | Formatnya dikenali | ✅ | Header di baris ke-5; **dua baris terakhir `Total for 1201671` dan `Grand Total` WAJIB dibuang** |
| 2.3 | Berkasnya bisa dibuka program | ✅ | Stylesheet-nya rusak (`Colors must be aRGB hex values`); akalnya sudah terbukti — salin ulang zip dengan `xl/styles.xml` minimal, `cellXfs` dipad sejumlah aslinya |
| 2.4 | Penarikan otomatis lewat API Kino | ❌ | Belum ada, dan belum diminta. Manual dulu |

## Langkah 3 — Upload laporan ke web

| # | Yang harus benar | Status | Catatan |
|---|---|---|---|
| 3.1 | Endpoint upload xlsx + RBAC + CSRF | ✅ | `POST /api/principal-order`, izin `order.create` |
| 3.2 | Parser ORDER_DETAIL → baris ternormalisasi | ✅ | `lib/order-detail.ts`; nilai baris cocok Rp 0,00 atas dua berkas nyata |
| 3.3 | Satu unggahan = satu batch, punya identitas | ✅ | `principal_order_batch` + `principal_order_line` (migrasi 0008) |
| 3.4 | Idempoten: berkas sama diunggah dua kali tidak menggandakan | ✅ | `UNIQUE(principal, file_hash)`; unggah ulang ditolak 409 kecuali menyatakan `replace` |
| 3.5 | Pengelompokan jadi calon faktur | ✅ | `lib/principal-invoice.ts`: satu SO = satu faktur; SO ditolak UTUH bila ada satu baris `review` |

## Langkah 4 tahap 1a — cocokkan ITEM dan HARGA dengan Accurate

| # | Yang harus benar | Status | Catatan |
|---|---|---|---|
| 4.1 | `PRD_ID` Kino → kode barang internal | ✅ | **Selesai 2026-09-11.** Tabel `principal_mapping` + halaman `/principal-mapping`. Termuat nyata dari `KINO (1).xlsx`: 677 barang, 1.433 pelanggan, 9 salesman |
| 4.2 | Kode internal ada di master `item` Accurate | ✅ | Tabel `item` tersinkron (4.185 item, semuanya bersatuan) |
| 4.3 | **Satuan** baris | ✅ | `fixLine()` menerapkan aturan Power Query; 13 dari 53 baris berkas 11 Sep naik ke KRT, nilai baris tetap |
| 4.4 | Harga per pelanggan dari Accurate | ✅ | `lib/item-price.ts` + `customerPriceCategory` + `item_selling_price` (2,33 juta baris). **Cabang pelanggan WAJIB ikut**: daftar harga berisi satu baris per (kategori x satuan x CABANG) |
| 4.5 | Bandingkan harga laporan vs harga Accurate | ✅ | Toleransi Rp 1 dua arah, dihitung pada **satuan terkecil** (tempat pembulatannya terjadi), bukan pada harga karton |
| 4.6 | `CUST_ID1` → pelanggan Accurate yang benar | ✅ | `CUST_ID1` -> mapping -> `+ "-KN"`, lalu dicek ada di master `customer` |

## Langkah 4 tahap 1b — cocokkan PROMO dengan aturan terbit

| # | Yang harus benar | Status | Catatan |
|---|---|---|---|
| 4.7 | Surat program jadi aturan terbit | ✅ | `kino_letter.py` (tanpa OCR) + `summary_rules` + gerbang on-faktur |
| 4.8 | Kelayakan outlet (loyalty dll) | ✅ | `outlet_class.py`; 41 outlet loyalty Makassar sudah dimuat |
| 4.9 | Pilah diskon: distributor / principal / tak bertuan | ✅ | `kino_discount.classify`, toleransi Rp 1 |
| 4.10 | Tarif **Discount Reguler (Tanggungan Distributor)** termuat | ❌ | **MENAHAN FAKTUR sejak 2026-09-12.** Keputusan pengguna: *"gerbang validasi tidak boleh meloloskan apa pun tanpa aturan"*. Potongan posisi 1-3 kini WAJIB cocok dengan aturan berbeban `DISTRIBUTOR`; belum ada satu pun yang termuat (145 aturan semuanya `PRINCIPAL`), jadi setiap potongan distributor tertahan. Batch 12 Sep: 48 lolos -> 37 lolos, 11 ditinjau. **Ini penahan utama alur sekarang** — muat sheet `PERIKSA` untuk membukanya |
| 4.11 | Kode barang per program promo | ✅ | `promo_rule.item_code` termuat: 105 aturan `DISC_PCT`, 30 `BONUS_QTY`, 10 `DISC_RP` tingkat faktur |
| 4.12 | Aturan untuk channel MT/NKA | ❌ | Surat PRONAS hanya GT. Diskon ALFAMART berasal dari Discount Reguler, bukan surat |
| 4.13 | Potongan tingkat FAKTUR (MSG) vs tingkat BARIS | ✅ | **SELESAI 2026-09-12.** `checkSoPromo()` mencocokkan SISA klaim se-SO dengan tier `DISC_RP` (`item_code` kosong, `trigger_unit='RP'`). Nominal surat TERMASUK PPN sedangkan laporan membawa DPP, jadi klaim dikalikan 1,11 sebelum dibandingkan — RISKA TK: 18.016,22 × 1,11 = 19.998 lawan tier Rp 20.000, beda Rp 2. Toleransi Rp 1 **per baris** karena nominalnya dibagi rata lalu dibulatkan di tiap baris |
| 4.39 | **Tidak ada potongan tembus ke faktur tanpa aturan** | ✅ | **2026-09-12.** `checkLine` memeriksa KEDUA beban, bukan hanya klaim principal. Potongan yang tidak punya aturan bukan "beban sendiri" — ia potongan yang belum jelas milik siapa |
| 4.40 | Rekap promo: tak bertuan = tidak sesuai aturan | ✅ | **2026-09-12.** Bukan lagi "posisi 6+". Beban ikut dicocokkan. Saringan principal (aturan hanya ada untuk KINO, sementara rekap membaca semua principal). Tiap kartu & program bisa dibuka rinciannya dan diunduh CSV; satu daftar `rows` melayani kartu, tabel, dan unduhan supaya angkanya tidak mungkin berbeda |

## Langkah 4 tahap 1c — routing: cocok lanjut, tidak cocok ke admin review

| # | Yang harus benar | Status | Catatan |
|---|---|---|---|
| 4.14 | Status per baris: cocok / perlu ditinjau | ✅ | `principal_order_line.status` + hitungan `ok_count`/`review_count` pada batch |
| 4.15 | Halaman admin review | 🟡 | `/principal-order` sudah menampilkan temuan per baris + saringan "hanya yang perlu ditinjau". Halaman khusus peninjau (dan tindakannya) belum |
| 4.16 | Izin RBAC peninjau | ❌ | Sudah diputuskan jadi permission baru, belum dibuat |
| 4.17 | Yang sudah diperbaiki bisa diperiksa ulang | ✅ | Tombol Validasi bisa dijalankan berulang; terbukti 0 cocok -> 6 cocok setelah satu mapping diperbaiki |

## Langkah 4 tahap 2 — satu tombol kirim ke Accurate

| # | Yang harus benar | Status | Catatan |
|---|---|---|---|
| 4.18 | Payload faktur dari angka beku | ✅ | `lib/accurate-invoice-write.ts`, kini kirim persen + rupiah terpisah |
| 4.19 | Antrean + anti-ganda | ✅ | `invoice_outbox`, kunci `accurate_db_id` + order; `unknown` tidak pernah dikirim ulang sendiri |
| 4.20 | Nomor faktur ikut seri cabang pelanggan | ✅ | `branch.si_auto_number_id`, tidak pernah mengirim `number` |
| 4.21 | **Sumber payload = batch unggahan, bukan `sales_order`** | ✅ | `POST /api/principal-order/queue` mengisi `invoice_outbox` dari batch. Dua jalur hidup berdampingan, kuncinya berbeda: order internal pakai uuid, laporan principal pakai `PRINCIPAL:NO-SO` |
| 4.22 | Satu tombol untuk satu batch sekaligus | ✅ | Tombol **Faktur** pada tiap batch: pratinjau dulu (tidak menulis apa pun), lalu "Antrekan N faktur" |
| 4.23 | Gerbang kirim | ✅ | **Satu faktur uji SUDAH dikirim 2026-09-12**: `INV/2609/KN00403`. Satuan, harga, PPN, nomor seri cabang, dan `charField1` semuanya benar. Rem ditutup lagi setelahnya; `ACCURATE_INVOICE_SEND` kosong, sisa 3 faktur tetap tertahan |
| 4.30 | **Verifikasi balik otomatis: faktur di Accurate vs yang dikirim** | 🟡 | **DIBANGUN 2026-09-12** — `lib/invoice-verify.ts` + `GET /api/invoice-verify` + bagian **Verifikasi balik** pada `/antrean-faktur` (dimuat sendiri, tanpa tombol). Per baris: kode barang, **satuan (id, bukan nama)**, qty, harga, diskon persen, diskon rupiah, dan **nilai baris**; per faktur: `charField1`, pelanggan, `taxable`/`inclusiveTax`/`tax1Amount`, `branchId`, nomor terbit, dan tanggal (satu arah — lihat di bawah). 16 test. **Sisa:** belum pernah dijalankan atas data produksi — sekali buka `/antrean-faktur` di produksi, hasilnya langsung terlihat |
| 4.31 | Salesman pada faktur | ✅ | **SELESAI 2026-09-12.** `salesman/list.do` TIDAK ADA (404 "URL API tidak tepat"); salesman = pegawai bertanda `salesman: true` pada **`employee/list.do`** (236 pegawai, 220 salesman), dan **`employee.number` SAMA PERSIS dengan kode salesman internal kita** (`M-IDW` = id 4652 `KN2_IRDAWATI ALIM`). Jadi jembatannya DITURUNKAN dari master (tabel `accurate_employee`, migrasi 0012, modul sync `employee`), bukan diketik ulang di mapping — kolom isian tangan basi diam-diam tiap sales berganti, dan itu SUDAH terjadi: `M-LFD` dan `M-EKA` keduanya `suspended` di Accurate. Yang `suspended`/bukan salesman tidak dipakai; sales yang tidak ketemu TIDAK menahan faktur, hanya ditandai verifikasi balik. Kesembilan kode Kino nyambung di produksi |
| 4.32 | Diskon persen pada faktur nyata | ❌ | Faktur uji `itemDiscPercent: ""` karena berkas 11 September tanpa diskon sama sekali. Field yang paling berisiko justru BELUM terbukti; menunggu hari yang promonya turun. **Yang berubah 2026-09-12:** pembuktiannya tidak lagi perlu mata manusia — verifikasi balik membandingkan rantai persennya DAN `totalPrice` baris, jadi kalau Accurate menjumlahkan persen (bukan bertingkat) selisihnya muncul sendiri sebagai temuan "nilai baris" | **Catatan 2026-09-12:** `transDate` TERBUKTI diabaikan `save.do` — dikirim 11/09/2026, tercatat 12/09/2026 (hari faktur dibuat). Itu justru sesuai aturan pengguna ("faktur diproses pada tanggal masalahnya selesai"), tetapi membuktikan field yang tak dikenal memang hilang diam-diam — termasuk kemungkinan `masterSalesmanId`. Verifikasi balik akan melaporkannya pada faktur uji berikutnya |
| 4.33 | Faktur GANDA untuk satu SO | 🟡 | Ikut diperiksa verifikasi balik: dua faktur Accurate dengan `charField1` sama = temuan paling atas, mengalahkan hasil apa pun. Belum pernah terjadi (dan tidak boleh) |
| 4.34 | `raw_data` faktur tidak boleh kehilangan rincian baris | ✅ | **Bug diperbaiki 2026-09-12.** Cron sync memakai `list.do` yang TIDAK membawa `detailItem`, dan upsert-nya menimpa `raw_data` tanpa syarat — jadi tiap sync menghapus satu-satunya salinan baris faktur yang dipakai Rekap Promo dan verifikasi balik. `lib/sync.ts` kini hanya menimpa bila yang baru punya rincian atau yang lama memang tidak punya |
| 4.35 | Membatalkan baris antrean yang BELUM terkirim | ✅ | **2026-09-12.** `discardable()` kini mencakup `queued`, bukan hanya `rejected`: payload DIBEKUKAN saat diantrekan, jadi saat aturan pembentuknya berubah (salesman mulai ikut dikirim) baris lama akan terbit dengan angka lama dan tidak ada jalan membuangnya selain menyentuh DB. `sending`/`posted`/`unknown` tetap tidak pernah bisa dibuang |
| 4.36 | **Tombol Kirim ke Accurate + verifikasi di tempat** | ✅ | **2026-09-12, permintaan pengguna.** `POST /api/invoice-outbox/send`: kirim -> tarik ulang `detail.do` -> bandingkan per baris -> lapor. "Terkirim" saja TIDAK dilaporkan berhasil; yang hijau hanya yang isinya terbukti sama. Gerbangnya izin `order.edit` + **sesi Accurate milik penekan sendiri** + `ACCURATE_INVOICE_DB_ID` wajib cocok. Sengaja TIDAK memakai `ACCURATE_INVOICE_SEND`: env itu rem untuk jalur OTOMATIS (cron tanpa manusia), dan env Coolify tertimpa tiap deploy — dua env pengirim lenyap dalam sehari pada 2026-09-12, jadi tombol yang bergantung padanya akan mati diam-diam. Jalur kirimnya SATU (`lib/invoice-sender`), dipakai tombol maupun cron |

## Langkah 4 tahap 2b — tangkap 4 jenis error Accurate

| # | Yang harus benar | Status | Catatan |
|---|---|---|---|
| 4.24 | Error mentah dari Accurate tersimpan | ✅ | `invoice_outbox.last_error` |
| 4.25 | Klasifikasi ke 4 kategori | ❌ | **Belum pernah kita lihat satu pun pesan error asli** karena belum pernah mengirim. Teksnya harus dikumpulkan dari faktur uji, jangan ditebak |
| 4.26 | Outlet non-aktif — bisa dicek SEBELUM kirim | 🟡 | Master `customer` tersinkron; kolom status aktif perlu dipastikan ada |
| 4.27 | Item non-aktif — bisa dicek SEBELUM kirim | 🟡 | Sama, dari master `item` |
| 4.28 | Piutang overdue | ❌ | **Tidak bisa diprediksi lokal.** `sales-invoice/list.do` tidak membawa outstanding sama sekali (terverifikasi); hanya `detail.do` per faktur. Jadi ini hanya ketahuan dari jawaban Accurate |
| 4.29 | Over limit piutang | ❌ | Sama seperti 4.28; limit kredit pelanggan belum ada di DB kita |

## Langkah 5 — tab error dan resend

| # | Yang harus benar | Status | Catatan |
|---|---|---|---|
| 5.1 | Tab error: Faktur, Sales, centang 4 kategori | 🟡 | `/antrean-faktur` ada: kolom faktur/SO, outlet, **sales**, umur, jawaban Accurate apa adanya, saringan per status. **4 kategori belum ada** — teksnya belum pernah kita lihat (4.25) |
| 5.2 | Resend hanya untuk yang AMAN | ✅ | `resendable()` + `POST /api/invoice-outbox`: hanya `rejected`. `unknown` ditolak 409 dengan alasannya dan **tidak punya tombol** di layar. Diuji keempat statusnya |
| 5.3 | Gagal lagi → kembali ke antrean error | ✅ | Kirim ulang mengembalikan ke `queued`; pengirim menandainya `rejected` lagi bila ditolak lagi, dan barisnya muncul lagi di layar yang sama |
| 5.4 | Jejak percobaan | ✅ | `attempts`, `last_error`, `updated_at` |

## Langkah 6 — daily closing dan eskalasi ke OM

| # | Yang harus benar | Status | Catatan |
|---|---|---|---|
| 6.1 | Definisi "selesai hari itu" | ✅ | Bukan jam cut-off: **umur masalah 2 jam** (keputusan pengguna). Dihitung sejak faktur masuk antrean, bukan sejak percobaan terakhir — menekan Kirim ulang tidak menyetel ulang jamnya |
| 6.2 | Siapa yang menutup hari | ✅ | Admin, dengan menarik ulang laporan dari Kino lalu mengunggah + memvalidasinya lagi. Tidak perlu tombol "tutup hari": SO yang sudah diantrekan bentrok di kunci `PRINCIPAL:NO-SO`, jadi tarik ulang aman diulang |
| 6.3 | Halaman laporan OM | ✅ | Bukan halaman terpisah: saringan **"hanya yang lewat 2 jam"** pada `/antrean-faktur`. Satu daftar, satu sumber angka — laporan OM tidak bisa berbeda dari layar admin |
| 6.4 | Isi laporan OM | ✅ | Jumlah yang menggantung, umur per baris, faktur/SO, outlet, **sales** (dari `principal_order_line` lewat nomor SO), status, dan jawaban Accurate apa adanya |
| 6.5 | Pemicu eskalasi | ✅ | Otomatis dari umur: spanduk merah muncul sendiri begitu ada yang lewat 2 jam. Tidak ada tombol "eskalasi" yang bisa lupa ditekan |
| 6.6 | Cron produksi | 🟡 | `/etc/cron.d/accapi` ada (sync 4x/hari + cleanup). Jadwal untuk closing/eskalasi belum |

---

## Jawaban pengguna 2026-09-11 dan temuan Power Query

### Keputusan

1. **Dua jalur hidup berdampingan.** Principal yang punya sistem sendiri (Kino) lewat **upload
   laporan**; principal yang tidak, lewat **entri di web kita**. `invoice_outbox` harus bisa
   diisi dari dua sumber, dan tiap principal perlu penanda jalurnya.
2. **Harga**: selisih sampai **Rp 1** boleh lewat. Di atas itu **DITAHAN**, mau lebih tinggi
   maupun lebih rendah. Sama seperti toleransi diskon.
3. **Daily closing**: saat admin mau selesai kerja, admin **wajib menarik ulang laporan dari
   Kino** lalu disandingkan lagi. Status juga harus **real-time**, dan hitungan waktunya
   **sejak masalahnya muncul**: lewat **2 jam** -> tembus ke OM.

### Isi Power Query `KINO (1).xlsx` — proses manual yang berjalan hari ini

Berkasnya menyimpan sepuluh query (`Kino_OD_Base`, `Header`, `Detail`, `ToAccurateNew`, dst).
Ini **spesifikasi yang sudah terbukti dipakai**, jadi jangan dibangun ulang dengan tebakan.

**Sumber**: `\192.168.1.249ktrs$\Bersama_5\Integrasi\Kino Non Food\OD.xlsx` — laporan
integrasi mendarat di network share, bukan hanya di unduhan admin.

**Satuan, kuantitas, dan harga — jawaban pertanyaan 4.3:**

```
Custom     = QTY / ISI                     (ISI dari Mapping_Prd)
Fix Qty    = if QTY habis dibagi ISI then QTY/ISI   else QTY
Fix Satuan = if QTY habis dibagi ISI then "KRT"     else Mapping_Prd[Satuan]
Fix Harga  = if QTY habis dibagi ISI then PRICE*ISI else PRICE
```

Jadi **QTY selalu dalam satuan terkecil**, dan dinaikkan ke KRT hanya bila pas sekarton.
Harga ikut dikalikan ISI supaya nilai barisnya tidak berubah.

**Bonus barang**: `Fix Disc. 1 = if FLAG_BONUS = "N" then DISC_1 else 100`. Baris bonus muncul
sebagai baris biasa dengan **diskon 100%**, bukan sebagai catatan bonus terpisah. Gerbang promo
harus memperlakukannya begitu, kalau tidak setiap bonus akan tampak sebagai diskon tak bertuan.

**Kode dan relasi yang dipakai:**

| Yang dicari | Caranya |
|---|---|
| Kode barang internal | `Mapping_Prd[KODE ITEM]`, di-join lewat `Kode Alias` = `Text.End(PRD_ID, 15)` (PRD_ID "-" diganti ".") |
| Pelanggan Accurate | `Mapping_Customer[Code Internal]` **& `"-KN"`** — akhiran cabang Kino terkonfirmasi |
| Salesman | `Mapping_Sls[Code Internal]` |
| Gudang | konstanta `"GD01"` |
| Diskon persen | `"d1+d2+d3+d4+d5"` digabung dengan `+` — **format yang sama persis dengan `itemDiscPercent`** yang sudah kita kirim |

**Nomor faktur**: query `ToAccurateNew` membuat nomornya SENDIRI dari sheet `Config_LastNumber`
(prefix + urutan dipad nol, lanjut dari nomor terakhir). Pada jalur API **ini tidak dipakai
lagi** — nomor datang dari Accurate lewat seri cabang (`branch.si_auto_number_id`). Itu justru
menghilangkan satu sumber kesalahan, tetapi berarti nomor faktur hasil sistem baru TIDAK akan
melanjutkan deret `Config_LastNumber`. Perlu dipastikan itu diterima bagian pembukuan.

**Keluarannya format HEADER/ITEM kolom A..N** — template impor berkas, bukan API. Artinya jalur
API kita menggantikan langkah impor manual ini, bukan menambahinya.

### Dampak ke checklist di atas

- 4.3 satuan: ❌ -> **✅ aturannya pasti** (tinggal diimplementasikan)
- 4.1 kode barang: rumusnya pasti (`KODE ITEM` lewat `Kode Alias`)
- 4.6 pelanggan: akhiran `-KN` terkonfirmasi, bukan lagi tebakan
- 4.5 harga: toleransi Rp 1 dua arah, sisanya ditahan
- 6.1/6.2/6.5: pemicu eskalasi = **umur masalah 2 jam**, bukan jam cut-off tetap; ditambah
  penarikan ulang laporan di akhir kerja sebagai penutup hari
- Baru: **baris bonus = diskon 100%** wajib dikenali gerbang promo

## Langkah 1 urutan kerja SELESAI — mapping principal, 2026-09-11

`db/migrations/0007_principal_mapping.sql` + `/principal-mapping`.

**Satu tabel untuk tiga jenis**, bukan tiga tabel: bentuknya sama (kode sana -> kode sini),
dan tiga tabel berarti tiga importir, tiga endpoint, dan tiga layar untuk hal yang persis
sama. `unit` dan `pack_size` hanya terisi untuk `kind='item'`.

- `lib/principal-mapping.ts` — murni, tanpa DB. Judul kolom **dicari lewat sinonim yang
  dinormalkan**, bukan indeks tetap, karena berkas principal adalah laporan ad hoc yang judul
  kolomnya berubah-ubah. Baris setengah jadi, ISI kosong, dan kode ganda **dilaporkan**.
- Barang tanpa `ISI` **ditolak**, di importir maupun di form: aturan satuan menaikkan baris ke
  KRT hanya bila QTY habis dibagi ISI, jadi ISI yang hilang membuat satu baris salah 36x.
- `/api/principal-mapping` GET (cari + halaman), PUT (tambah/ubah), DELETE, POST (ringkasan).
  Izin memakai modul `principles` yang sudah ada — ini master data principal, bukan modul baru.
- `/api/principal-mapping/import` — **default pratinjau**, menulis hanya dengan `apply=true`.
  Memuat MENGGANTI seluruh jenis yang diimpor: kode yang dicabut principal harus benar-benar
  hilang, bukan menumpuk dari muatan sebelumnya.
- Halaman `/principal-mapping`: tiga tab, cari, halaman, tambah/ubah/hapus per baris, dan
  impor berkas dengan pratinjau temuan lebih dulu.

**Dibuktikan jalan** (lokal, 2026-09-11): impor `KINO (1).xlsx` lewat endpoint sungguhan ->
**677 barang, 1.433 pelanggan, 9 salesman** masuk Postgres; satu baris salesman berkode
internal kosong dilaporkan dan dilewati. PUT/DELETE/cari diuji lewat HTTP; barang tanpa ISI
dan tanpa satuan ditolak dengan pesan yang jelas. Halaman dibuka di browser dan menampilkan
677 baris. `npx tsc --noEmit` bersih, `lib/principal-mapping.test.ts` 6 test lolos,
`components/SidebarLayout.test.ts` lolos setelah katalognya diperbarui.

**Belum dilakukan**: migrasi `0007` belum diterapkan di PRODUKSI.

## Koreksi dan temuan dari `Order Detail.xlsx` (11 September 2026)

**Koreksi penting soal berkas.** Yang diunggah admin setiap hari adalah **`Order Detail.xlsx`**
— laporan integrasi dari sistem Kino. `KINO (1).xlsx` **bukan** berkas harian: itu berkas kerja
manual pengguna selama ini (tabel terjemahan + Power Query). Perannya di sistem baru hanya
sebagai **sumber awal isi `principal_mapping`**, diimpor sesekali saat mapping berubah, lewat
halaman `/principal-mapping`. Dua berkas, dua jalur, jangan tertukar.

**Tiga temuan dari berkas 11 September yang mengubah rancangan parser:**

1. **`CUST_ID2` TIDAK selalu berisi kode internal.** Pada berkas 3 September, `CUST_ID2` =
   `C-GAL006`. Pada berkas 11 September, `CUST_ID1` = `CUST_ID2` = `322680876413` — dua-duanya
   kode Kino, dan kode internalnya (`CTU001`) hanya menempel pada teks `CUSTOMER`
   ("trufarm CTU001"). Jadi **jalur yang sah hanya `CUST_ID1` -> `principal_mapping`**, persis
   seperti yang dilakukan Power Query. Membaca `CUST_ID2` atau mengorek nama outlet adalah
   pencocokan samar yang sudah pernah menyusahkan master Priskila.
2. **Kode outlet itu belum ada di `Mapping_Customer`.** `322680876413` tidak ketemu di 1.433
   baris yang sudah dimuat. Artinya mapping akan sering tertinggal dari kenyataan, dan
   **itulah alasan halaman `/principal-mapping` harus bisa diperbaiki admin saat itu juga** —
   bukan menunggu berkas baru dari kantor.
3. **Ada baris ber-`QTY` 0** (baris pertama berkas ini: QTY 0, GROSS 0, TAX 0, tapi PRICE
   terisi). Parser tidak boleh memperlakukannya sebagai baris faktur.

Sisanya sama persis: 49 kolom, judul di baris ke-5, stylesheet rusak (butuh perbaikan
`cellXfs`), dan dua baris ekor `Total for ...` / `Grand Total` yang wajib dibuang. Berkas ini
satu SO (`1671-SOP-260013001`, Modern Trade, 65 baris, gross Rp 20.165.405) **tanpa satu pun
diskon dan tanpa `TOTAL_PROMO`** — jadi pertanyaan "di kolom mana potongan program jatuh"
masih terbuka sampai ada laporan hari yang promonya benar-benar turun.

## PPN wajib aktif pada setiap faktur penjualan — 2026-09-11

Permintaan pengguna. `buildInvoicePayload` sekarang **selalu** mengirim `taxable: true`. Tidak
ada saklar, tidak ada env, tidak ada jalur yang bisa membuat faktur non-PPN diam-diam.

Ditambah `inclusiveTax: false`, karena harga pada kedua sumber adalah **DPP**: data Kino
3 September memperlihatkan GROSS 324.324,32 + TAX 35.675,68 (11%) = NET 360.000, jadi pajaknya
ditambahkan di atas harga. **Kalau faktur uji nanti keluar 11% terlalu tinggi, di sinilah
tempat memperbaikinya** — dan ini masuk daftar periksa faktur uji bersama satuan, harga,
diskon persen, dan nomor.

## Langkah 2 urutan kerja SELESAI — parser + unggah batch, 2026-09-11

`lib/order-detail.ts` + `db/migrations/0008_principal_order_batch.sql` + `/principal-order`.

**SheetJS membaca stylesheet rusak laporan ini tanpa perbaikan apa pun** — akal-akalan
`cellXfs` yang dipakai dari Python tidak perlu diporting. Satu blok kerja hilang.

Aturan yang diterapkan, semuanya dari Power Query admin:

- `fixLine()` — naik ke KRT HANYA bila QTY habis dibagi ISI, harga dikali ISI. Testnya
  memeriksa `qty * price` tidak berubah di kedua cabang.
- `discountsOf()` — DISC_1..8 jadi `{position, percent}`; baris `FLAG_BONUS != "N"` menjadi
  **potongan 100% di posisi 1**. Posisi 6–8 tetap ikut supaya bisa dilaporkan sebagai diskon
  tak bertuan.
- `customerCode` diambil dari **`CUST_ID1`**, bukan `CUST_ID2` dan bukan nama outlet.
- Baris ekor `Total for ...` / `Grand Total` dan baris ber-QTY nol dikeluarkan dan dilaporkan.
- Produk tanpa mapping **tidak ditebak satuannya** — barisnya keluar dan kodenya dilaporkan
  supaya admin memperbaikinya di `/principal-mapping` lalu mengunggah ulang.

Penyimpanan menyimpan **dua versi angka**: `report_*` (bukti apa adanya dari principal,
tidak pernah diubah) dan `qty/unit/price` (hasil aturan satuan). Gerbang membandingkan
keduanya, dan saat ada selisih peninjau harus bisa melihat angka aslinya.

**Dibuktikan jalan** (lokal, 2026-09-11, lewat endpoint sungguhan):

| Berkas | Baris dipakai | Dilewati | Naik KRT | Nilai hasil fix vs GROSS laporan |
|---|---|---|---|---|
| `Order Detail.xlsx` (11 Sep) | 53 | 12 (QTY nol) | 13 | Rp 20.165.405,40 — **selisih Rp 0,00** |
| `ORDER_DETAIL_20260903` (3 Sep) | 23 | 0 | 8 | Rp 24.488.648,65 — **selisih Rp 0,00** |

Unggah ulang berkas yang sama **ditolak 409** dengan menyebut batch sebelumnya. Halaman
`/principal-order` menampilkan daftar batch dan isi barisnya, dengan posisi diskon diberi
warna: D1–D3 distributor, D4–D5 klaim principal, D6–D8 merah (tak bertuan).

**Belum dilakukan**: migrasi `0007` dan `0008` belum diterapkan di PRODUKSI.

## Langkah 3 urutan kerja SELESAI — validasi tahap 1, 2026-09-11

`lib/principal-validation.ts` + `POST /api/principal-order/validate` + migrasi 0009.

Yang diperiksa per baris, **semuanya menahan** (tidak ada yang "cuma peringatan", karena semua
yang diperiksa di sini berakhir sebagai angka pada faktur):

1. Kode produk ada di mapping, dan kode barangnya ada di master `item` Accurate.
2. Kode outlet ada di mapping, dan `kode + "-KN"` ada di master `customer`.
3. Kode salesman ada di mapping.
4. Satuan baris ada pada daftar harga Accurate (satu item bisa berselisih 72x antar satuan).
5. **Harga**: selisih sampai **Rp 1** lolos; di atas itu ditahan, **lebih tinggi maupun lebih
   rendah** (keputusan pengguna).
6. **Pecahan diskon per POSISI**: D1–D3 distributor, D4–D5 klaim principal, sisanya tak bertuan.
   Diskon bertingkat, bukan dijumlah.
7. Klaim principal tanpa aturan promo terbit.
8. Total diskon hitungan kami vs yang dilaporkan principal (toleransi Rp 1).

Hasil terjemahan (`item_code`, `customer_no`, `salesman_internal`, `expected_price`) **DISIMPAN**
pada barisnya, bukan dihitung ulang saat kirim: mapping bisa berubah setelah batch ditinjau, dan
faktur wajib memakai angka yang benar-benar dilihat manusia.

**Satu penyederhanaan yang disengaja dan gagal-tertutup**: `hasPublishedRules` ditahan pada
`false` di `validate/route.ts`. Aturan promo terbit tinggal di SQLite backend Python, bukan di
Postgres, jadi belum bisa ditanya dari route Next. Akibatnya **setiap klaim principal wajib
ditinjau manusia** — arah yang aman. Upgrade-nya tertulis di komentar kode: panggil
`GET /summary/library/published` pada FastAPI lalu bandingkan hasil `calculate()` per faktur.

**Dibuktikan jalan** (lokal, berkas `Order Detail.xlsx` 11 September, 53 baris):

| Tahap | Cocok | Perlu ditinjau | Temuan utama |
|---|---|---|---|
| Validasi pertama | 0 | 53 | outlet `322680876413` belum ada di mapping — 53 baris ditahan |
| Setelah admin menambah mapping outlet lewat UI | **6** | 47 | sisanya **selisih harga nyata** Rp 630–2.387 per satuan |

Terjemahan yang berhasil: item 53/53, salesman 53/53, pelanggan 53/53 setelah diperbaiki.
Selisih harga yang tersisa itu temuan bisnis sungguhan — entah master harga Accurate tertinggal,
entah Kino menagih harga lain. Persis yang gerbang ini ada untuk menangkapnya.

**Migrasi 0007, 0008, dan 0009 SUDAH diterapkan di PRODUKSI** (2026-09-11). 0009 ikut diterapkan
tanpa diminta terpisah karena kode yang di-push memerlukannya; sifatnya aditif dan idempoten.

**Jebakan yang sempat memakan waktu**: cache Turbopack basi membuat SELURUH route `/api/*`
menjawab 404 padahal kodenya benar. `rm -rf .next/cache` lalu jalankan ulang dev server.

## Langkah 4 urutan kerja SELESAI — batch jadi antrean faktur, 2026-09-11

`lib/principal-invoice.ts` + `POST /api/principal-order/queue` + tombol **Faktur** pada tiap batch.
Tanpa migrasi baru: `invoice_outbox` yang sudah ada dipakai apa adanya.

**Kunci antrean = `PRINCIPAL:NO-SO`, BUKAN id batch.** Ini keputusan yang menentukan seluruh
bentuknya. Admin menarik ulang laporan setiap hari (dan wajib menariknya lagi saat daily
closing), jadi SO yang sama pasti muncul lagi di berkas lain. Kalau kuncinya id batch, SO itu
akan difakturkan dua kali; dengan kunci SO, unggahan kedua bentrok di primary key
`invoice_outbox` dan dilewati dengan alasan yang ditampilkan. Order internal tetap memakai
uuid-nya sendiri, jadi dua jalur itu tidak pernah bertabrakan — sesuai keputusan pengguna
bahwa keduanya hidup berdampingan.

Gerbang berlapis, semuanya gagal-tertutup:

- batch wajib sudah divalidasi (`validated_at`), kalau belum ditolak 409;
- satu baris `review` saja menjatuhkan SELURUH SO-nya — faktur separuh isi adalah faktur salah
  dan tidak bisa ditarik dari Accurate;
- pelanggan wajib tunggal per SO, tanggal wajib terbaca (tidak pernah ditebak);
- cabang + seri penomoran dari `lib/order-branch`; SO yang cabangnya tidak pasti dilewati;
- pratinjau adalah default — `queue: true` harus dinyatakan eksplisit, persis seperti unggahan.

`lib/accurate-units.ts` (baru) membaca master satuan dari tabel hasil sync `accurate_unit`,
bukan memanggil `unit/list.do` live. Isinya sama persis (37 baris, PCS=50, KRT=100) dan
menghilangkan satu titik gagal pada jalur faktur — termasuk saat token OAuth sedang dipegang
sesi lain. Jalur order internal ikut memakainya. Ceilingnya tertulis di kode: satuan yang baru
dibuat di Accurate belum ada sampai sync berikutnya, dan gejalanya adalah payload DITOLAK
dengan menyebut satuannya, bukan salah diam-diam.

`buildInvoicePayload` disentuh dua baris saja: baris hasil boleh membawa `price` sendiri
(satu SO bisa memuat item+satuan yang SAMA dua kali karena baris bonus berdiskon 100%, jadi
peta `code|unit` tidak cukup), dan `label` opsional membuat catatan baris memakai NOMOR SO.

**Dibuktikan jalan** (lokal, 2026-09-11, lewat endpoint dan UI sungguhan):

| Uji | Hasil |
|---|---|
| Batch nyata `Order Detail.xlsx` (6 cocok, 47 ditinjau) | **0 calon faktur**, alasan ditampilkan: "47 dari 53 baris belum lolos validasi" |
| Batch uji berisi 6 baris yang semuanya cocok | 1 faktur, 6 baris, bruto Rp 3.059.459,46, `typeAutoNumber` 1701, `taxable: true`, satuan BTL=203/KRT=100 |
| Antrekan dua kali | kedua kalinya **ditolak**: "sudah ada di antrean faktur (status queued)" |
| SO yang sama dari **batch berbeda** (simulasi tarik ulang) | **ditolak juga** — inilah gunanya kunci SO |

`lib/principal-invoice.test.ts` 4 test lolos (24 test lolos untuk seluruh berkas terkait),
`npx tsc --noEmit` bersih. Data uji lokal sudah dihapus lagi; `invoice_outbox` lokal kembali 0 baris.

**Yang masih menahan pengiriman**: gerbang `ACCURATE_INVOICE_SEND` tetap kosong. Antrean boleh
terisi, pengirimannya tidak jalan sampai satu faktur uji diperiksa manual.

## Langkah 5 dan 6 SELESAI — tab error, resend, dan laporan OM, 2026-09-11

`/antrean-faktur` + `app/api/invoice-outbox/route.ts`. Tanpa migrasi baru dan tanpa tabel baru.

**Satu layar, bukan dua.** Laporan OM adalah saringan "hanya yang lewat 2 jam" pada layar yang
sama. Halaman OM terpisah berarti dua query yang bisa menjawab berbeda untuk pertanyaan yang
sama, dan OM akan menelepon admin soal angka yang tidak ada di layar admin.

**Perubahan aturan kirim yang disengaja**: pengirim terjadwal kini HANYA mengambil `queued`.
Sebelumnya `rejected` ikut terambil setiap jalannya cron — padahal Accurate menolak karena ada
yang salah (outlet non-aktif, piutang lewat tempo, harga keliru) dan mengulanginya 4x sehari
tidak memperbaiki satu pun dari itu. Sekarang yang ditolak menunggu manusia. `sendable()` =
`queued` saja, `resendable()` = `rejected` saja, keduanya diuji.

Dua tindakan, keduanya hanya untuk yang DITOLAK:

- **Kirim ulang** — kembali ke `queued` dengan payload yang SAMA. Untuk masalah di luar angka:
  outlet diaktifkan lagi, piutang dibayar, limit dinaikkan.
- **Buang dari antrean** — barisnya dihapus supaya batch yang sudah diperbaiki bisa diantrekan
  ulang dengan angka baru. Ini satu-satunya jalan memperbaiki ANGKA, karena payload dibekukan
  saat diantrekan dan kirim ulang tidak menghitung ulang apa pun.

`unknown` tidak punya tombol sama sekali, di layar maupun di API (409 dengan alasannya).

**Jam eskalasi dihitung sejak `created_at`, bukan `updated_at`.** Kalau dari percobaan
terakhir, menekan Kirim ulang akan menyetel ulang jamnya dan masalah berumur sehari bisa
tampak baru semenit — eskalasi yang bisa dihindari dengan menekan tombol bukan eskalasi.
Dibuktikan: baris berumur 242 menit tetap 242 menit dan tetap terhitung `overdue` setelah
dikirim ulang.

**Dibuktikan jalan** (lokal, 2026-09-11, empat baris antrean buatan di keempat status):

| Uji | Hasil |
|---|---|
| Daftar bawaan | hanya yang belum selesai; `posted` tidak ikut |
| Saringan "lewat 2 jam" | 2 baris tersaring, yang berumur 10 menit hilang |
| Sales + outlet pada baris laporan principal | terisi dari `principal_order_line` lewat nomor SO (`M-MEL`, `trufarm CTU001`) |
| Kirim ulang `unknown` | **ditolak** dengan alasan charField1 |
| Buang `unknown` | **ditolak**, alasan yang sama |
| Kirim ulang `posted` | **ditolak** |
| Kirim ulang `rejected` | boleh; jadi `queued`, umur masalah tetap |
| Buang `rejected` | barisnya hilang, batch bisa diantrekan ulang |
| Cron dengan gerbang tertutup | `waiting: 1` — yang `rejected` TIDAK ikut terhitung maupun terkirim |

**Yang belum, dan sengaja**: klasifikasi 4 kategori error (4.25). Kita belum pernah melihat
satu pun teks error asli dari Accurate, dan pencocokan pola yang ditebak akan salah
menggolongkan error nyata — lebih buruk daripada tidak menggolongkan sama sekali. Sekarang
jawaban Accurate ditampilkan apa adanya. Begitu faktur uji menghasilkan teks aslinya, tempat
menambahkannya adalah satu fungsi pemeta di `app/api/invoice-outbox/route.ts`.

## Koreksi harga — cabang pelanggan dan toleransi per satuan terkecil, 2026-09-11

Temuan pengguna: 47 dari 53 baris tertahan sebagai "selisih harga" padahal kalau disandingkan
dengan harga MT, harganya sudah benar. Dua sebab, dua perbaikan kecil.

**Sebab 1 — cabang, bukan kategori.** Kategori harga pelanggan sudah benar: `C-TRU001-KN`
memang MT (id 200), dan validasi memang sudah memakainya. Yang hilang adalah CABANG. Daftar
harga Accurate berisi satu baris per (kategori x satuan x **cabang**), dan kenaikan harga
sering terbit hanya di cabang principalnya:

| item K1082002002010, satuan SCH, kategori MT | berlaku | harga |
|---|---|---|
| cabang KINO NON FOOD (1051) | 2026-08-01 | **7.207** |
| 21 cabang lain, termasuk Kantor Pusat | 2026-03-09 | 6.306 |

`resolvePrices` memilih CABANG DULU baru tanggal — aturan yang memang benar dan sudah diuji.
Tetapi `validate/route.ts` tidak pernah mengirim `branchId`, jadi pemilihnya jatuh ke cabang
default (Kantor Pusat) dan mengambil harga Maret. Perbaikannya satu opsi pada satu panggilan:
cabang diambil dari `customer.branch_id` pelanggan itu sendiri, sama seperti cabang faktur.

**Sebab 2 — toleransi Rp 1 diterapkan pada satuan yang salah.** Setelah cabang benar, 6 baris
masih tertahan karena beda Rp 3–18 per KARTON. Asalnya pembulatan: Accurate menyimpan harga
per satuan terkecil dalam rupiah bulat (BTL 29.189; KRT = 29.189 x 24 = 700.536) sedangkan
laporan Kino membawa desimal DPP (29.189,1892 = 32.400 / 1,11). Beda Rp 0,19 per botol menjadi
Rp 4,54 begitu dikali 24. Toleransi Rp 1 sekarang dihitung pada satuan terkecil, dengan ISI
dibaca dari yang sudah terjadi pada barisnya (`report_qty / qty`), bukan dari tabel lain.
Salah harga yang sungguhan — ratusan rupiah per satuan terkecil — tetap tertahan, dan ada
testnya.

**Hasil pada berkas nyata 11 September**: 6 cocok / 47 ditinjau -> **53 cocok / 0 ditinjau**,
lalu tombol Faktur menghasilkan **1 calon faktur, 53 baris, bruto Rp 20.165.405,36** (laporan
Kino Rp 20.165.405,40 — beda 4 sen, di bawah satu rupiah).

## Yang paling menentukan sebelum kode ditulis

1. **Sumber kebenaran order** — sistem Kino (upload) atau entri internal kita? Ini menentukan
   apakah `invoice_outbox` diisi dari batch unggahan atau tetap dari `sales_order`, dan apakah
   halaman Order Sales / Order Internal masih punya peran.
2. **Satuan** — ORDER_DETAIL tidak punya kolomnya; salah satuan berarti salah 36x atau 72x.
3. **Harga mana yang menang** kalau laporan Kino berbeda dari master Accurate.
4. **Cut-off dan pemicu daily closing.**

## Risiko yang sudah diketahui dan tidak boleh hilang

- **Gerbang kirim masih tertutup dengan sengaja.** Nama field REQUEST `sales-invoice/save.do`
  belum terbukti dan Accurate mengabaikan field tak dikenal **tanpa galat** — satuan, diskon,
  atau persen bisa diabaikan diam-diam. Satu faktur uji wajib diperiksa manual.
- **`unknown` bukan `gagal`.** Timeout atau koneksi putus berarti faktur MUNGKIN sudah masuk.
  Tombol resend tidak boleh menyentuhnya.
- **Idempotensi unggahan.** Berkas yang sama diunggah dua kali tidak boleh membuat dua faktur.
- **Daftar kelas outlet yang bolong** memberi potongan ke outlet yang seharusnya dikecualikan;
  importirnya sudah menolak daftar bolong kecuali dipaksa sadar.

## Butir 4.30 SELESAI dibangun — verifikasi balik otomatis, 2026-09-12

Permintaannya satu kalimat: *"kenapa harus saya yang mastikan?"* Jawabannya bukan daftar
periksa yang lebih rapi, melainkan pembanding yang berjalan sendiri.

| Berkas | Isi |
|---|---|
| `lib/invoice-verify.ts` | Murni, tanpa DB/jaringan. `readAccurateInvoice` + `verifyInvoice` + `normalizePercentChain` |
| `lib/invoice-verify.test.ts` | 16 test, termasuk bentuk nyata `INV/2609/KN00403` |
| `app/api/invoice-verify/route.ts` | `GET`, read-only, izin `order.view` |
| `/antrean-faktur` | Bagian **Verifikasi balik faktur Accurate**, dimuat bersama halaman |

**Yang dibandingkan, per baris:** kode barang, satuan, qty, harga satuan, diskon persen,
diskon rupiah, dan **nilai baris**. **Per faktur:** `charField1`, pelanggan, `taxable`, `inclusiveTax`,
`tax1Amount` > 0, `branchId`, dan nomor faktur benar-benar terbit.

**Tanggal diperiksa SATU ARAH saja** (aturan pengguna 2026-09-12: *"faktur diproses pada
tanggal masalah itu selesai"*). Faktur uji dikirim 12/09 untuk SO 11/09 dan Accurate
menstempel tanggal pembuatannya sendiri; menuntut sama persis menghasilkan alarm yang tidak
pernah bisa dipadamkan, dan alarm begitu mengajari orang mengabaikan seluruh layarnya. Yang
ditandai: faktur bertanggal **lebih awal** daripada SO-nya, atau tanggal yang tidak terbaca.
Tanggal yang benar-benar dipakai Accurate ditampilkan apa adanya. **Belum ada**: pemilihan
tanggal proses di web (permintaan pengguna 2026-09-12).

**Enam keputusan yang menentukan bentuknya** — semuanya menutup satu cara verifikasi bisa
berbohong:

1. **Pembandingnya `invoice_outbox.payload`, bukan baris batch.** Unggah ulang berkas yang
   sama menghapus batch lama beserta barisnya (`ON DELETE CASCADE`), jadi harapan yang
   dibangun dari batch akan buta justru pada faktur paling lama — yang paling butuh diperiksa.
   Payload adalah rekaman permanen niat sistem, dan rantai batch -> payload hanya punya satu
   jalur kode (`groupCandidates` + `buildInvoicePayload`) yang bertest dan punya pratinjau.
2. **Tidak diperiksa ≠ cocok.** Faktur yang `raw_data`-nya tanpa `detailItem` berstatus
   `tak-terperiksa`, bukan hijau. Hijau palsu lebih berbahaya daripada tidak ada verifikasi,
   karena orang berhenti memeriksa.
3. **`charField1` ikut diperiksa, bukan hanya dipakai.** Kalau faktur yang ketemu membawa
   kunci lain, yang salah bukan angkanya — yang salah pasangannya, dan sisa perbandingan
   menyesatkan.
4. **Baris dipasangkan lewat `detailNotes` ("…baris N") yang kita tulis sendiri**, bukan lewat
   kode barang: satu SO bisa memuat item+satuan yang sama dua kali (baris biasa dan baris
   bonus berdiskon 100%), dan memasangkan lewat kode barang akan menukar keduanya.
5. **Satuan dibandingkan pada ID, bukan nama** — satu item bisa berselisih 72x antar satuan,
   dan nama satuan boleh berganti di master tanpa mengubah barang apa pun.
6. **`nilai baris` diperiksa terpisah dari rantai persennya.** Di situlah salah tafsir diskon
   muncul sebagai UANG: "10+5" bertingkat atas Rp 100.000 memberi netto 85.500, dijumlahkan
   15% memberi 85.000. Rp 500 itu tidak terlihat dari field mana pun kecuali nilai barisnya.

**Faktur ganda (4.33)** ikut terjaring: calon faktur dikumpulkan sebagai DAFTAR per
`charField1`, jadi dua faktur berkunci sama langsung jadi temuan teratas.

**Cara kerjanya di layar**: dimuat sendiri saat `/antrean-faktur` dibuka. Tidak ada tombol
"periksa" — tombol yang harus ditekan akan lupa ditekan justru pada hari fakturnya salah.

**Bug yang ditemukan sambil membangunnya (4.34)**: `lib/sync.ts` menimpa `raw_data` tiap cron
dengan jawaban `list.do` yang TIDAK punya `detailItem`. Artinya rincian baris faktur — satu-
satunya bahan verifikasi ini DAN Rekap Promo — terhapus 4x sehari. Sudah dijaga. Faktur yang
terlanjur kehilangan rinciannya akan muncul sebagai `tak-terperiksa` dengan alasannya, dan
pulih sendiri begitu Accurate mengirim webhook berikutnya untuk faktur itu.

**Yang belum**: verifikasi ini belum pernah dijalankan atas data produksi. Sekali
`/antrean-faktur` dibuka di produksi, `INV/2609/KN00403` langsung ikut diperiksa. **Gerbang
kirim tetap TERTUTUP sampai hasil itu terlihat.**

## Butir 4.37 SELESAI — gerbang validasi membaca aturan promo terbit, 2026-09-12

Sampai hari ini `app/api/principal-order/validate` memakai `const hasPublishedRules = false;`
— dipatok mati. Akibatnya **setiap** klaim principal ditahan, termasuk yang aturannya sudah
termuat di web dan angkanya cocok persis. Gerbang yang menahan segalanya sama tidak bergunanya
dengan gerbang yang meloloskan segalanya: keduanya tidak membedakan benar dari salah.

Dibuktikan atas berkas NYATA `ORDER_DETAIL_20260912` (49 baris, 33 berdiskon, 4 SO):

| SO | Outlet | Bentuk potongan | Hasil gerbang |
|---|---|---|---|
| `-260013044` | BAJI PAMAI (MT) | 3% di posisi 4, 5 baris | cocok **BP2609007909** `DISC_PCT 3%` per barang |
| `-260013050`, `-260013051` | SS DIAPERS (Satu Sama Group) | 2% di posisi 1 | tanggungan distributor, tidak perlu aturan |
| `-260013054` | RISKA TK (GT) | **rupiah** di posisi 5, 18 baris | cocok **BP2609006016** tier 1 (belanja ≥ Rp 1 juta → Rp 20.000) |

**Tiga hal yang menentukan bentuknya:**

1. **Aturan per BARANG diperiksa dulu, sisanya baru ditanyakan ke aturan tingkat FAKTUR.**
   Memakai total klaim mentah akan menuduh SO yang klaimnya sudah beres: SO `-260013044`
   brutonya Rp 3 juta sehingga menyentuh tier 3 MSG (Rp 60.000), padahal seluruh klaimnya
   promo 3% per barang yang tidak ada urusannya dengan MSG. `matchItemRule()` dipakai dua kali
   — oleh `checkLine` dan oleh penghitung sisa — supaya keduanya tidak mungkin berbeda jawaban.
2. **Potongan tingkat faktur dinilai per SO, bukan per baris.** Nominalnya dibagi rata ke SELURUH
   baris, termasuk 7 barang ESK Cologne yang sama sekali tidak masuk program mana pun.
   Memeriksanya per barang akan menuduh baris yang benar.
3. **PPN dikembalikan sebelum dibandingkan.** Surat program menulis manfaatnya termasuk PPN
   (Rp 20.000); laporan principal membawa DPP (18.016,22). Tanpa `× 1,11` potongan yang sah
   akan terlihat meleset 10%.

**Bug parser yang ikut diperbaiki**: kolom `DISC_n` TIDAK selalu berisi persen. Dalam satu
berkas, SS DIAPERS menaruh persen (2,0) di `DISC_1` sementara RISKA menaruh **rupiah**
(446,8468) di `DISC_5`. Dibaca sebagai persen, 446,8468 berarti 446,85%. Pembedanya tidak perlu
ditebak — `TOTAL_DISC` yang dilaporkan principal adalah jawabannya: hitung kedua tafsir, pakai
yang mereproduksinya. Yang berupa rupiah dibawa sampai ke faktur sebagai **rupiah**
(`itemCashDiscount`), bukan dibulatkan ulang dari persen hasil pembagian.

| # | Yang harus benar | Status | Catatan |
|---|---|---|---|
| 4.37 | Gerbang validasi membaca `promo_rule` | ✅ | `checkLine(rules)` + `checkSoPromo()` + `matchItemRule()`; 12 test baru |
| 4.38 | `DISC_n` rupiah vs persen dibedakan | ✅ | Pembedanya `TOTAL_DISC`; hanya saat tepat satu posisi terisi, selebihnya jatuh ke persen dan selisih totalnya tetap menahan — gagal tertutup |

