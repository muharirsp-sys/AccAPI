<!--
Tujuan: Kontrak pekerjaan redesign dan alur Summary -> order -> Accurate -> gudang.
Caller: Implementasi, validasi bertahap, dan handover saat melanjutkan task.
Dependensi: SYSTEM_MAP, kode aktual, dokumentasi resmi Mistral/Accurate.
Main Functions: Keputusan, urutan, bukti validasi, status implementasi, dan instruksi melanjutkan.
Side Effects: Tidak ada; setiap status harus berdasarkan bukti.
-->
# Surya: ruang kerja dan integrasi penjualan

## Keputusan pengguna
- Eksekusi seluruh pekerjaan; validasi setiap tahap sebelum beralih.
- Redesign menyeluruh dengan kebebasan arah visual.
- 100 sales, 15 order/sales/hari (~1.500/hari), sibuk 11.00–17.00; satu gudang.
- Web Sales terpisah BELUM ADA; bangun aplikasi terpisah, admin di web internal.
- Summary Program menggunakan Mistral OCR 4.1; draft harus ditinjau sebelum aturan diterbitkan.
- Promo: tier, mix barang, bonus, persen/rupiah, minimum nilai, stacking.
- Order valid otomatis menjadi Faktur Penjualan (bukan SO); admin menangani pengecualian.
- Internal pull order setiap 5 menit; petugas mengaktifkan koneksi, server terus berjalan sampai dinonaktifkan.
- Faktur terverifikasi masuk Rekapan Nota untuk cetak gudang.

## Urutan implementasi dan validasi
1. Redesign + navigasi: SELESAI dan tervalidasi lokal. Pengemasan deployment belum lolos validasi; lihat temuan build di bawah.
   - Katalog 18 menu + Beranda, 6 kelompok, RBAC, pencarian, 3 favorit per akun.
   - Tema Surya default, tema alternatif tetap tersedia; native mobile dialog.
   - Tiga unit checks dan sepuluh browser checks lulus (5 redesign + 5 kompatibilitas); lint dan TypeScript lulus setelah perbaikan terakhir.
   - Tipografi akhir dan halaman Summary/Faktur/Rekapan Nota/Rekonsiliasi diperiksa pada desktop dan mobile.
   - Browser menemukan klik sebelum hydration hilang; controls sekarang disabled sampai siap.
   - Diperbaiki: teks unggah pucat di Summary, warna label lama, label tema default, drawer mobile yang tetap terbuka saat viewport menjadi desktop.
   - Native dialog mencegah fokus ke kontrol aplikasi di belakang; perpindahan fokus ke browser chrome tetap diizinkan oleh browser.
   - Referensi: `docs/design/surya-workspace-reference.png`.
   - Hasil aktual: `docs/design/surya-workspace-desktop.png`, `docs/design/surya-workspace-mobile.png`.
2. Summary OCR + penyimpanan/aturan promo: SELESAI dan tervalidasi live (Mistral 4.1 + surat Priskila produksi); sisa pekerjaan hanya integrasi ke tahap order.
   - Router Summary memakai `summary_mistral.extract` (model `mistral-ocr-4-1`) langsung ke api.mistral.ai; jalur SumoPod dan parser regex lama mengembalikan 410.
   - Draft, sumber PDF, dan output disimpan per pemilik di SQLite (`summary_store`); unduhan tidak lagi dapat diakses hanya dengan ID.
   - Aturan promo disusun DETERMINISTIK oleh server dari baris yang ditinjau (`summary_rules.compile_programs`); browser tidak pernah mengirim angka aturan.
   - Publikasi butuh centang tinjauan, nol issue, dan revisi yang cocok; versi terbit dibekukan dan dipakai simulasi.
   - Panel Summary web: ekstraksi Mistral, daftar draft tersimpan, tabel aturan tersusun, catatan OCR/issue, tombol terbit, dan simulator order.
   - Bukti offline: `python python_backend/test_summary_rules.py` (4 blok lulus: kalkulator, compiler, pencocokan kode, alur HTTP), `npx tsc --noEmit` lulus, eslint halaman Summary 0 error.
   - Bukti live Mistral (2 panggilan berbayar, 1 halaman, surat contoh fiktif tanpa data pelanggan): `mistral-ocr-4-1` menjawab, 4 baris terbaca, tier "Beli 10 -> 5%" dan "Beli 20 -> 10%" terpisah benar, "4+1" dibaca BONUS_QTY 1 (bukan 5), "4.700" -> DISC_RP 4700, tanggal dinormalkan ke YYYY-MM-DD.
   - Bukti UI (browser lokal, halaman Summary asli): daftar draft, panel tinjauan, 3 aturan tersusun dari data live, simulator memberi bruto 755.000 / diskon 74.100 / netto 680.900 (sama dengan hasil offline), bonus 1 PCS, tombol terbit terkunci sampai centang tinjauan, publikasi mengubah status ke published rev 2 dan membekukan aturan, kontras panel diperiksa pada tema surya, office-calm, dan neon.
   - Bukti surat produksi (Priskila, `reference_surat_program/TRADE PROGRAM GT BULAN MARET 2026.pdf`, 9 halaman scan tanpa lapisan teks, master `data/rebuild_master/MASTER BARANG PRISKILA.xlsx` 303 item): 57 baris terbaca, periode 2026-03-01..2026-03-31 diambil dari kepala surat, channel RETAIL/GROSIR, kode ter-map per-pecahan (Roll On 50ml -> 6 kode), **25 aturan lolos validasi**, 31 baris ditandai butuh pilihan kode manual, dan halaman price-list/CR ditolak dengan catatan per halaman.
   - Simulasi atas aturan Priskila: beli 7 EDT 100ml -> bonus 1 SKU tersebut; beli 4 Roll On -> bonus 1 dari kode yang dibeli; channel GROSIR dan tanggal di luar Maret -> nol benefit.
   - BELUM ada: uji dengan sesi login pengguna asli (uji UI memakai backend scratchpad dengan identitas uji, kode produksi tidak diubah) dan integrasi aturan terbit ke tahap order.

### Temuan dari surat Priskila yang sudah diperbaiki

- Satu panggilan anotasi untuk seluruh dokumen 9 halaman **melewatkan halaman belakang secara diam-diam** dan menghasilkan 118 baris "DISC_PCT 13%" yang sebenarnya kolom **CR / cost ratio** pada halaman price list. Anotasi kini satu panggilan per halaman (`SUMMARY_OCR_CONCURRENCY`, default 3), PDF dipecah per halaman secara lokal (mengirim dokumen penuh 9x membuat unggahan 75 MB dan koneksi terputus), setiap halaman tanpa baris dilaporkan sebagai catatan, dan `pages_with_rows` disimpan pada hasil.
- `benefit_type` sekarang dibatasi enum pada JSON schema (`DISC_PCT`, `DISC_RP`, `BONUS_QTY`, kosong) karena model pernah menjawab `CR`. Compiler juga menolak `CR` secara eksplisit.
- Kolom PAKET mentah ("22+2") ditangani deterministik: minimum 22, bonus 2, dan kolom CR pada baris itu diabaikan. Tidak bergantung pada prompt saja.
- Timeout 180 detik terlalu ketat (anotasi 9 halaman terukur ~157 detik) dan batas 8 halaman menolak surat 9 halaman yang sah. Timeout 600 detik, default halaman 20 (cap keras 40), dan timeout memberi pesan berbeda dari respons rusak.
- Surat produksi sering mencetak periode hanya di kepala. Draft punya `period` tingkat draft yang diisi peninjau; periode pada baris selalu menang. Pernyataan eksplisit "tidak ada pembatasan/minimum pembelian" menjadi minimum 1 (aturan bisnis lama, bukan tebakan).
- Bonus "gratis 1" atas kelompok multi-kode tidak menunjuk satu SKU. Tier punya `bonus_scope`: `code` (SKU pasti) atau `purchased` (hak bonus dari barang yang dibeli, `eligible_codes` dikembalikan kalkulator dan SKU dipilih saat order).

### Temuan dari uji live yang sudah diperbaiki

- Panggilan pertama mengembalikan `kode_barangs` dan `source_quote` kosong sehingga 0 aturan tersusun. Prompt sekarang mewajibkan `kelompok` dan `source_quote` verbatim, dan `summary_mistral.attach_codes` mencocokkan kode dari nama master yang tercetak (hanya nama utuh, nama terpanjang menang, merek saja tetap kosong). Versi pipeline dinaikkan ke `surya-summary-v2` agar cache lama tidak dipakai.
- "Beli 1 PCS potongan Rp 4.700 per PCS" dibaca sebagai batas belanja Rp 4.700. `threshold_of` sekarang memeriksa trigger kuantitas lebih dulu, nilai rupiah hanya menjadi batas bila frasanya frasa pembelian, dan potongan per satuan dikenali eksplisit (`rupiah_mode=per_unit`).
- Respons publish/withdraw tidak mengembalikan aturan sehingga panel menjadi "0 aturan tersusun" setelah terbit. Semua endpoint library kini memakai satu bentuk respons `with_rules`; regresi dijaga oleh `check_flow`.
- Tombol dan catatan pada panel memakai warna gelap yang dipetakan tema Surya menjadi tinta gelap di atas latar gelap. Kelas diganti ke kosakata yang sudah dipetakan tema (`bg-emerald-600 text-white`, `text-slate-300`, `text-rose-600`).
3. Input order internal + Web Sales terpisah: ORDER INTERNAL SELESAI dan tervalidasi lokal; Web Sales terpisah BELUM dibangun.
   - `python_backend/routers/orders.py`: `POST /orders` menghitung dengan aturan terbit lalu **membekukan salinan aturan, sumber (draft_id + revision), dan hasilnya** pada order; `GET /orders` (scope mine/all sesuai izin) dan `GET /orders/{id}`.
   - Urutan lintas surat = urutan publikasi. Prioritas ditulis ulang berurutan saat penggabungan supaya hasil tidak bergantung pada ID acak, dan urutan itu ikut dibekukan. Dua surat non-stacking pada barang sama: yang lebih dulu terbit menang, yang lain harus ditarik (withdraw) bila tidak dikehendaki.
   - Tabel `sales_order` pada store SQLite yang sama dengan draft Summary, sehingga pembekuan aturan dan penyimpanan order berada dalam satu transaksi singkat.
   - RBAC modul baru `order` di backend dan `lib/rbac.ts` (staff: view+create, manager: view/create/edit/export, viewer: view), menu "Order Masuk" pada kelompok Penjualan, halaman `app/(dashboard)/orders/page.tsx`.
   - Bukti: `python python_backend/test_orders.py` lulus (tanpa aturan terbit -> 409; promo baru tidak mengubah order lama; urutan publikasi menentukan pemenang; channel/tanggal di luar cakupan -> nol; baris/tanggal/outlet tidak valid -> 400; 401/403/404 lintas pemilik; aturan tersimpan utuh, bukan hanya nomor versi). Uji navigasi 3 check lulus, `tsc --noEmit` lulus.
   - Bukti UI lokal: order 20 pcs @30.000 pada channel GT tanggal 2026-06-15 menghasilkan bruto 600.000, diskon 60.000 (tier "Beli 20" = 10%), netto 540.000, dengan asal aturan tampil sebagai `e6c56dac:GT-001-202606`.
   - **Basis data Web Sales DIPISAH dari internal** (keputusan pengguna 2026-09-08): `python_backend/websales_store.py` (`WEBSALES_STORE_PATH`, default `data/websales.sqlite3`) hanya berisi tabel `order_request`; draft Summary, aturan promo, dan order internal tidak dapat disentuh dari sisi sales.
   - Pemisahan ini menghapus masalah daftar harga: `POST /websales/orders` menerima **kode, satuan, dan jumlah saja** (harga yang dikirim klien dibuang), lalu uang dihitung internal dengan aturan terbit. Klien tidak pernah menentukan nilai transaksi.
   - `POST /orders/pull` (khusus izin `order.edit`) menarik permintaan ke internal. Karena dua basis data tidak bisa satu transaksi, urutannya: tulis order internal dengan `request_id` UNIQUE lebih dulu, baru tandai permintaan `pulled`. Bila penandaan gagal, pull berikutnya menabrak kunci unik lalu hanya menandai — tidak menggandakan order.
   - Order hasil pull berstatus `needs_price` dengan aturan BELUM dibekukan, karena uang belum dapat dihitung tanpa harga. Pembekuan aturan terjadi saat harga terisi (tahap Accurate). Input internal langsung yang sudah berharga tetap dihitung dan dibekukan seketika.
   - Bukti: `python python_backend/test_websales_pull.py` lulus (basis data sales hanya `order_request`; harga klien dibuang; jumlah/tanggal ngawur ditolak di pintu masuk; sales tidak boleh menarik order; pull kedua dan permintaan yang di-reset tidak menggandakan order; input internal tetap membekukan aturan). Bukti UI lokal: dua permintaan sales ditarik menjadi dua order `needs_price`, klik kedua menghasilkan "Ditarik 0 order baru", order internal lama tetap membawa angka bekunya.
   - BELUM: aplikasi Web Sales terpisah beserta identitas 100 sales (endpoint sudah ada, aplikasinya belum), pengisian harga dari Accurate, dan worker penarik otomatis 5 menit (saat ini ditarik manual dari halaman Order Masuk).

### Koreksi pengguna 2026-09-08 — sumber data dan tampilan promo untuk sales

Tiga premis saya sebelumnya salah dan sudah dikoreksi:

1. **Barang/jasa, pelanggan, dan nomor faktur semuanya dari Accurate lewat API.** Bukan dibangun sendiri. Sinkronisasi yang sudah jalan: `lib/sync.ts` -> tabel Postgres `item` (termasuk `unitPrice`) dan `customer`. Nomor faktur milik Accurate (`sales-invoice.number`, `typeAutoNumber` saat `save.do`) — jangan pernah dikarang di aplikasi.
2. **Sales HARUS melihat nilai transaksi dan promo yang berlaku.** Yang tidak boleh adalah klien *menentukan* harga, bukan *melihatnya*. Harga tetap diambil server dari master hasil sync; sales melihat hasil hitungan server.
3. Riset API Accurate lebih lanjut ada di `docs/prd/ACCURATE_API_REFERENCE.md` (dibangun dari probe live 2026-07-28). Yang relevan untuk harga bertingkat: `item.detailSellingPrice[]` (berisi `priceCategory`, `price`, `unit`, `branch`, `effectiveDate`) dipilih lewat `customer.priceCategoryId`, plus endpoint `item/get-selling-price.do` yang sudah mengembalikan harga + diskon terhitung. Spec resmi Accurate TIDAK punya response schema sama sekali, jadi nama field hanya bisa dipastikan lewat panggilan live (`scripts/probe-accurate-detail-fields.mjs`).

### Mesin saran promo untuk sales (selesai, tervalidasi offline)

- `summary_rules.suggestions()`: selisih menuju tier berikutnya per program yang benar-benar berlaku pada tanggal dan channel order, memakai metrik yang sama dengan kalkulator sehingga angka yang dijanjikan ke sales = angka yang nanti dihitung. Tidak menyarankan apa pun bila tier tertinggi sudah tercapai. Diurutkan dari selisih terkecil (paling mudah dicapai) dan dibatasi 20 saran.
- Bentuk pesan: kuantitas -> "Tambah 2 PCS lagi untuk bonus 1 PCS A"; nilai -> "Tambah Rp 200.000 lagi untuk diskon 2%".
- `POST /orders/preview` (Python): nilai transaksi + saran, tanpa menyimpan apa pun, menolak baris tanpa harga dari server.
- `app/api/orders/preview/route.ts` (Next): mengambil harga HANYA dari tabel `item` hasil sync Accurate, mengabaikan harga apa pun dari klien, lalu meneruskan ke backend promo. Kode tanpa harga dijawab 409 dengan daftar kodenya, bukan dihitung dengan harga nol.
- Tampilan yang dipilih (tanpa mengacaukan layout): catatan satu baris di bawah item yang bersangkutan + satu banner ringkas berisi maksimal 3 saran termudah, dipicu otomatis 600 ms setelah pengguna berhenti mengetik. Notifikasi push ke HP sales menyusul saat aplikasi Web Sales dibangun; mesin sarannya sudah siap dipakai ulang.
- Bukti: `check_suggestions` pada `test_summary_rules.py` (kasus 12+1 kurang 2; tier tertinggi tidak disarankan; batas nilai kurang Rp 200.000; tier bertingkat menyarankan tier berikutnya bukan tertinggi; urutan termudah dulu; luar channel/periode tidak memunculkan saran; mix vs non-mix) dan `test_orders.py` (pratinjau tidak menyimpan order, menolak baris tanpa harga, saran muncul untuk paket 12+1).

### Migrasi lokal 2026-09-08 (dengan persetujuan pengguna) dan status sync

Diterapkan ke Postgres dev lokal (`127.0.0.1:5432/accapi`), keduanya aditif dan idempoten:

- `node scripts/migrate-accurate-verified-fields.mjs` -> `item.quantity`, `item.quantity_in_all_unit`, `customer.credit_limit_*`, `customer.credit_age_limit_*`, `sales_invoice.due_date`, `sales_invoice.age`.
- `node scripts/migrate-ext-sync-watermark.mjs` -> `synced_at` + indeksnya pada `item`, `customer`, `sales_invoice`, `sales_return`.

`db/migrations/0002_rekapan_nota.sql` **gagal diterapkan**: `relation "app_setting" does not exist`. DB dev lokal tertinggal beberapa modul utuh (hanya 53 tabel; `app_setting`, `pick_group`, `rekap_upload`, `wave_line_pool`, tabel `reconciliation_*` tidak ada). Skema penuh TIDAK dipaksakan lewat `drizzle-kit push` karena push bisa menghapus kolom/tabel yang ada di DB tapi tidak ada di schema — keputusan pengguna dulu sebelum itu dijalankan.

**Sync Accurate SUDAH BERHASIL di lokal, 2026-09-08:**

- `item`: 4.182 baris, 12,9 detik. `customer`: 31.955 baris — panggilan pertama putus di halaman 296 (`fetch failed` setelah 29.500 baris), dijalankan ulang dan **checkpoint per halaman bekerja**: lanjut dari halaman 296, selesai dalam 26 detik. Ini bukti nyata bahwa `sync_state.last_page` layak dipercaya saat koneksi putus.
- Harga nyata masuk (mis. item `13011010500000` = 13.120), dan pratinjau promo diuji ulang dengan harga itu: bruto 131.200, diskon 6.560, netto 124.640, saran "Tambah 10 PCS lagi untuk diskon 10%" tampil di UI.

### Rantai masalah OAuth yang sudah dibereskan (jangan terulang)

Empat penyebab berlapis, ditemukan berurutan:

1. **`NEXT_PUBLIC_ACCURATE_CLIENT_ID` tidak di-set.** Halaman `/api-wrapper` membangun URL authorize di browser, jadi ia butuh varian `NEXT_PUBLIC_`; `ACCURATE_CLIENT_ID` (server) hanya dipakai callback. Kode punya **fallback client id hardcoded** sehingga permintaan terkirim dengan client id milik app lain -> Accurate menjawab "Client ID tidak tepat" tanpa petunjuk. Fallback itu sudah DIHAPUS; sekarang tombol menolak dengan pesan jelas bila env kosong.
2. **Sesi Better Auth kedaluwarsa** (10 baris `session`, terbaru kedaluwarsa 2026-07-26). Callback memanggil `auth.api.getSession` dan cabang gagalnya dulu **tidak mencetak apa pun** — sekarang mencetak sebab eksplisit.
3. **`LOCAL_AUTH_BYPASS=true` menutupi masalah nomor 2**: halaman terbuka tanpa sesi, logout tidak berfungsi, dan callback melempar ke `/login` yang lalu memantul ke beranda — terlihat seperti "login berputar-putar". Bypass harus DIMATIKAN saat harus login ulang, lalu boleh dinyalakan lagi setelah token Accurate tersimpan.
4. **Sandi admin lokal terlupa.** `scripts/reset-password.mjs` dulu hanya menyasar SQLite (warisan sebelum cutover D4) sehingga gagal senyap di Postgres. Sekarang mendeteksi `postgres://`, memuat `.env.local` sendiri, menolak sandi < 6 karakter, dan menghapus sesi lama setelah reset. Sandi hanya dibaca dari environment.

