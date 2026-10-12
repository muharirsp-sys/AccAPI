# O1 — Kontrak server Order per cabang Accurate (untuk O2 UI)

Status: DRAFT O1 (12 Okt 2026), zona AGENTS §3 (sync Accurate, harga, jalur order → faktur) — 2 peninjau Opus sebelum merge.
Keputusan owner (mengikat): `scratch/fiori-intake/OWNER-ANSWERS-ORDER-CABANG-2026-10-12.md`.

## 1. Aturan

| Aturan | Sumber | Di mana ditegakkan |
|---|---|---|
| Pelanggan cabang X hanya boleh dipesankan barang ber-cabang X | owner 12 Okt | `lib/order-cabang.ts periksaOrder` (pratinjau + simpan), pencarian barang |
| Cabang barang = tag divisi `item.charField2` → cabang (`TAG_KE_CABANG`: nama cabang persis; `24MNF1`/`21MNF2`/`FRN` → MIX NON FOOD; `HEINZ ABC` → HEINZ; `MIX2` → DOLPHIN; `FKS` → MIX FOOD). Non-jual (ALAT TULIS KANTOR, ASSET, AMARON, LAKBAN BENING, PEMBELIAN ASET, PRINTER), tanpa tag, tag tak dikenal → `item.branch_id` NULL = tak bisa diorder | owner 12 Okt | `lib/sync.ts` (item/list.do + webhook item) |
| Cabang salesman = `accurate_employee.branch_id` karyawan yang ditautkan ke akun | owner 12 Okt | `cakupanCabang` |
| Petugas internal (punya `order.view`: admin/fakturist/Order Masuk) = semua cabang; akun lain (sales: `websales.*` saja) = cabang karyawannya | O1 (tafsir teknis) | `cakupanCabang` |
| Pelanggan/barang suspended di Accurate tidak bisa diorder | brief O1 | sync (`suspended`) + `periksaOrder` + pencarian |
| Harga = cabang PELANGGAN (dibaca server), tanggal berlaku terbaru ≤ tanggal order; cabang pelanggan tanpa baris harga → cabang default | lib/item-price | pratinjau, `/api/orders/harga`, pencarian barang |
| Order Web Sales dibekukan BERHARGA saat ditarik (tidak lagi `needs_price`); faktur memakai harga beku | BL-18 | FastAPI `store_order` ← `/api/orders/harga` |

Tautan akun ↔ karyawan disimpan di `sales_profile.sales_code` (= `accurate_employee.number`). `sales_profile.accurate_branch_id` TIDAK dibaca/diisi (salinan cabang akan basi).

## 2. Kode galat (`{ ok:false, kode, error, ... }`; FastAPI: `{ ok:false, detail, kode, ... }`)

| Kode | HTTP | Arti / tindakan UI |
|---|---|---|
| `SALESMAN_BELUM_TERHUBUNG` | 403 | Akun belum ditautkan ke karyawan salesman Accurate (atau kodenya tak ada / >1 profil). Tampilkan kalimatnya; jangan tampilkan daftar kosong. |
| `SALESMAN_TIDAK_AKTIF` | 403 | Karyawan tertaut suspended / bukan salesman / tanpa cabang di Accurate. |
| `CABANG_DI_LUAR_CAKUPAN` | 403 | Salesman meminta cabang/pelanggan cabang lain. |
| `PELANGGAN_WAJIB` | 400 | Pratinjau/simpan tanpa kode pelanggan. |
| `PELANGGAN_TIDAK_ADA` | 409 | Kode/id pelanggan tak ada di master hasil sync. |
| `PELANGGAN_SUSPENDED` | 409 | Pelanggan suspended di Accurate. |
| `PELANGGAN_TANPA_CABANG` | 409 | Pelanggan tanpa cabang di Accurate. |
| `BARANG_TIDAK_ADA` | 409 | `barang: [kode]`. |
| `BARANG_SUSPENDED` | 409 | `barang: [kode]`. |
| `BARANG_BEDA_CABANG` | 409 | `barang: [{code, name, branchId, branchName, tag}]` — termasuk barang tanpa cabang (non-jual/tag tak dikenal). |
| `SATUAN_SALAH` | 409 | `wrong_unit: [{code, unit, known_units}]` (bentuk lama dipertahankan). |
| `HARGA_BELUM_ADA` | 409 | `missing: [kode]` (bentuk lama dipertahankan). |
| `INPUT_TIDAK_VALID` | 400 | Query/badan tidak valid. |
| `TIDAK_DIIZINKAN` | 403 | Izin layar tidak ada. |

