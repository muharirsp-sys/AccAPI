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

**Belum:** sync cabang pertama belum dijalankan (butuh kode ini ter-deploy), pemetaan
`accurate_branch_id` untuk tiap profil sales belum diisi, dan jalur order belum membawa
`sales_code`/`branchId`.

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
`ACCURATE_INVOICE_DB_ID`, `ACCURATE_INVOICE_USER_ID`, `ACCURATE_INVOICE_BRANCH_ID` (opsional),
`ACCURATE_INVOICE_BATCH` (opsional, default 20). Untuk dev lokal `CRON_SECRET` sudah
ditambahkan ke `python_backend/.env` (gitignored).

### Prompt melanjutkan

> Lanjutkan pekerjaan Surya di D:\AccAPI\_github_clean, branch `feat/surya-workspace` (empat commit LOKAL `e21de22`, `f7db064`, `7343dac`, `e17a4a5` — belum di-push). Baca SYSTEM_MAP.md dan docs/SURYA_IMPLEMENTATION.md, lalu periksa kondisi aktual. Tahap 1–3 selesai; satuan order kini dari master Accurate; penarikan Web Sales otomatis 5 menit lewat cron; halaman Order Sales ada dengan izin `websales` terpisah. Tahap 4 dibangun penuh tapi GERBANG KIRIM MASIH TERTUTUP dan nama field request `sales-invoice/save.do` belum terbukti — satu faktur uji pada database yang saya tunjuk harus diperiksa manual sebelum `ACCURATE_INVOICE_SEND=on`. Tahap 5 (Rekapan Nota) menunggu itu plus skema modulnya di DB dev. Jangan stage massal dan jangan push tanpa saya minta.

### Prompt melanjutkan (lama, 7 September)

> Lanjutkan pekerjaan Surya di D:\AccAPI\_github_clean, branch `feat/surya-workspace` (commit `608ab9e` sudah di-push). Baca SYSTEM_MAP.md dan docs/SURYA_IMPLEMENTATION.md, lalu periksa kondisi aktual. Tahap 1–3 selesai dan tervalidasi live: ruang kerja, Summary OCR Mistral 4.1 (anotasi per halaman), order internal dengan aturan promo yang dibekukan, basis data Web Sales terpisah, dan harga dari Accurate (2,3 juta baris `item_selling_price`). Pekerjaan berikutnya: satuan dari master Accurate (bukan input bebas), aplikasi Web Sales terpisah, worker pull 5 menit, lalu faktur Accurate dan Rekapan Nota. Jangan stage massal — working tree masih memuat pekerjaan rekonsiliasi dan eksperimen OCR lama yang bukan milik tahap ini. Perbarui handover setelah setiap tahap.
