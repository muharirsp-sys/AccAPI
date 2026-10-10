# S6e-2 — Kontrak API server Pelunasan (untuk UI wizard S6e-2b)

Cabang `feat/fiori-s6e2a-pelunasan-server` (basis `origin/feat/fiori` 95859d59). Zona AGENTS §3 (tulis Accurate + idempotensi).
Semua route Next same-origin, sesi Better Auth (cookie). Dasar keputusan: `OWNER-ANSWERS-S6e-2026-10-10.md` #5–#8, C11.

## Aturan umum

- **Galat**: `{ "error": "<kalimat Indonesia>", "code": "<KODE>", ...detail }`. UI memetakan **menurut `code` + status**, bukan teks.
  401 `Unauthorized` / 403 `Forbidden` (gerbang `requirePermission`) tetap berbentuk lama `{error}`.
- **`sent: false`** pada jawaban galat = server menjamin TIDAK ADA yang diteruskan ke Accurate (baris boleh dilaporkan `FAILED`
  lewat `/api/idempotency/complete` — hanya baris `PROCESSING` milik lock yang berubah).
- **C11**: jawaban Accurate selain `s:true` per baris = **Tidak pasti** (bukan Gagal, bukan Ditolak). Tidak ada jalur yang
  menghasilkan "Ditolak" dari jawaban Accurate. "Gagal" hanya untuk baris yang pasti tidak terkirim (`sent:false`, ditolak
  penjaga sebelum kirim).
- **Kemiripan riwayat** (sidik jari pelanggan|tanggal|faktur+nominal+potongan identik dengan sales-receipt di Accurate) tidak
  pernah menaikkan baris ke Terposting — hanya petunjuk.

## Izin

| Kunci | Arti | Ditegakkan di |
|---|---|---|
| `pelunasan.kirim` (BARU) | kirim pelunasan (sales-receipt) ke Accurate | `POST /api/proxy` cabang tulis sales-receipt; `POST /api/idempotency/lock` non-pratinjau; `GET /api/idempotency/summary` (atau `finance.resolve_unknown`) |
| `finance.override_duplicate` | izinkan baris ganda / terkunci / MIRIP riwayat (alasan ≥ 15) | `POST /api/idempotency/lock` (`allowDuplicateKeys`, `allowLockedKeys`, `allowHistoryKeys`) |
| `finance.resolve_unknown` | Selesaikan baris Tidak pasti | `GET /api/idempotency/resolve`; `GET /api/idempotency/summary` |

Preset grup TIDAK diubah. GET proxy dan tulis endpoint lain lewat proxy TIDAK berubah (Konsol AOL tetap `api_wrapper.*`).

## 1. `POST /api/proxy` — tulis sales-receipt (BERUBAH)

Badan: `{ endpointPath: "/api/sales-receipt/bulk-save.do" | "/api/sales-receipt/save.do", method: "POST", payload,
idempotencyLockId, expectedDatabaseId }` — **`expectedDatabaseId` BARU, wajib** = id database Accurate yang ditampilkan ke
pengguna (header wizard / dialog Kirim), dibaca dari `GET /api/auth/accurate-session` `databaseId`.

Urutan pemeriksaan (yang pertama gagal menjawab; semua sebelum `SENDING` = `sent:false`):

