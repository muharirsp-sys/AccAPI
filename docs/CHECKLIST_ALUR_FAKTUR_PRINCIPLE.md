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
| 3.1 | Endpoint upload xlsx + RBAC + CSRF | ❌ | Belum ada satu pun jalur unggah laporan principal |
| 3.2 | Parser ORDER_DETAIL → baris ternormalisasi | ❌ | Bahannya ada (`kino_discount.line_percentages`), parsernya belum |
| 3.3 | Satu unggahan = satu batch, punya identitas | ❌ | Butuh tabel batch + baris |
| 3.4 | Idempoten: berkas sama diunggah dua kali tidak menggandakan | ❌ | Kunci: hash isi berkas + `SO_NO`. **Wajib**, kalau tidak faktur bisa dobel di Accurate |
| 3.5 | Pengelompokan jadi calon faktur | ❌ | Per `SO_NO`? per `INVOICE_NO`? Lihat pertanyaan 6 |

## Langkah 4 tahap 1a — cocokkan ITEM dan HARGA dengan Accurate

| # | Yang harus benar | Status | Catatan |
|---|---|---|---|
| 4.1 | `PRD_ID` Kino → kode barang internal | ✅ | **Selesai 2026-09-11.** Tabel `principal_mapping` + halaman `/principal-mapping`. Termuat nyata dari `KINO (1).xlsx`: 677 barang, 1.433 pelanggan, 9 salesman |
| 4.2 | Kode internal ada di master `item` Accurate | ✅ | Tabel `item` tersinkron (4.185 item, semuanya bersatuan) |
| 4.3 | **Satuan** baris | 🟡 | Aturannya pasti (lihat Power Query) dan `unit`+`pack_size` sudah tersimpan per barang; penerapannya pada parser laporan belum |
| 4.4 | Harga per pelanggan dari Accurate | ✅ | `lib/item-price.ts` + `customerPriceCategory` + `item_selling_price` (2,33 juta baris) |
| 4.5 | Bandingkan harga laporan vs harga Accurate | ❌ | Perbandingannya belum dibuat. Dan **kalau beda, siapa yang menang?** Lihat pertanyaan 3 |
| 4.6 | `CUST_ID2` → pelanggan Accurate yang benar | 🟡 | Mapping pelanggan sudah di DB; akhiran cabang `-KN` terkonfirmasi dari Power Query. Penyambungannya ke parser laporan belum |

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
| 4.14 | Status per faktur: cocok / perlu ditinjau | ❌ | Belum ada |
| 4.15 | Halaman admin review | ❌ | Harus menunjukkan: faktur mana, baris mana, selisih apa (item / harga / diskon), dan angka pembandingnya |
| 4.16 | Izin RBAC peninjau | ❌ | Sudah diputuskan jadi permission baru, belum dibuat |
| 4.17 | Faktur yang sudah diperbaiki bisa masuk kembali ke antrean | ❌ | Belum ada |

## Langkah 4 tahap 2 — satu tombol kirim ke Accurate

| # | Yang harus benar | Status | Catatan |
|---|---|---|---|
| 4.18 | Payload faktur dari angka beku | ✅ | `lib/accurate-invoice-write.ts`, kini kirim persen + rupiah terpisah |
| 4.19 | Antrean + anti-ganda | ✅ | `invoice_outbox`, kunci `accurate_db_id` + order; `unknown` tidak pernah dikirim ulang sendiri |
| 4.20 | Nomor faktur ikut seri cabang pelanggan | ✅ | `branch.si_auto_number_id`, tidak pernah mengirim `number` |
| 4.21 | **Sumber payload = batch unggahan, bukan `sales_order`** | ❌ | Sekarang `invoice_outbox` diisi dari order internal SQLite. Perlu adaptor dari batch |
| 4.22 | Satu tombol untuk satu batch sekaligus | ❌ | Yang ada baru per order |
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