## 3. Endpoint

### `GET /api/customers/search?q=&branchId=&limit=`
Izin `websales.create` ATAU `order.create`. `limit` 1–50 (20). Cari nama/kode (ILIKE, `%`/`_` literal), kode persis di atas.
Tanpa suspended, tanpa cabang kosong. Salesman: hanya cabangnya (`branchId` lain → 403). Internal: semua atau saring `branchId`.
200: `{ ok, cakupan: {semua, branchId, branchName}, items: [{ id, customerNo, name, branchId, branchName, categoryName, channel ("GT"/"MT"/…), priceCategoryName, alamat }] }`.

### `GET /api/items/search?q=&branchId=&customerId=&tanggal=&limit=`
Izin sama. Dengan `customerId` (= `customer.id`): cabang = cabang pelanggan (`branchId` beda → 400), plus harga per satuan.
Tanpa `customerId`: salesman = cabangnya; internal = `branchId` atau semua. Tanpa suspended / tanpa cabang. `tanggal` bawaan hari ini WITA.
200: `{ ok, tanggal, branchId, items: [{ id, no, name, branchId, branchName, tag, units: [{ unit, price?, source?, branchName?, effectiveDate? }] }] }`
(`price/source/...` hanya bila `customerId`; `units: []` = belum ada daftar harga → tidak bisa dipilih).

### `POST /api/orders/preview` (berubah)
`customer_no` WAJIB; cabang harga dari pelanggan (badan `branch_id` diabaikan); galat §2. Bentuk jawaban + `sidik` + harga petugas: §4.2.

### `POST /api/orders/harga` (layanan; juga boleh sesi)
Dipanggil FastAPI (`python_backend/order_cabang.py`). CRON_SECRET (Bearer) = semua cabang; sesi `websales.create`/`order.create` = cakupan pemakai.
Badan `{ customer_no, order_date, lines: [{code, unit, quantity?}], harga?: boolean }` (1–500 baris). `harga:false` = aturan cabang saja.
200: `{ ok, pelanggan, lines: [{code, unit, quantity, price}] }` (urutan = masukan). Tanpa efek samping.

### `GET /api/orders/salesmen?branchId=` (berubah)
Izin `order.edit`. `branchId` = hanya salesman aktif cabang itu (Antre Faktur: kirim cabang pelanggan order — ambil dari
`branch.branchId` jawaban pratinjau `POST /api/orders/[id]/invoice` `queue:false`). Kosong = semua (perilaku lama).

### `GET|PUT|DELETE /api/admin/users/[id]/salesman` (baru)
- GET (izin `users.manage` atau `users.view`): `{ ok, tautan: [{ salesCode, salesName, employeeId, employeeName, branchId, branchName, salesman, suspended, aktif }], pilihan: [{ id, number, name, branchId, branchName, terhubungKe: {userId, name, email} | null }] }` — `pilihan` = karyawan salesman aktif, urut cabang lalu nama.
- PUT `{ employeeNumber }` (izin `users.manage`): tetapkan/ganti. 200 `{ ok, changed, tautan: { salesCode, employeeName, employeeId, branchId, branchName } }`. Galat (`code`): `KARYAWAN_TIDAK_ADA` 404, `KARYAWAN_GANDA`/`KARYAWAN_BUKAN_SALESMAN_AKTIF`/`KARYAWAN_TANPA_CABANG`/`KARYAWAN_SUDAH_TERHUBUNG` (+`terhubungKe`)/`PROFIL_GANDA` 409, `USER_TIDAK_ADA` 404, `IZIN_BERUBAH` 403.
- DELETE (izin `users.manage`): lepas (hapus baris `sales_profile` akun; baris utuh di audit). 200 `{ ok, changed }`.
- Audit `permission_audit_log`: `salesman.link` (`detail.sebelum/sesudah`), `salesman.unlink` (`detail.dihapus`) — tampil di Riwayat user (label di `lib/rbac.ts`).

