# O1 — Kontrak server Order per cabang Accurate (untuk O2 UI)

Status: DRAFT O1 + putaran perbaikan 1 (12 Okt 2026), zona AGENTS §3 (sync Accurate, harga, jalur order → faktur) — 2 peninjau Opus sebelum
merge. Putaran 1 = `scratch/fiori-intake/O1-PERBAIKAN-PUTARAN1-2026-10-12.md` butir 1–15.
Keputusan owner (mengikat): `scratch/fiori-intake/OWNER-ANSWERS-ORDER-CABANG-2026-10-12.md`.

## 1. Aturan

| Aturan | Sumber | Di mana ditegakkan |
|---|---|---|
| Pelanggan cabang X hanya boleh dipesankan barang ber-cabang X | owner 12 Okt | `lib/order-cabang.ts periksaOrder` (pratinjau + simpan), pencarian barang |
| Cabang barang = tag divisi `item.charField2` → cabang (`TAG_KE_CABANG`: nama cabang persis; `24MNF1`/`21MNF2` → MIX NON FOOD; `FRN` → SHINZUI (revisi owner); `HEINZ ABC` → HEINZ; `MIX2` → DOLPHIN; `FKS` → MIX FOOD). Non-jual (ALAT TULIS KANTOR, ASSET, AMARON, LAKBAN BENING, PEMBELIAN ASET, PRINTER), tag kosong, tag tak dikenal → `item.branch_id` NULL = tak bisa diorder. Jawaban Accurate TANPA key `charField2` = cabang lama dipertahankan (butir 10) | owner 12 Okt | `lib/sync.ts` (item/list.do + webhook item) |
| Cabang salesman = `accurate_employee.branch_id` karyawan yang ditautkan ke akun | owner 12 Okt | `cakupanCabang` |
| Petugas internal (punya `order.view`: admin/fakturist/Order Masuk) = semua cabang; akun lain (sales: `websales.*` saja) = cabang karyawannya. Tripwire: `websales.create` + `order.view` TANPA `order.create` = `IZIN_TIDAK_KONSISTEN` (bukan semua cabang) | O1 (tafsir teknis) + butir 11 | `cakupanCabang`/`tripwireIzin`; DDL_O1 VERIFIKASI per grup |
| Pelanggan/barang suspended di Accurate tidak bisa diorder | brief O1 | sync (`suspended`) + `periksaOrder` + pencarian |
| Harga master = daftar harga Accurate (`tier`) cabang PELANGGAN (dibaca server), tanggal berlaku terbaru ≤ tanggal order; cabang pelanggan tanpa baris berlaku → cabang DEFAULT. Harga standar `item.unitPrice` (satu angka semua satuan), harga ≤ 0, harga cabang LAIN = TIDAK sah → `HARGA_BELUM_ADA` | lib/item-price + butir 3 | `hargaSah`: pratinjau, `/api/orders/harga`, pencarian barang (`price: null`); Python menolak ≤ 0 |
| Harga petugas (Order Baru, `order.create`) per baris MENANG, > 0, tercatat `sumber_harga: "petugas"`; kosong = harga master; tidak pernah ditimpa | butir 7 | `periksaOrder`, `order_cabang.periksa`, §4.4 |
| Order Web Sales dibekukan BERHARGA saat ditarik (tidak lagi `needs_price`); faktur memakai harga beku | BL-18 | FastAPI `store_order` ← `/api/orders/harga` |
| Promo: pratinjau = tersimpan (`sidik`), satu fungsi hitung | owner 12 Okt (revisi) | §4 |
| Salesman faktur (Antre Faktur) = salesman cabang PELANGGAN order | butir 4 | `/api/orders/[id]/invoice` (`salesmanBedaCabang`), pratinjau + antre |

