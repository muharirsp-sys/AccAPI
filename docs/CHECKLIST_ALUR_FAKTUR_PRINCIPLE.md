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
| 4.1 | `PRD_ID` Kino → kode barang internal | 🟡 | Tabelnya ada di `KINO.xlsx` sheet `Mapping_Prd` (678 baris) tapi **masih berupa berkas, belum masuk DB**. Perlu importir seperti `import_outlet_class.py` |
| 4.2 | Kode internal ada di master `item` Accurate | ✅ | Tabel `item` tersinkron (4.185 item, semuanya bersatuan) |
| 4.3 | **Satuan** baris | ❌ | **ORDER_DETAIL TIDAK punya kolom satuan.** `Mapping_Prd` punya `Satuan` + `ISI`. Lihat pertanyaan 2 — salah satuan = salah 36x/72x |
| 4.4 | Harga per pelanggan dari Accurate | ✅ | `lib/item-price.ts` + `customerPriceCategory` + `item_selling_price` (2,33 juta baris) |
| 4.5 | Bandingkan harga laporan vs harga Accurate | ❌ | Perbandingannya belum dibuat. Dan **kalau beda, siapa yang menang?** Lihat pertanyaan 3 |
| 4.6 | `CUST_ID2` → pelanggan Accurate yang benar | 🟡 | `CUST_ID2` = kode dasar (`C-GAL006`); Accurate memakai kode per cabang principal (`C-GAL006-KN`). Pemilihan akhiran cabang Kino belum dibuat |

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