### FastAPI (berubah)
- `POST /websales/orders`: diperiksa Next dengan sesi sales sebelum disimpan; ditolak → status + `{ ok:false, detail, kode, ... }`; Next tak terjangkau → 503. Harga tetap TIDAK disimpan di permintaan.
- `POST /orders` (Order Baru): aturan cabang diperiksa (harga petugas tidak ditimpa); ditolak → `{ ok:false, detail, kode, ... }`.
- Tarik (`/orders/pull`, `/orders/pull-cron`): order dibekukan berharga server → `draft`. Permintaan yang ditolak tetap `pending` dan muncul di `failed: [{ request_id, error, kode }]`; Next tak terjangkau → 503 (tarikan berhenti).

## 4. Promo — pratinjau = tersimpan (owner 12 Okt 2026, putaran perbaikan 1)

Owner (revisi 12 Okt): program promo (Summary terbit) terhubung di Order Sales DAN Order Manual (Order Baru); angka yang dilihat di
pratinjau (diskon/bonus/net per baris) = angka yang tersimpan/dibekukan. Tidak ada hitung ulang diam-diam yang berbeda.

### 4.1 Satu fungsi, masukan sama
- **Hitung promo = SATU fungsi** FastAPI `hitung_promo` (`python_backend/routers/orders.py`): `published_rules()` + `calculate(...)` dengan
  kelas outlet pelanggan (`outlet_class.classes_of(customer_no)` + `known()`). Dipakai: pratinjau (`POST /orders/preview`), simpan Order Baru
  (`POST /orders`), simpan Order Sales (`POST /websales/orders`), tarik (`/orders/pull`, `/orders/pull-cron`).
- **Harga = SATU pemeriksa** Next `periksaOrder` (`lib/order-cabang.ts`): pratinjau memanggilnya langsung; simpan/tarik lewat
  `POST /api/orders/harga` (FastAPI `order_cabang.periksa`). Cabang harga = cabang pelanggan (server), tanggal berlaku ≤ `order_date`.
- **Masukan:** `customer_no` (→ cabang/principal, harga, kelas outlet), `channel` (simpan menolak bila ≠ master: `CHANNEL_BEDA_MASTER`;
  pratinjau melaporkannya di `channel_masalah` dengan kalimat yang sama), `order_date`, baris berharga `[kode, satuan, jumlah, harga]`.
- **Principal cabang pelanggan** ditegakkan lewat kode barang: semua baris order = barang cabang pelanggan (`BARANG_BEDA_CABANG`), dan
  program hanya berlaku pada baris yang kodenya ada di `codes` program → hanya program principal cabang itu yang bisa kena.
- **`sidik`** = sha256 atas `{customer_no, channel, order_date, baris [kode, satuan, jumlah, harga], result}` (angka dinormalkan). Pratinjau
  mengembalikannya; simpan WAJIB membawanya dan server menghitung ulang dengan fungsi + masukan yang sama: beda = DITOLAK
  `PRATINJAU_BERUBAH` (409) beserta pratinjau baru — tidak disimpan. Yang disimpan selalu hitungan server, bukan angka klien.
- **Dibekukan:** Order Baru saat simpan. Order Sales dicocokkan saat simpan (sesi sales) lalu DIBEKUKAN saat tarik (cocok `sidik` lagi;
  beda = permintaan `rejected` `PRATINJAU_BERUBAH`, sales kirim ulang). Sesudah beku, aturan diubah/ditarik TIDAK mengubah order
  (`rules` utuh, `sources`, `result`, `lines` berharga tersimpan di order).