Tautan akun ↔ karyawan disimpan di `sales_profile.sales_code` (= `accurate_employee.number`) + `sales_profile.accurate_linked` (tautan AKTIF;
bawaan false). Lepas = `accurate_linked` false — baris, kode, dan hierarki Form Kontrol tetap (butir 12). `sales_profile.accurate_branch_id`
TIDAK dibaca/diisi (salinan cabang akan basi).

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
| `HARGA_BELUM_ADA` | 409 | `missing: [kode]` (bentuk lama dipertahankan). Kalimat menyebut sebab per baris: belum ada / harga standar / harga 0 / harga cabang lain. |
| `HARGA_TIDAK_VALID` | 400 | Harga petugas bukan angka > 0 (maks 4 desimal, tanpa titik ribuan). `barang: [kode]`. |
| `INPUT_TIDAK_VALID` | 400 | Query/badan tidak valid — termasuk `price` dikirim dari Order Sales (sales tidak menentukan harga). |
| `TIDAK_DIIZINKAN` | 403 | Izin layar tidak ada. |
| `IZIN_TIDAK_KONSISTEN` | 403 | Akun punya `websales.create` + `order.view` tanpa `order.create` (butir 11). Admin membetulkan grup. |
| `SALESMAN_BEDA_CABANG` | 409 | Antre Faktur: salesman bukan cabang pelanggan order / tanpa cabang (butir 4). |
| `KODE_DIPAKAI_FORM_KONTROL` | 409 | Tautan admin mengganti kode sales yang punya laporan Form Kontrol (`laporan: {laporanHarian, ao, merchandising, jks, total}`); kirim ulang `konfirmasiGantiKode: true` bila disengaja. |
| `KODE_DIPAKAI_PROFIL_LAIN` | 409 | Kode karyawan masih dipegang profil Form Kontrol akun lain yang tautannya dilepas (kode unik). |
| Promo/simpan FastAPI | — | `SIDIK_WAJIB`, `PRATINJAU_BERUBAH`, `CHANNEL_BEDA_MASTER`, `ORDER_GANDA`, `ATURAN_BELUM_TERBIT`, `DATA_TIDAK_VALID`, `KONFIGURASI_SERVER`, `LAYANAN_TIDAK_PASTI` — §4.3/§4.5. |

## 3. Endpoint

### `GET /api/customers/search?q=&branchId=&limit=`
Izin `websales.create` ATAU `order.create`. `limit` 1–50 (20). Cari nama/kode (ILIKE, `%`/`_` literal), kode persis di atas.
Tanpa suspended, tanpa cabang kosong. Salesman: hanya cabangnya (`branchId` lain → 403). Internal: semua atau saring `branchId`.
200: `{ ok, cakupan: {semua, branchId, branchName}, items: [{ id, customerNo, name, branchId, branchName, categoryName, channel ("GT"/"MT"/…), priceCategoryName, alamat }] }`.

### `GET /api/items/search?q=&branchId=&customerId=&tanggal=&limit=`
Izin sama. Dengan `customerId` (= `customer.id`): cabang = cabang pelanggan (`branchId` beda → 400), plus harga per satuan.
Tanpa `customerId`: salesman = cabangnya; internal = `branchId` atau semua. Tanpa suspended / tanpa cabang. `tanggal` bawaan hari ini WITA.
200: `{ ok, tanggal, branchId, cabangTanpaBarang, items: [{ id, no, name, branchId, branchName, tag, units: [{ unit, price?, source?, branchName?, effectiveDate? }] }] }`
(`price/source/...` hanya bila `customerId`; `units: []` = belum ada daftar harga; `price: null` = harga master TIDAK sah untuk order
(standar/0/cabang lain — `source`/`branchName` menjelaskan) → tidak bisa dipilih kecuali harga petugas Order Baru).
`cabangTanpaBarang: true` = hasil kosong karena cabang itu memang tanpa barang orderan (sync barang belum jalan / cabang tanpa tag divisi),
bukan karena pencarian tidak cocok — layar menampilkan penjelasan, bukan "tidak ada hasil".

### `GET /api/customers/lookup?no=` (berubah, butir 14)
Salesman hanya pelanggan cabangnya: kode cabang lain / tanpa cabang → 403 `CABANG_DI_LUAR_CAKUPAN`; akun belum tertaut →
`SALESMAN_BELUM_TERHUBUNG`. Kode tak ada = 200 `found:false` (bentuk lama). Internal (`order.view`) semua cabang.

### `POST /api/orders/preview` (berubah)
`customer_no` WAJIB; cabang harga dari pelanggan (badan `branch_id` diabaikan); galat §2. Bentuk jawaban + `sidik` + harga petugas: §4.2.

### `POST /api/orders/harga` (layanan; juga boleh sesi)
Dipanggil FastAPI (`python_backend/order_cabang.py`). CRON_SECRET (Bearer) = semua cabang; sesi `websales.create`/`order.create` = cakupan pemakai.
Badan `{ customer_no, order_date, lines: [{code, unit, quantity?, price?}] }` (1–500 baris). `price` = harga petugas (hanya CRON atau sesi
`order.create`; sesi sales → 400). `harga:false` (bentuk lama) DIHAPUS — tidak lagi melewati harga master.
200: `{ ok, pelanggan, lines: [{code, unit, quantity, price, sumber_harga: "master"|"petugas"}] }` (urutan = masukan; harga petugas
kembali APA ADANYA). Tanpa efek samping. CRON_SECRET hanya header `Authorization: Bearer` (konstan-waktu; `?secret=` ditolak — butir 6).

