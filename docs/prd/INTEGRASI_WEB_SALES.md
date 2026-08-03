<!--
Tujuan: Kontrak integrasi Web Internal (AccAPI) <-> Web Sales — arah data, mekanisme, kepemilikan entitas.
Caller: Developer sisi Web Sales sebelum menulis worker sync; developer Internal sebelum menambah entitas.
Dependensi: app/api/ext/changes/route.ts, lib/ext-sync.ts, lib/api-security.ts, lib/sync.ts.
Main Functions: Definisi endpoint /api/ext/changes, aturan cursor, tabel kepemilikan data.
Side Effects: Tidak ada; dokumen kontrak. Wajib disinkronkan saat entitas baru ditambahkan.
-->
# Integrasi Web Internal ↔ Web Sales

## Topologi

```
Web Sales (VPS, online)  ◄─── VPN antar server ───►  Web Internal (VPS, tanpa jalur publik)
  Postgres Sales                                        Postgres Internal
  kunjungan, GPS, order,                                 customer, item, harga, stok,
  absensi, foto                                          kredit, AR, faktur, OPC, klaim, AI
```

Dua database benar-benar terpisah. Tidak ada foreign key, tidak ada shared connection,
tidak ada dblink. Satu-satunya jalur adalah HTTP di dalam VPN.

## Mekanisme: dua sisi saling *pull*, bukan push

| Arah | Pemanggil | Endpoint | Interval |
|---|---|---|---|
| Internal → Sales | worker di Web Sales | `GET /api/ext/changes` (di Internal) | 15–30s |
| Sales → Internal | worker di Web Internal | `GET /api/ext/changes` (di Sales, kontrak sama) | 15–30s |

**Kenapa pull, bukan webhook push:** pull dengan cursor itu idempoten dan menyembuhkan
diri sendiri. Kalau satu sisi mati 3 hari, siklus pertama saat hidup lagi menyusul dari
cursor terakhir — tanpa outbox, tanpa retry queue, tanpa dead-letter, tanpa event hilang.
Push butuh semua itu untuk mencapai jaminan yang sama.

**Latency:** interval 15s berarti order sampai ke fakturis ≤15 detik. Untuk ops distribusi
itu sudah "real-time". Kalau nanti ada kebutuhan nyata di bawah 1 detik, upgrade-nya SSE
long-lived — satu file baru, arsitektur ini tidak berubah.

Yang **tidak** dipakai: Kafka/RabbitMQ, Debezium/CDC, replikasi Postgres antar server,
edit master dua arah, 2-phase commit.

## Kontrak `/api/ext/changes`

```
GET /api/ext/changes?entity=<nama>&since=<cursor>&limit=500
Authorization: Bearer <EXT_SALES_TOKEN>
```

```json
{
  "ok": true,
  "entity": "item",
  "items": [{ "id": 1042, "no": "SKU-001", "name": "...", "unitPrice": 12500 }],
  "nextCursor": "2026-07-25T03:11:22.123Z|1042",
  "hasMore": true
}
```

Aturan untuk klien:
1. Simpan `nextCursor` sebagai **string opaque** — jangan diparsing, formatnya bisa berubah.
2. Kirim balik sebagai `since` di siklus berikutnya. Siklus pertama: **tanpa** `since` (full load).
3. Selama `hasMore: true`, langsung panggil lagi dengan cursor baru — jangan tunggu interval.
4. Upsert berdasarkan `id`. Endpoint ini at-least-once: baris yang sama bisa datang dua kali,
   jadi upsert wajib, bukan insert.
5. `since` tidak valid → `400`. Jangan retry dengan cursor yang sama; reset ke full load.

Entitas yang sudah tersedia: `item`, `customer`, `sales_invoice`, `sales_return`.

Watermark = kolom lokal `synced_at`, bukan `last_update` dari Accurate (format Accurate
`dd/MM/yyyy` → urutan leksikografis ≠ kronologis). `synced_at` hanya maju kalau isi baris
benar-benar berubah, jadi full-resync harian dari Accurate tidak memicu tarik-ulang penuh
di sisi Sales.

## Kepemilikan data — satu pemilik per entitas

Ini yang mencegah konflik, bukan teknologinya. Sisi non-pemilik hanya boleh baca.

| Entitas | Pemilik | Ke Sales? |
|---|---|---|
| customer, item, harga/tier, stok, limit kredit, AR/outstanding, faktur, retur | Internal | ya, read-only |
| kunjungan, GPS, order draft, foto, absensi | Sales | ya, read-only ke Internal |
| OPC, klaim principal, pembayaran, SPPD, summary program, master barang AI | Internal | tidak |

Order menjadi faktur = perpindahan status, bukan perpindahan kepemilikan: Sales yang membuat
order, Internal yang menyetujui/menolak, hasilnya balik ke Sales lewat feed `sales_invoice`.
Web Sales **tidak** memanggil Accurate langsung — Internal sudah jadi cache/proxy Accurate.

## Nama field Accurate — hasil verifikasi live

OpenAPI Accurate (`acc.json.do.txt`) TIDAK mendokumentasikan response: 321 endpoint semuanya
`"200": {"description": "Success"}` tanpa schema. Nama field di bawah ini didapat dari panggilan
live ke DB `CV Surya Perkasa` (id 1742775) @ `iris.accurate.id` pada 2026-07-28 via
`scripts/probe-accurate-fields.mjs`. Jangan menebak — pakai script itu untuk entitas baru.