| # | Status | `code` | Kapan |
|---|---|---|---|
| 1 | 409 | `SALES_RECEIPT_LOCK_REQUIRED` | tanpa lock / bukan POST / path non-kanonik / bentuk payload salah (lama) |
| 2 | 400 | `PLACEHOLDER_AKUN` | payload masih memuat `ISI_KODE_AKUN_` (akun potongan belum dipilih di langkah Akun) |
| 3 | 403 | `PERMISSION_REQUIRED` | tanpa `pelunasan.kirim` |
| 4 | 400 | `DATABASE_REQUIRED` | `expectedDatabaseId` kosong |
| 5 | 409 | `SALES_RECEIPT_LOCK_REQUIRED` | sesi belum lengkap DAN lock tidak mencakup baris (lama) |
| 6 | 400 | `ACCURATE_SESSION_INCOMPLETE` | sesi Accurate belum lengkap / host tak diizinkan — `sent:false` (dulu tanpa kode → klien menganggap Tidak pasti) |
| 7 | 409 | `database_changed` | database sesi ≠ `expectedDatabaseId` — `{sent:false, databaseId, databaseAlias}` (database sesi kini) |
| 8 | 409 | `SALES_RECEIPT_LOCK_REQUIRED` | baris tidak tercakup lock/override (dinilai SEBELUM membaca riwayat) |
| 9 | 409 | `ACCURATE_HISTORY` | ada baris MIRIP riwayat Accurate (atau riwayat GAGAL dibaca) tanpa override `ACCURATE_HISTORY` |
| — | 200 | — | jawaban Accurate apa adanya (lama); hasil per baris dicatat server (`SUCCESS` hanya untuk `s:true` per baris, selain itu `UNKNOWN`) |
| — | 502 / 504 / 500 | — | bukan JSON / timeout / galat server = Tidak pasti (lama) |

Jawaban 409 `ACCURATE_HISTORY` (seluruh paket TIDAK dikirim, override & lock TIDAK dihabiskan):
```json
{"error": "2 baris ditahan: mirip pelunasan yang sudah ada di Accurate …", "code": "ACCURATE_HISTORY", "sent": false,
 "rows": [{"index": 3, "key": "PAY_…", "reason": "ACCURATE_HISTORY", "receiptNumbers": ["PR.2026.10.00012"]},
          {"index": 7, "key": "PAY_…", "reason": "ACCURATE_HISTORY_UNREADABLE", "receiptNumbers": [], "detail": "timeout"}]}
```
`index` = indeks baris di `payload` paket ini. `ACCURATE_HISTORY_UNREADABLE` = riwayat pelanggan+tanggal itu gagal dibaca
(fail-closed). Override `ACCURATE_HISTORY` menutup keduanya. Klien (lib `kirim.ts`) menandai baris itu "ditahan", melaporkannya
`FAILED` (tidak terkirim), lalu mengirim ulang sisa paket SEKALI.

Biaya: tiap paket membaca riwayat per kelompok pelanggan+tanggal = `list.do` (≤ 5 halaman) + `detail.do` per kandidat,
paling banyak 4 serentak, batas 60 dtk per paket (melewati batas = kelompok sisanya `UNREADABLE`).

## 2. `POST /api/idempotency/lock` (BERUBAH)

Badan lama + **`allowHistoryKeys: string[]` (BARU)** — kunci baris MIRIP riwayat Accurate yang diizinkan Finance. Satu override
`{action:"allow_duplicate", blockReason:"ACCURATE_HISTORY"}` per kemunculan kunci di `keys`; gerbang sama dengan override lain
(403 tanpa `finance.override_duplicate`, 400 alasan < 15). Override dihabiskan proxy per `blockReason` (override riwayat tidak
bisa dipakai untuk blok lock, dan sebaliknya).
- Non-pratinjau tanpa `pelunasan.kirim` → **403** `{code:"PERMISSION_REQUIRED"}`. Pratinjau (`preview:true`) tetap untuk semua
  pengguna bersesi (baca-saja).
- Non-pratinjau dengan key memuat `ISI_KODE_AKUN_` → **400** `{code:"PLACEHOLDER_AKUN"}` (sebelum menulis).
- Jawaban sukses tidak berubah: `{ok, lockId, blockedKeys, blockedEntries}`.

## 3. `POST /api/idempotency/complete` — TIDAK berubah

## 4. `GET /api/idempotency/resolve?key=…&key=…` (BARU, baca-saja) — pratinjau pencarian Selesaikan