### `GET /api/orders/salesmen?branchId=` (berubah)
Izin `order.edit`. `branchId` = hanya salesman aktif cabang itu (Antre Faktur: kirim cabang pelanggan order — ambil dari
`branch.branchId` jawaban pratinjau `POST /api/orders/[id]/invoice` `queue:false`). Kosong = semua (perilaku lama).
Server MENOLAK salesman cabang lain saat pratinjau/antre faktur: 409 `{ ok:false, kode: "SALESMAN_BEDA_CABANG", error }` (butir 4).

### `GET|PUT|DELETE /api/admin/users/[id]/salesman` (baru)
- GET (izin `users.manage` atau `users.view`): `{ ok, tautan: [{ salesCode, salesName, employeeId, employeeName, branchId, branchName, salesman, suspended, terhubung, aktif }], pilihan: [{ id, number, name, branchId, branchName, terhubungKe: {userId, name, email, terhubung} | null }] }` — `pilihan` = karyawan salesman aktif, urut cabang lalu nama; `terhubungKe.terhubung: false` = kode dipegang profil Form Kontrol akun lain yang tautannya dilepas. `aktif` = tertaut + salesman + tidak suspended + bercabang.
- PUT `{ employeeNumber, konfirmasiGantiKode? }` (izin `users.manage`): tetapkan/ganti/tautkan ulang. 200 `{ ok, changed, tautan: { salesCode, employeeName, employeeId, branchId, branchName } }`. Galat (`code`): `KARYAWAN_TIDAK_ADA` 404, `KARYAWAN_GANDA`/`KARYAWAN_BUKAN_SALESMAN_AKTIF`/`KARYAWAN_TANPA_CABANG`/`KARYAWAN_SUDAH_TERHUBUNG` (+`terhubungKe`)/`KODE_DIPAKAI_PROFIL_LAIN`/`KODE_DIPAKAI_FORM_KONTROL` (+`laporan`)/`PROFIL_GANDA` 409, `USER_TIDAK_ADA` 404, `IZIN_BERUBAH` 403.
- DELETE (izin `users.manage`): LEPAS tautan (`accurate_linked` = false); baris `sales_profile`, kode, dan hierarki Form Kontrol TETAP (butir 12). 200 `{ ok, changed }`.
- Audit `permission_audit_log`: `salesman.link` (`detail.sebelum/sesudah`, + `laporanKodeLama` bila kode diganti dengan konfirmasi), `salesman.unlink` (`detail.dilepas`) — tampil di Riwayat user (label di `lib/rbac.ts`).

### FastAPI (berubah)
- `POST /websales/orders`: dihitung LENGKAP dengan sesi sales (channel master, cabang, harga, promo) + WAJIB `sidik`; ditolak → status +
  `{ ok:false, detail, kode, ... }`; Next tak pasti → 503 berkode. Harga TIDAK disimpan di permintaan (hanya kuantitas + `sidik`). §4.3.
- `POST /orders` (Order Baru): harga petugas per baris tidak ditimpa, ≤ 0 ditolak; WAJIB `sidik`. §4.3–4.4.
- Tarik (`/orders/pull`, `/orders/pull-cron`): order dibekukan berharga server → `draft` bila angka = sidik sales; `failed` (ditahan) vs
  `rejected` (permanen, status `rejected` + sebab); Next tak pasti / CRON_SECRET beda → 503 `{ok:false, detail, kode}` (tarikan berhenti,
  tidak ada yang ditolak). §4.5.

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
3. User admin: panel "Salesman Accurate" (GET/PUT/DELETE tautan), pilihan dari `pilihan` (tandai yang sudah tertaut ke akun lain;
   `terhubung:false` = profil dilepas). `KODE_DIPAKAI_FORM_KONTROL` → dialog konfirmasi berisi hitungan laporan → PUT ulang
   `konfirmasiGantiKode:true`. Tombol "Lepas" = tautan mati, profil Form Kontrol tetap (kalimatnya jangan "hapus").
4. Antre Faktur: `GET /api/orders/salesmen?branchId=<cabang pelanggan>`; `SALESMAN_BEDA_CABANG` = kalimat server apa adanya.
5. Order Masuk: hasil tarik `failed[]` (ditahan, dugaan ganda) dan `rejected[]` (permanen) tampil per permintaan dengan kodenya; 503
   `KONFIGURASI_SERVER` = "konfigurasi server" (BUKAN "sesi login berakhir"). Order Sales: daftar "Order saya" menampilkan
   `rejected` + `reject_reason`.
