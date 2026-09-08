<!--
Tujuan: Peta menyeluruh cara kerja Accurate Online API — auth, pola endpoint, sistem filter,
        field entitas, dan batasan — sebagai dasar membangun aplikasi third-party internal.
Caller: Developer yang membangun/memelihara integrasi Accurate (Web Internal & Web Sales).
Dependensi: acc.json.do.txt (OpenAPI), scripts/probe-accurate-detail-fields.mjs untuk verifikasi.
Main Functions: Referensi; bukan kode. Perbarui saat menemukan field/endpoint baru secara live.
Side Effects: Tidak ada.
-->
# Accurate Online API — Referensi Menyeluruh

Sumber: OpenAPI `acc.json.do.txt` (321 operasi, 68 modul, 213 scope OAuth) + verifikasi live
ke DB `CV Surya Perkasa` @ `iris.accurate.id`, 2026-07-28.

> **Peringatan paling penting tentang dokumentasi resmi Accurate:**
> Dari 321 operasi, **nol** yang punya response schema — semuanya hanya
> `"200": {"description": "Success"}`. Spec resmi hanya mendokumentasikan **request**.
> Nama field response TIDAK bisa dijawab dari spec; harus dari panggilan live.
> Baca bagian [Menemukan field](#menemukan-field-teknik-paling-penting) sebelum menebak apa pun.

---

## 1. Model mental

Accurate bukan satu API tunggal. Ada **dua lapis host** yang sering bikin bingung:

```
account.accurate.id          <- lapis AKUN: OAuth, daftar Data Usaha, buka sesi
        |
        | open-db.do  ->  { host, session }
        v
{tenant}.accurate.id         <- lapis DATA: seluruh 300+ endpoint bisnis
  (mis. iris.accurate.id)       base path: /accurate/api/...
```

Satu akun Accurate bisa punya banyak **Data Usaha** (database perusahaan). Setiap Data Usaha
punya host sendiri yang baru diketahui **setelah** `open-db.do`. Jangan hardcode host.

### Dua kredensial berbeda, jangan tertukar

| Kredensial | Header | Dari mana | Umur |
|---|---|---|---|
| **Access token** | `Authorization: Bearer <token>` | OAuth authorization code | Panjang, tapi **tanpa refresh_token** — habis = wajib login ulang manual |
| **Session ID** | `X-Session-ID: <session>` | `open-db.do` | **Pendek**, sering habis |

Kalau `X-Session-ID` habis: `401 {"s":false,"d":["Data Session Key tidak tepat"]}`.
Kalau access token habis: `401 {"error":"invalid_token"}`.
Keduanya 401 — bedakan dari isi body, bukan status code.

---

## 2. Alur autentikasi lengkap

```
1. Redirect user ke:
   https://account.accurate.id/oauth/authorize
     ?client_id=<id>&response_type=code&redirect_uri=<terdaftar>&scope=<spasi-dipisah>

2. Callback membawa ?code=... ; tukar jadi token:
   POST https://account.accurate.id/oauth/token
   Authorization: Basic base64(client_id:client_secret)
   Content-Type: application/x-www-form-urlencoded
   grant_type=authorization_code&code=<code>&redirect_uri=<sama persis dgn langkah 1>

3. Daftar Data Usaha:
   GET https://account.accurate.id/api/db-list.do          [Bearer]
   -> { s:true, d:[{ id, alias, ... }] }

4. Buka sesi:
   GET https://account.accurate.id/api/open-db.do?id=<dbId>  [Bearer]
   -> { host: "https://iris.accurate.id", session: "<sessionId>" }

5. Semua panggilan bisnis:
   GET {host}/accurate/api/<modul>/<aksi>.do
   Authorization: Bearer <token>
   X-Session-ID: <session>
```

### Endpoint pengelolaan sesi (modul `/api`, 11 endpoint)

| Endpoint | Guna |
|---|---|
| `db-list.do` | Daftar Data Usaha yang bisa diakses |
| `open-db.do` | Buka Data Usaha → dapat `{host, session}` |
| **`db-refresh-session.do`** | **Periksa & ganti session kalau sudah tidak bisa dipakai — endpoint RESMI untuk refresh** |
| `db-check-session.do` | Cek apakah session masih valid (tanpa mengganti) |
| `db-detail.do` / `db-status.do` | Info & status database |
| `auth-info.do` / `userinfo.do` | Identitas pemilik token |
| `approved-scope.do` | Scope apa saja yang user setujui — **penting: user bisa menyetujui sebagian saja** |
| `webhook-history.do` | Riwayat pengiriman webhook 1 bulan terakhir (hanya developer app) |
| `webhook-renew.do` | Perpanjang masa aktif webhook |

> **Catatan untuk kode kita:** `lib/accurate-session.ts` sekarang refresh pakai `open-db.do`.
> Itu jalan, tapi `db-refresh-session.do` adalah endpoint yang memang dirancang untuk itu —
> layak dipindah saat ada kesempatan.

---

## 3. Bentuk response (tidak didokumentasikan, hasil observasi)

Semua endpoint bisnis membungkus hasil dalam amplop yang sama:

```json
{
  "s": true,                    // sukses/gagal — CEK INI, bukan cuma HTTP status
  "d": [ ... ] | { ... },       // data: array untuk list.do, objek untuk detail.do
  "sp": { "page": 1, "pageCount": 12, "rowCount": 1150 },   // hanya di list.do
  "m": { ... }                  // pesan error (kadang di "d" berupa array string)
}
```

**Jebakan:** Accurate bisa balas **HTTP 200 dengan `s: false`**. Contoh nyata:
`200 {"s":false,"d":["Barang & Jasa tidak tepat"]}`. Cek `body.s`, jangan `response.ok` saja.

---

## 4. Pola endpoint universal

Hampir setiap modul punya 5 aksi dengan pola yang sama persis:

| Aksi | Method | Jumlah | Guna |
|---|---|---|---|
| `list.do` | GET | 63 | Daftar + filter + paging. **Ringkas** — hanya field yang diminta |
| `detail.do` | GET | 60 | Satu record, **SELURUH field** (bisa 300+) |
| `save.do` | POST | 60 | Create kalau tanpa `id`, update kalau ada `id` |
| `bulk-save.do` | POST | 48 | Maks **100 record** per request |
| `delete.do` | DELETE | 56 | Hapus by id |

### `bulk-save.do` — format khusus yang aneh

Bukan array JSON biasa. Accurate memaksa bentuk flat dengan indeks:

```
data[0].name=Produk A&data[0].unitPrice=1000&data[1].name=Produk B&...
```

Kode kita sudah menangani ini di [app/api/proxy/route.ts](../../app/api/proxy/route.ts) —
lihat fungsi `flattenPayload`.

---

## 5. Paging, sorting, filter

### Paging & sort (ada di 66 endpoint)
```
sp.page=1              # mulai dari 1, bukan 0
sp.pageSize=100        # default 20
sp.sort=name|asc;no|desc
```
Total halaman ada di response `sp.pageCount`.

### `fields` — WAJIB diisi (jebakan besar)
```
fields=id,no,name,unitPrice
```
**Tanpa `fields`, `list.do` hanya mengembalikan `{ id }`.** Ini terbukti di produksi.
Dan `id` **harus disebut eksplisit** — Accurate tidak menyertakannya otomatis.

Accurate juga tidak mem-parse `%2C`; koma harus literal di query string.

### Sistem filter
Dua bentuk, tergantung field:

```
# Bentuk operator (paling umum)
filter.<field>.op=<OPERATOR>&filter.<field>.val=<nilai>

# Bentuk ringkas (beberapa field saja)
filter.customerNo=C-100005&filter.suspended=false
```

Operator yang tersedia:
`EQUAL` (default), `NOT_EQUAL`, `CONTAIN`, `BETWEEN`, `NOT_BETWEEN`,
`GREATER_THAN`, `GREATER_EQUAL_THAN`, `LESS_THAN`, `LESS_EQUAL_THAN`, `EMPTY`, `NOT_EMPTY`

Untuk `BETWEEN`, `val` diisi dua nilai: `filter.transDate.val=01/01/2026&filter.transDate.val=31/01/2026`

Filter yang paling sering tersedia: `keywords` (59 endpoint), `lastUpdate` (50),
`transDate` (25), `number` (23), `branchId` (22), `approvalStatus` (20).

Ada juga filter siap pakai bernama sendiri, mis. `outstandingFilter=true` di
`sales-invoice/list.do` (faktur belum lunas).

### Format tanggal
**`dd/MM/yyyy`** — bukan ISO. `lastUpdate` juga `dd/MM/yyyy HH:mm:ss`
(contoh nyata: `"16/01/2026 09:49:13"`).

> **Konsekuensi arsitektural:** `lastUpdate` **tidak bisa** dipakai sebagai watermark sinkronisasi,
> karena urutan leksikografis ≠ kronologis. Itu sebabnya kita punya kolom lokal `synced_at`.
> Lihat [INTEGRASI_WEB_SALES.md](INTEGRASI_WEB_SALES.md).

---

## 6. Menemukan field (teknik paling penting)

Dokumentasi `fields` menyebut: *"Daftar field yang dapat digunakan dapat dilihat pada
response dari API **detail.do**"*.

Jadi alurnya:

```bash
# 1. Ambil satu id
GET /<modul>/list.do?sp.pageSize=1&fields=id

# 2. Bongkar seluruh field
GET /<modul>/detail.do?id=<id>

# 3. Pakai subset field itu di list.do
GET /<modul>/list.do?fields=id,field1,field2
```

Script siap pakai: [scripts/probe-accurate-detail-fields.mjs](../../scripts/probe-accurate-detail-fields.mjs)

**Jangan pernah menebak nama field.** Bukti: kami menguji 18 kandidat di
`sales-invoice/list.do`; 9 di antaranya (`outstanding`, `outstandingAmount`, `paidAmount`,
`status`, `customerName`, `branchName`, ...) diterima Accurate tanpa error tapi **selalu
mengembalikan kosong**. Field yang tidak dikenal **tidak memicu error** — ia diam-diam
diabaikan. Ini mode kegagalan paling berbahaya di API ini.

---

## 7. Entitas inti — field penting (terverifikasi live)

### `item` — 163 field di detail.do

| Kebutuhan | Field |
|---|---|
| Identitas | `id`, `no`, `name`, `shortName`, `itemType`, `itemTypeName`, `suspended` |
| Stok agregat | `availableToSell`, `availableToSellInAllUnit`, `balance`, `balanceInUnit`, `onSales` |
| **Stok per gudang** | **`detailWarehouseData[]`** |
| Biaya/HPP | `cost`, `balanceUnitCost`, `balanceTotalCost`, `defStandardCost` |
| Harga dasar | `unitPrice` |
| **Tier harga** | **`detailSellingPrice[]`** |
| Multi-unit | `hasMultiUnit`, `ratio2`..`ratio5`, `unit2Name`..`unit5Name` |
| Kategori/brand | `itemCategory{}`, `itemCategoryId`, `itemBrand`, `itemBrandId` |
| Kontrol | `controlQuantity`, `minimumQuantity`, `minimumQuantityReorder`, `manageExpired`, `manageSN` |
| Pajak | `tax1`..`tax4`, `percentTaxable`, `codeItemTax` |

**`detailSellingPrice[]`** — inilah tier harga yang selama ini dicari (528 baris pada item uji):
```json
{
  "priceCategory": { "id": 400, "name": "ALFAMART", "defaultCategory": false },
  "price": 21945.95,
  "unit": { "id": 50, "name": "PCS" },
  "currency": { "code": "IDR", "symbol": "Rp" },
  "branch": { "id": 50, "name": "Kantor Pusat", "defaultBranch": true },
  "effectiveDate": "01/12/2025"
}
```
Tier per pelanggan otomatis: `customer.priceCategoryId` → cocokkan ke `detailSellingPrice[].priceCategory.id`.
Perhatikan `effectiveDate` — harga berlaku per tanggal, jadi ambil yang terbaru ≤ hari ini.

**`detailWarehouseData[]`** — stok per gudang (11 gudang pada item uji):
```json
{
  "id": 100, "name": "GD01", "warehouseName": "GD01", "description": "GUDANG UTAMA",
  "balance": 0, "balanceUnit": "0 PCS",
  "unit1Quantity": 0, "unit2Quantity": 0, "unit3Quantity": 0,
  "defaultWarehouse": false, "scrapWarehouse": false, "suspended": false
}
```

Endpoint stok lain:
- `item/list-stock.do` → ringkas, semua item: `id, no, name, quantity, quantityInAllUnit, upcNo`. Bisa difilter `warehouseId`/`warehouseName`.
- `item/get-stock.do` → stok satu item
- `item/get-selling-price.do` → harga + diskon terhitung
- `item/get-nearest-cost.do` → HPP pada tanggal tertentu
- `item/search-by-no-upc.do`, `search-by-item-or-sn.do` → cari via barcode/serial

### Harga jual terbaru — dibuktikan live 2026-09-08 (DB CV Surya Perkasa)

Pertanyaan "bagaimana Accurate memberikan harga paling terbaru" sudah dijawab dengan probe:

| Sumber | Hasil probe |
|---|---|
| `item/list.do` (sync sekarang) | Hanya `unitPrice`. **Tidak ada** `priceCategory` maupun `effectiveDate` — 0 dari 4.182 item punya `priceCategory` di `raw_data`. |
| `item/detail.do` -> `detailSellingPrice[]` | **Inilah daftar harga yang berlaku.** Item uji `13011010500000` (id 11900): **572 entri**, satu per kombinasi (priceCategory x unit x branch), dan **nol kombinasi punya lebih dari satu `effectiveDate`**. Semua bertanggal `07/07/2026` = kapan kenaikan terakhir mulai berlaku. Jadi ini harga **saat ini**, bukan riwayat. Scope `item_view` sudah cukup. |
| `sellingprice-adjustment/list.do` | **HTTP 403 `insufficient_scope`, butuh scope `sellingprice_adjustment_view`** yang TIDAK ada di permintaan OAuth `/api-wrapper`. Modul ini adalah **riwayat perubahan** harga, bukan harga berlaku. |
| `item/get-selling-price.do` | Parameternya `id` atau `no` (BUKAN `itemId` — `itemId` menjawab "Missing item"). Setelah itu tertahan `"Invalid Item branch access"` walau `branchId=50` (Kantor Pusat, cabang default dari 22 cabang). Belum terpecahkan; kemungkinan soal hak akses cabang pada user OAuth. |

**Aturan yang benar untuk mengambil harga terbaru:** dari `detailSellingPrice[]`, pilih baris
yang `priceCategory.id` = `customer.priceCategoryId`, `unit.name` = satuan baris order, dan
`branch` = cabang order; lalu ambil `effectiveDate` TERBESAR yang `<= tanggal order`. Filter
`<= tanggal order` tetap wajib walau data uji tidak punya tanggal masa depan — kenaikan yang
dijadwalkan ke depan akan muncul di sini juga.

Kapan `sellingprice-adjustment` benar-benar dibutuhkan: (a) melihat kenaikan yang dijadwalkan
SEBELUM berlaku, (b) audit "kapan naik dan dari berapa". Keduanya butuh tambahan scope dan
otorisasi ulang oleh pengguna.

**Jebakan satuan:** item uji hanya punya harga untuk satuan `KRT` dan `PACK` — **tidak ada
`PCS`**. Kategori harga pada item itu: ALFAMART, ALFAMIDI, BTL, DIAMOND, HARGA KHUSUS,
INDOGROSIR, INDOMARET, KANVAS, MOTORIST, MT, NKA, TT. Satuan pada aturan promo dan baris order
WAJIB diambil dari master, bukan diasumsikan `PCS`, kalau tidak harga dan promo tidak akan cocok.

**Alat probe:** `scripts/probe-accurate-endpoint.ts` (read-only, token tidak dicetak). Dua
jebakan pemakaian yang sudah ditangani: argumen endpoint tanpa `/` di depan (Git Bash
mengubahnya menjadi path Windows) dan `--env-file=.env.local` wajib (`process.loadEnvFile`
kalah cepat dari hoisting import).

**Catatan sesi:** `/api/proxy` memakai `getAccurateSession(session.user.id)`, sedangkan
`LOCAL_AUTH_BYPASS` memberi identitas sintetis yang TIDAK memiliki baris
`accurate_oauth_session` — jadi dengan bypass aktif, proxy menjawab "Sesi Accurate belum
lengkap" walau token ada. Sync tetap jalan karena `resolveSyncCredentials()` memakai baris
sesi terbaru, bukan user id pemanggil.

### `customer` — 143 field

| Kebutuhan | Field |
|---|---|
| Identitas | `id`, `customerNo`, `name`, `suspended`, `category{}`, `categoryId` |
| **Limit kredit** | `customerLimitAmount` (bool), `customerLimitAmountValue` (nominal), `customerLimitAge` (bool), `customerLimitAgeValue` (hari), `maxInvoiceAge` |
| Limit grup | `groupCustomerLimit`, `groupCustomerLimitOption`, `referenceCustomerLimit`, `childCustomerLimitGroupList` |
| Piutang | `balanceList`, `customerReceivableAccountList`, `detailOpenBalance` |
| **Tier harga** | `priceCategory{}`, `priceCategoryId`, `discountCategory`, `defaultSalesDisc` |
| **Salesman** | `salesman{}`, `salesmanList[]`, `defaultSalesmanId`, `salesman2Id`..`salesman5Id` |
| Termin | `term{}`, `defaultTermId` |
| Gudang default | `defaultWarehouse`, `defaultWarehouseId` |
| Alamat | `billStreet/City/Province/Country/ZipCode`, `shipSameAsBill`, `ship*`, `detailShipAddress[]` |
| Kontak | `email`, `mobilePhone`, `workPhone`, `fax`, `website`, `detailContact[]` |
| Pajak | `npwpNo`, `pkpNo`, `customerTaxType`, `nitku`, `wpName/Number/Type` |

### `sales-order` — 177 field | `sales-invoice` — 303 field

Field header penting:
- Identitas: `id`, `number`, `transDate`, `dueDate`, `poNumber`, `description`
- Status: `status`, `statusName`, **`approvalStatus`**, `statusOutstanding`
- **Piutang: `outstanding`, `primeOwing`, `taxOwing`, `age`, `dueDate`** *(hanya di detail.do, TIDAK di list.do)*
- Nilai: `subTotal`, `totalAmount`, `salesAmount`, `cashDiscount`, `cashDiscPercent`, `totalExpense`
- Pajak: `tax1Amount`..`tax4Amount`, `taxable`, `dppAmount`, `inclusiveTax`, `taxNumber`
- Relasi: `customer{}`, `customerId`, `branchId`, `paymentTerm{}`, `salesOrder`, `deliveryOrder`, `salesReceipt`, `salesReturn`
- **Salesman: `masterSalesmanId`, `masterSalesmanName`**
- **Check-in: `checkInId`, `salesCheckIn`**
- Riwayat: `receiptHistory`, `returnHistory`, `deliveryOrderHistory`, `processHistory`
- e-Faktur: `efakturProceed`, `efakturFileName`, `taxDate`, `referenceNumberTax`

Field baris (`detailItem[]`, ~120 field):
`itemId`, `item{}`, `quantity`, `unitPrice`, `totalPrice`, `itemDiscPercent`, `itemCashDiscount`,
`warehouseId`, `warehouse{}`, `itemUnitId`, `unitRatio`, `detailNotes`, `seq`,
`salesman1Id`..`salesman5Id`, `salesmanName`, `project{}`, `department{}`,
`deliveredQuantity`, `returnQuantity`, `availableQuantity`, `shipQuantity`

Field untuk **membuat** SO (`sales-order/save.do`, 22 field):
```
WAJIB: customerNo, detailItem, detailExpense
Opsional: number, transDate, shipDate, poNumber, description, branchId/branchName,
          currencyCode, rate, paymentTermName, fobName, shipmentName, toAddress,
          taxable, inclusiveTax, cashDiscount, cashDiscPercent, typeAutoNumber, id
```

---

## 8. Custom field — kunci "kontrol sesuai aturan internal"

Ini bagian yang paling relevan dengan tujuanmu. Hampir semua entitas punya slot kosong
milikmu sendiri:

| Level | Slot tersedia |
|---|---|
| Header (item, customer, SO, SI, dll) | `charField1`–`charField10`, `numericField1`–`numericField10`, `dateField1`, `dateField2` |
| Baris (`detailItem[]`) | `charField1`–`charField15`, `numericField1`–`numericField10`, `dateField1`, `dateField2`, `dataClassification1`–`dataClassification10` |
| Pencarian | `searchCharField1`–`searchCharField3` (objek `{id,name}` — terhubung ke master list) |

Artinya kamu bisa menyimpan aturan internal (kode program promo, ID kunjungan, flag approval
internal, kode wilayah, nomor batch klaim) **langsung di record Accurate**, lalu memfilternya
lewat `filter.charField1.op=EQUAL&filter.charField1.val=...`.

`dataClassification1-10` bahkan terhubung ke master `data-classification` — dimensi analitik
resmi Accurate, bukan sekadar teks bebas.

---

## 9. Peta modul (68 modul, 321 operasi)

**Penjualan:** sales-quotation → sales-order → delivery-order → sales-invoice →
sales-receipt; plus sales-return, exchange-invoice, shipment, sales-checkin

**Pembelian:** purchase-requisition → purchase-order → receive-item → purchase-invoice →
purchase-payment; plus purchase-return, vendor-price

**Persediaan:** item (13 operasi — terbanyak), item-adjustment, item-transfer, item-category,
warehouse, stock-opname-order, stock-opname-result, sellingprice-adjustment, price-category

**Manufaktur:** work-order, job-order, manufacture-order, bill-of-material, material-slip,
material-adjustment, finished-good-slip, process-stages, standard-product-cost, wo-pic

**Keuangan:** glaccount (8), journal-voucher, other-deposit, other-payment, bank-transfer,
expense, fixed-asset, roll-over, currency, tax

**Master:** customer, vendor, employee, branch, department, project, unit, payment-term,
customer-category, vendor-category, data-classification, auto-number, fob/freeonboard

**Klaim:** customer-claim, vendor-claim

**Khusus integrasi:** `pos/customer/save.do`, `pos/item/save.do`, `pos/transaction/save.do`

**Laporan:** report/stock-mutation-summary, report/serial-number-mutation,
report/serial-number-per-warehouse, report/work-order-detail, salesman-commission,
glaccount/get-balance, glaccount/get-bs-account-amount, glaccount/get-pl-account-amount

### Endpoint POS — jalan pintas untuk aplikasi third-party

`POST /api/pos/transaction/save.do` mengimpor **Faktur Penjualan + Pembayaran Pelanggan +
Retur** sekaligus dalam satu panggilan. `pos/customer/save.do` dan `pos/item/save.do`
melakukan upsert master (update kalau ada, insert kalau belum).

Sifatnya **idempoten by design**: dokumentasi menyebut "Jika data terkait sudah ada di
Accurate Online maka akan diabaikan". Ini dirancang persis untuk kasus seperti Web Sales —
kirim ulang aman, tidak akan dobel.

---

## 10. Batasan yang harus kamu tahu sebelum merancang

| Batasan | Dampak |
|---|---|
| **Tidak ada refresh_token** | Access token habis = **wajib** ada manusia login ulang. Aplikasi tidak bisa 100% otonom selamanya. Rancang alarm untuk ini. |
| **`X-Session-ID` berumur pendek** | Wajib auto-refresh (`db-refresh-session.do`). Kalau tidak, cron mati diam-diam — kami sudah kena ini. |
| **Field tak dikenal diabaikan diam-diam** | Salah ketik nama field = kolom kosong, bukan error. Wajib verifikasi lewat `detail.do`. |
| **`list.do` tanpa `fields` = cuma `{id}`** | Mudah disangka "API-nya rusak". |
| **`outstanding` tidak ada di `list.do`** | Untuk piutang per faktur harus `detail.do` per record (mahal) atau turunkan dari `outstandingFilter` + `totalAmount`. |
| **`sales-checkin` READ-ONLY** | Hanya `list.do` + `detail.do`, **tidak ada `save.do`**. Check-in/GPS **tidak bisa** ditulis ke Accurate — harus disimpan di DB aplikasi sendiri. |
| **`salesman-commission` READ-ONLY** | Hanya baca. Skema komisi internal harus dihitung di aplikasi sendiri. |
| **`bulk-save` maks 100** | Sinkronisasi besar harus dipotong per 100. |
| **Rate limit** | Tidak didokumentasikan. Kode kita pakai jeda 150ms/halaman secara defensif. |
| **Scope parsial** | User bisa menyetujui sebagian scope. Cek `approved-scope.do`, jangan asumsikan semua scope didapat. |
| **HTTP 200 + `s:false`** | Cek `body.s`, bukan status code. |

---

## 11. Implikasi untuk aplikasi third-party kamu

Accurate Lite terbatas; API-nya **tidak**. Yang bisa kamu bangun sendiri:

**Bisa penuh lewat API:** master barang & pelanggan, pesanan penjualan, faktur, retur,
pembayaran, pengiriman, stok per gudang, tier harga per kategori pelanggan, limit kredit,
approval status, custom field untuk aturan internalmu.

**Harus di DB aplikasi sendiri (Accurate tidak menyediakan tulis):** kunjungan/check-in
salesman, GPS, foto, absensi, komisi internal, alur approval internal di luar
`approvalStatus` bawaan.

Ini persis membenarkan arsitektur dua-database di
[INTEGRASI_WEB_SALES.md](INTEGRASI_WEB_SALES.md): Accurate jadi sumber kebenaran untuk
data transaksi & master, sementara data lapangan hidup di Postgres Sales.

**Urutan pengerjaan yang saya sarankan:**
1. Jalankan `probe-accurate-detail-fields.mjs` untuk tiap entitas yang mau dipakai — dapatkan daftar field pastinya sebelum menulis kode apa pun.
2. Petakan tier harga: `customer.priceCategoryId` → `item.detailSellingPrice[]`.
3. Petakan stok: `item.detailWarehouseData[]` per gudang, bukan cuma agregat.
4. Tentukan slot custom field mana yang jadi milik aturan internalmu — **tulis di dokumen ini** supaya tidak bentrok antar modul.
5. Baru bangun alur order: SO via `sales-order/save.do`, atau `pos/transaction/save.do` kalau langsung jadi faktur.