### Kolom yang harus ditambahkan pada DB dev yang tertinggal

Sync gagal dua kali karena `insert` merujuk kolom yang belum ada di DB lokal. Semua aditif dan idempoten:

```sql
ALTER TABLE item     ADD COLUMN IF NOT EXISTS isi_per_karton integer;
ALTER TABLE item     ADD COLUMN IF NOT EXISTS satuan_besar   text;
ALTER TABLE customer ADD COLUMN IF NOT EXISTS area      text;
ALTER TABLE customer ADD COLUMN IF NOT EXISTS grup_all  text;
ALTER TABLE customer ADD COLUMN IF NOT EXISTS grup_gdi  text;
ALTER TABLE customer ADD COLUMN IF NOT EXISTS alamat    text;
```

### Harga bertingkat per pelanggan — dibangun 2026-09-08

Keputusan pengguna: ambil harga terbaru, **cabang mengikuti itemnya** (tidak dipaksa satu cabang),
dan **fallback ke harga standar** bila tidak ada baris harga yang cocok.

- `db/migrations/0003_item_selling_price.sql` + `db/schema.ts` -> tabel `item_selling_price`,
  satu baris per (item, kategori harga, satuan, cabang, tanggal berlaku). Tanggal berlaku ikut
  primary key supaya kenaikan terjadwal bisa hidup berdampingan dengan harga yang berlaku.
- `scripts/sync-item-selling-price.ts` -> `item/detail.do` per item, batch paralel 4 (batas resmi
  8 serentak), checkpoint per batch di `sync_state` module `item_selling_price`. Aman diulang:
  id di bawah checkpoint pasti sudah selesai karena tiap batch ditunggu penuh.
  **Hasil sync penuh 2026-09-08: 4.182/4.182 item, 2.330.900 baris harga, 1.258 detik (~21
  menit), nol item tanpa detail.** Panggilan pertama crash `ECONNRESET` pada item ke-256 —
  kejadian kedua setelah sync customer — jadi skrip sekarang punya retry bertahap per
  permintaan (4 percobaan, 500ms sampai 4s, termasuk pada 429/5xx) dan dijalankan ulang dari
  checkpoint (item_id 786) tanpa mengulang dari nol.
- `lib/item-price.ts` -> `resolvePrices()`. Urutan penentuan harga, semuanya deterministik:
  tanggal berlaku terbesar `<= tanggal order`, lalu cabang yang diminta, lalu cabang default
  item, lalu cabang mana pun. Tidak ada baris cocok -> `item.unitPrice` (harga standar, `source:
  "standard"`). Tidak ada keduanya -> `source: "missing"` dan pratinjau menolak dengan 409,
  bukan menghitung dengan harga nol.
- `lib/sync.ts` sync customer kini meminta field `priceCategory` dan menyimpannya ke
  `customer.price_category_id` / `price_category_name` (kolom baru). **Sync customer WAJIB
  dijalankan ulang** setelah perubahan ini; sebelum itu semua pelanggan tanpa kategori dan
  seluruh harga jatuh ke fallback standar.