6. Pencarian pelanggan/barang (butir 15): debounce ≥ 300 ms, minimal 2 huruf sebelum memanggil server (kosong/1 huruf = tidak memanggil),
   batalkan permintaan lama (`AbortController`) dan abaikan jawaban yang datang terlambat untuk kata kunci lama. Hasil kosong:
   `cabangTanpaBarang: true` → penjelasan "Cabang <nama> belum punya barang yang bisa diorder (sync barang / tag divisi)"; selain itu
   "Tidak ada yang cocok". Galat (non-2xx) ≠ kosong: tampilkan kalimat server + "Coba lagi".

## 6. Deploy (urut)
1. IT Support: `docs/handover/DDL_O1.sql` sebagai pemilik SEBELUM image (VERIFIKASI semua `ok`, termasuk UNIQUE `sales_profile.sales_code`
   dan tripwire grup; `false` = berhenti, laporkan).
2. Image baru; segera picu sync `branch,employee,item,customer` (lihat kepala DDL_O1: perintah + perkiraan durasi). Sebelum sync item selesai semua order ditolak `BARANG_BEDA_CABANG` (gagal tertutup).
3. Kirim `results.item.tagTakDikenal` ke orkestrator; periksa sebaran barang per cabang dan jumlah pelanggan suspended.
4. Admin menautkan akun salesman (sebelum sales memakai Order Sales) — `accurate_linked` bawaan false: profil lama tidak membuka order.
4a. Pastikan CRON_SECRET frontend = backend (FastAPI → Next `/api/orders/harga`): beda = tarik/simpan 503 `KONFIGURASI_SERVER` + log
   `accapi.order_cabang` "Next menolak CRON_SECRET FastAPI". Pemicu manual/seed: header `Authorization: Bearer`, bukan `?secret=`.
4b. O1 tanpa O2: layar lama Order Sales/Order Baru TIDAK mengirim `sidik` → simpan ditolak `SIDIK_WAJIB` (produksi: 0 order/0 permintaan).
   Rilis O1 bersama O2, atau sesudah O2 siap.
5. Order `needs_price` LAMA: probe produksi 12 Okt = 0 baris `sales_order` dan 0 `order_request` → tidak ada yang buntu (selesai tanpa keputusan).

## 7. TERBUKA
- Penanda "petugas internal = `order.view`" (semua cabang) adalah tafsir teknis dari "admin/fakturist boleh semua cabang"; bila owner mau kunci khusus, tambahkan kapabilitas.
- 31 nilai `charField2` probe tidak tersedia sebagai berkas; uji memakai superset (22 nama cabang + 6 pemetaan + 6 non-jual + tak dikenal). Sesudah sync pertama `tagTakDikenal` membuktikan tidak ada yang terlewat.
- `customer/list.do` & `item/list.do` `suspended`: bila Accurate mengabaikan field itu, semua tetap `false` — periksa sesudah sync pertama.
- `item/list.do` tanpa key `charField2` untuk barang tak bertag (bila Accurate membuang field null): cabang lama dipertahankan (butir 10) →
  tag yang DIHAPUS di Accurate tidak mengosongkan cabang. Periksa sesudah sync pertama (DDL_O1: `ada_key` harus = jumlah barang).
- Sidik WAJIB = O1 dan O2 dirilis bersama (lihat §6.4b); bila owner mau O1 lebih dulu, keputusan: izinkan simpan tanpa sidik sementara
  (hitung ulang diam-diam — bertentangan dengan keputusan "pratinjau = tersimpan") atau tahan Order Sales/Order Baru sampai O2.
- Harga petugas MENANG atas harga master sah (perilaku Order Baru lama dipertahankan, kini tercatat `sumber_harga`). Bila owner mau harga
  petugas hanya untuk baris TANPA harga master, cukup tolak `price` saat `hargaMaster` tidak null (satu baris di `periksaOrder`).
- Permintaan yang ditahan dugaan ganda (BL-20) tetap `pending` tanpa jalur lepas di layar; halaman keyset mencegah antrean macet, tetapi
  keputusan "bukan order ganda" untuk Web Sales belum ada.
- Bonus barang promo (`bonuses[].code`) tidak diperiksa cabangnya (program principal memberi bonus barang principal itu; tidak divalidasi).
- Migrasi: O1 memakai `db/migrations/0033_order_cabang.sql` + entri migrate-pg terakhir; K2a (cabang lain) memakai 0032 dan juga menambah
  entri di `scripts/migrate-pg.mjs` → konflik teks saat merge (urutan entri bebas: keduanya aditif + `sudahAda`). Nomor TIDAK diubah.
- `?secret=` dihapus dari `requireCronSecret`: pemakai yang tidak tercatat di repo (skrip pribadi/bookmark) akan mendapat 401 — gunakan header.