### 4.2 `POST /api/orders/preview` — bentuk jawaban (dipakai Order Sales DAN Order Baru)
Badan: `{ customer_no, channel, order_date, lines: [{ code, unit, quantity, price? }] }`. `price` = harga petugas, HANYA izin `order.create`
(Order Baru); akun tanpa `order.create` mengirim `price` → 400 `INPUT_TIDAK_VALID`.
```
200 { ok: true,
  pelanggan: { customerNo, name, branchId, branchName },
  lines:  [{ code, unit, quantity, price: "7207", sumber_harga: "master" | "petugas" }],      // harga yang DIPAKAI (string)
  prices: [{ code, unit, price, source: "tier" | "petugas", hargaMaster, priceCategoryName, branchName, effectiveDate, knownUnits }],
  result: { gross, discount, net,
            lines: [{ code, unit, quantity, gross, net, percents: ["10"], cash }],   // PER BARIS = yang dibekukan
            bonuses: [{ program_id, code, unit, quantity, eligible_codes? }],
            applications: [{ program_id, minimum, discount }],
            blocked: [{ program_id, program_name, reason }] },                        // program yang tertahan kelas outlet
  suggestions: [{ program_id, message, codes, ... }],
  sources: [{ draft_id, revision }],
  channel_masalah: "",            // tidak kosong = simpan akan ditolak CHANNEL_BEDA_MASTER (tampilkan, jangan izinkan simpan)
  sidik: "<64 hex>" }
```
`hargaMaster` = harga master sah baris itu (null bila tak ada) — untuk tanda "harga diubah petugas". Galat FastAPI diteruskan berkode
`{ ok:false, kode, error }` (mis. `ATURAN_BELUM_TERBIT` 409); galat Next §2 tetap.

### 4.3 Simpan (FastAPI) — WAJIB membawa `sidik` pratinjau terakhir
- Order Baru `POST /orders`: `{ outlet, channel, order_date, note, customer_no, lines: [{ code, unit, quantity, price? }], sidik,
  confirm_duplicate? }` — `price` HANYA baris yang diketik petugas (kosong = harga master). 200 `{ ok, order }`; `order.lines[]` membawa
  `price` + `sumber_harga`, `order.result` = `result` pratinjau.
- Order Sales `POST /websales/orders`: `{ outlet, channel, order_date, note, customer_no, lines: [{ code, unit, quantity }], sidik }` → 200
  `{ ok, request }` (permintaan TANPA harga; `sidik` disimpan, dicocokkan lagi saat tarik). `GET /websales/orders` menambah
  `reject_code`, `reject_reason`, `rejected_at` (status `pending` | `pulled` | `rejected`).
- Galat (`{ ok:false, detail, kode, ... }`): `SIDIK_WAJIB` 400 · `PRATINJAU_BERUBAH` 409 + `pratinjau: { lines, result, sources, sidik }`
  (tampilkan angka baru, minta konfirmasi, simpan ulang dengan sidik baru) · `CHANNEL_BEDA_MASTER` 422 · `HARGA_TIDAK_VALID` 400 ·
  `ORDER_GANDA` 409 (Order Baru: `confirm_duplicate:true` sesudah diperiksa) · `ATURAN_BELUM_TERBIT` 409 · kode §2 (Next) ·
  `KONFIGURASI_SERVER` / `LAYANAN_TIDAK_PASTI` 503 (TIDAK tersimpan; jangan tampilkan "sesi berakhir").

### 4.4 Harga petugas (Order Baru) — aturan timpa
Per baris: `price` diisi = harga petugas MENANG atas master, wajib > 0 (≤ 0 / bukan angka → `HARGA_TIDAK_VALID` 400), tercatat
`sumber_harga: "petugas"`. `price` kosong = harga master yang SAH (daftar harga Accurate cabang pelanggan — atau cabang default bila
cabang pelanggan tak punya baris berlaku — dan > 0; harga standar `item.unitPrice`, harga 0, harga cabang lain → `HARGA_BELUM_ADA`).
Server tidak pernah menimpa harga petugas dan tidak pernah mengisi harga diam-diam. Order Sales tidak pernah membawa harga.