Izin `finance.resolve_unknown`. 1–50 `key`. Mencari di Accurate dengan sesi PEMANGGIL (database sesi kini) memakai sidik jari
yang sama dengan penahanan riwayat. Tidak menulis apa pun.
```json
{"ok": true, "databaseId": "123", "databaseAlias": "PT A",
 "rows": [{"key": "PAY_…", "status": "UNKNOWN", "customerNo": "C1", "transDate": "01/10/2026", "invoiceNo": "INV-1",
           "amount": 1000, "updatedAt": "…", "ageSeconds": 900, "eligible": true,
           "found": true, "receiptNumbers": ["PR.2026.10.00012"], "readError": null}]}
```
`eligible` = `UNKNOWN`, atau `SENDING`/`PROCESSING` ≥ 2 mnt. `found:null` + `readError` = riwayat gagal dibaca. 400 tanpa key /
> 50; 400 `ACCURATE_SESSION_INCOMPLETE`; 404 key tidak ada.

## 5. `POST /api/idempotency/resolve` — **BELUM ADA (menunggu DDL, lihat §8)**

Rencana: `{key, decision:"terposting"|"tidak_ada", accurateNumber?, reason (≥15), checkedSource, expectedDatabaseId}`; server
mencari ulang dulu; `terposting` wajib nomor yang ada di hasil cari; `tidak_ada` ditolak bila pencarian menemukan/ gagal baca,
atau umur < 2 mnt; database sesi = database lock; tercatat (siapa/kapan/sumber/alasan/nomor); `already_resolved` = 200.
Tertahan karena butuh kolom database di `idempotency_log` + tabel jejak penyelesaian (CHECK `idempotency_override.action`
tidak memuat aksi penyelesaian).

## 6. `GET /api/idempotency/summary` (BARU, baca-saja) — Beranda Admin Incaso (BL-41)

Izin `pelunasan.kirim` ATAU `finance.resolve_unknown`.
```json
{"ok": true, "uncertain": {"unknown": 2, "sendingStale": 1, "total": 3}, "retryable": 4, "processingStale": 0,
 "perDatabase": null, "staleMinutes": 15, "asOf": "2026-10-10T08:00:00.000Z"}
```
`uncertain` = Tidak pasti (tile 1; `SENDING` basi = > 15 mnt, sama dengan lock). `retryable` = `FAILED` (tidak terkirim, tile 2).
`processingStale` = lock > 15 mnt yang tak pernah diteruskan (diblokir lock sebagai tidak pasti; tampilkan bila > 0).
`perDatabase` = `null` sampai kolom database ada (§8).

## 7. Lib untuk wizard (bukan HTTP)

- `parsePelunasan(rows, opsi)` → `{payload, manualRows, counts: {read, skipped: [{row, reason}]}}` (BARU `counts`; `row` = nomor
  baris data mulai 1; `reason` ∈ `"KODE_OUTLET_KOSONG"`, `"TANPA_NOMINAL"`).
- `kirimPelunasan(rows, deps)` (`lib/pelunasan/kirim.ts`, BARU): lock → paket 100 → laporan per baris → complete.
  `deps = {postJson(url, body) → {status, data}, expectedDatabaseId, override?, cariRiwayat?, lapor?, chunkSize?}`.
  Hasil `{lockId, rows: [{index, outcome:"terposting"|"gagal"|"tidak_pasti"|"ditahan", message, code?, receiptNumbers?, item?}]}`.
  Pra-cek klien: placeholder akun → semua baris `gagal` tanpa lock.

## 8. Prasyarat deploy & DDL tertunda

- **Kunci izin**: IT Support menambah `pelunasan.kirim` ke grup yang MENGIRIM pelunasan (Admin Incaso, Finance) SEBELUM deploy —
  tanpanya semua kirim sales-receipt non-admin 403. `seed-rbac-presets` tidak dijalankan ke produksi.
- **DDL tertunda (keputusan orkestrator)**: kolom `idempotency_log."databaseId"` (lock mencatat database; Selesaikan & ringkasan
  per database) + tabel jejak penyelesaian. Sampai itu, pengikatan database = `expectedDatabaseId` vs sesi pada SETIAP paket.
