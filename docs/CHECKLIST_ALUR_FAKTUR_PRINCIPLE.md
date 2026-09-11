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
| 4.4 | Harga per pelanggan dari Accurate | ✅ | `lib/item-price.ts` + `customerPriceCategory` + `item_selling_price` (2,33 juta baris) |
| 4.5 | Bandingkan harga laporan vs harga Accurate | ✅ | Toleransi Rp 1 dua arah; di atas itu baris ditahan |
| 4.6 | `CUST_ID1` → pelanggan Accurate yang benar | ✅ | `CUST_ID1` -> mapping -> `+ "-KN"`, lalu dicek ada di master `customer` |

## Langkah 4 tahap 1b — cocokkan PROMO dengan aturan terbit

| # | Yang harus benar | Status | Catatan |
|---|---|---|---|
| 4.7 | Surat program jadi aturan terbit | ✅ | `kino_letter.py` (tanpa OCR) + `summary_rules` + gerbang on-faktur |
| 4.8 | Kelayakan outlet (loyalty dll) | ✅ | `outlet_class.py`; 41 outlet loyalty Makassar sudah dimuat |
| 4.9 | Pilah diskon: distributor / principal / tak bertuan | ✅ | `kino_discount.classify`, toleransi Rp 1 |
| 4.10 | Tarif **Discount Reguler (Tanggungan Distributor)** termuat | ❌ | Menunggu sheet `PERIKSA` diisi; importirnya belum dibuat |
| 4.11 | Kode barang per program promo | ❌ | Menunggu sheet `PAKAI` dicentang |
| 4.12 | Aturan untuk channel MT/NKA | ❌ | Surat PRONAS hanya GT. Diskon ALFAMART berasal dari Discount Reguler, bukan surat |
| 4.13 | Potongan tingkat FAKTUR (MSG) vs tingkat BARIS | 🟡 | Kalkulator sudah menghitung sekeranjang; pengadu-annya ke laporan Kino belum. Lihat pertanyaan 6 tentang `TOTAL_PROMO` |

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
| 4.23 | Gerbang kirim | 🟡 | `ACCURATE_INVOICE_SEND` masih kosong, **sengaja**. Nama field request `save.do` belum terbukti; satu faktur uji wajib diperiksa manual dulu |

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
| 5.1 | Tab error: Faktur, Sales, centang 4 kategori | ❌ | Belum ada |
| 5.2 | Resend hanya untuk yang AMAN | 🟡 | Pondasinya sudah benar: `rejected` boleh dikirim ulang, `unknown` **TIDAK PERNAH** — faktur ganda di Accurate tidak bisa dibatalkan. Tombol resend wajib menghormati ini |
| 5.3 | Gagal lagi → kembali ke antrean error | ❌ | Belum ada |
| 5.4 | Jejak percobaan | ✅ | `attempts`, `last_error`, `updated_at` |

## Langkah 6 — daily closing dan eskalasi ke OM

| # | Yang harus benar | Status | Catatan |
|---|---|---|---|
| 6.1 | Definisi "selesai hari itu" | ❓ | **Pertanyaan 4.** Cut-off jam berapa? Zona waktu apa? |
| 6.2 | Siapa yang menutup hari | ❓ | Otomatis lewat cron, atau admin menekan "tutup hari"? |
| 6.3 | Halaman laporan OM | ❌ | Belum ada |
| 6.4 | Isi laporan OM | ❌ | Minimal: jumlah belum selesai, umur masalahnya, faktur + sales + jenis error |
| 6.5 | Pemicu eskalasi | ❓ | Otomatis saat lewat cut-off, atau admin yang mengeskalasi? |
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