### 4.5 Tarik (`/orders/pull`, `/orders/pull-cron`)
200 `{ ok, imported: [{request_id, order_id}], already_imported: [id], failed: [{request_id, error, kode: "ORDER_GANDA", duplicate: true}],
rejected: [{request_id, kode, error}] }`. `failed` = DITAHAN (tetap `pending`, menunggu keputusan — BL-20). `rejected` = PERMANEN
(status `rejected` + sebab; tidak dicoba lagi): kode §2, `PRATINJAU_BERUBAH`, `CHANNEL_BEDA_MASTER`, `SIDIK_WAJIB`, `DATA_TIDAK_VALID`.
503 `{ ok:false, detail, kode }` (Next tak pasti / konfigurasi) dan 409 `ATURAN_BELUM_TERBIT` = tarikan BERHENTI, tidak ada yang ditolak.

## 5. Tugas O2 (UI)
0. Promo (§4): Order Sales & Order Baru menampilkan `result` pratinjau per baris (bruto, persen, potongan rupiah, netto) + `bonuses` +
   `blocked`; simpan membawa `sidik` pratinjau TERAKHIR (pratinjau usang/masih dihitung = tombol simpan terkunci). `PRATINJAU_BERUBAH` →
   tampilkan `pratinjau` baru dan minta konfirmasi ulang. Order Baru mengirim `price` hanya untuk baris yang diketik petugas.
1. Order Sales & Order Baru: pemilih pelanggan (`customers/search`) → tampilkan cabang + channel; pemilih barang (`items/search?customerId=`) → hanya barang cabang itu, satuan dari `units`, harga per satuan. Tampilkan galat berkode §2 sebagai kalimat (bukan "kosong").
2. Order Sales: `SALESMAN_BELUM_TERHUBUNG` = layar penjelas (hubungi admin), bukan form kosong.
3. User admin: panel "Salesman Accurate" (GET/PUT/DELETE tautan), pilihan dari `pilihan` (tandai yang sudah tertaut ke akun lain).
4. Antre Faktur: `GET /api/orders/salesmen?branchId=<cabang pelanggan>`.
5. Order Masuk: hasil tarik `failed[].kode` tampil per permintaan.

## 6. Deploy (urut)
1. IT Support: `docs/handover/DDL_O1.sql` sebagai pemilik SEBELUM image (VERIFIKASI semua `ok`).
2. Image baru; segera picu sync `branch,employee,item,customer` (lihat kepala DDL_O1: perintah + perkiraan durasi). Sebelum sync item selesai semua order ditolak `BARANG_BEDA_CABANG` (gagal tertutup).
3. Kirim `results.item.tagTakDikenal` ke orkestrator; periksa sebaran barang per cabang dan jumlah pelanggan suspended.
4. Admin menautkan akun salesman (sebelum sales memakai Order Sales).
5. Order `needs_price` LAMA (sebelum O1) tetap tidak bisa difakturkan — lihat TERBUKA.

## 7. TERBUKA
- Order `needs_price` yang sudah tersimpan sebelum O1: tidak ada jalur memberi harga (O1 hanya membuat order baru berharga). Perlu hitungan produksi (orkestrator) → batal + order ulang, atau endpoint "beri harga" (keputusan owner).
- Penanda "petugas internal = `order.view`" (semua cabang) adalah tafsir teknis dari "admin/fakturist boleh semua cabang"; bila owner mau kunci khusus, tambahkan kapabilitas.
- 31 nilai `charField2` probe tidak tersedia sebagai berkas; uji memakai superset (22 nama cabang + 6 pemetaan + 6 non-jual + tak dikenal). Sesudah sync pertama `tagTakDikenal` membuktikan tidak ada yang terlewat.
- `customer/list.do` & `item/list.do` `suspended`: bila Accurate mengabaikan field itu, semua tetap `false` — periksa sesudah sync pertama.