- `app/api/orders/preview/route.ts` menerima `customer_no` dan `branch_id` opsional, memanggil
  `resolvePrices`, dan mengembalikan `prices[]` berisi `source`, nama kategori, cabang, dan
  tanggal berlaku. Halaman Order Masuk menampilkannya di bawah tiap baris ("Harga MT 13.120 -
  Kantor Pusat - berlaku 2026-07-07" atau "Harga standar ... (kategori pelanggan belum
  tersedia)") dan punya kolom **Kode pelanggan Accurate**.

### Dua bug harga yang ditemukan lewat data nyata dan sudah diperbaiki

1. **Urutan cabang.** Versi pertama menyortir tanggal berlaku LEBIH DULU, lalu cabang. Akibatnya
   cabang mana pun yang harganya paling baru diperbarui menang: item `M5012001000740` memakai
   harga cabang **MIX FOOD** (berlaku 2025-11-01) padahal ada baris cabang default **Kantor
   Pusat** (2025-10-31). Sekarang urutannya CABANG DULU (cabang order -> cabang default -> id
   terkecil), baru tanggal berlaku terbesar di dalam cabang itu. Terbukti: tanpa `branch_id` ->
   Kantor Pusat; dengan `branch_id=150` -> MIX FOOD.
2. **Satuan asing memakai harga standar diam-diam.** Item `M5012001000740` berharga
   **BAG 15.900** dan **KRT 1.144.800** (selisih 72x). Order dengan satuan `LUSIN` jatuh ke
   harga standar 15.900 tanpa tanda apa pun — nilai order salah tanpa peringatan. Aturan
   fallback tetap dipertahankan sesuai keputusan pengguna, tetapi `resolvePrices` kini
   mengembalikan `knownUnits` bila satuan yang diminta tidak ada padahal satuan lain ada, dan
   halaman order menampilkannya **merah**: "Harga standar 15.900 — satuan LUSIN tidak ada di
   daftar harga (tersedia: BAG, KRT)".

Bukti jalur harga (live, pelanggan `C-MUS026-GD` kategori TT):

| Kasus | Hasil |
|---|---|
| KRT 2 + BAG 5, tanpa cabang | tier TT, Kantor Pusat: 1.144.800 dan 15.900, bruto 2.369.100 |
| `branch_id=150` | tier TT, MIX FOOD, berlaku 2025-11-01 |
| Tanpa `customer_no` | `source: standard` (tidak ada kategori) |
| Satuan `LUSIN` | `source: standard` + `knownUnits: [BAG, KRT]` |
| Backend promo mati | 502 "Layanan promo tidak dapat dihubungi" — bukan menghitung tanpa promo |

### Satuan dari master Accurate, bukan input bebas — selesai dan tervalidasi live 2026-09-08

Ini menutup risiko nomor satu pada daftar "paling mendesak" sebelumnya: satuan yang salah
membuat nilai order salah sampai 72x (`M5012001000740`: BAG 15.900 vs KRT 1.144.800).

- `lib/item-price.ts` -> `itemUnits(codes)`: satuan sah sebuah item = satuan yang punya baris
  di `item_selling_price`. Diambil lepas dari kategori harga, jadi pelanggan tanpa kategori pun
  tidak bisa memakai satuan yang tidak ada pada itemnya.
- `priceForLine()` dipisah menjadi fungsi murni (tier -> harga standar -> tidak ada harga) supaya
  urutan keputusannya bisa diuji tanpa DB: `lib/item-price.test.ts`, 4 blok.
- `app/api/items/units/route.ts` (`GET ?code=`): `{ found, name, units }`. `units` kosong berarti
  item itu belum punya daftar harga (mis. produksi sebelum sync harga jual) — pemanggil
  memutuskan sendiri, tidak menebak "PCS".
- `app/api/orders/preview/route.ts`: default `"PCS"` DIHAPUS (satuan wajib, kalau kosong 400),
  dan satuan di luar master ditolak **409** sebelum uang dihitung — bukan lagi hanya peringatan
  merah di bawah baris.
- Halaman Order Masuk: satuan menjadi `<select>` berisi satuan master item itu, nama barang
  tampil di bawah baris, satu-satunya satuan dipilih otomatis, dan kode yang tidak ada di master
  ditandai merah. Item tanpa daftar harga tetap boleh diketik (degradasi, server memang tidak
  punya master untuk menolaknya).
- Baris yang sudah ada kodenya tapi belum lengkap kini MENGHENTIKAN pratinjau, bukan dibuang
  diam-diam: sebelumnya total terlihat benar padahal satu baris tidak ikut dihitung.

Bukti live (Postgres lokal, 2,3 juta baris `item_selling_price` asli):

| Uji | Hasil |
|---|---|
| `GET /api/items/units?code=M5012001000740` | `found:true`, nama "ADEM SARI BAG SPARKLING LIME 7GR X 72 BAG", `units:["BAG","KRT"]` |
| Kode tidak ada | `found:false`, `units:[]` |
| Pratinjau satuan `LUSIN` | 409 "Satuan LUSIN tidak ada di master untuk M5012001000740 (tersedia: BAG, KRT)" |
| Pratinjau satuan `PCS` pada `13011010500000` | 409, tersedia KRT, PACK — persis jebakan satuan di `ACCURATE_API_REFERENCE.md` |
| Satuan kosong | 400 "Setiap baris butuh kode barang, satuan, dan jumlah" |
| 3 baris (2 satuan salah) | 409 dalam 187 ms |
| UI | dropdown hanya berisi BAG dan KRT; `LUSIN` tidak bisa lagi diketik |

Batas kejujuran: jalur sukses penuh (satuan sah -> harga tier -> promo) TIDAK diuji ulang live
pada sesi ini karena `/orders/preview` FastAPI menolak tanpa sesi Better Auth yang sah (sesi
lokal kedaluwarsa, `LOCAL_AUTH_BYPASS` hanya berlaku di Next). Query pemilihan harga tidak
diubah dan sudah terbukti live pada sesi sebelumnya (KRT 1.144.800 + BAG 15.900 -> bruto
2.369.100); yang baru hanya pemeriksaan satuan sebelum harga dipakai.

**Satuan pada aturan promo masih dari surat, bukan dari master.** `summary_rules.tier_of`
memakai `PCS` bila suratnya tidak menyebut satuan, dan `calculate` mencocokkan satuan secara
eksak (`line["unit"] == program.unit`). Akibatnya program bersatuan salah TIDAK memberi diskon
keliru — promonya hanya tidak berlaku. Gagal-aman, tapi tetap salah; menyambungkannya butuh
master Accurate masuk ke sisi Python (sekarang hanya punya master Excel per principle).

### Tahap 4 — faktur Accurate: DIBANGUN, BELUM PERNAH MENGIRIM (2026-09-08)

Keputusan pengguna: "bangun dulu tanpa mengirim". Jadi seluruh jalur ada dan teruji, tetapi
**nol request tulis pernah dikirim ke Accurate** dan gerbangnya masih tertutup.

Prasyarat yang ternyata belum ada dan sudah diperbaiki: **order tidak menyimpan pelanggan
Accurate.** `customerNo` adalah field WAJIB `sales-invoice/save.do`, jadi order tanpa
pelanggan tidak akan pernah bisa menjadi faktur. Sekarang `customer_no` ada di tabel
`sales_order` dan `order_request` (ALTER idempoten, seperti pola `request_id`), wajib pada
`POST /orders` dan `POST /websales/orders`, ikut terbawa saat pull, dan dikirim kedua halaman.

Yang dibangun:

- `lib/accurate-invoice-write.ts` (murni, tanpa DB/jaringan). **Bukan** `lib/accurate-invoice.ts`
  — file itu sudah ada dan MEMBACA faktur (`detail.do` -> tampilan); yang ini MENULIS.
  - `buildInvoicePayload` memakai angka **beku** pada order: `unitPrice` dari harga beku baris,
    `itemCashDiscount` = bruto - netto hasil beku (bukan hitung ulang persentase, supaya tidak
    ada selisih pembulatan), `itemUnitId` dari master satuan Accurate.
  - Melempar, bukan menebak: pelanggan kosong, order `needs_price`, satuan tidak ada di master
    satuan, baris hasil tidak berpasangan dengan baris masukan, netto > bruto.
  - `typeAutoNumber: 1` dan **tidak pernah mengirim `number`** — nomor faktur milik Accurate.
  - `charField1` = order id pada header DAN tiap baris: jejak untuk rekonsiliasi status TIDAK
    PASTI lewat `filter.charField1` di `sales-invoice/list.do`. `charField2` = sumber aturan beku.
  - `nextOutboxState`: tanpa jawaban (timeout / koneksi putus / respons non-JSON) -> `unknown`,
    dan `unknown` **tidak pernah** berubah sendiri lagi. Accurate menjawab-dan-menolak ->
    `rejected` (aman diperbaiki lalu dicoba lagi). Hanya `queued`/`rejected` yang boleh dikirim.
- `db/migrations/0004_invoice_outbox.sql` + `db/schema.ts` -> tabel `invoice_outbox`
  (satu baris per order, payload dibekukan saat masuk antrean, identitas = `accurate_db_id` +
  `accurate_id`; `accurate_number` hanya catatan karena nomor bisa dipakai ulang Accurate).
  **Sudah diterapkan ke Postgres dev lokal**; produksi BELUM.
- `app/api/orders/[id]/invoice/route.ts` (izin `order.edit`): POST tanpa `queue` = **dry-run**
  (payload persis yang akan dikirim, tanpa menyentuh DB maupun Accurate); `{"queue":true}` =
  masuk antrean. Order yang sudah pernah masuk antrean **tidak ditimpa** (409): menimpa baris
  `posted`/`unknown` bisa membuat faktur kedua. GET = status antrean order itu.
- `app/api/cron/post-invoices/route.ts` — satu-satunya tempat request tulis terjadi, dan
  **rem tangannya terpasang**: menolak 503 sampai `ACCURATE_INVOICE_SEND=on` DAN
  `ACCURATE_INVOICE_DB_ID` di-set, lalu menolak 409 bila sesi Accurate ternyata terbuka pada
  database lain. Sesi yang dipakai adalah sesi petugas eksplisit (`ACCURATE_INVOICE_USER_ID`),
  **bukan** fallback "sesi terbaru siapa pun" seperti sync. Satu status `unknown` menghentikan
  seluruh batch.
- Halaman Order Masuk: tombol "Tinjau payload" per order + panel JSON dan tombol "Masukkan ke
  antrean faktur"; panel menyatakan terang-terangan bahwa payload BELUM dikirim.

Bukti live read-only (DB CV Surya Perkasa, 2026-09-08) yang mendasari pemetaan:

| Probe | Temuan |
|---|---|
| `sales-invoice/list.do` | `transDate: "08/09/2026"` -> tanggal tulis **dd/MM/yyyy** (sama dengan jalur purchase-payment yang sudah jalan di produksi) |
| `sales-invoice/detail.do id=331710` | `detailItem[].itemUnit = {id,name}`, `unitPrice`, `availableUnitRatio`, `branchId`, `tax1Rate: 11` |
| `item/detail.do id=11900` | `detailSellingPrice[].unit = {id,name}` — id satuan memang ada di data yang sudah kita sync, tapi kolomnya tidak kita simpan |
| `unit/list.do` | 37 satuan dengan id+nama (BAG=350, KRT=100, PACK=101) -> sumber `itemUnitId`, tanpa tabel baru |
| `acc.json.do` | 404 — spec OpenAPI tidak bisa diambil dari tenant; tidak ada di repo |

Bukti gerbang (live, Next sungguhan):

| Uji | Hasil |
|---|---|
| `GET /api/cron/post-invoices` tanpa Bearer | 401 |
| Dengan Bearer, gerbang tertutup | 503 "Pengiriman faktur Accurate belum diizinkan…", `sent: 0` |
| `GET /api/orders/<id>/invoice` | 200 dengan `outbox: null` |
| `POST /api/orders/<id>/invoice` | 401 dari FastAPI (sesi lokal kedaluwarsa) — jalur diteruskan benar |
| Migrasi 0004 di Postgres lokal | tabel + 2 indeks terbentuk |

Bukti offline: `lib/accurate-invoice-write.test.ts` 5 blok — dd/MM/yyyy (**testnya menemukan
bug nyata**: `"08-09-2026"` dulu diterima dan menghasilkan `2026/09/08`, sekarang polanya
diperiksa penuh), payload dari angka beku, lima penolakan "tidak boleh menebak", pembacaan
identitas dari amplop `{s,d,r}`, dan mesin status TIDAK PASTI. `test_orders.py`,
`test_websales_pull.py`, `test_summary_rules.py`, `registry.test.ts` (195 pemakaian key),
`SidebarLayout.test.ts`, `item-price.test.ts`, `tsc`, eslint semuanya lulus.

**RISIKO YANG BELUM TERTUTUP — baca sebelum mengizinkan pengiriman.** Nama field REQUEST
`sales-invoice/save.do` belum terbukti: spec resmi tidak ada di repo (`acc.json.do` -> 404) dan
**Accurate MENGABAIKAN field yang tidak dikenal tanpa galat**. Artinya `itemUnitId`,
`itemCashDiscount`, dan `typeAutoNumber` bisa saja diabaikan diam-diam sehingga faktur
terbentuk dengan satuan/diskon yang salah. Karena itu satu faktur uji pada database yang
Anda tunjuk WAJIB diperiksa manual (satuan, harga per satuan, diskon, nomor) sebelum
`ACCURATE_INVOICE_SEND=on` dipasang di produksi.

Urutan mengaktifkan nanti: (1) terapkan `0004_invoice_outbox.sql` di produksi, (2) tunjuk
database Accurate tujuan + petugas pemilik sesi, (3) satu order uji -> "Tinjau payload" ->
antrean -> jalankan cron sekali, (4) periksa fakturnya di Accurate, (5) baru pasang scheduled
task 5 menit.

### Aplikasi Web Sales — selesai 2026-09-08 (keputusan pengguna: halaman di web internal)

Keputusan pengguna 2026-09-08 atas dua pilihan yang diajukan:

1. **Bentuk aplikasi: halaman di aplikasi internal, dibatasi izin sales** (bukan proses/VPS
   terpisah). Basis data order sales tetap terpisah (`websales.sqlite3`).
2. **Identitas 100 sales: akun Better Auth internal**, dikelola admin dari web internal.

Topologi penuh di `docs/prd/INTEGRASI_WEB_SALES.md` (VPS + Postgres sendiri + dua arah pull)
TIDAK dipakai. Dokumen itu tetap sah sebagai rancangan bila kelak sales perlu tetap jalan saat
internal mati.

**Izin `websales` SENGAJA terpisah dari `order`.** Ini bukan kosmetik: `POST /orders` internal
menerima harga dari klien (input manual petugas), jadi memberi sales `order.create` akan
membuat mereka bisa menentukan nilai transaksi lewat pintu lain. Akun sales cukup
`websales.view` + `websales.create`.

- `lib/rbac.ts`: modul baru `websales` (`view`, `create`), label "Order Sales (Web Sales)",
  dan `pagePermissions` `/sales` -> `websales.create` (guard halaman lewat layout dashboard).
- `lib/rbac/registry.ts`: **`order` DAN `websales` didaftarkan.** `order.*` sebelumnya TIDAK
  terdaftar — registry adalah satu-satunya daftar key yang boleh disimpan pada Access Group,
  jadi selama ini modul Order Masuk hanya bisa dipakai admin dan tidak bisa diberikan ke
  siapa pun lewat grup. Bug ini ketinggalan sejak modul order dibuat.
- `lib/rbac/registry.test.ts`: pemindai anti-lupa-daftar kini juga mencocokkan bentuk
  `perms.has("key")`, bukan hanya `requirePermission(...)`. Justru bentuk itu yang dipakai
  route dengan izin majemuk, dan itulah sebabnya `order.*` lolos. Hasil: 193 pemakaian key di
  `app/api/**` tervalidasi, 108 key terdaftar.
- `python_backend/shared.py`: `websales` masuk `PERMISSION_MODULES` — tanpa itu izin
  `websales` dibuang senyap oleh `normalize_permissions`.
- `routers/websales.py`: `require_sales` memeriksa `websales`, bukan `order`.
- `POST /orders/preview` (FastAPI) dan `/api/orders/preview`, `/api/items/units`,
  `/api/customers/lookup` (Next) menerima `order.create` **atau** `websales.create`: sales
  HARUS melihat nilai transaksi dan promo; yang dilarang adalah klien MENENTUKAN harga.
- `app/api/customers/lookup/route.ts`: konfirmasi pelanggan dari kodenya (nama, area,
  kategori harga) supaya sales tidak salah pelanggan — kelas kesalahan yang sama dengan
  salah satuan.
- `app/(dashboard)/sales/page.tsx`: halaman mobile-first. Kode pelanggan -> nama + kategori
  harga tampil dan outlet terisi otomatis; per baris kode barang -> nama + satuan `<select>`
  dari master; perkiraan bruto/diskon/netto + bonus + saran promo; kirim ke
  `POST /websales/orders` (hanya kode, satuan, jumlah); daftar "Order saya" dengan status
  menunggu/sudah diproses.
- Menu "Order Sales" masuk katalog navigasi, jadi filter izin yang menentukan siapa
  melihatnya — bukan hard-code di dua tempat.

Bukti offline: `test_websales_pull.py` (blok baru: sales `POST /orders` internal -> **403**,
sales `POST /orders/preview` -> 200 dengan diskon benar, sales `GET /orders/connection` ->
403, dan mock izin diganti dari "semua boleh kecuali edit" menjadi peta izin nyata per akun),
`registry.test.ts`, `SidebarLayout.test.ts` (3 blok, katalog 20 item), `tsc`, eslint bersih.

Bukti live lokal:

| Uji | Hasil |
|---|---|
| `/api/customers/lookup?no=C-MUS026-GD` | "HJ. MUSTARI, TK {C-MUS026}", kategori harga TT |
| Kode pelanggan ngawur | `found:false` (ditandai merah di halaman) |
| Halaman `/sales` di viewport 375x812 | render penuh, tanpa scroll horizontal |
| Isi kode pelanggan di halaman | nama + "harga TT" tampil, outlet terisi otomatis |
| Isi kode barang `M5012001000740` | nama tampil, dropdown satuan hanya BAG dan KRT |
| Access Group: grant `websales.view`+`websales.create` | tersimpan (grup uji dibuat lalu DIHAPUS lagi) |
| Access Group: grant `websales.hapus_semua` | ditolak "Key tidak valid" |

Batas kejujuran: **pengiriman order dari halaman sales belum diuji live** — `POST
/websales/orders` FastAPI menolak tanpa sesi Better Auth yang sah (sesi lokal kedaluwarsa,
`LOCAL_AUTH_BYPASS` hanya berlaku di Next), sehingga pratinjau di halaman itu juga masih
menampilkan galat. Jalur HTTP-nya diuji lewat TestClient dengan peta izin nyata.

**Langkah operasional sebelum sales dipakai:** buat satu Access Group (mis. "Sales Lapangan")
berisi HANYA `websales.view` + `websales.create`, lalu buat akun sales dan masukkan ke grup itu
dari `/admin/users`. Jangan memberi grup itu `order.*`.

Sisa yang belum dikerjakan pada jalur sales: pencarian barang/pelanggan (sekarang kode diketik,
nama hanya konfirmasi), notifikasi push saran promo ke HP, dan pembatasan pelanggan per sales
(sekarang sales bisa memilih kode pelanggan mana pun).

### Penarikan otomatis 5 menit — selesai 2026-09-08 (tahap 4, bagian penjadwal)

Keputusan pengguna: "petugas mengaktifkan koneksi, server terus berjalan sampai dinonaktifkan."

**Tidak dibangun sebagai worker asyncio di dalam FastAPI.** Penjadwalnya cron 5 menit yang
sudah terpasang di VPS (pola identik `/api/cron/sync-accurate`), dan endpoint penarik no-op
saat koneksi mati. Alasan pilihan ini: status koneksi bertahan melewati restart, tidak ada dua
worker saat uvicorn dijalankan multi-proses, tidak ada task yang harus dimatikan rapi, dan
tidak ada proses baru untuk dideploy. Naikkan ke worker in-process hanya kalau latensi 5 menit
terbukti tidak cukup.

- `pull_once(owner)` dipisah dari handler `POST /orders/pull` supaya penjadwal dan tombol
  manual memakai jalur yang sama persis.
- `GET /orders/connection` (izin `order.view`): status + jumlah permintaan yang menunggu +
  hasil jalan terakhir. `POST /orders/connection` (izin `order.edit` + CSRF): `{enabled}`.
- Order hasil tarik otomatis dimiliki **petugas yang menyalakan koneksi** (disimpan pada
  status), bukan tanpa pemilik — jadi tetap terlihat di "Milik saya" dan jelas siapa yang
  bertanggung jawab.
- `POST /orders/pull-cron`: TANPA sesi pengguna, secret `CRON_SECRET` dibandingkan
  konstan-waktu. `CRON_SECRET` kosong -> **503, bukan terbuka**.
- `app/api/cron/pull-websales/route.ts`: gerbang `requireCronSecret` (Bearer) lalu meneruskan
  ke FastAPI dengan header `X-Cron-Secret`. Satu nilai secret dipakai kedua sisi.
- Halaman Order Masuk: tombol "Koneksi Web Sales: AKTIF/MATI", tombol "Tarik sekarang", dan
  satu baris status (menunggu berapa, terakhir jalan kapan, berapa masuk/gagal).
- Dua pull yang jalan bersamaan tidak menggandakan order: yang menjaga adalah kunci UNIQUE
  `request_id`, bukan penjadwalannya.

Bukti offline: `python python_backend/test_websales_pull.py` lulus dengan blok baru
`check_connection` (tanpa `CRON_SECRET` -> 503; secret salah/absen -> 403; koneksi mati ->
`skipped` dan permintaan tetap menunggu; sales tidak boleh menyalakan koneksi -> 403;
`enabled` bukan boolean -> 400; koneksi hidup -> 1 order masuk atas nama petugas dan
`last_result` tercatat; dimatikan lagi -> penarikan berhenti walau ada permintaan baru).
`test_orders.py` dan `test_summary_rules.py` tetap lulus; `tsc` dan eslint bersih.

Bukti live lokal (uvicorn + Next sungguhan, bukan TestClient):

| Uji | Hasil |
|---|---|
| `GET /api/cron/pull-websales` tanpa Bearer | 401 |
| Dengan Bearer, `CRON_SECRET` belum ada di backend | 503 "CRON_SECRET belum dikonfigurasi di server" |
| Setelah `CRON_SECRET` di-set di backend, koneksi default mati | 200 `{"skipped":"koneksi Web Sales dimatikan"}` |
| `POST /orders/pull-cron` dengan secret salah | 403 "Secret penjadwal tidak cocok" |

Batas kejujuran: tombol koneksi di UI TIDAK dilihat langsung di browser lokal karena
`/orders/connection` FastAPI menolak tanpa sesi Better Auth yang sah (sesi lokal kedaluwarsa,
`LOCAL_AUTH_BYPASS` hanya berlaku di Next). Jalur HTTP-nya diuji lewat TestClient dengan RBAC
tiruan; jalur penjadwal diuji live seperti tabel di atas.

**Yang WAJIB dilakukan di produksi:** set `CRON_SECRET` pada container **backend** (sekarang
hanya frontend yang punya), lalu tambahkan scheduled task tiap 5 menit:
`curl -fsS -H "Authorization: Bearer $CRON_SECRET" https://<app>/api/cron/pull-websales`.
Cron boleh dipasang lebih dulu — selama koneksi mati, ia tidak berefek apa pun.
Untuk dev lokal, `CRON_SECRET` ditambahkan ke `python_backend/.env` (gitignored).

### Temuan untuk harga bertingkat per pelanggan

`raw_data` hasil `item/list.do` **tidak memuat `priceCategory` sama sekali** (0 dari 4.182 item) — sesuai peringatan `ACCURATE_API_REFERENCE.md` bahwa `detailSellingPrice[]` hanya ada di `detail.do`. Jadi tier harga per pelanggan TIDAK bisa didapat dari sync `list.do` yang sekarang. Dua pilihan, keduanya belum dikerjakan:

- `item/detail.do` per item (4.182 panggilan, hormati 8 req/detik) lalu simpan `detailSellingPrice[]`, dipilih lewat `customer.priceCategoryId` (perlu ditambahkan ke `fields` sync customer + kolom baru).
- `item/get-selling-price.do` per baris saat pratinjau — tanpa tabel baru, tapi menambah latensi dan panggilan API per ketikan; perlu cache.

Sync modul lain (`item_stock`, `sales_invoice`, `sales_return`) belum dijalankan di lokal.

### Batas verifikasi yang jujur

- Jalur gagal-aman terbukti live di browser: pratinjau menampilkan "Harga belum tersedia dari Accurate untuk: <kode>".
- Jalur sukses juga terbukti live setelah migrasi: satu item uji (`id=999000001`, harga 30.000) disisipkan ke tabel `item` yang kosong, lalu order 10 PCS menghasilkan "Perkiraan: bruto 300000.00 - diskon 15000.00 - netto 285000.00" dengan saran **"Tambah 10 PCS lagi untuk diskon 10%"** muncul di dua tempat (di bawah barisnya dan di banner). Item uji sudah dihapus; tabel `item` kembali 0 baris.
- Angka dari harga Accurate sungguhan SUDAH terbukti (item `13011010500000`, harga 13.120). Yang masih belum: harga bertingkat per pelanggan (lihat temuan `priceCategory` di atas).

### Keputusan dan batas terbuka pada tahap 3

- **Harga tidak pernah datang dari klien, tapi sales tetap melihatnya.** Jalur Web Sales mengirim kuantitas; harga diambil server dari tabel `item` hasil sync Accurate dan dikembalikan sebagai pratinjau. Yang masih menerima harga dari form hanya input internal oleh staf (setara input manual hari ini) dan ordernya berstatus `draft` sampai diverifikasi.
- Langkah berikutnya untuk harga bertingkat per pelanggan: tambahkan `priceCategoryId` pada sync `customer` dan simpan `item.detailSellingPrice[]` (atau panggil `item/get-selling-price.do` per baris). Belum dikerjakan; `item.unitPrice` dipakai sementara.
- Order internal disimpan di SQLite bersama draft Summary, bukan di Postgres D4. Alasannya pembekuan aturan dan penulisan order menjadi satu transaksi. Permintaan order Web Sales berada di basis data SQLite yang berbeda. 1.500 order/hari jauh di bawah kapasitas SQLite WAL. Pindahkan ke Postgres bila order perlu di-join dengan modul Postgres lain.
- Untuk deployment: `WEBSALES_STORE_PATH` dan `SUMMARY_STORE_PATH` WAJIB menunjuk ke dua volume/berkas berbeda, dan proses Web Sales tidak boleh mendapat akses ke `SUMMARY_STORE_PATH`.
- Bonus `bonus_scope=purchased` mengembalikan `eligible_codes`; pemilihan SKU bonus terjadi di tahap order/faktur dan belum ada UI pemilihannya.
4. Worker lima menit + autentikasi/penulisan Accurate: PENDING.
5. Faktur -> Rekapan Nota + end-to-end validation: PENDING.

## Aturan correctness
- AI mengekstrak draft; angka transaksi dihitung deterministik oleh aturan yang diterbitkan.
- Versi aturan dan hasil perhitungan dibekukan pada order; promo baru tidak mengubah transaksi lama.
- Data sumber OCR, scope pengguna, model/prompt/master version, serta completeness disimpan.
- Timeout setelah write Accurate = UNKNOWN, bukan langsung retry create.
- Identitas dokumen: Accurate database + record ID; nomor faktur bukan identitas unik.
- Antrean persisten, satu worker per koneksi, transaksi DB singkat tanpa menunggu network.
- Database uji terisolasi dari database pengguna; bukti mock tidak disebut bukti live Accurate.
- Tidak mem-publish/merge atau menulis faktur produksi tanpa validasi hasil yang bisa ditinjau.

## Lingkungan validasi
- Native PostgreSQL 18 yang sudah terpasang; cluster baru khusus validasi di `%LOCALAPPDATA%/AccAPI/surya-validation-pg`.
- Listen `127.0.0.1:55432`, database `surya_validation`, role lokal `surya_validation`.
- Auth trust hanya untuk cluster uji loopback; tidak digunakan untuk deployment.
- Schema dasar berhasil diterapkan lewat Drizzle pada database uji kosong.
- Next.js development `http://127.0.0.1:3000`, localhost auth bypass bawaan proyek.
- Workspace sudah memiliki perubahan reconciliation dan banyak artefak untracked sebelum pekerjaan; jangan revert/stage massal.

## Sumber resmi yang telah diperiksa
- https://docs.mistral.ai/models/ocr-4-1
- https://help.mistral.ai/en/articles/347612-can-i-activate-zero-data-retention-zdr
- https://accurate.id/api-integration/batasan-pemanggilan-api/ (8 request/detik, 8 proses serentak)
- https://accurate.id/api-integration/oauth/ (Authorization Code + refresh token)
- https://accurate.id/api-integration/api-example/

## Handover aktif — 7 September 2026

Dokumen ini adalah checkpoint di disk, bukan bukti seluruh proyek selesai. Perbarui setelah setiap tahap tervalidasi dan sebelum berhenti. Jangan menyimpan credential atau isi dokumen pelanggan di handover.

### Posisi berhenti dan tindakan pertama

- Instruksi terbaru: tahap 2 selesai dan tervalidasi live dengan surat Priskila; tahap 3 berjalan dengan basis data Web Sales yang dipisah dari internal. Sisa tahap 3: aplikasi Web Sales terpisah dan identitas sales. Tahap 4–5 belum dikerjakan.
- Catatan lingkungan: `/api/me` pada FastAPI lokal menjawab `authenticated: false` karena bypass auth hanya berlaku di Next; uji UI dilakukan dengan launcher scratchpad yang menyuntik identitas uji ke referensi `get_current_user`. Kode produksi TIDAK memiliki bypass; jangan menambahkannya.
- Checkout: `D:\AccAPI\_github_clean`. Pekerjaan ini **sudah di-commit dan di-push** ke branch
  **`feat/surya-workspace`** (dicabangkan dari `feat/rekapan-nota` @ `c9f8d98`), commit
  `608ab9e` — 45 file, +4.493/-1.528. PR belum dibuat:
  https://github.com/muharirsp-sys/AccAPI/pull/new/feat/surya-workspace
- Cherry-pick sengaja: hanya file milik tahap 1–3. **TIDAK ikut** (tetap milik pekerjaan lain,
  masih uncommitted di working tree): `app/(dashboard)/reconciliation/page.tsx`,
  `docs/REKONSILIASI_HANDOFF_FAKTUR_PEMBELIAN_RETURN.md`,
  `lib/off-program-control/sales-reconciliation.ts` + test-nya, `CLAUDE.md`,
  `docker-compose.metabase.yml`, `docs/form-kerja/`, `dashboard-generator/`,
  `docs/handover/*` lama, dan eksperimen OCR lama (`ab_*.py`, `chandra_ocr_adapter.py`,
  `mistral_ocr_adapter.py`, `ocr_text_compare.py`, `python_backend/data/`).
- `python_backend/api_key_mistral.txt` dimasukkan ke `.gitignore` pada commit ini. File aslinya
  TIDAK dihapus; hanya dicegah masuk repo. Temuan pengemasan `.next` tetap harus dibereskan
  sebelum deployment.
- **PR #24 sudah dibuat ke `main`**: https://github.com/muharirsp-sys/AccAPI/pull/24
  HEAD branch `1cd2d95` — `origin/main` (2 commit insentif: `48d279d`, `d7b1328`) sudah
  di-merge MASUK ke branch ini tanpa konflik, dan hasil gabungannya diverifikasi ulang:
  `tsc` bersih, 3 uji navigasi, 4 uji insentif (`insentif-konstanta`, `insentif-mt-calc`,
  `insentif-pph`), dan 3 self-check Python semuanya lulus.
- **BELUM di-merge ke `main`, dan ini bukan masalah teknis.** Ruleset repo
  **"Protect main with AccAPI Guardian"** pada `refs/heads/main` mensyaratkan: 1 approving
  review + code owner review + persetujuan ekstra untuk perubahan tak-terkait-author, DAN
  status check **"Deterministic risk gate"** (integration id 15368, `strict` policy) yang
  sampai sekarang belum melaporkan apa pun. `bypass_actors` KOSONG. Status PR:
  `mergeable: MERGEABLE`, `mergeStateStatus: BLOCKED`, `reviewDecision: REVIEW_REQUIRED`.
  `gh pr merge --admin` TIDAK dipakai: gate itu sengaja dipasang pemilik repo dan perubahan
  ini langsung memicu deploy produksi. Perlu approval manusia.

### Master Accurate untuk order sales — dibuktikan live 2026-09-09

Seluruh nama field di bawah ini datang dari **probe live** ke DB CV Surya Perkasa
(`iris.accurate.id`), bukan dari spec. Alasannya tercatat di `ACCURATE_API_REFERENCE.md`: spec
resmi Accurate tidak punya response schema sama sekali, dan **field yang tidak dikenal diterima
tanpa error lalu diabaikan diam-diam**. Setiap klaim di sini punya bukti panggilannya.

#### Temuan yang mengubah pemahaman sebelumnya

1. **"Cabang" di database ini berarti DIVISI PRINCIPAL, bukan kota.** 22 cabang: Kantor Pusat
   (id 50, default), MIX FOOD, MIX NON FOOD, FORISA, HEINZ, UNIBIS, ABC, URC, SHINZUI, PURATOS,
   PRIMARASA, VINDA, FORISA - MT, DOLPHIN, ENERGIZER, KINO NON FOOD, RECKITT, MONTISS, MOTASA,
   CUSSONS, GODREJ, MSM. **Koreksi atas catatan sebelumnya:** kolom `branch` pada `sales_targets`
   yang saya sebut "tercampur nama principal" ternyata memang memakai kosakata cabang Accurate.
   Yang justru tidak cocok adalah `sales_profile` (BANDUNG/CIMAHI/SUMEDANG) — itu data contoh.
2. **Satu outlet fisik punya customerNo BERBEDA per cabang** — mis. `C-100005-RB` (RECKITT) dan
   `C-100005-VIN` (VINDA) untuk outlet yang sama. Order wajib memakai customerNo cabang yang benar.
3. **`item/list.do` tidak membawa nama satuan sama sekali.** `unit1Name` dkk diabaikan diam-diam;
   hanya `ratio2`/`ratio3` yang lolos. Satuan hanya ada di `item/detail.do`.
4. **Tipe outlet dan tier harga adalah DUA master berbeda** walau beberapa namanya sama.
   `customer.category` = tipe outlet (9 nilai: TT, MT, NKA, KANVAS, MOTORIST, BTL, INDOGROSIR,
   EKSPEDISI, Umum); `customer.priceCategory` = tier harga (termasuk ALFAMART, INDOMARET,
   DIAMOND, HARGA KHUSUS yang tidak ada di daftar tipe outlet).

#### Penomoran faktur per cabang

`auto-number/list.do` -> 155 baris. `transactionType='SI'` adalah seri Faktur Penjualan, 23 buah,
satu per principal. **Tidak ada satu pun field cabang di dalamnya**, dan `auto-number/detail.do`
menjawab **404** — endpointnya tidak ada. Jadi pasangan cabang -> seri tidak bisa ditanyakan ke
Accurate dan harus disimpan sendiri.

`lib/branch-auto-number.ts` memasangkannya deterministik dari nama seri, dengan dua pengaman yang
lahir dari data nyata:

- **Alias eksplisit** untuk singkatan: `MF`->MIX FOOD, `MNF`->MIX NON FOOD, `FR`->FORISA,
  `FR - MT`->FORISA - MT. Ditulis satu per satu, bukan pencocokan samar — justru singkatan mirip
  (`MF` vs `MNF`) yang paling berbahaya kalau ditebak.
- **Seri "Faktur Pembelian ..." yang bertipe SI ditolak.** Dua seri seperti itu ada sungguhan
  (`Faktur Pembelian MSM`, `Faktur Pembelian Vinda`); memakainya berarti faktur penjualan
  menempel pada penomoran pembelian.

Hasil pemasangan (lokal, otomatis dijalankan ulang tiap sync `branch`/`auto_number`):
**20 dari 22 cabang terpasang.** Dua yang kosong bukan kegagalan:

| Cabang | Sebab |
|---|---|
| Kantor Pusat (50) | tidak punya seri Faktur Penjualan sama sekali |
| URC (551) | serinya ada (`Faktur Penjualan URC`, id 352) tapi **suspended** di Accurate |

Cabang tanpa seri sengaja dibiarkan NULL dan jalur faktur menolaknya. Nomor faktur yang masuk
seri cabang lain tidak bisa ditarik kembali dari pembukuan.

#### Satuan

`unit/list.do` -> **37 satuan**, dan ruang id-nya **sama** dengan `item.unitNId` (dibuktikan:
PCS=50 dan KRT=100 identik di kedua sumber). Jadi master ini sah dipakai sebagai
`detailItem[].itemUnitId` saat membuat faktur.

Pemeriksaan silang yang penting: **nol** nama satuan pada 2,3 juta baris `item_selling_price`
yang tidak ada di master satuan. Artinya `itemUnitId` selalu bisa diresolusi — tidak ada baris
order yang akan gagal di Accurate karena satuannya asing.

Satuan item ikut terisi oleh `scripts/sync-item-selling-price.ts` **tanpa satu pun panggilan API
tambahan**, karena skrip itu memang sudah memanggil `item/detail.do` per item. Uji batch 40 item:
40/40 terisi (mis. `F4013001007010` PCS(50) + KRT(100), ratio2 72).

#### Yang sudah tersinkron di LOKAL

| Modul | Hasil |
|---|---|
| `branch` | 22 baris |
| `auto_number` | 155 baris, 20 cabang terpasang serinya |
| `unit` | 37 baris |
| `customer` | 32.450 baris — 32.448 punya tier harga, 32.072 tipe outlet, 32.070 cabang |
| `item` + satuan | **4.182 item, 4.182 bersatuan (100%), semuanya multi-satuan** |
| `item_selling_price` | 2.330.900 baris, 4.182/4.182 item, 0 item tanpa detail, 1.368 detik |

Pemeriksaan silang terakhir setelah sync penuh: **nol** nama satuan pada `item.unit1..5` yang
tidak ada di master satuan, dan **nol** nama satuan pada 2,3 juta baris harga yang tidak ada di
master satuan. Jadi setiap baris order bisa dipetakan ke `itemUnitId` yang sah.

Sebaran tipe outlet: TT 29.210, MT 2.045, Umum 649, NKA 154, EKSPEDISI 7, MOTORIST 5,
INDOGROSIR 2, kosong 378.

#### Produksi: migrasi sudah, sync BELUM BISA

`db/migrations/0006_accurate_order_masters.sql` sudah diterapkan ke Postgres produksi dan
diverifikasi (4 kolom customer, 15 kolom satuan/ratio item, 3 tabel baru, 1 kolom seri di
`branch`). Kodenya juga sudah ter-deploy (PR #28).

Awalnya sync produksi gagal 500 karena token Accurate tidak bisa didekripsi. Sudah pulih
2026-09-09 setelah bug jalur login diperbaiki dan login ulang dilakukan di produksi; angka
final ada di bagian "PRODUKSI TERSINKRON PENUH".

### Tahap 5 (Rekapan Nota) — jalurnya sudah dilacak sampai dasar, 2026-09-09

Modul Rekapan Nota yang ada **belum pernah dipakai dengan data nyata**: `rekap_upload` 0 baris,
`wave_line_pool` 0 baris, `wave` 0 baris. Yang sudah terkonfigurasi hanya 17 `pick_group`.
Artinya tidak ada data historis untuk dijadikan acuan bentuk kolom — ini yang membuat
penelusuran di bawah perlu dilakukan lewat kode, bukan lewat contoh data.

**Sumber datanya sejak awal memang faktur Accurate.** `app/api/rekapan-nota/upload` memarse
export Accurate "Rincian Faktur Penjualan". Jadi tahap 5 bukan membangun sumber baru, melainkan
mengganti pengantarnya: dari file Excel yang diunduh orang menjadi panggilan API.

Dimensi pengelompokan cetak gudang — dilacak dari `lib/rekapan-nota/query.ts`:

| Dimensi | Sumber sebenarnya | Siap? |
|---|---|---|
| `area` | **`customer.area`** (bukan kolom `region` pada pool) | 19.746 dari 32.458 pelanggan terisi |
| `outlet_all` | `customer.grup_all` | hanya 163 terisi; sisanya jatuh ke "Gabung" |
| `outlet_gdi` | `customer.grup_gdi` | hanya 548 terisi; sisanya "Gabung" |
| `volume` | dihitung (karton per nota) | butuh `qty_pcs` + konversi |
| `jenis_produk` | `wave_line_pool.jenisproduk` | **belum jelas** (lihat di bawah) |
| `sirup` | `jenisproduk = 'HEINZ ABC'` + pola kode/nama barang | ikut bergantung pada `jenisproduk` |

Kolom `region` pada pool ternyata **tidak dipakai oleh satu pun grup**, jadi ia tidak
menghalangi. Yang menghalangi hanya satu: **kosakata `jenisproduk`.**

`EKSPRESI_SIRUP` membandingkannya dengan string **`'HEINZ ABC'`**, sedangkan nama cabang
Accurate untuk principal itu adalah **`HEINZ`** (id 401). Kalau saya isi `jenisproduk` dari nama
cabang, aturan sirup akan mengembalikan NULL untuk seluruh baris Heinz — dan grup
`SRP-SIRUP`/`SRP-NONSIRUP` adalah **gudang yang terpisah secara fisik**. Salah di sini bukan
salah tampilan, tapi barang diambil dari gudang yang salah. Karena itu tidak saya tebak.

Yang SUDAH bisa diisi dari master hasil sync tanpa menebak: `tanggal`, `no_nota`, `kode_cust`,
`customer`, `kode_barang`, `nama_barang`, `qty`, `satuan`, `satuan_kecil` (`item.unit1_name`,
100% terisi), `qty_pcs` dan `konv_tersirat` (dari `item.ratio2..5` Accurate — sekaligus menutup
347 item yang `isi_per_karton`-nya kosong), serta `principal`.

Satu hambatan teknis untuk verifikasi: **satu OAuth client Accurate hanya bisa memegang satu
token aktif.** Login produksi 2026-09-09 membuat token lokal menjadi `invalid_token`, jadi probe
`sales-invoice/detail.do` dari lokal tidak bisa lagi dijalankan sampai login lokal diulang —
dan mengulangnya akan mematikan token produksi. Jangan login bergantian tanpa sadar; pilih satu
sisi saat perlu memprobe.

### Penomoran faktur per cabang benar-benar terpasang — 2026-09-09

Dua cacat ditemukan saat menyambungkan master yang baru tersinkron ke jalur faktur, dan
keduanya diam:

1. **`typeAutoNumber` masih tertulis `1`** di `buildInvoicePayload`. Artinya SELURUH faktur
   akan masuk satu seri penomoran, tak peduli cabangnya — nomor nyasar ke pembukuan cabang lain
   tanpa satu pun galat.
2. **Cabang diambil dari satu env `ACCURATE_INVOICE_BRANCH_ID`.** Satu cabang untuk semua
   faktur, dengan masalah yang sama.

Sekarang keduanya datang dari `lib/order-branch.ts` -> `resolveOrderBranch(customerNo)`:
**cabang diambil dari PELANGGAN order itu**, lalu serinya dari `branch.si_auto_number_id`.

Kenapa dari pelanggan dan bukan dari perangkat sales atau env: di Accurate ini satu outlet
fisik punya customerNo BERBEDA per cabang (`C-100005-RB` untuk RECKITT, `C-100005-VIN` untuk
VINDA), jadi cabang sudah melekat pada kode pelanggan yang dipilih. Efek sampingnya justru
yang paling berharga — **nilai ini tidak bisa dipalsukan klien, karena tidak pernah dibaca dari
permintaan.** `ACCURATE_INVOICE_BRANCH_ID` tidak dipakai lagi.

Setiap ketidakpastian MENOLAK (409), tidak memakai nilai default. Diuji atas data produksi:

| Kondisi | Jumlah pelanggan produksi | Perilaku |
|---|---|---|
| Cabang + seri aktif | **32.181** | OK — mis. `C-100005-RB` -> RECKITT -> "Faktur Penjualan Reckitt", `C-MUS026-GD` -> GODREJ -> "Faktur Penjualan Godrej" |
| Pelanggan tanpa cabang | 73 | ditolak: cabang faktur tidak dapat ditentukan |
| Cabang tanpa seri aktif | 204 | ditolak: seri penomoran tidak aktif (semuanya pelanggan URC, serinya suspended) |
| Pelanggan tidak ada di master | — | ditolak: tidak ada di hasil sync |

`buildInvoicePayload` sekarang MEWAJIBKAN `branchId` dan `typeAutoNumber` sebagai opsi (bukan
opsional), jadi pemanggil baru tidak bisa lupa dan diam-diam kembali ke seri tunggal.

Dry-run untuk ditinjau sebelum gerbang kirim dibuka:

```bash
# tanpa body `{"queue":true}` = dry-run; tidak menyentuh DB maupun Accurate
POST /api/orders/<id>/invoice
```

Responsnya kini membawa `branch` (id, nama, id + nama seri) di samping `payload`, jadi yang
ditinjau bukan hanya angkanya tapi juga seri nomor yang akan dipakai.

### PRODUKSI TERSINKRON PENUH — 2026-09-09

Seluruh 9 modul sync berstatus `idle` (tidak ada yang `error`/`syncing`).

| Modul | Baris produksi |
|---|---|
| `branch` | 22 — **20 terpasang seri Faktur Penjualan** |
| `accurate_auto_number` | 155 (23 di antaranya bertipe `SI`) |
| `accurate_unit` | 37 |
| `item` | 4.185 — **4.185 bersatuan (100%), semuanya multi-satuan** |
| `item_stock` | 4.185 |
| `item_selling_price` | **2.332.616** baris; 4.185 item, 35 satuan, 13 tier harga, 22 cabang |
| `customer` | 32.456 — 32.034 tipe outlet, 32.032 cabang, 32.034 tier harga |
| `sales_invoice` | 223.589 |
| `sales_return` | 34.720 |

Pemeriksaan silang ketepatan (bukan sekadar "sync sukses"):

| Uji | Hasil |
|---|---|
| Satuan pada 2,33 juta baris harga yang tidak ada di master satuan | **NOL** |
| Satuan pada `item.unit1..5` yang tidak ada di master satuan | **NOL** |
| Item tanpa detail saat sync harga | **0 dari 4.185** |

Artinya setiap baris order bisa dipetakan ke `itemUnitId` yang sah, dan tidak ada satuan yang
akan ditolak Accurate saat faktur dibuat.

Dua cabang sengaja tanpa seri faktur — sudah diperiksa, bukan kegagalan pemetaan: **Kantor
Pusat** tidak punya seri Faktur Penjualan sama sekali, dan seri **URC** (`Faktur Penjualan URC`,
id 352) berstatus **suspended** di Accurate. Order dari dua cabang itu akan ditolak, bukan
dinomori pada seri cabang lain.

Sync harga jual dijalankan berbatch lewat endpoint baru: 7 panggilan x 600 item, ~3 menit per
batch, total ~21 menit, `skipped: 0` pada semua batch.

### Menjalankan sync harga di PRODUKSI — jalurnya baru ada 2026-09-09

Sebelum ini tidak ada cara menjalankannya di produksi sama sekali, dan itu bukan soal kemauan:

- `scripts/` **tidak ikut ke image** — Dockerfile hanya menyalin `.next/standalone`.
- Postgres produksi **tidak dipublikasikan ke host** (`5432/tcp` tanpa binding), jadi tunnel dari
  luar juga tidak bisa tanpa membawa kredensial DB keluar server.

Logikanya dipindah ke `lib/item-price-sync.ts` dan dipakai dua pintu masuk yang berbagi satu
sumber: `scripts/sync-item-selling-price.ts` (CLI, cara pakai tidak berubah) dan
`app/api/cron/sync-item-prices` (produksi).

Endpoint-nya **berbatch, default 600 item per panggilan**, karena satu request HTTP selama 21
menit rapuh — terbukti hari ini: satu panggilan mati dengan `Empty reply from server` tepat saat
Coolify menukar container. Checkpoint `sync_state` membuat panggilan berikutnya melanjutkan, dan
respons membawa `done`/`remaining` supaya pemanggil tahu perlu memanggil lagi atau tidak.

```bash
# satu batch (ulangi sampai "done":true)
/usr/local/bin/accapi-cron.sh "/api/cron/sync-item-prices?limit=600"
# mulai dari nol
/usr/local/bin/accapi-cron.sh "/api/cron/sync-item-prices?limit=600&restart=1"
```

Jangan jalankan bersamaan dengan sync `sales_invoice`: keduanya memukul Accurate dan batas
resminya 8 request/detik.

### Bug pemulihan login Accurate — diperbaiki 2026-09-09

Kunci enkripsi token berubah, dan akibatnya bukan cuma sync mati: **login ulang pun mustahil.**
`upsertAccurateSession` memanggil `getAccurateSession` lebih dulu, yang mendekripsi baris lama —
jadi callback melempar `OAuth Callback Exception: Unsupported state or unable to authenticate
data` **sebelum** token baru sempat ditulis. Satu-satunya jalan pemulihan terhalang oleh
kerusakan yang mau diperbaiki, dan barisnya tetap usang selamanya.

Sekarang baris yang tidak bisa didekripsi diperlakukan sebagai "tidak ada", **hanya bila**
pemanggil membawa access token baru; tanpa itu error tetap dilempar. Penimpaan dicatat ke log.

Dua jebakan lain yang ikut terungkap saat ini:

1. **Login di localhost tidak memperbaiki produksi.** Dua percobaan login pertama tersimpan ke
   Postgres lokal (`updated_at` lokal maju, produksi tidak). Periksa `accurate_oauth_session`
   pada database yang DIMAKSUD, jangan percaya tampilan halaman.
2. **`BETTER_AUTH_URL` produksi masih `http://localhost:3000`.** Callback OAuth memakainya
   sebagai basis SEMUA pengalihan, jadi setelah authorize di produksi browser dilempar ke
   `localhost:3000/api-wrapper?accurate=connected` — halaman lokal yang kebetulan hidup dan
   menampilkan "connected" padahal yang tersambung bukan produksi. Sudah diminta diubah ke
   `https://web-super.online`; **periksa lagi nilainya saat resume.**

`ACCURATE_TOKEN_ENCRYPTION_KEY` sekarang di-set di produksi, jadi token tidak lagi terikat
`BETTER_AUTH_SECRET`. **Kunci itu tidak boleh diganti lagi** — menggantinya mengulang insiden ini.

### Riwayat insiden: token Accurate produksi tidak bisa didekripsi (SELESAI 2026-09-09)

Ditemukan 2026-09-09 saat sync cabang pertama gagal 500 di produksi. Sudah pulih.

- `accurate_oauth_session.access_token` produksi berbentuk benar (3 bagian `iv.tag.data`) tapi
  **tidak ada satu pun kunci di server yang bisa membukanya**: `ACCURATE_TOKEN_ENCRYPTION_KEY`
  tidak di-set, `BETTER_AUTH_SECRET` dan `AUTH_SECRET` sama-sama menjawab
  "unable to authenticate data". Datanya utuh; kuncinya yang berubah.
- Token itu dienkripsi 2026-08-11. Sync terakhir yang berhasil: 2026-09-08 11:15 WITA
  (`sync_state` semua modul). `/var/log/accapi-cron.log` berubah dari 502 menjadi 500 mulai
  slot berikutnya, jadi **kegagalan pertama 2026-09-08 sekitar 17:15** — sebelum seluruh deploy
  2026-09-09. Bukan akibat merge mana pun.
- Akibat: SELURUH sync Accurate produksi mati sejak saat itu (item, customer, stok, faktur,
  retur), dan master baru (cabang, penomoran, satuan) tidak bisa diisi.
- Pemulihan hanya lewat **login ulang OAuth Accurate di `https://web-super.online/api-wrapper`**;
  Accurate tidak memakai refresh token sehingga tokennya tidak bisa diperbarui otomatis.
- Pencegahan, dan **urutannya wajib**: set `ACCURATE_TOKEN_ENCRYPTION_KEY` di Coolify LEBIH
  DULU (kode sudah memprioritaskannya), BARU login ulang. Kalau terbalik, tokennya kembali
  terikat pada `BETTER_AUTH_SECRET` dan akan hilang lagi setiap rahasia auth berubah.

### Cabang Accurate + id penjual pada Web Sales — 2026-09-09 (sedang berjalan)

Keputusan pengguna 2026-09-09:

1. **"Setiap cabang punya penomoran sendiri" = penomoran FAKTUR Accurate per cabang.** Order
   membawa `branchId` cabang penjualnya; Accurate yang menomori. Aplikasi tidak mengarang nomor.
2. **Daftar cabang yang berlaku = daftar cabang Accurate**, bukan kosakata lokal.
3. Izin `order.*` DICABUT dari grup Salesman (lihat di bawah).

Temuan yang menentukan bentuk implementasinya: **backend Python tidak punya akses Postgres sama
sekali** (tidak ada `psycopg` maupun `DATABASE_URL`). Jadi `sales_profile` mustahil dibaca
FastAPI, dan pelampiran identitas penjual harus terjadi di sisi Next — pola yang sama dengan
harga: klien mengirim kuantitas, server melengkapi sisanya.

Yang SUDAH ada sebelum pekerjaan ini (tidak perlu dibangun): tabel `sales_profile` di produksi
sudah memetakan `user_id` -> `sales_code` (UNIQUE) + `sales_name` + `branch` + `channel` +
`spv_name`/`sm_name`. Isinya 6 baris contoh (`SLS-001`..`SLS-006`, BANDUNG/CIMAHI/SUMEDANG);
kode 100 sales asli belum ada.

Jebakan yang ditemukan: kolom `branch` pada `sales_targets` **bukan cabang geografis** — isinya
tercampur nama principal (CUSSONS, GODREJ, HEINZ ABC, FORISA - MT, MIX FOOD, ...). Karena itu
kolom cabang Accurate dibuat terpisah dan numerik, dan kolom teks lama tidak diubah supaya modul
insentif tidak ikut rusak.

Selesai pada tahap ini:

- `db/migrations/0005_branch_and_sales_branch.sql` -> tabel `branch` (id cabang **Accurate**,
  bukan id lokal) + `sales_profile.accurate_branch_id`. Aditif dan idempoten.
- `db/schema.ts` -> `branch` dan `salesProfile.accurateBranchId`.
- `lib/sync.ts` -> modul sync `branch` (`/branch/list.do`, `fields=id,name,defaultBranch,
  suspended,lastUpdate`). Karena registry modul dibaca otomatis oleh `/api/cron/sync-accurate`,
  cabang ikut tersegarkan pada jadwal 4x/hari yang sudah ada — tanpa baris cron baru.
- `lib/sync-fields.test.ts` -> penjaga sumber: **setiap** modul sync wajib meminta `id` secara
  eksplisit. Tanpa `id`, Accurate mengembalikan baris tanpa id dan seluruh upsert masuk sebagai
  NaN — gagal senyap yang pernah terjadi di produksi 2026-07-13.

Diterapkan ke Postgres produksi 2026-09-09 dan diverifikasi: tabel `branch` + 2 indeks,
`sales_profile.accurate_branch_id` bigint, hak `accapi_app` SELECT/INSERT/UPDATE/DELETE otomatis
dari `pg_default_acl`.

**Belum:** pemetaan `accurate_branch_id` untuk tiap profil sales belum diisi, dan jalur order
belum membawa `sales_code`/`branchId`. Catatan penting untuk langkah itu: 6 baris
`sales_profile` di produksi bercabang BANDUNG/CIMAHI/SUMEDANG, dan **ketiganya bukan cabang
Accurate** — jadi pemetaannya menunggu daftar kode sales dan cabang yang asli dari pengguna,
bukan sekadar pekerjaan kode.

Catatan kejujuran: `defaultBranch` dan `suspended` pada `fields` **belum terbukti live**.
Accurate mengabaikan field tak dikenal tanpa error, jadi kalau kolom itu kosong setelah sync
pertama, itu bukan bug data — nama fieldnya yang salah dan harus diperbaiki dari hasil probe.

### Izin grup Salesman dikoreksi 2026-09-09

Grup `Salesman` sempat diberi `order.create`, `order.edit`, `order.export`, `order.view`. Tiga
akibat nyatanya: `order.create` membuka `POST /orders` internal yang **menerima harga dari
klien**; `order.edit` adalah izin menarik order Web Sales ke internal; dan `order.edit` juga
membuka `scope=all` sehingga sales bisa membaca seluruh order perusahaan. Keempat izin itu
dihapus (`DELETE 4`); grup Salesman kini hanya `websales.view` + `websales.create` (plus
dashboard/form_kontrol/insentif yang memang miliknya).

### Perubahan PRODUKSI 2026-09-09 — migrasi 0004 (antrean faktur)

Atas permintaan eksplisit pengguna, sebelum merge PR #24. Pola yang sama:
`tr -d '\r' < db/migrations/0004_invoice_outbox.sql | ssh root@43.156.118.114 "docker exec -i
accapi-postgres psql -U accapi -d accapi -v ON_ERROR_STOP=1 --single-transaction"`.
(`tr -d '\r'` karena `core.autocrlf=true` membuat working copy Windows ber-CRLF.)

| Objek | Status setelah migrasi |
|---|---|
| Tabel `invoice_outbox` | dibuat, 13 kolom sesuai file migrasi, 0 baris |
| Indeks | `invoice_outbox_pkey` (order_id) + `idx_invoice_outbox_state` (state, created_at) |
| Hak `accapi_app` | SELECT, INSERT, UPDATE, DELETE — **otomatis** dari `pg_default_acl` (`accapi_app=arwd/accapi`), bukan GRANT manual |
| Tabel lain | tidak disentuh; jumlah tabel `public` 68 -> 69 |
| Idempotensi | dijalankan DUA KALI; jalan kedua hanya `NOTICE: relation ... already exists, skipping` |

Konsekuensi kalau migrasi ini dilewat (sudah tidak berlaku, dicatat sebagai alasan): jalur
penolakan `/api/cron/post-invoices` tetap membaca `invoice_outbox` untuk melaporkan kedalaman
antrean, jadi tanpa tabelnya route itu melempar 500 alih-alih menolak rapi 503.

**Gerbang kirim tetap TERTUTUP setelah migrasi ini.** Tabelnya ada, tapi
`ACCURATE_INVOICE_SEND` dan `ACCURATE_INVOICE_DB_ID` tidak di-set di produksi, jadi tidak ada
satu pun request tulis ke Accurate yang bisa terjadi. Migrasi ini hanya menyiapkan wadahnya.

### Perubahan PRODUKSI yang sudah nyata dilakukan 2026-09-08

Dilakukan atas permintaan eksplisit pengguna (opsi A: migrasi dulu, baru merge), lewat pola
resmi proyek: `ssh root@43.156.118.114` -> `docker exec -i accapi-postgres psql -U accapi -d
accapi -v ON_ERROR_STOP=1 --single-transaction` dengan isi `db/migrations/0003_item_selling_price.sql`.

Kondisi produksi SEBELUM migrasi membuktikan peringatan itu benar: `customer` **belum punya**
`price_category_id`/`price_category_name`, sehingga deploy tanpa migrasi akan mematikan sync
customer yang berjalan 4x/hari (persis kegagalan yang terjadi di lokal).

Terverifikasi SETELAH migrasi:

| Objek | Status |
|---|---|
| `item_selling_price` | dibuat + 3 indeks (`_pkey`, `idx_..._lookup`, `idx_..._item`) |
| `customer.price_category_id` / `price_category_name` | ditambahkan (bigint, text) |
| Hak role `accapi_app` di tabel baru | `select` = true, `insert` = true |

Semuanya aditif + idempoten; tidak ada data yang diubah/dihapus. Postgres produksi 16.14.
Baris produksi saat diperiksa: `item` 4.162, `customer` 32.273.

### Yang MASIH harus dilakukan di produksi sebelum/sesudah deploy

1. **`MISTRAL_API_KEY` belum di-set** di kedua container (`accapi-frontend-*`, `accapi-backend-*`;
   diperiksa dengan `printenv` tanpa menampilkan nilai). Bukan kerusakan — jalur OCR menjawab
   "MISTRAL_API_KEY belum dikonfigurasi di server" — tetapi ekstraksi Summary tidak bisa dipakai
   sampai di-set lewat env Coolify (BUKAN edit file compose).
2. **`item_selling_price` produksi masih KOSONG** (migrasi hanya membuat tabelnya). Setelah
   deploy, jalankan `scripts/sync-item-selling-price.ts` di produksi (~21 menit untuk 4.182 item,
   ~2,3 juta baris). Sebelum itu semua harga jatuh ke fallback standar — degradasi yang aman,
   bukan galat.
3. **`customer.price_category_id` produksi masih NULL** sampai sync customer berjalan dengan kode
   baru (kolomnya sudah ada, jadi sync tidak akan gagal).
4. Temuan pengemasan `.next` TIDAK lagi relevan untuk image produksi: kunci Mistral tidak pernah
   tracked dan sekarang gitignored, sedangkan build CI berasal dari checkout repo — jadi file
   kunci itu mustahil ikut ke image. Yang tersisa hanya kebersihan build lokal.

### Menjalankan ulang lingkungan lokal di sesi berikutnya

Ketiga proses lokal sudah DIMATIKAN pada akhir sesi 2026-09-08. Untuk menghidupkan lagi:

```powershell
# 1. Next dev (halaman Order Masuk, Summary, route /api/orders/preview)
npm run dev -- --port 3000

# 2. Backend promo/Summary FastAPI di :8000 — WAJIB untuk pratinjau promo.
#    Sesi ini memakai launcher scratchpad dengan identitas uji karena sesi Better Auth
#    lokal kedaluwarsa. Cara produksi-benar: login aplikasi lalu jalankan uvicorn biasa.
cd python_backend
python -m uvicorn main:app --host 127.0.0.1 --port 8000

# 3. Sync harga jual (hanya bila master/harga berubah; butuh sesi Accurate aktif)
npx tsx --env-file=.env.local scripts/sync-item-selling-price.ts          # lanjut dari checkpoint
npx tsx --env-file=.env.local scripts/sync-item-selling-price.ts --restart # dari awal

# Sync master Accurate (item/customer)
curl -H "Authorization: Bearer <CRON_SECRET dari .env.local>" `
  "http://localhost:3000/api/cron/sync-accurate?modules=item,customer"

# Probe endpoint Accurate untuk menemukan nama field (read-only)
npx tsx --env-file=.env.local scripts/probe-accurate-endpoint.ts item/detail.do id=11900 pick=detailSellingPrice max=2000
```

Catatan penting saat resume: `LOCAL_AUTH_BYPASS=true` aktif kembali di `.env.local`. Bypass ini
membuat `/api/proxy` dan halaman `/api-wrapper` TIDAK bisa memakai sesi Accurate (identitas
bypass tidak punya baris `accurate_oauth_session`), dan menutupi sesi Better Auth yang
kedaluwarsa. Matikan bypass bila harus login Accurate/aplikasi lagi. Sync cron tetap jalan
dengan bypass aktif karena memakai baris sesi terbaru, bukan user id pemanggil.
- Baca `SYSTEM_MAP.md`, lalu dokumen ini. Periksa status Git aktual; jangan mengasumsikan semua perubahan milik pekerjaan ini.
- Posisi terbaru: UI tahap 1 selesai dan tervalidasi. Pengguna dapat meninjau hasil lokal; jangan ulangi implementasi sidebar. Tahap 2–5 belum dikerjakan. Temuan pengemasan harus dibereskan sebelum deployment.
- Jangan ulangi diskusi kebutuhan yang sudah dijawab. Web Sales memang belum ada dan pembuatannya sudah diotorisasi.

### File milik tahap redesign

- `config/workspace-navigation.ts`: katalog menu tunggal, filter RBAC, pencocokan rute terpanjang.
- `components/WorkspaceNavigation.tsx`: kelompok menu, pencarian, favorit per akun, kesiapan hydration.
- `components/SidebarLayout.tsx`: shell, rail desktop, dialog mobile, identitas, navigasi bawah.
- `app/(dashboard)/page.tsx`: beranda dan direktori modul berbasis permission.
- `app/(dashboard)/layout.tsx`: meneruskan identitas akun ke shell.
- `app/layout.tsx`, `app/workspace.css`, `components/ThemeSwitcher.tsx`: Geist, tema Surya, kompatibilitas tema lama.
- `components/SidebarLayout.test.ts`, `tests/workspace-redesign.spec.ts`, `tests/sidebar-tooltip-contrast.spec.ts`, `tests/office-calm-theme.spec.ts`: pemeriksaan navigasi, browser, aksesibilitas, dan tema.
- `SYSTEM_MAP.md`, dokumen ini, `docs/design/surya-workspace-reference.png`, `docs/design/surya-workspace-desktop.png`, `docs/design/surya-workspace-mobile.png`: dokumentasi, referensi, dan screenshot hasil browser.

### Bukti dan pemeriksaan berikutnya

Pemeriksaan terbaru lulus: 3 unit navigasi; 5 browser redesign; 5 browser kompatibilitas (office-calm homepage, finance error, SPPD file input, kontras 4 tema, mobile chat). Run browser lengkap terakhir: 10 passed (31.9s). TypeScript, lint seluruh file TS/TSX redesign, dan `git diff --check` lulus setelah perubahan terakhir. Screenshot akhir dipertahankan di `docs/design/` karena `test-results/` dibersihkan Playwright pada run berikutnya.

### Temuan pengemasan — jangan gunakan artefak ini untuk deployment

- `npm run build` lolos kompilasi (29.4s), TypeScript build (36.3s), dan pembuatan 113/113 halaman. Build penuh TIDAK dinyatakan lulus: dihentikan pada finalisasi setelah ditemukan file kunci lokal ikut dikemas.
- Warning Turbopack menunjuk `app/api/cron/webhook-backfill/route.ts` -> `next.config.ts`: pelacakan melebar ke proyek. Daftar tracing route tersebut berisi 4.541 file, termasuk `python_backend/api_key_mistral.txt` yang sudah ada sebelum redesign.
- Salinan kunci ditemukan di `.next/standalone/python_backend/api_key_mistral.txt`. Proses build validasi dihentikan dan HANYA salinan artefak itu dihapus. File asli tetap ada. Isi kunci tidak dibaca/dicetak; tidak ada deployment atau push.
- Konfigurasi/source route terkait tidak diubah dalam redesign. Tindak lanjut sebelum deployment: persempit dependency/file tracing route tersebut, pastikan file rahasia/runtime tidak masuk output, lalu build ulang dan audit isi artefak. Jangan mengatasi warning dengan menghapus kunci asli pengguna.
- Pengujian UI dan kompilasi yang lulus tetap merupakan bukti validasi lokal; bukan bukti keamanan paket deployment.

Jalankan dari root workspace setelah memeriksa server lokal:

```powershell
python python_backend\test_summary_rules.py
python python_backend\test_orders.py
python python_backend\test_websales_pull.py
npx.cmd tsx --test lib\item-price.test.ts
npx.cmd tsx --test lib\accurate-invoice-write.test.ts
npx.cmd tsx lib\rbac\registry.test.ts
npx.cmd tsc --noEmit --incremental false
npx.cmd eslint components/SidebarLayout.tsx components/WorkspaceNavigation.tsx components/ThemeSwitcher.tsx components/SidebarLayout.test.ts config/workspace-navigation.ts 'app/(dashboard)/page.tsx' 'app/(dashboard)/layout.tsx' app/layout.tsx tests/workspace-redesign.spec.ts tests/sidebar-tooltip-contrast.spec.ts tests/office-calm-theme.spec.ts
npx.cmd tsx --test components/SidebarLayout.test.ts
npx.cmd playwright test tests/workspace-redesign.spec.ts tests/sidebar-tooltip-contrast.spec.ts tests/office-calm-theme.spec.ts
git diff --check
```

Screenshot baru dan sampel halaman operasional telah diperiksa; tidak ada overflow horizontal pada konten Summary/Faktur/Rekapan Nota/Rekonsiliasi di viewport 1366 dan 390 px. Kontrol unggah Summary kini memiliki teks putih pada tombol hijau dan nama file gelap. Tes UI lokal dengan auth bypass tidak membuktikan RBAC pengguna produksi, data transaksi penuh, atau keberhasilan transaksi Accurate.

### Lingkungan yang harus diperiksa ulang saat resume

- Next development terakhir berjalan di port 3000. Konfigurasi DB proses tersebut masih mengarah ke port 5432, belum ke cluster uji 55432. Periksa proses/listener sebelum menjalankan server kedua.
- PostgreSQL uji sudah dibuat dengan binary `C:\Program Files\PostgreSQL\18\bin`. Cluster: `C:\Users\Muhar\AppData\Local\AccAPI\surya-validation-pg`; DB/role: `surya_validation`; port 55432 loopback. Schema Drizzle dasar sudah diterapkan pada DB kosong ini.
- Untuk tahap DB, set `DATABASE_URL` hanya pada proses lokal yang dijalankan: `postgres://surya_validation@127.0.0.1:55432/surya_validation`. Jangan mengubah koneksi produksi atau menjalankan schema push pada DB lain.
- Launcher pg_ctl sebelumnya masih menunggu pohon proses PostgreSQL; status menunggu bukan kegagalan server. Kelola cluster ini dengan pg_ctl dan path eksplisit. Jangan menghentikan service/cluster PostgreSQL pengguna.
- Proses dan ID sesi terminal mungkin tidak bertahan setelah restart aplikasi; periksa kembali, jangan mengandalkannya sebagai checkpoint.

### Tahap 2 — file dan kontrak yang sudah ada

- `python_backend/summary_mistral.py`: satu panggilan `POST https://api.mistral.ai/v1/ocr`, `model=mistral-ocr-4-1`, semua halaman dikirim eksplisit, `document_annotation_format` JSON schema ketat. Menolak PDF terkunci/rusak/>20 MB/>`SUMMARY_MAX_OCR_PAGES` (default 8), menolak hasil dengan halaman kurang atau duplikat, dan tidak pernah menyimpan hasil parsial. Cache berkunci pemilik + hash PDF + hash master + model + versi pipeline. Dokumen dan katalog dinyatakan UNTRUSTED DATA di prompt.
- `python_backend/summary_store.py`: SQLite WAL lintas proses; `JsonStore` menggantikan cache master/output in-memory, draft menyimpan sumber PDF sebagai blob milik pemilik.
- `python_backend/summary_rules.py`: `Program`/`Tier` Pydantic strict, `compile_programs` (baris -> aturan, tanpa menebak), `calculate` (Decimal, tier tertinggi, mix, stacking eksplisit, alokasi sen tanpa selisih).
- `python_backend/routers/summary_library.py`: `/summary/library` list, detail, source PDF privat, save, publish, withdraw, simulate, feed `published`.
- `python_backend/test_summary_rules.py`: satu file self-check tanpa framework; jalankan setelah menyentuh aturan promo.
- Sisa risiko yang belum dibuktikan: biaya nyata per surat produksi belum diukur (surat 9 halaman = 9 panggilan anotasi), perilaku dengan sesi login pengguna asli, dan surat dengan tabel CUT PRICE/DISC_RP produksi (surat Priskila Maret 2026 hanya berisi paket bonus).
- `mix` hanya diaktifkan bila suratnya menulis "mix"/"campur". Untuk surat Priskila, "Beli 4" atas kelompok 6 varian berarti 4 pcs SKU yang sama; peninjau harus menambah kata mix bila suratnya mengizinkan campur. Jangan membaca atau menyalin file API key ke output/handover; gunakan secret server (`MISTRAL_API_KEY`).
- AI menghasilkan draft aturan. Perhitungan tier/mix/bonus/stacking/nilai/rupiah harus deterministik dan versi aturan dibekukan pada order. Tinjauan draft sebelum publikasi adalah rancangan kontrol implementasi, bukan persetujuan admin untuk setiap order.
- Accurate: `lib/accurate-session.ts` menyimpan access token/session terenkripsi; callback OAuth belum menyimpan refresh token. Outbound harus terikat petugas dan database eksplisit; jangan gunakan fallback sesi pengguna terbaru/DB pertama untuk penulisan faktur.
- Batas resmi Accurate: 8 request/detik dan 8 serentak. Perhitungkan trafik sinkronisasi lama bersama worker baru. OAuth mendukung refresh token; dokumentasi lokal lama perlu dikoreksi.
- `app/api/ext/changes/route.ts` adalah feed master internal -> sales, bukan antrean order masuk. Rancangan awal berada di `docs/prd/INTEGRASI_WEB_SALES.md`; cycle pengguna adalah 5 menit, mengalahkan interval lama di rancangan.
- Timeout setelah pengiriman faktur harus menjadi status tidak pasti dan direkonsiliasi; kunci unik lokal saja tidak menjamin tidak ada faktur ganda di Accurate. Field referensi/query remote wajib dibuktikan sebelum mengklaim idempotensi.
- Gudang: `app/api/rekapan-nota/upload/route.ts` -> `rekap_upload`/`wave_line_pool` -> `lib/rekapan-nota/query.ts`. Integrasi otomatis harus mencegah ganda antara impor Excel dan API, membawa bonus/satuan, serta menangani perubahan/pembatalan setelah wave dilepas.
- Identitas faktur adalah database Accurate + record ID. Nomor nota dapat digunakan ulang setelah penghapusan. Jangan deduplikasi global hanya berdasarkan nomor nota.
- Validasi live Mistral/Accurate belum dilakukan; tidak ada bukti siap produksi untuk tahap 2–5.

### Perubahan bawaan yang harus dipertahankan

Sudah dirty sebelum redesign: `app/(dashboard)/reconciliation/page.tsx`, `docs/REKONSILIASI_HANDOFF_FAKTUR_PEMBELIAN_RETURN.md`, `lib/off-program-control/sales-reconciliation.ts`, test pasangannya, dan gitlink `.claude/worktrees/agent-aaac9a19b50b4ba84`. Banyak artefak untracked lain juga sudah ada, termasuk eksperimen OCR, laporan, dan handover lama. Jangan revert, hapus, atau stage massal. Handover ini tersimpan lokal; belum menjadi backup remote.

### Yang paling mendesak berikutnya

1. ~~Satuan pada order dari master Accurate~~ — SELESAI 2026-09-08 (lihat bagian di atas).
   Sisanya: satuan pada **aturan promo** masih dari surat, bukan master.
2. ~~Aplikasi Web Sales + identitas 100 sales~~ — SELESAI 2026-09-08 sebagai halaman `/sales`
   di web internal dengan izin `websales` terpisah. Sisanya: pencarian barang/pelanggan,
   notifikasi push, dan pembatasan pelanggan per sales.
3. ~~Worker penarik 5 menit~~ — SELESAI 2026-09-08 sebagai cron 5 menit + tombol koneksi.
4. Tahap 4 (faktur Accurate) DIBANGUN tapi belum pernah mengirim — gerbang masih tertutup dan
   nama field request `save.do` belum terbukti. Tahap 5 (Rekapan Nota) belum disentuh.
5. Skema DB dev lokal masih tertinggal beberapa modul utuh (`app_setting`, `pick_group`,
   `rekap_upload`, `wave_line_pool`, `reconciliation_*`), sehingga `0002_rekapan_nota.sql`
   belum bisa diterapkan. `drizzle-kit push` TIDAK dijalankan karena bisa menghapus kolom.

### Posisi akhir sesi 2026-09-08 (empat commit LOKAL, belum di-push atas permintaan pengguna)

| Commit | Isi |
|---|---|
| `e21de22` | Satuan order dari master Accurate (bukan input bebas) |
| `f7db064` | Penarikan order Web Sales otomatis 5 menit lewat cron |
| `7343dac` | Halaman Order Sales + izin `websales` terpisah dari `order` |
| `e17a4a5` | Jalur faktur Accurate dibangun penuh, gerbang kirim masih tertutup |

Pengguna memilih **menahan push**: PR #24 tetap pada isi lamanya sampai diminta. Working tree
kembali hanya berisi pekerjaan rekonsiliasi + eksperimen OCR lama yang memang sudah ada
sebelum sesi ini; tidak ada berkas sesi ini yang tertinggal tanpa commit.

**Tahap 5 (Rekapan Nota) BELUM BISA DIKERJAKAN, dan ini bukan soal waktu.** Masukannya adalah
faktur yang sudah terverifikasi di Accurate, dan tahap 4 belum pernah mengirim satu pun. Lebih
dari itu, DB dev lokal tidak punya tabel modul ini sama sekali (`app_setting`, `rekap_upload`,
`wave_line_pool` tidak ada, sehingga `0002_rekapan_nota.sql` gagal diterapkan) — jadi apa pun
yang dibangun untuk tahap 5 sekarang tidak bisa divalidasi sedikit pun di lokal. Prasyarat
sebelum tahap 5: (a) satu faktur uji tahap 4 terbukti benar, (b) skema modul Rekapan Nota ada
di DB dev, TANPA `drizzle-kit push` (push bisa menghapus kolom/tabel yang ada di DB tapi tidak
ada di schema — keputusan pengguna dulu sebelum itu dijalankan).

Env baru yang dipakai sesi ini (semua fail-closed bila kosong):
`CRON_SECRET` (juga di container **backend**), `ACCURATE_INVOICE_SEND`,
`ACCURATE_INVOICE_DB_ID`, `ACCURATE_INVOICE_USER_ID` (`ACCURATE_INVOICE_BRANCH_ID` SUDAH TIDAK DIPAKAI sejak 2026-09-09 — cabang diambil dari pelanggan),
`ACCURATE_INVOICE_BATCH` (opsional, default 20). Untuk dev lokal `CRON_SECRET` sudah
ditambahkan ke `python_backend/.env` (gitignored).

## TAHAP 6 (BARU) — Gerbang validasi program Kino sebelum faktur naik ke Accurate

Diminta pengguna 2026-09-10 dengan lampiran nyata. **Belum satu baris kode pun dikerjakan** —
sesi berhenti di titik keputusan. Bagian ini adalah seluruh konteksnya.

### Apa yang diminta, disusun ulang

Bukan sekadar mengganti upload manual menjadi API. Yang diminta adalah **rekonsiliasi tiga arah**:

```
A. SURAT PROGRAM (PDF)  -> aturan promo terbit    = yang SEHARUSNYA diberikan
B. DATA KINO (xlsx)     -> DISC_1..8, TOTAL_PROMO = yang KATA KINO diberikan
C. ACCURATE             -> faktur tercatat        = yang NYATA masuk pembukuan
```

Alurnya:

1. Surat -> aturan terbit. **Hanya program on-faktur.**
2. Data Kino masuk, diterjemahkan ke kode internal lewat KINO.xlsx.
3. **Gerbang validasi (A vs B).** Sistem menghitung ulang diskon dari aturan terbit lalu
   membandingkan dengan angka Kino. Cocok -> boleh naik ke Accurate. Tidak cocok -> **DITAHAN**,
   wajib ditinjau manusia.
4. Kirim ke Accurate lewat API (bukan upload manual), diskon klaim sudah terhitung.
5. **Rekonsiliasi balik (C vs B)** — memastikan yang masuk Accurate sama dengan data Kino.
   Menyambung ke modul rekonsiliasi yang sudah ada.
6. Ada program tambahan -> surat baru -> ulangi 1, lalu 3 dan 5 lagi.

### Keputusan pengguna 2026-09-10

| Pertanyaan | Jawaban |
|---|---|
| Yang diunggah ke Accurate | **Faktur penjualan ke outlet** (ORDER_DETAIL = penjualan Surya ke outlet yang dilaporkan ke Kino) |
| Toleransi selisih | **Rp 1 per faktur** — hanya menyerap pembulatan |
| Siapa peninjau | **Atur di RBAC** — jadi permission baru, bukan role yang di-hardcode |
| Surat pertama | **Keempat surat on-faktur sekaligus** (lihat hambatannya di bawah) |

### Lampiran yang dipakai (ADA DI `C:\Users\Muhar\Downloads`, BUKAN di repo)

5 PDF surat Kino September 2026 + `KINO (1).xlsx` + `ORDER_DETAIL_20260903_20260903 (3).xlsx`.
**Sesi baru harus meminta ulang lampirannya** — tidak disalin ke repo karena berisi data
pelanggan dan harga.

- **Kelima surat berlapis teks, BUKAN scan.** `pypdf` dan `pymupdf` sudah ada di container
  backend produksi, jadi surat Kino bisa diparse deterministik **tanpa OCR sama sekali** —
  lebih murah dan lebih tepat daripada jalur Mistral yang dipakai untuk surat hasil scan.
- Field surat berlabel: `NO. PROMO ID`, `Kode Aju`, `PID External`, `Nama Program Promo`,
  `Periode Promo`, `Divisi`, `Brand`, `Group Of Promo`, `Type Of Promo`, `Class Of Promo`,
  `Activity Promo`, `Mekanisme Promo`, `Detail Promo`, `Outlet/Account`.
- **Klasifikasi on-faktur itu MEKANIS**, dari field `Mekanisme Promo`:

| Surat | Mekanisme Promo | Status |
|---|---|---|
| BP2609006016 MSG ALL BRAND | `CB ON FAKTUR VALUE` | on faktur — tier nilai |
| BP2609008021 SMALL PACKAGE | `CB ON FAKTUR DISC %` | on faktur — diskon 1% |
| BP2609007664 OVALE 2IN1 | `BONUS BARANG ON FAKTUR` | on faktur — bonus barang |
| BP2609007713 RESIK V | `BONUS BARANG ON FAKTUR` | on faktur — bonus barang |
| BP2609007909 MTI CONSUMER | `ADDITIONAL DISCOUNT` / class `DISC ON PO` | **BUKAN on faktur — dikecualikan** |

- `KINO (1).xlsx` **bukan format upload**, melainkan tabel terjemahan: sheet
  `Mapping_Customer` (1.433 baris, Code Kino -> Code Internal), `Mapping_Prd` (678 baris,
  KODE ITEM / Kode Alias / Satuan / ISI), `Mapping_Sls` (10 baris, SLSMAN_ID -> Code Internal).
- `ORDER_DETAIL` = versi Kino atas transaksi yang sama, 49 kolom. Yang penting: `SLSMAN_ID`,
  `CUST_ID1` (kode Kino), **`CUST_ID2` sudah berisi kode internal kita** (mis. `C-GAL006`),
  `CUST_TYPE1/2/3` (General Trade / Retail / Cosmetic Store), `SO_NO`, `SO_DATE`, `PRD_ID`
  (kode Kino), `QTY`, `PRICE`, `GROSS`, `DISC_1`..`DISC_8`, `TOTAL_DISC`, `CASH_DISC`, `TAX`,
  `TOTAL_PROMO`, `NET`, `FLAG_BONUS`, `INVOICE_NO`, `INVOICE_DATE`.
- Catatan: file `ORDER_DETAIL` tidak bisa dibuka openpyxl langsung (stylesheet rusak,
  "Colors must be aRGB hex values"). Akalinya: salin ulang zip-nya dengan `xl/styles.xml`
  diganti stylesheet minimal, baru dibaca.

### Mekanisme surat, verbatim (supaya sesi baru tidak perlu membaca PDF lagi)

**MSG ALL BRAND** (`CB ON FAKTUR VALUE`, periode 1–30 September 2026):
> PROGRAM INI KHUSUS CHANNEL GT EXCLUDE LOYALTY DAN CONTRACTUAL. REWARD DIBERIKAN DENGAN
> MINIMAL TRANSAKSI: 1JT–1.99JT potongan on faktur 20.000; 2JT–2.99JT 40.000; 3JT–3.99JT
> 60.000; 4JT 80.000; 5JT 100.000; 6JT 120.000; 7JT 140.000; 8JT 160.000; 9JT 180.000;
> 10JT UP 200.000. Outlet/Account: ALL.

**OVALE 2IN1** (`BONUS BARANG ON FAKTUR`):
> KHUSUS CHANNEL GT PESERTA LOYALTY. KHUSUS BRAND OVALE 2IN1 CLEANSER. SETIAP PEMBELIAN
> 30 PCS OVALE 2IN1 CLEANSER MIX VARIANT MENDAPATKAN BONUS 1 PCS PRODUK DENGAN HARGA YANG
> SAMA (BERLAKU KELIPATAN).

**RESIK V** (`BONUS BARANG ON FAKTUR`) — **EMPAT sub-program**, masing-masing 30 PCS -> bonus
1 PCS harga sama, berlaku kelipatan: Khasiat Manjakani (MIX VARIANT), Manjakani Whitening
(MIX VARIANT), Khasiat Ramuan Madura Whitening (MIX VARIANT), dan **Godokan Sirih TANPA
"MIX VARIANT"**. Semuanya khusus GT PESERTA LOYALTY.

**SMALL PACKAGE** (`CB ON FAKTUR DISC %`):
> KHUSUS CHANNEL GT EXCLUDE PESERTA IKATAN LOYALTY / HYBRID / CONTRACTUAL & MSG (HIT LIST
> OUTLET TERLAMPIR). **KHUSUS LD JAWA SESUAI LIST TERLAMPIR.** DISC ON FAKTUR 1%. Size tiap
> package mengikuti lampiran. Brand/sub-brand: B&B, Sleek Baby, Ellips, Eskulin, Ovale,
> Resik V, Sasha Hair.

### Empat temuan yang MENGHALANGI "terbitkan keempatnya"

1. **Dimensi kelayakan outlet belum ada di model aturan.** Dua program mensyaratkan PESERTA
   LOYALTY, dua lainnya EXCLUDE LOYALTY/CONTRACTUAL. Model `summary_rules.Program` hanya punya
   `channel` (GT/RETAIL). Kalau keempatnya diterbitkan apa adanya, **semuanya berlaku untuk
   setiap outlet** — outlet loyalty menerima potongan MSG yang seharusnya tidak boleh, dan
   sebaliknya. Ini diskon salah orang, bukan selisih pembulatan.
2. **SMALL PACKAGE kemungkinan tidak berlaku untuk Surya.** Suratnya "KHUSUS LD JAWA",
   sedangkan cabang pada ORDER_DETAIL adalah `1201671 SURYA PERKASA / SULAWESI SELATAN`.
   Menerbitkannya menciptakan potongan 1% yang tidak bisa diklaim. **Belum dikonfirmasi.**
3. **RESIK V harus jadi empat aturan terpisah**, dan yang Godokan Sirih `mix=false`. Model
   sudah menangani beda ini dengan benar (mix hanya aktif bila suratnya menyebut), tapi
   keempatnya jangan digabung.
4. **`Mapping_Prd` tidak punya kolom brand/sub-brand.** Memetakan "OVALE 2IN1 CLEANSER" ke
   daftar kode hanya bisa lewat pencocokan NAMA barang — jenis pencocokan samar yang sudah
   pernah menyusahkan master Priskila, dan di sini akibatnya bonus SKU yang salah.

### Yang MASIH DIBUTUHKAN dari pengguna

- **Lampiran HIT LIST OUTLET** untuk MSG dan SMALL PACKAGE (daftar outlet
  loyalty/hybrid/contractual/MSG). Tanpa ini temuan #1 tidak bisa ditutup.
- **Lampiran size/paket** SMALL PACKAGE.
- Konfirmasi apakah SMALL PACKAGE memang tidak berlaku untuk Makassar.
- Lampirkan ulang 7 file itu di sesi baru.

### Rencana yang arahnya sudah disampaikan (belum dikerjakan)

1. **Dimensi kelayakan outlet** pada aturan promo: nilai `LOYALTY`/`HYBRID`/`CONTRACTUAL`/`MSG`
   dengan mode "hanya" atau "kecuali". Dipakai aturan promo DAN gerbang validasi.
2. **Parser surat Kino deterministik** (`pypdf`, tanpa OCR) + filter on-faktur mekanis.
3. Terbitkan **MSG ALL BRAND** lebih dulu — satu-satunya yang mekanismenya lengkap tanpa
   lampiran (tier nilai murni, semua brand HPC, tanpa perlu kode barang), dengan catatan
   eksplisit bahwa pengecualian loyalty belum aktif.
4. Baru bangun gerbang validasi (toleransi Rp 1), permission peninjau di RBAC, pengiriman ke
   Accurate, dan rekonsiliasi balik.
5. UI/UX dirancang SETELAH bentuk model aturannya pasti (pengguna minta pakai taste-skill).
   Merancang layar di atas model yang masih akan berubah hanya akan dikerjakan dua kali.

### Tahap 6 langkah 1–2 SELESAI — 2026-09-10 (sesi lanjutan)

Dua dari lima langkah rencana di atas sudah dikerjakan dan lolos self-check. Langkah 3–5
(terbitkan MSG, gerbang validasi, kirim + rekonsiliasi balik) belum.

**1. Dimensi kelayakan outlet pada aturan promo** — `python_backend/summary_rules.py`

- `Program` bertambah `outlet_mode` (`all` / `only` / `except`) dan `outlet_classes`.
  Daftar kelas TERTUTUP: `OUTLET_CLASSES = ("LOYALTY","HYBRID","CONTRACTUAL","MSG")`.
  Sengaja tertutup — satu salah ketik pada mode `except` berarti potongan jatuh ke outlet
  yang justru harus dikecualikan. Principal menambah kelas -> tambahkan di konstanta itu.
- `outlet_allows(program, outlet_classes, known_classes)` adalah gerbangnya.
  **`known_classes` = kelas yang daftar outletnya sudah dimuat.** Kelas yang daftarnya belum
  ada membuat program DITAHAN, bukan berlaku untuk semua. Ini keputusan yang diambil sesi
  ini tanpa menunggu jawaban: potongan yang kurang bisa dibayar susulan, potongan yang
  terlanjur masuk faktur outlet yang salah tidak bisa ditarik.
- `calculate()` dan `suggestions()` menerima `outlet_classes=`/`known_classes=` (default
  kosong = gagal tertutup), jadi **`routers/orders.py` tidak diubah sama sekali** dan
  perilakunya sekarang: tiap program berkelas outlet ditahan sampai daftarnya dimuat.
- `calculate()` mengembalikan `blocked: [{program_id, program_name, reason}]` — alasan
  penahanan ikut tersimpan pada `sales_order.result`, jadi terlihat di halaman order.
- `compile_programs()` membaca kolom baris `outlet_mode` + `outlet_classes` (dipisah koma),
  ikut jadi kunci pengelompokan (baris berbeda kelayakan tidak melebur), dan salah isi
  dilaporkan sebagai issue, bukan ditebak.
- **BELUM ADA sumber data kelasnya.** Tidak ada tabel outlet-tag dan tidak ada importir —
  sengaja belum dibangun karena berkas hit list-nya belum ada. Begitu berkasnya datang:
  tabel `outlet_tag(customer_no, tag)` + `known_classes` = kelas yang punya minimal satu
  baris, lalu `store_order`/`preview_order` meneruskannya ke `calculate`.

**2. Parser surat Kino deterministik, tanpa OCR** — `python_backend/kino_letter.py`

- `parse_pdf(raw)` / `parse_text(text)`: baca label kop (`NO. PROMO ID`, `Kode Aju`,
  `Periode Promo`, `Mekanisme Promo`, `Detail Promo`, ...) lalu keluarkan baris draft
  Summary dengan bentuk `FIELDS` yang sama seperti keluaran Mistral, plus `outlet_mode`
  dan `outlet_classes`. Menolak PDF tanpa lapisan teks (arahkan ke jalur OCR).
- Klasifikasi on-faktur MEKANIS dari field `Mekanisme Promo` saja (`\bON FAKTUR\b`), bukan
  dari badan teks — surat DISC ON PO pun menyebut "ON FAKTUR" di kalimatnya.
- Kelayakan outlet dibaca dari butir yang menyebut CHANNEL/PESERTA, dan **EXCLUDE menang
  atas PESERTA**: "EXCLUDE PESERTA PROGRAM IKATAN LOYALTY / HYBRID / CONTRACTUAL & MSG"
  memuat kedua kata, membacanya terbalik membalik arti surat.
- Tier `1JT � 1.99 JT POTONGAN ON FAKTUR 20.000` terbaca sebagai batas BAWAH (1 juta).
  Bullet dan tanda rentang surat Kino sama-sama keluar sebagai U+FFFD, jadi tier discan
  utuh dengan satu regex, sedangkan bonus discan PER BUTIR supaya "berlaku kelipatan"
  milik butirnya sendiri.
- Disambung ke `POST /summary/manual/parse_pdf_ai` lewat `kino_extraction()` di
  `routers/summary.py`: **dicoba lebih dulu, jatuh ke Mistral bila bukan surat Kino atau
  bukan berlapis teks.** Nol biaya OCR untuk surat Kino.
- `POST /summary/library/{id}/publish` menolak 409 bila `extraction.on_faktur is False`.

**Tiga bug lama yang ketahuan dari data nyata dan sudah diperbaiki** (semuanya di
`summary_rules.py`, ketiganya salah UANG, bukan kosmetik):

1. `threshold_of` membaca "Setiap pembelian 30 PCS" sebagai minimum **1**, karena
   `NO_MINIMUM_MARKS` diperiksa sebelum trigger berangka. Akibatnya bonus 30-dapat-1 pada
   order 60 PCS keluar **60 bonus**, bukan 2. Urutannya dibalik.
2. Batas nilai difilter satuan: program "minimal transaksi Rp X" hanya menghitung baris
   bersatuan sama dengan `program.unit`, jadi order campur BTL+PCS terpecah. Sekarang
   `threshold == "value"` mengabaikan satuan.
3. Batas nilai dihitung PER BARIS, bukan sekeranjang. Order Rp 9,37 juta jatuh ke tier
   Rp 1 juta beberapa kali dan keluar Rp 80.000, bukan Rp 180.000. Sekarang
   `threshold == "value"` selalu satu keranjang.

**Bukti yang benar-benar dijalankan**

- `python test_summary_rules.py`, `test_kino_letter.py`, `test_orders.py` — semua OK.
  `test_kino_letter.py` memuat salinan verbatim lapisan teks surat, jadi tidak butuh PDF
  di repo (PDF-nya berisi data pelanggan, tetap di luar repo).
- Kelima surat September 2026 diparse dari berkas asli: MSG 10 tier + `except
  LOYALTY,CONTRACTUAL`; OVALE 1 baris `only LOYALTY`; RESIK V **4 baris terpisah** dengan
  Godokan Sirih tanpa MIX (temuan #3 tertutup); SMALL PACKAGE 1% + `except` empat kelas +
  peringatan lampiran; **MTI ditolak** `on_faktur=False`, 0 baris.
- Rantai penuh diuji dengan order GT nyata dari `ORDER_DETAIL_20260903`
  (GALERY MAKASSAR `C-GAL006`, 18 baris, gross Rp 9.375.135):
  daftar belum dimuat -> Rp 0 (`blocked: daftar outlet CONTRACTUAL, LOYALTY belum dimuat`);
  outlet biasa -> **Rp 180.000** (tier 9JT, sesuai surat); outlet LOYALTY -> Rp 0.
  **Kino mencatat TOTAL_DISC = 0 untuk order itu.** Jadi begitu gerbang validasi ada, order
  ini akan DITAHAN — entah GALERY MAKASSAR memang loyalty/contractual, entah Kino kurang
  memberi. Tidak bisa dipastikan tanpa hit list.
- `kino_extraction()` dijalankan langsung atas keempat berkas: MSG 10 baris, RESIK 4 baris,
  MTI 0 baris `on_faktur=False`, dan berkas non-PDF mengembalikan `None` (jatuh ke OCR).

**Batas verifikasi yang jujur**: jalur HTTP-nya (`parse_pdf_ai`, `publish`) belum diklik
lewat browser di sesi ini — yang diuji fungsinya langsung plus import router. Dev server
tidak dinyalakan.

**Temuan #4 masih berdiri**: `attach_codes` hanya mencocokkan nama master UTUH, dan
"OVALE 2IN1 CLEANSER" bukan nama master utuh, jadi `kode_barangs` keluar kosong dan peninjau
harus memilih kode. Itu memang perilaku yang diinginkan (tidak ada pencocokan samar), tapi
artinya menerbitkan OVALE/RESIK V/SMALL PACKAGE butuh pemilihan kode manual — atau tabel
merek->kode yang dibangun dari `Mapping_Prd` + master Accurate, yang belum ada.

**Catatan model yang sengaja tidak diubah**: `value_scope` tetap `eligible`, bukan `order`.
Di Accurate, cabang = divisi principal dan `customerNo` per cabang, jadi satu faktur hanya
berisi satu principal — `eligible` dan `order` sama saja untuk MSG. Kalau nanti ada faktur
campur principal, ini harus ditinjau ulang.

**UI belum disentuh sama sekali** (sesuai rencana butir 5): editor Summary belum punya
kolom `outlet_mode`/`outlet_classes`, jadi kelayakan outlet baru bisa diisi lewat parser.
Baris yang sudah punya kolom itu TIDAK hilang saat disimpan (frontend menyalin baris dengan
spread), tapi baris baru yang dibuat dari UI default `all`.

### Surat induk PRONAS + daftar loyalty — 2026-09-10 (lanjutan sesi yang sama)

Pengguna melampirkan `Loyalty makassar.xlsx` dan `SURAT PRONAS HPC GT Q3 (SEPTEMBER) 2026.PDF`.

**Surat PRONAS adalah surat INDUK-nya**, No. `014/KINO/SLS-SPRT HPC/VIII/2026`, Tangerang
31 Agustus 2026, ditandatangani Nanang Rezeki (Head of Sales GT HPC West) dan Mochamad Isroin
(Head of Sales HPC East). **Hasil scan, TIDAK ada lapisan teks** — dibaca sesi ini dengan
membuka gambar halamannya, bukan OCR berbayar. Isinya tabel 10 program HPC GT Q3:

| # | Program | Rate | On/Off faktur | Periode |
|---|---|---|---|---|
| 1 | Loyalty Program (cashback strata PLATINUM 3% / GOLD 2% / SILVER 1%) | running | **OFF FAKTUR** | 01-Jul → 30-Sep-26 |
| 2 | Contractual Program (quarterly cashback 2,5%) | running | **OFF FAKTUR** | 01-Jul → 30-Sep-26 |
| 3 | Contractual Program (monthly cashback 2,5%) | running | **OFF FAKTUR** | 01-Sep → 30-Sep-26 |
| 4 | **MSG Program** (tier potongan) | fixed | **ON FAKTUR** | 01-Sep → 30-Sep-26 |
| 5 | Program Small Package 1% | running | **ON FAKTUR** | 01-Sep → 30-Sep-26 |
| 6 | **TP 30+1 Ovale 2in1 Cleanser** | running | **ON FAKTUR** | 01-Sep → 30-Sep-26 |
| 7 | **TP 30+1 Resik-V** (4 sub-program) | running | **ON FAKTUR** | 01-Sep → 30-Sep-26 |
| 8 | Hybrid Activation (monthly cashback 1%) | running | OFF FAKTUR | 01-Sep → 30-Sep-26 |
| 9 | Hybrid Activation (quarterly, strata 150JT UP 3% / 75–149,9JT 2% / 30–74,9JT 1%) | running | OFF FAKTUR | 01-Jul → 30-Sep-26 |
| 10 | Support Ads/Affiliate/Voucher Hybrid | running | OFF FAKTUR | 01-Sep → 30-Sep-26 |

Ini **membuktikan** klasifikasi on-faktur yang dipakai parser: tujuh program cashback/hybrid
memang diklaim di luar faktur dan tidak boleh menyentuh nilai faktur sama sekali.

**Keputusan pengguna 2026-09-10**: Small Package "KHUSUS LD JAWA" -> **tidak berlaku untuk
Surya Perkasa Makassar, diabaikan.** Jadi yang on-faktur untuk Surya tinggal **tiga**:
MSG, Ovale 30+1, dan Resik-V 30+1 (empat sub-program).

**Daftar loyalty dimuat**: 41 outlet, semuanya `SURYA PERKASA, CV - MAKASSAR`
(4 PLATINUM, 10 GOLD, 27 SILVER). Strata cashback hanya relevan untuk program OFF faktur;
untuk gerbang on-faktur semuanya cukup berkelas `LOYALTY`.

- `python_backend/outlet_class.py` — keanggotaan kelas outlet. **Kuncinya KODE OUTLET DASAR**
  (`C-GAL006`), bukan `customerNo` Accurate: satu outlet fisik punya satu customerNo per
  cabang principal (dibuktikan live: `C-GAL006-KN` Kino, `-RB` Reckitt, `-CS` Cussons,
  `-GD`, `-MSM`, `-SZ`, `-M1`...), sedangkan keanggotaan loyalty melekat pada tokonya.
  `classes_of()` mencocokkan kode penuh maupun kode dasar.
- **Registri terpisah dari barisnya** (`summary_kv` namespace `outlet_class_loaded`):
  "dimuat tapi kosong" harus bisa dibedakan dari "belum dimuat" — yang pertama menjalankan
  programnya, yang kedua menahannya. `load(klass, [], ...)` adalah pernyataan tegas
  "kelas ini tidak ada di cabang kita".
- `load()` **mengganti**, bukan menambah: daftar Kino terbit ulang tiap kuartal dan outlet
  yang keluar dari program harus benar-benar hilang.
- `python_backend/import_outlet_class.py` — CLI pemuatnya. Kolom kode outlet **tidak ditebak
  dari judul** (berkas Kino laporan ad hoc), melainkan dipilih dari kolom yang isinya paling
  banyak cocok dengan `Mapping_Customer`. Default dry-run; `--apply` untuk menulis.
  **Menolak memuat daftar yang bolong** kecuali diberi `--force`, karena daftar `except` yang
  kurang satu outlet berarti outlet itu menerima potongan yang seharusnya tidak.
- `routers/orders.py` kini meneruskan `outlet_classes`/`known_classes` ke `calculate` dan
  `suggestions`, baik pada `POST /orders` maupun `POST /orders/preview` (pratinjau membaca
  `customer_no` dari body).

**Perintah yang benar-benar dijalankan (lokal, dev SQLite):**

```bash
python import_outlet_class.py LOYALTY "Loyalty makassar.xlsx" --mapping "KINO (1).xlsx" \
  --extra C-KOS005,C-KA0059,C-LO0019 --force --apply
```

`--extra` dipakai karena **3 outlet tidak ada di `Mapping_Customer`** (sheet-nya lebih lama
dari daftar loyalty): Kino `52390254695`, `2191200123409`, `3210402085278`. Ketiganya
diverifikasi satu per satu ke tabel `customer` Accurate dan namanya cocok persis —
`C-KOS005` KOSMETIK MUNAWARAH, `C-KA0059` KAMIL STAND, `C-LO0019` LOLLYPOP BABY. **Sebaiknya
`Mapping_Customer` diperbarui** supaya kuartal depan tidak perlu `--force` lagi.

**Bukti rantai penuh atas order nyata** (GALERY MAKASSAR `C-GAL006`, gross Rp 9.375.135,
`ORDER_DETAIL_20260903`) — inilah kecocokan A-vs-B pertama yang benar:

| Keadaan | Aturan kita | Kino | Alasan tercatat |
|---|---|---|---|
| sekarang (CONTRACTUAL belum dimuat) | Rp 0 | Rp 0 | `daftar outlet CONTRACTUAL belum dimuat` |
| kalau CONTRACTUAL dinyatakan kosong | **Rp 0** | **Rp 0** | `outlet termasuk LOYALTY` |
| outlet GT non-loyalty (hipotetis) | Rp 180.000 | — | — |

Jadi pertanyaan yang tergantung sejak sesi lalu — "kenapa Kino memberi Rp 0 padahal ordernya
kena tier 9JT?" — **terjawab: GALERY MAKASSAR memang outlet loyalty (GOLD)**, dan MSG
mengecualikan loyalty. Bukan Kino yang kurang memberi.

**CONTRACTUAL — keputusan pengguna 2026-09-10**: "list outletnya ada di file loyalty
makassar". Berkas itu hanya punya kolom `Loyalty Program` (PLATINUM/GOLD/SILVER) dan tidak
memuat penanda contractual/hybrid sama sekali, jadi CONTRACTUAL dimuat dari **berkas yang
sama, 41 outlet yang sama**. Untuk MSG ini tidak mengubah apa pun: ke-41 outlet itu sudah
dikecualikan lewat LOYALTY, dan MSG mengecualikan LOYALTY **atau** CONTRACTUAL. **Peringatan
untuk nanti**: jangan pakai keanggotaan CONTRACTUAL ini untuk program ber-mode `only
CONTRACTUAL` — sumbernya tidak pernah benar-benar membedakan keduanya. Minta daftar
contractual asli ke Kino kalau program semacam itu muncul.

**MSG sekarang HIDUP** di lingkungan lokal. Gerbang atas ketiga order nyata di
`ORDER_DETAIL_20260903`:

| SO | Outlet | Channel | Gross | Aturan kita | Kino | Selisih |
|---|---|---|---|---|---|---|
| 1671-SOP-260012670 | C-GAL006 | GT | 9.375.135 | **0** (`outlet termasuk CONTRACTUAL, LOYALTY`) | **0** | **0** |
| 1671-SOP-260012692 | C-AL0063 ALFAMART | MT | 898.378 | 0 | 55.340 | -55.340 |
| 1671-SOP-260012693 | C-AL0063 ALFAMART | MT | 14.215.135 | 0 | 875.652 | -875.652 |

Baris GT cocok tepat Rp 0. **Dua order ALFAMART adalah MODERN TRADE**, dan surat PRONAS ini
khusus channel **GT** — tidak ada satu pun aturan MT yang terbit, jadi diskon Kino di situ
tidak punya dasar aturan di sistem kita. Ini temuan untuk langkah berikutnya: **gerbang
validasi butuh surat program MT juga**, kalau tidak setiap faktur MT akan tertahan.

**Jebakan pembaca ORDER_DETAIL**: dua baris terakhir berkas adalah `Total for 1201671` dan
`Grand Total` (kolom `REGION_ID` berisi teksnya, `PRICE` kosong). Importir wajib
membuangnya, kalau tidak nilainya terhitung dua kali.

### Tiga jenis diskon dan posisi kolom DISC_n — 2026-09-10

Pengguna melampirkan foto tabel **"DISCON SUPER DEV. KINO NON FOOD"** (Makassar, Agustus 2026,
berlaku 15-08-26 s/d 31-12-26) dan menetapkan taksonomi yang harus dipakai gerbang validasi:

1. **Disc Principle** — bisa diklaim ke Kino.
2. **Disc Distributor** — tanggungan distributor sendiri.
3. **Disc Tak Bertuan** — tidak ada di keduanya. **Tidak boleh terjadi; wajib memunculkan peringatan.**

**Penemuan kunci: POSISI kolom `DISC_n` adalah penanda siapa yang menanggung.** Tabel itu
berkepala `POSISI DISCON` dengan sub-kolom 1..5, `Distributor` di atas 1-3 dan `Principle` di
atas 4-5. Dibuktikan dengan data nyata: baris ALFAMART pada `ORDER_DETAIL_20260903` berisi
`DISC_1 = 4` dan `DISC_4 = 2.25` — persis kolom 1 dan 4 pada tabel itu untuk baris Alfamart.

**Diskonnya BERTINGKAT, bukan dijumlah.** 4% lalu 2,25% atas gross Rp 345.945,95 memberi
Rp 21.310,27, sama persis dengan `TOTAL_DISC` yang dilaporkan Kino. Menjumlahkan 6,25%
memberi Rp 21.621,62 dan setiap faktur akan tampak selisih.

`python_backend/kino_discount.py` — `split()` dan `classify()`. Memilah satu baris ke tiga
ember lalu melaporkan yang tidak terjelaskan. Peringatan yang dihasilkan: posisi tanpa pemilik
(DISC_6..8), klaim principal tanpa aturan terbit, klaim principal tidak sebesar aturan
(toleransi Rp 1), tarif distributor tidak sesuai kesepakatan, tarif disepakati tapi tidak
diberikan, tarif outlet belum terdaftar, dan total tidak cocok dengan laporan Kino.
Self-check `test_kino_discount.py`.

**Hasil atas data nyata 3 September 2026:**

| SO | Outlet | Ch | Distributor | Principal | Tak bertuan |
|---|---|---|---|---|---|
| …012670 | C-GAL006 | GT | 0 | 0 | 0 |
| …012692 | ALFAMART | MT | 35.935,14 | 19.404,97 | 0 |
| …012693 | ALFAMART | MT | 568.605,41 | 307.046,92 | 0 |

**Rp 326.451,89 klaim principal dalam satu hari penjualan MT tidak punya dasar aturan di
sistem** — bukan karena salah, tapi karena tarif 2,25% Alfamart itu hidup di tabel discon
super dev yang belum dimuat, dan surat program MT belum ada.

**Dugaan yang BELUM dikonfirmasi** (jangan dibangun sebelum dijawab): `DISC_1..8` adalah tarif
tetap dari tabel discon super dev, sedangkan uang program promo (potongan MSG dan sejenisnya)
masuk ke kolom terpisah `TOTAL_PROMO` — yang pada ketiga order ini bernilai 0. Kalau benar,
gerbangnya memeriksa dua sumber berbeda: `DISC_n` lawan tabel discon, `TOTAL_PROMO` lawan
aturan promo terbit.

**Master barang Kino**: `master_barang_principle/FIX_FORM MASTER BARANG - KINO NON FOOD.xlsx`,
sheet `Fix Mapping` (606 item) punya kolom `NAMA KELOMPOK` — 101 kelompok. Ini **memperkecil**
temuan #4, tidak menutupnya: tidak ada kelompok bernama persis "OVALE 2IN1 CLEANSER" (yang
terdekat `OVALE CLEANSING GEL`, 4 item), dan sub-program Resik V harus dipetakan tangan ke
`RESIK V MANJAKANI` (6), `RESIK V RAMUAN MADURA` (3), `RESIK V GODOKAN` (1), dan seterusnya.
Peninjau memilih dari daftar pendek, bukan dari 606 item — menebaknya otomatis adalah pola
kegagalan yang sudah pernah terjadi pada master Priskila.

### Di kolom Accurate mana diskon rupiah masuk — dijawab 2026-09-10

Pertanyaan pengguna. Dijawab dari `docs/prd/ACCURATE_API_REFERENCE.md` (hasil probe 303 field
`sales-invoice`) dan `lib/accurate-invoice.ts` yang sudah terbukti membaca faktur live.
**Tidak** memanggil API: satu OAuth client hanya memegang satu token, probe dari lokal akan
mematikan token produksi.

| Yang mau dikirim | Field Accurate | Tingkat |
|---|---|---|
| Diskon **persen** per baris (boleh bertingkat, mis. `4+2.25`) | `itemDiscPercent` | `detailItem[]` |
| Diskon **rupiah** per baris | `itemCashDiscount` | `detailItem[]` |
| Diskon **persen** seluruh faktur | `cashDiscPercent` | header |
| Diskon **rupiah** seluruh faktur | `cashDiscount` | header |

Pemetaan yang masuk akal untuk Kino:

- `DISC_1..8` Kino adalah **persen berantai** -> `itemDiscPercent` per baris. Bentuk `"4+2.25"`
  itulah yang menghasilkan perhitungan bertingkat yang sudah dibuktikan cocok dengan
  `TOTAL_DISC` Kino. Sayangnya satu field tidak bisa menyimpan SIAPA yang menanggung tiap
  bagian — pembagian distributor/principal harus tetap disimpan di sisi kita.
- Potongan program berupa rupiah tingkat faktur (MSG Rp 180.000) -> `cashDiscount` header.

**Yang perlu diputuskan**: `lib/accurate-invoice-write.ts` sekarang mengirim SEMUA diskon
sebagai `itemCashDiscount` rupiah per baris (bruto - netto beku), sengaja supaya tidak ada
selisih pembulatan. Kalau faktur harus MENAMPILKAN persen seperti nota Kino, penulisnya perlu
diubah memakai `itemDiscPercent` untuk bagian persen dan menyisakan `cashDiscount` untuk uang
program. Itu perubahan pada jalur yang gerbang kirimnya masih tertutup, jadi belum dikerjakan.

**Peringatan yang masih berlaku**: nama field REQUEST `sales-invoice/save.do` BELUM terbukti,
dan Accurate mengabaikan field tak dikenal tanpa galat. Tabel di atas berasal dari RESPONS
`detail.do`. Satu faktur uji tetap wajib diperiksa manual.

### Surat MT dan ALFAMART — tidak cocok, 2026-09-10

Pengguna menunjuk `BP2609007909 - MTI - HPC CONSUMER PROMO ON PO` sebagai program MT. Benar
bahwa itu surat sisi MT (`Group Of Promo: MODERN`, `Type Of Promo: CONSUMER PROMO`), tetapi
**surat itu tidak menjelaskan diskon ALFAMART**:

- `Class Of Promo: DISC ON PO`, `Mekanisme Promo: ADDITIONAL DISCOUNT`, dan syaratnya
  "wajib konfirmasi/pengajuan outlet" + "wajib melampirkan SKP" — bukan potongan yang jatuh
  otomatis di faktur.
- Daftar outletnya untuk cabang 1201671 hanya **DUA**: `5191202075409 BAJI PAMAI CBA0003` dan
  `5191202076135 WANG MART CWA0012`. **ALFAMART tidak ada di dalamnya.**
- Isinya diskon 3% untuk brand tertentu (Ellips Hair Vitamin Jar, Ellips Hair Mist, Sleek Baby
  Bottle Nipple, Resik V Cair, B&B all variant) — bukan 4% + 2,25%.

Diskon ALFAMART 4% + 2,25% justru tertera pada **tabel discon super dev** baris `Alfamart`,
channel NKA, kolom 1 dan kolom 4. Jadi sumber kebenaran untuk faktur MT/NKA adalah tabel itu,
bukan surat MTI. Tabelnya masih berupa FOTO; 29 baris terlalu berisiko disalin dari foto
miring, jadi belum dimuat.

Catatan taksonomi: tabel discon memakai channel **NKA / MT / GT**, sedangkan `ORDER_DETAIL`
memakai `CUST_TYPE1` **General Trade / Modern Trade**. ALFAMART = NKA pada tabel, Modern Trade
pada ORDER_DETAIL.

**Keputusan pengguna 2026-09-10**: pemetaan dua taksonomi ini **TIDAK diformalkan dulu** —
"nanti kita check by case". Jadi jangan bangun tabel pemetaan channel; gerbang MT menunggu
tabel discon dalam bentuk xlsx, dan kecocokan channel diperiksa per kasus saat itu.

**Istilah**: "tabel discon super dev" bukan istilah internal, melainkan judul yang tercetak
pada fotonya (`DISCON SUPER DEV. KINO NON FOOD`). Kalau nama internalnya berbeda, ganti
sebutan ini di dokumen dan kode sebelum modulnya dibangun.

### Discount Reguler, kode barang, dan faktur persen+rupiah — 2026-09-10

**Penamaan resmi (keputusan pengguna)**: tabel pada foto itu bernama **"Discount Reguler
(Tanggungan Distributor)"**. Sebutan "discon super dev" hanya judul cetakannya; pakai nama
resmi ini di kode dan dokumen berikutnya.

**Excel-nya tidak ada, jadi diekstrak dari foto.** Hasilnya
`DISCOUNT REGULER - TANGGUNGAN DISTRIBUTOR - KINO NON FOOD.xlsx`, dikirim ke pengguna dan
**TIDAK disimpan di repo** (memuat nama pelanggan dan tarif diskon). Dua sheet:

- `Discount Reguler` — 29 baris, kolom `POSISI 1..5` + `NILAI TERBACA DI FOTO` + `PERIKSA`.
  Hanya baris **Alfamart** yang posisinya TERBUKTI (dari `DISC_1=4`/`DISC_4=2.25` pada
  ORDER_DETAIL); sisanya ditandai "posisi kolom BELUM PASTI". Tiga baris tidak terbaca sama
  sekali (Panen Selaras/Boots, Hypermart, PT. Millennium Multi Persada).
  **11 kode internal yang tercetak di foto diverifikasi ke master pelanggan Accurate dan
  semuanya cocok** — dengan satu koreksi: yang terbaca `C-MAA0056` sebenarnya **`C-MA0056`**
  (MAJU JAYA SENTOSA, CV). Sembilan di antaranya juga ada di daftar loyalty, jadi saling
  menguatkan.
- `Kode Barang` — 41 kelompok kandidat dari master Kino untuk 5 sub-program on-faktur, dengan
  jumlah item dan contoh nama, plus kolom `PAKAI` untuk dicentang. **Ini jawaban atas
  pertanyaan "kode barang bagaimana"**: surat menyebut MEREK, master menyebut KELOMPOK, dan
  tidak satu pun namanya sama persis — jadi peninjau mencentang dari daftar pendek, bukan
  memilih dari 606 item, dan sistem tidak pernah menebak.

**Faktur Accurate kini menampilkan persen DAN rupiah** (permintaan pengguna):

- `summary_rules.calculate()` mencatat per baris `percents` (rantai persen yang berlaku,
  mis. `["10","5"]`) dan `cash` (bagian diskon yang berupa rupiah). Totalnya tetap angka yang
  sama; yang baru hanya pemisahannya. Alokasi sen tetap deterministik dan tidak pernah
  melebihi netto satu baris.
- `lib/accurate-invoice-write.ts` mengirim `itemDiscPercent: "10+5"` dan `itemCashDiscount`
  **hanya sisa rupiahnya**. Mengirim seluruh diskon di kedua field akan membuat Accurate
  memotong DUA KALI. Penulisnya menolak bila bagian rupiah melebihi total diskon baris.
- Konsekuensi yang diterima: Accurate menghitung ulang bagian persennya sendiri, jadi total
  faktur bisa berbeda beberapa sen dari angka beku kita. Itu masuk toleransi Rp 1.
- Hasil beku lama (tanpa `percents`/`cash`) tetap jalan: seluruh diskon jatuh sebagai rupiah
  seperti perilaku sebelumnya.

Diperiksa: `test_summary_rules.py` (`summary split check`), `lib/accurate-invoice-write.test.ts`
(5 test), dan `tsc --noEmit` bersih.

### Yang dibutuhkan dari pengguna untuk melanjutkan

1. ~~Hit list LOYALTY~~ **SUDAH** (41 outlet, dimuat 2026-09-10).
2. ~~SMALL PACKAGE berlaku di Makassar?~~ **TIDAK** — LD Jawa, diabaikan atas keputusan pengguna.
   Lampiran size/paketnya jadi tidak perlu.
3. **Daftar outlet CONTRACTUAL** untuk cabang 1201671 — atau pernyataan bahwa tidak ada.
   Ini satu-satunya yang menahan MSG sekarang.
4. Perbarui sheet `Mapping_Customer` pada KINO.xlsx: 3 outlet loyalty belum ada di sana.

### TAHAP 7 — alur laporan principal: langkah 1–6 SELESAI (2026-09-11)

Alur yang diminta pengguna: sales input di sistem principal -> admin tarik laporan integrasi ->
unggah ke web -> validasi 2 tahap -> kirim ke Accurate 1 tombol -> tab error + resend ->
daily closing + eskalasi OM. Checklist lengkap 40 titik periksa ada di
**`docs/CHECKLIST_ALUR_FAKTUR_PRINCIPLE.md`** — baca itu lebih dulu, bukan bagian ini.

Selesai: **langkah 1 (mapping), 2 (parser + unggah batch), 3 (validasi tahap 1), 4 (batch -> antrean
faktur), 5 (tab error + resend), 6 (laporan OM 2 jam)**.

| Yang dibangun | Berkas |
|---|---|
| Mapping kode principal -> internal, bisa diimpor & diubah lewat UI | `lib/principal-mapping.ts`, `/principal-mapping`, migrasi 0007 |
| Parser Order Detail + unggah batch anti-ganda | `lib/order-detail.ts`, `/principal-order`, migrasi 0008 |
| Validasi tahap 1 (8 pemeriksaan, semuanya menahan) | `lib/principal-validation.ts`, migrasi 0009 |
| Batch -> antrean faktur, satu tombol per batch | `lib/principal-invoice.ts`, `/api/principal-order/queue`, `lib/accurate-units.ts` |
| Tab error + resend + laporan OM 2 jam | `/antrean-faktur`, `/api/invoice-outbox` |
| PPN wajib aktif pada setiap faktur | `lib/accurate-invoice-write.ts` |

**Migrasi 0007, 0008, 0009 SUDAH di PRODUKSI** (2026-09-11), semuanya 0 baris.

Keputusan pengguna yang mengikat pekerjaan berikutnya:

- **Dua jalur order hidup berdampingan**: principal bersistem sendiri lewat unggah laporan,
  principal lain lewat entri di web kita. `invoice_outbox` harus bisa diisi dari keduanya.
- **Harga**: beda sampai Rp 1 lolos, di atas itu ditahan, lebih tinggi maupun lebih rendah.
- **Daily closing**: admin menarik ulang laporan saat mau selesai kerja lalu disandingkan;
  status juga harus real-time; **masalah yang sudah berumur 2 jam tembus ke OM**.
- **Small Package (LD Jawa) diabaikan** untuk Surya.
- Pemetaan channel NKA/MT/GT vs General/Modern Trade **tidak diformalkan**, diperiksa per kasus.

Aturan yang diambil dari Power Query admin (`KINO (1).xlsx`) dan sudah diterapkan: satuan naik
ke KRT hanya bila QTY habis dibagi ISI dengan harga dikali ISI; baris bonus = potongan 100% di
posisi 1; pelanggan dari `CUST_ID1` + akhiran `-KN`; diskon persen digabung dengan `+`.

**Langkah 4 SELESAI juga (2026-09-11, sesi lanjutan)**: `lib/principal-invoice.ts` +
`POST /api/principal-order/queue` + tombol **Faktur** per batch. Tanpa migrasi baru. Kunci
antrean **`PRINCIPAL:NO-SO`, bukan id batch** — admin menarik ulang laporan tiap hari, jadi
kunci per batch akan memfakturkan SO yang sama dua kali; dengan kunci SO, unggahan kedua
bentrok di primary key dan dilewati. Satu baris `review` menjatuhkan seluruh SO-nya. Master
satuan kini dibaca dari tabel sync `accurate_unit`, bukan panggilan live — satu titik gagal
hilang dari jalur faktur, jalur order internal ikut. Rinciannya (termasuk bukti ujinya) ada di
checklist bagian "Langkah 4 urutan kerja SELESAI".

**Langkah 5–6 SELESAI juga (2026-09-11)**: `/antrean-faktur` + `/api/invoice-outbox`. Satu
layar untuk tab error DAN laporan OM — laporan OM adalah saringan "hanya yang lewat 2 jam" di
layar yang sama, supaya tidak ada angka kedua yang bisa berbeda dari layar admin. Jam eskalasi
dihitung sejak faktur masuk antrean, **bukan** sejak percobaan terakhir: kalau dari percobaan
terakhir, menekan Kirim ulang akan menyetel ulang jamnya. Pengirim terjadwal sekarang HANYA
mengambil `queued` — yang `rejected` menunggu manusia, karena mengulang kegagalan yang sama
4x sehari tidak memperbaiki sebabnya. `unknown` tidak punya tombol sama sekali.

**Koreksi harga 2026-09-11 (dari temuan pengguna)**: harga dicari per pelanggan DAN per
**cabang** pelanggan — daftar harga Accurate punya satu baris per (kategori x satuan x cabang),
dan kenaikan harga sering terbit hanya di cabang principalnya (KINO NON FOOD 7.207 sejak
1 Agu 2026; 21 cabang lain masih 6.306 dari Maret). Selain itu toleransi Rp 1 kini dihitung
pada satuan TERKECIL, bukan pada harga karton, karena di situlah pembulatan terjadi. Berkas
11 September berubah dari 6 cocok/47 ditinjau menjadi **53 cocok/0 ditinjau**. Rinciannya di
checklist bagian "Koreksi harga".

**Yang tersisa (langkah 7 + 4.25)**: klasifikasi 4 error Accurate (overdue, overlimit, outlet
non-aktif, item non-aktif). Teksnya **belum pernah kita lihat** dan harus diambil dari faktur
uji — pola yang ditebak akan salah menggolongkan error nyata, lebih buruk daripada tidak
menggolongkan. Sekarang jawaban Accurate ditampilkan apa adanya.

**Gerbang kirim faktur MASIH TERTUTUP** (`ACCURATE_INVOICE_SEND` kosong). Daftar periksa faktur
uji kini: satuan, harga per satuan, **diskon persen (`itemDiscPercent`)**, **PPN (`taxable`)
dan totalnya**, dan nomor faktur.

### Prompt melanjutkan (2026-09-11, setelah langkah 6)

> Lanjutkan pekerjaan Surya di D:\AccAPI\_github_clean, branch `feat/surya-workspace`. Baca
> `docs/CHECKLIST_ALUR_FAKTUR_PRINCIPLE.md` lebih dulu, lalu bagian "TAHAP 7" pada
> docs/SURYA_IMPLEMENTATION.md. Langkah 1–6 alur laporan principal SELESAI dan terbukti jalan
> lokal: mapping, parser + unggah batch, validasi 8 pemeriksaan, batch -> `invoice_outbox`
> (kunci `PRINCIPAL:NO-SO`), lalu `/antrean-faktur` sebagai tab error + resend + laporan OM
> 2 jam. Migrasi 0007–0009 sudah di produksi; langkah 4–6 tidak menambah migrasi sama sekali.
> **Yang tersisa hanya bisa dikerjakan setelah SATU FAKTUR UJI dikirim dan diperiksa manual**:
> klasifikasi 4 kategori error Accurate dari teks aslinya (jangan ditebak), dan pemeriksaan
> `save.do` (satuan, harga, `itemDiscPercent`, `taxable` + totalnya, nomor faktur dari seri
> cabang). Gerbang kirim masih tertutup (`ACCURATE_INVOICE_SEND` kosong) — jangan membukanya
> tanpa saya minta. Jangan stage massal: working tree masih memuat pekerjaan rekonsiliasi dan
> eksperimen OCR lama.

### Prompt melanjutkan (2026-09-11, setelah langkah 4)

> Lanjutkan pekerjaan Surya di D:\AccAPI\_github_clean, branch `feat/surya-workspace`. Baca
> `docs/CHECKLIST_ALUR_FAKTUR_PRINCIPLE.md` lebih dulu, lalu bagian "TAHAP 7" pada
> docs/SURYA_IMPLEMENTATION.md. Langkah 1–4 alur laporan principal SELESAI dan terbukti jalan:
> mapping, parser + unggah batch, validasi 8 pemeriksaan, dan batch -> `invoice_outbox` lewat
> tombol Faktur (kunci antrean `PRINCIPAL:NO-SO`, pratinjau default). Migrasi 0007–0009 sudah
> di produksi dan langkah 4 tidak menambah migrasi. Berikutnya langkah 5–7: tab error + resend
> yang menghormati `unknown` (tidak boleh dikirim ulang), klasifikasi 4 error Accurate yang
> teksnya HARUS diambil dari faktur uji (jangan ditebak), dan halaman OM dengan penanda umur
> 2 jam. Gerbang kirim masih tertutup (`ACCURATE_INVOICE_SEND` kosong) menunggu satu faktur uji
> diperiksa manual. Jangan stage massal — working tree masih memuat pekerjaan rekonsiliasi dan
> eksperimen OCR lama.

### Prompt melanjutkan (2026-09-11, setelah langkah 1–3)

> Lanjutkan pekerjaan Surya di D:\AccAPI\_github_clean, branch `feat/surya-workspace`
> (sudah di-push). Baca `docs/CHECKLIST_ALUR_FAKTUR_PRINCIPLE.md` lebih dulu, lalu bagian
> "TAHAP 7" pada docs/SURYA_IMPLEMENTATION.md. Langkah 1–3 alur laporan principal selesai dan
> terbukti jalan dengan berkas nyata; migrasi 0007–0009 sudah di produksi. Berikutnya langkah 4:
> adaptor batch ke `invoice_outbox` + satu tombol kirim per batch, lalu klasifikasi 4 error
> Accurate, tab error + resend, dan halaman OM dengan penanda umur 2 jam. Gerbang kirim masih
> tertutup menunggu satu faktur uji diperiksa manual. Jangan stage massal — working tree masih
> memuat pekerjaan rekonsiliasi dan eksperimen OCR lama.

### Prompt melanjutkan (2026-09-10, setelah langkah 1–2)

> Lanjutkan pekerjaan Surya di D:\AccAPI\_github_clean, branch `feat/surya-workspace`. Baca
> SYSTEM_MAP.md dan docs/SURYA_IMPLEMENTATION.md mulai dari "TAHAP 6". Tahap 1–5 selesai;
> Tahap 6 langkah 1 (dimensi kelayakan outlet, gagal tertutup) dan langkah 2 (parser surat
> Kino deterministik tanpa OCR + gerbang on-faktur) SELESAI dan lolos self-check. Berikutnya:
> tabel + importir outlet-tag begitu hit list-nya saya lampirkan, lalu terbitkan MSG ALL
> BRAND, lalu gerbang validasi data Kino vs aturan (toleransi Rp 1) dengan permission peninjau
> di RBAC, lalu kirim ke Accurate dan rekonsiliasi balik. Gerbang kirim faktur MASIH TERTUTUP
> (`ACCURATE_INVOICE_SEND` kosong) menunggu satu faktur uji diperiksa. Jangan stage massal —
> working tree masih memuat pekerjaan rekonsiliasi dan eksperimen OCR lama.

### Prompt melanjutkan (2026-09-10, sebelum langkah 1–2)

> Lanjutkan pekerjaan Surya di D:\AccAPI\_github_clean, branch `feat/surya-workspace` (semua
> sudah di-merge ke `main`, tidak ada commit lokal tertinggal). Baca SYSTEM_MAP.md dan
> docs/SURYA_IMPLEMENTATION.md — mulai dari bagian "TAHAP 6 (BARU)". Tahap 1–4 selesai dan
> produksi sudah tersinkron penuh dari Accurate (22 cabang, 155 penomoran, 37 satuan, 4.185
> item semuanya bersatuan, 2,33 juta baris harga, 32.456 pelanggan, 223.589 faktur); nomor
> faktur sudah mengikuti seri cabang pelanggan; gerbang kirim faktur MASIH TERTUTUP menunggu
> satu faktur uji diperiksa. Pekerjaan berikutnya TAHAP 6: dimensi kelayakan outlet pada aturan
> promo, parser surat Kino deterministik (tanpa OCR), lalu gerbang validasi data Kino vs aturan
> (toleransi Rp 1) sebelum faktur naik ke Accurate. Saya lampirkan ulang 5 surat Kino +
> KINO.xlsx + ORDER_DETAIL.xlsx. Jangan stage massal — working tree masih memuat pekerjaan
> rekonsiliasi dan eksperimen OCR lama yang bukan milik pekerjaan ini.

### Kondisi lingkungan saat sesi 2026-09-10 ditutup

- **Git**: semua pekerjaan sudah di-merge ke `main` (PR #27, #28, #29, #30, #31, #32, #33, #34).
  Tidak ada commit lokal tertinggal. Working tree hanya menyisakan pekerjaan rekonsiliasi dan
  eksperimen OCR lama yang memang sudah dirty sebelum seluruh rangkaian sesi ini.
- **Produksi**: 9 modul sync `idle`. `MISTRAL_API_KEY`, `ACCURATE_INVOICE_DB_ID` (1742775), dan
  `ACCURATE_TOKEN_ENCRYPTION_KEY` terpasang; `BETTER_AUTH_URL` sudah diperbaiki menjadi
  `https://web-super.online`. `ACCURATE_INVOICE_SEND` **tetap kosong** (gerbang tertutup).
- **Produksi masih kosong isinya**: `summary_draft` 0, `sales_order` 0, `order_request` 0,
  `wave_line_pool` 0, `invoice_outbox` 0. Belum ada satu pun aturan promo terbit, sehingga
  `POST /orders` masih menolak 409. **Ini blokir pertama yang harus dibuka.**
- **Cron produksi**: `/etc/cron.d/accapi` berisi sync-accurate 4x/hari (05:15, 11:15, 17:15,
  23:15) + tiga cleanup. **`/api/cron/pull-websales` BELUM terjadwal** (penarikan order sales
  masih manual dari halaman Order Masuk), dan `/api/cron/sync-item-prices` juga belum — jalankan
  manual saat harga berubah.
- **Lokal**: Postgres 18 dijalankan lewat `pg_ctl` (service-nya tidak bisa distart tanpa
  elevasi), `LOCAL_AUTH_BYPASS=true`, dev server SUDAH DIMATIKAN.
- **PENTING — satu token Accurate saja**: satu OAuth client hanya memegang satu token aktif.
  Login produksi 2026-09-09 membuat token lokal `invalid_token`. Jangan login bergantian; kalau
  perlu memprobe dari lokal, sadari itu akan mematikan token produksi.

### Prompt melanjutkan (2026-09-09, sebelum tahap 6)

> Lanjutkan pekerjaan Surya di D:\AccAPI\_github_clean, branch `feat/surya-workspace` (empat commit LOKAL `e21de22`, `f7db064`, `7343dac`, `e17a4a5` — belum di-push). Baca SYSTEM_MAP.md dan docs/SURYA_IMPLEMENTATION.md, lalu periksa kondisi aktual. Tahap 1–3 selesai; satuan order kini dari master Accurate; penarikan Web Sales otomatis 5 menit lewat cron; halaman Order Sales ada dengan izin `websales` terpisah. Tahap 4 dibangun penuh tapi GERBANG KIRIM MASIH TERTUTUP dan nama field request `sales-invoice/save.do` belum terbukti — satu faktur uji pada database yang saya tunjuk harus diperiksa manual sebelum `ACCURATE_INVOICE_SEND=on`. Tahap 5 (Rekapan Nota) menunggu itu plus skema modulnya di DB dev. Jangan stage massal dan jangan push tanpa saya minta.

### Prompt melanjutkan (lama, 7 September)

> Lanjutkan pekerjaan Surya di D:\AccAPI\_github_clean, branch `feat/surya-workspace` (commit `608ab9e` sudah di-push). Baca SYSTEM_MAP.md dan docs/SURYA_IMPLEMENTATION.md, lalu periksa kondisi aktual. Tahap 1–3 selesai dan tervalidasi live: ruang kerja, Summary OCR Mistral 4.1 (anotasi per halaman), order internal dengan aturan promo yang dibekukan, basis data Web Sales terpisah, dan harga dari Accurate (2,3 juta baris `item_selling_price`). Pekerjaan berikutnya: satuan dari master Accurate (bukan input bebas), aplikasi Web Sales terpisah, worker pull 5 menit, lalu faktur Accurate dan Rekapan Nota. Jangan stage massal — working tree masih memuat pekerjaan rekonsiliasi dan eksperimen OCR lama yang bukan milik tahap ini. Perbarui handover setelah setiap tahap.
