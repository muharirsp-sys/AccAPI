# Supervisor Review — desain

Tanggal: 16 Okt 2026. Status: disetujui owner per bagian (sesi brainstorming 15–16 Okt).
Acuan layar: "Supervisor Review" EskaLink (foto di `scratch/fiori-intake/supervisor-review/`). Eksplorasi awal:
`scratch/fiori-intake/supervisor-review/SUPERVISOR-REVIEW-EKSPLORASI-2026-10-15.md`.
Data contoh di uji, templat, dan mock memakai SALES A, CABANG A, PRINCIPLE A, bukan nama dari foto.

## 1. Tujuan dan lingkup

SPV, SM, dan Admin/Manager dapat melihat dalam satu layar untuk satu tanggal WITA:
- **Tabel ringkasan per salesman** (C), dikelompokkan per cabang dengan baris TOTAL per cabang.
- **Rincian kunjungan** salesman yang dipilih (C).
- **Peta titik kunjungan** (A).
- **Tombol WhatsApp** untuk mengirim ringkasan ke salesman.

**Keputusan owner:**

| # | Pertanyaan | Jawaban |
|---|---|---|
| 1 | Cakupan "A-C" | A + C. **Tanpa B** (pelacakan lokasi langsung). |
| 2 | Sumber EC dan angka order | **Gabungan:** EC dari ORDER Form Kontrol; Qty/Item/nilai dari faktur Accurate. |
| 2b | Faktur tanpa kunjungan Form Kontrol | Dihitung **EC dan Call Non Rute**. |
| 3 | Lokasi toko di peta | Owner memberi **latitude/longitude per kode JKS** (= kode pelanggan Accurate). |
| 4 | Siapa melihat | **Mengikuti hierarki:** SPV melihat timnya, SM bawahannya, Admin/Manager semua cabang. |
| 5 | Kolom tanpa sumber | Canvas Qty, Back, Time Pause **dibuang**. **Send message dipertahankan** lewat WhatsApp (`wa.me`). |
| 6 | Pendekatan angka faktur | **Kolom ringkas di `sales_invoice`, diisi saat sinkron**, ditambah backfill 60 hari. |

**Fakta produksi yang membentuk desain (probe baca-saja 15 Okt):**
- **Form Kontrol nyaris belum dipakai.** Dalam 10 hari hanya ada 2 kunjungan (pilot MSM 14 Okt) dan 2 titik GPS.
- **Order Sales aplikasi belum dipakai.** `order_request` berisi 0 baris sejak rilis 12 Okt.
- **Faktur Accurate lengkap.** Pada 14 Okt, 851/851 INV memiliki `detailItem` dan salesman header/baris, dan masuk hampir seketika lewat webhook.
- **Mengurai `raw_data` satu hari makan 9,1 dtk** (851 faktur, JSON string ±50 KB per faktur) di VPS 2 core. Karena itu dipilih kolom ringkas, bukan hitung saat dibuka.
- **Toko tidak punya koordinat** di `customer`, `jks_master`, maupun Accurate. Koordinat hanya ada di `noo_toko` dan titik check-in.