**Stok** — `GET /api/item/list-stock.do` (belum dipakai `lib/sync.ts`):
`id, no, name, quantity, quantityInAllUnit, upcNo`
`quantity` angka, `quantityInAllUnit` string (`"0 PCS"`). Filter gudang: `warehouseId`/`warehouseName`.

**Limit kredit** — `GET /api/customer/list.do?fields=...`:
`customerLimitAmount` (bool), `customerLimitAmountValue` (mis. 1160000),
`customerLimitAge` (bool), `customerLimitAgeValue` (hari, mis. 21), `balance`, `lastUpdate`

**Faktur** — `GET /api/sales-invoice/list.do?fields=...`:
`number, transDate, dueDate, totalAmount, statusName, age, customerNo, customer, lastUpdate`
`statusName` = `"Belum Lunas"` / `"Lunas"`. `customer` objek bersarang `{id, name, customerNo}`.
**TIDAK ADA**: `outstanding`, `outstandingAmount`, `remainingAmount`, `paidAmount`, `status`,
`paymentTermName`, `customerName`, `branchName` — diterima tapi selalu kosong.

Konsekuensi: nilai outstanding per faktur tidak diekspos `list.do`. Untuk blokir kredit pakai
kombinasi `customer.balance` + `customerLimitAmountValue` + daftar faktur `outstandingFilter=true`
dengan `dueDate`/`age`/`totalAmount`. Itu cukup akurat kecuali ada pembayaran sebagian —
kalau presisi per-faktur diperlukan, cek `sales-invoice/detail.do`.

`lastUpdate` terbukti berformat `dd/MM/yyyy HH:mm:ss` (`"16/01/2026 09:49:13"`) — inilah alasan
watermark feed WAJIB pakai kolom lokal `synced_at`, bukan `lastUpdate`.

| Data untuk Web Sales | Status |
|---|---|
| Harga | ✅ `item.unitPrice` (tier per-kategori di `master_barang`, belum diekspos di feed) |
| Stok gudang | ✅ modul `item_stock` di `lib/sync.ts` — `item.quantity` + `item.quantityInAllUnit` |
| Limit kredit | ✅ modul `customer` — `creditLimitEnabled/Amount`, `creditAgeLimitEnabled/Days` |
| Status faktur (`statusName`) + umur (`age`) + jatuh tempo (`dueDate`) | ✅ modul `sales_invoice` |
| Outstanding AR per faktur | ❌ tidak tersedia di `list.do`; harus diturunkan atau via `detail.do` |

Semua di atas sudah diekspos di proyeksi kolom `/api/ext/changes` (`app/api/ext/changes/route.ts`).
`quantity`/`quantityInAllUnit` disync via modul terpisah `item_stock` (endpoint beda dari
`item/list.do`, lihat komentar di `lib/sync.ts`) — jadwalkan cron memanggil KEDUA modul,
bukan cuma `item`. `sync-accurate?modules=` menerima daftar dipisah koma; default (tanpa
`modules=`) sudah menjalankan semuanya termasuk `item_stock`.

## Catatan operasional: `X-Session-ID` kadaluarsa (SELESAI diperbaiki)

`X-Session-ID` punya masa hidup pendek. Kalau habis, Accurate balas
`401 {"s":false,"d":["Data Session Key tidak tepat"]}`. Session baru diambil dari
`GET https://account.accurate.id/api/open-db.do?id=<databaseId>` memakai Bearer access token.

Sebelumnya cron sync (`app/api/cron/sync-accurate/route.ts`) berhenti total setiap sessionId
habis, sampai ada orang membuka UI `/api-wrapper` dan memilih database ulang — cron tidak
pernah memanggil `open-db.do` sendiri. Sekarang `lib/accurate-session.ts` punya
`ensureFreshAccurateSession()`: kalau `sessionId` kosong, cron refresh sendiri lewat
`open-db.do` (pakai `databaseId` tersimpan, atau `db-list.do` kalau belum pernah dipilih sama
sekali). Cron hanya gagal sekarang kalau **access token**-nya sendiri sudah kadaluarsa —
itu butuh login ulang manual di `/api-wrapper`, tidak bisa di-refresh otomatis (Accurate
OAuth di sini tidak pakai refresh_token).

Bug terkait yang juga sudah diperbaiki: redirect callback OAuth (`app/api/auth/callback/route.ts`)
dulu memakai `request.url` sebagai base — di belakang proxy Coolify itu alamat internal
container, jadi setelah login sukses browser dilempar ke `0.0.0.0:3000` alih-alih domain
publik. Sekarang pakai `BETTER_AUTH_URL`/`NEXT_PUBLIC_APP_URL`, sama seperti `lib/auth.ts`.

## Setup

```bash
node scripts/migrate-ext-sync-watermark.mjs        # kolom synced_at (delta feed)
node scripts/migrate-accurate-verified-fields.mjs  # kolom stok/kredit/status faktur
```

Lalu set `EXT_SALES_TOKEN` (`openssl rand -hex 32`) di kedua sisi.
