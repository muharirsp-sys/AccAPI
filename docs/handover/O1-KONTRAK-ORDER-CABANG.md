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
Sama seperti sebelumnya + `customer_no` WAJIB; cabang harga dari pelanggan (badan `branch_id` diabaikan); galat §2.
200 menambah `pelanggan: { customerNo, name, branchId, branchName }`.

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

## 4. Tugas O2 (UI)
1. Order Sales & Order Baru: pemilih pelanggan (`customers/search`) → tampilkan cabang + channel; pemilih barang (`items/search?customerId=`) → hanya barang cabang itu, satuan dari `units`, harga per satuan. Tampilkan galat berkode §2 sebagai kalimat (bukan "kosong").
2. Order Sales: `SALESMAN_BELUM_TERHUBUNG` = layar penjelas (hubungi admin), bukan form kosong.
3. User admin: panel "Salesman Accurate" (GET/PUT/DELETE tautan), pilihan dari `pilihan` (tandai yang sudah tertaut ke akun lain).
4. Antre Faktur: `GET /api/orders/salesmen?branchId=<cabang pelanggan>`.
5. Order Masuk: hasil tarik `failed[].kode` tampil per permintaan.

## 5. Deploy (urut)
1. IT Support: `docs/handover/DDL_O1.sql` sebagai pemilik SEBELUM image (VERIFIKASI semua `ok`).
2. Image baru; segera picu sync `branch,employee,item,customer` (lihat kepala DDL_O1: perintah + perkiraan durasi). Sebelum sync item selesai semua order ditolak `BARANG_BEDA_CABANG` (gagal tertutup).
3. Kirim `results.item.tagTakDikenal` ke orkestrator; periksa sebaran barang per cabang dan jumlah pelanggan suspended.
4. Admin menautkan akun salesman (sebelum sales memakai Order Sales).
5. Order `needs_price` LAMA (sebelum O1) tetap tidak bisa difakturkan — lihat TERBUKA.

## 6. TERBUKA
- Order `needs_price` yang sudah tersimpan sebelum O1: tidak ada jalur memberi harga (O1 hanya membuat order baru berharga). Perlu hitungan produksi (orkestrator) → batal + order ulang, atau endpoint "beri harga" (keputusan owner).
- Penanda "petugas internal = `order.view`" (semua cabang) adalah tafsir teknis dari "admin/fakturist boleh semua cabang"; bila owner mau kunci khusus, tambahkan kapabilitas.
- Pratinjau Next tidak meneruskan `customer_no` ke FastAPI `/orders/preview` (sebelum O1 pun begitu) → kelas outlet/`channel_masalah` tidak dihitung di pratinjau, berbeda dengan saat simpan. Di luar lingkup O1 (aturan promo).
- 31 nilai `charField2` probe tidak tersedia sebagai berkas; uji memakai superset (22 nama cabang + 6 pemetaan + 6 non-jual + tak dikenal). Sesudah sync pertama `tagTakDikenal` membuktikan tidak ada yang terlewat.
- `customer/list.do` & `item/list.do` `suspended`: bila Accurate mengabaikan field itu, semua tetap `false` — periksa sesudah sync pertama.