**Di luar lingkup:**
- Pelacakan GPS latar belakang.
- Kotak pesan dalam aplikasi atau WhatsApp API.
- Canvas Qty, Back, Time Pause.
- Rentang tanggal: satu tanggal per tampilan.
- Perbaikan faktur terhapus (PR #185, terpisah).

## 2. Definisi angka (per salesman, per tanggal WITA)

| Kolom | Definisi |
|---|---|
| Status | ⚪ belum check-in hari itu · 🟢 sedang di toko (check-in tanpa check-out) · 🔵 sudah berkunjung, sedang tidak di toko |
| Registered Outlet | `count(distinct cust_code)` dari `jks_master` aktif milik `sales_code` (semua hari) |
| Call Plan | Toko JKS terjadwal tanggal itu: `hari_kunjungan` = hari + `minggu_pattern` ∈ {all, paritas minggu}, `is_active`. Filter sama dengan `getTodayRoute`. |
| Call Rute | Toko Call Plan yang punya `ao_control_daily.checkin_at` tanggal itu |
| Call Non Rute | (a) toko di-check-in yang tercatat di `kunjungan_luar_rute` (`dibatalkan_pada IS NULL`) **+** (b) toko berfaktur salesman itu tanpa check-in tanggal itu |
| EC | Himpunan toko: `ao_control_daily.status ∈ {ordered, active}` ∪ toko berfaktur salesman itu (tanggal faktur = tanggal itu). **Satu toko dihitung sekali.** |
| NOO | Baris `noo_toko` salesman itu bertanggal itu |
| Quantity | Σ `qty_total` faktur EC (satuan terkecil) |
| Item/EC | Σ `jumlah_item` faktur ÷ EC (0 bila EC = 0) |
| Nilai Order (Inquiry) | Σ `dpp` faktur (sebelum PPN; dasar yang sama dengan insentif) |
| Omzet/EC | Nilai Order ÷ EC |
| Time at Outlet | Σ (`checkout_at` − `checkin_at`) kunjungan ber-check-out, dalam jam |
| Time Travel | Σ (`checkin_at` kunjungan berikutnya − `checkout_at` sebelumnya), urut `checkin_at`, dalam jam |

**Kunci toko:**
- Faktur `customer_no` (berakhiran cabang) dipetakan ke kode JKS lewat `kodeJksUntuk` (`lib/form-kontrol/constants.ts`).
- EC dan Call dihitung per toko per salesman, tanpa memecah per principal.

**Kunci salesman:**
- Faktur header `masterSalesmanId` → `accurate_employee.number` → rantai `sales_code_merge` bulan faktur, lewat `muatPetaOrang` / `orangDariSalesmanId` (`lib/kasir/`).
- Faktur tanpa kode terpetakan masuk ke baris **"Tanpa salesman terpetakan"** di cabangnya.

**Faktur yang dihitung:** nomor berawalan `INV`, dan `trans_date` (teks `dd/MM/yyyy`) sama dengan tanggal tampilan.

**Rincian kunjungan (salesman terpilih):**
- Satu baris per kunjungan: kode dan nama toko, mulai, selesai, menit di toko, waktu tempuh dari kunjungan sebelumnya, qty, item, tanda EC ✓, jarak ke koordinat toko.
- Kunjungan ber-ORDER tanpa faktur diberi label **"belum difakturkan"**; masuk EC tanpa qty/nilai.
- Toko berfaktur tanpa check-in muncul sebagai baris **"tanpa check-in"** tanpa jam.
- Subtotal ditampilkan di bawah.

## 3. Data dan arsitektur

### 3.1 Skema

Satu berkas `docs/handover/DDL_SUPERVISOR_REVIEW.sql` (role pemilik `accapi`, **sebelum image**, idempoten, blok VERIFIKASI) ditambah entri `scripts/migrate-pg.mjs` dan `db/schema.ts`. Semua perubahan bersifat EXPAND; image lama tidak terganggu.

- **`sales_invoice`** + `salesman_id bigint`, `qty_total numeric`, `jumlah_item integer`, `dpp numeric(18,2)`.
  - Semua nullable tanpa default, sehingga instan di tabel 2,3 GB.
  - Nilai NULL berarti rincian belum terbaca.
- **`toko_koordinat`**: `cust_code text PRIMARY KEY` (kode JKS), `lat double precision`, `lng double precision`, `diperbarui_pada timestamptz`, `diperbarui_oleh text`.
  - CHECK wilayah Indonesia: lat −11…6, lng 95…141.
  - GRANT SELECT/INSERT/UPDATE untuk `accapi_app`.
- **`sales_profile`** + `no_hp text`.
  - CHECK `no_hp ~ '^08[1-9][0-9]{7,10}$'` bila tidak NULL; bentuk kanonik sama dengan NOO.

### 3.2 Pengisian ringkasan faktur

**Fungsi murni `ringkasFaktur(row)`** di `lib/supervisor-review/ringkas-faktur.ts`, dengan keluaran:

| Keluaran | Sumber |
|---|---|
| `salesmanId` | `row.masterSalesmanId` |
| `qtyTotal` | Σ `quantityDefault`, cadangan `quantity × unitRatio` (sama dengan `lib/promo-recap.ts`) |
| `jumlahItem` | Jumlah baris `detailItem` |
| `dpp` | Σ `dppAmount` (sama dengan `lib/sales-history/accurate.ts`) |

- Bila `detailItem` bukan larik, semua keluaran `null`.

**Titik panggil tunggal:** `SYNC_MODULES.sales_invoice.upsertPage` di `lib/sync.ts`. Titik ini mencakup webhook, `webhook-backfill`, `invoice-outbox/send`, dan cron list.do.
- Di `set{}` dipakai `coalesce(excluded.kolom, sales_invoice.kolom)`, meniru penjaga `raw_data` yang sudah ada. Akibatnya jawaban list.do (tanpa rincian) tidak mengosongkan ringkasan.

**Backfill** `scripts/backfill-ringkas-faktur.mjs`:
- Cakupan 60 hari terakhir, per hari.
- Ambil id faktur hari itu, lalu baca `raw_data` per PK secara bertahap dan tulis keempat kolom.
- Memakai fungsi yang sama dengan sinkron; tidak ada logika SQL kembar.
- Dijalankan sekali di dalam container frontend di luar jam sibuk, perkiraan ±10 menit.
- Idempoten: hanya baris dengan `qty_total IS NULL`.

### 3.3 Perhitungan dan API

**Pustaka `lib/supervisor-review/`:**
- `ringkasan.ts`: murni. Masukannya jadwal JKS, kunjungan, luar rute, NOO, ringkasan faktur, peta salesman, dan koordinat toko. Keluarannya baris per salesman, total per cabang, rincian kunjungan, penanda peta, dan teks WhatsApp.
- `db.ts`: pemuat Postgres per tanggal dan cakupan.

**API `GET /api/supervisor-review?tanggal=YYYY-MM-DD&cabang=&principle=`:**
- Izin `supervisor_review.view`.
- Cakupan dari `resolveScope(session).allowedSalesCodes` (`lib/form-kontrol/scope.ts`): SPV → timnya, SM → semua SPV dan salesman bawahannya, Admin/Manager → semua (`null`).
- Tanggal bawaan `witaToday()`, bukan UTC.
- Sengaja tidak di bawah `/api/form-kontrol`, karena prefiks itu mendapat `Cache-Control: private, max-age=300`.

**API `POST /api/supervisor-review/koordinat`:**
- Izin `form_kontrol.manage`.
- Isi: xlsx (kode toko, latitude, longitude), diurai SheetJS seperti `app/api/form-kontrol/jks/route.ts`.
- Penolakan dilaporkan per baris dengan nomor baris Excel, dan baris sah tetap tersimpan (upsert).
- Ditolak bila: kode tidak ada di `jks_master`, bukan angka, atau di luar wilayah Indonesia.

**No HP:** kolom baru di tab Hierarki (`app/api/form-kontrol/sales-profiles`, izin `form_kontrol.manage` dan global).

### 3.4 Izin

- Kunci baru `supervisor_review.view`, ditambahkan di:
  - `lib/rbac/registry.ts`,
  - `permissionActions` / `actionLabels` (`lib/rbac.ts`),
  - `pagePermissions` untuk `/supervisor-review` (di atas entri `"/"`),
  - menu `config/workspace-navigation.ts`,
  - `lib/rbac/registry.test.ts`.
- `docs/handover/RBAC_PRESET_SUPERVISOR_REVIEW.sql` (sesudah image, idempoten, pola `RBAC_PRESET_NOO.sql`) memberi kunci ke grup SPV, SM, Manager, Admin.
- `scripts/seed-rbac-presets.ts` **tidak** dipakai ke produksi.

## 4. Tampilan

**Kepala halaman:** pilih tanggal, saring cabang dan principal, tombol **Muat ulang**, dan keterangan "data per HH.MM".

**Desktop:**
- Tabel ringkasan selebar layar dengan kolom salesman tetap saat digulir menyamping, dikelompokkan per cabang dengan baris TOTAL.
- Di bawahnya, peta di kiri dan rincian kunjungan salesman terpilih di kanan.

**Ponsel (390 px):**
- Kartu per salesman: nama, status, EC/Call Plan, nilai.
- Ketuk kartu untuk membuka rincian dengan tab **Kunjungan | Peta**.

**Peta:**
- **Pustaka:** Leaflet (dependensi baru, dipakai langsung tanpa pembungkus React), dimuat dinamis hanya di halaman ini.
- **Ubin:** OpenStreetMap dengan atribusi "© OpenStreetMap contributors". Tidak ada CSP di app Next yang memblokir ubin.
- **Penanda toko** (yang punya koordinat): 🟢 dikunjungi + EC · 🟡 dikunjungi tanpa EC · 🔴 terjadwal belum dikunjungi · 🟣 berfaktur tanpa check-in.
- **Cakupan tampilan:**
  - Bawaan: semua salesman dalam cakupan.
  - Memilih satu salesman menyaring peta dan menggambar garis urutan check-in.
- **Jauh dari toko:**
  - Check-in yang berjarak > `JARAK_JAUH_M = 200` meter dari koordinat toko ditandai di rincian sebagai "jauh dari toko (N m)".
  - Jarak dihitung dengan haversine.
  - `ponytail:` ambang ini satu konstanta yang disetel dari data nyata; akurasi GPS median saat ini ±11 m.
- **Toko tanpa koordinat** hanya tampil di tabel dan rincian. Halaman menampilkan "N toko JKS belum punya koordinat".

**WhatsApp (Send message):**
- Tombol per salesman membuka `https://wa.me/628…?text=…`. Nomor `08…` dinormalkan ke `628…`.
- **Isi teks:** tanggal, Call Plan, Call Rute/Non Rute, EC, Nilai Order, dan daftar toko terjadwal yang belum dikunjungi (maks. 15, lalu "dan N lainnya").
- **Tanpa nomor:** tombol nonaktif dengan petunjuk "No HP belum diisi — Admin: tab Hierarki".

**Admin:**
- Tab baru **Koordinat Toko** di Form Kontrol, di samping tab JKS: unduh templat, pratinjau, lalu unggah.
- Kolom **No HP** di tab Hierarki.

## 5. Galat dan data tak lengkap

Semua kondisi ini terlihat di layar, tidak pernah diam-diam:
- **Faktur hari itu dengan `qty_total IS NULL`** (rincian belum masuk): tampil "N faktur cabang ini belum terbaca rinciannya". Cron `webhook-backfill` mengisinya.
- **`masterSalesmanId` tanpa kode:** masuk ke baris "Tanpa salesman terpetakan" per cabang.
- **Akun SPV/SM tanpa kecocokan Hierarki:** pesan "Akun belum tertaut ke hierarki — hubungi Admin" (bukan tabel kosong).
- **Faktur terhapus di Accurate** (cache hantu, PR #185) dapat ikut terhitung. Dampaknya per 15 Okt hanya 6 INV lama. Ini ketergantungan yang dicatat, bukan diperbaiki di sini.
- **`checkin_at` / `checkout_at` bertipe `timestamp` tanpa zona.** Pembuat SR-1 WAJIB membuktikan semantik nyatanya (UTC atau WITA) di produksi dengan probe baca-saja, sebelum menghitung jam dan Time Travel, lalu menuliskan buktinya di PR.

## 6. Uji

TDD. Setiap uji baru dibuktikan merah dengan sabotase.

**Unit:**
- `ringkasFaktur`: `quantityDefault` dan cadangannya, Σ DPP, tanpa `detailItem` → null.
- `ringkasan`: setiap baris tabel §2, termasuk EC gabungan dihitung sekali, faktur tanpa check-in → Non Rute + EC, "belum difakturkan", Time Travel, dan status.
- Teks WhatsApp dan normalisasi nomor.
- Validasi koordinat dan haversine.

**PG** (`uji-pg-fiori.sh`):
- DDL idempoten + migrate-pg SKIP.
- `upsertPage`: list.do tidak mengosongkan ringkasan.
- Backfill idempoten.
- Cakupan SPV/SM/global, termasuk SM tidak lagi 403.
- Unggah koordinat: penolakan per baris.

**Playwright:**
- Desktop dan ponsel 390 px.
- Penanda peta dengan ubin di-mock.
- `href` tautan WA.
- Tab Koordinat Toko.

## 7. Pecahan dan rilis

| Slice | Isi | Peninjau |
|---|---|---|
| **SR-1** server | DDL (3 perubahan), `ringkasFaktur` di `upsertPage`, skrip backfill, `lib/supervisor-review`, API ringkasan + koordinat + No HP, kunci izin + preset | A (Opus; zona skema & sinkron) |
| **SR-2** layar | Halaman `/supervisor-review`: tabel, total cabang, rincian, WhatsApp; kolom No HP di Hierarki | B (UI) |
| **SR-3** peta | Leaflet, penanda, garis urutan, jarak; tab Koordinat Toko | B (UI) |

**Urutan rilis** (setiap merge ke main atas perintah owner):
1. Cadangan DB.
2. `DDL_SUPERVISOR_REVIEW.sql`.
3. Merge SR-1, lalu tunggu container (migrate-pg SKIP).
4. Jalankan backfill.
5. `RBAC_PRESET_SUPERVISOR_REVIEW.sql`.
6. Merge SR-2 dan SR-3 (boleh satu deploy).
7. Uji asap.

**Prasyarat agar layar berisi penuh** (tanggung jawab owner/Admin, bukan kode):
- Salesman rutin check-in di Form Kontrol.
- Koordinat toko diunggah.
- No HP salesman diisi.
