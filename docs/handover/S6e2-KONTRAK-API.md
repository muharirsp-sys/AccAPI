# S6e-2 — Kontrak API server Pelunasan (untuk UI wizard S6e-2b)

Cabang `feat/fiori-s6e2a-pelunasan-server` (basis `origin/feat/fiori` 95859d59). Zona AGENTS §3 (tulis Accurate + idempotensi).
Semua route Next same-origin, sesi Better Auth (cookie). Dasar keputusan: `OWNER-ANSWERS-S6e-2026-10-10.md` #5–#8, C11.

## Aturan umum

- **Galat**: `{ "error": "<kalimat Indonesia>", "code": "<KODE>", ...detail }`. UI memetakan **menurut `code` + status**, bukan teks.
  401 `Unauthorized` / 403 `Forbidden` (gerbang `requirePermission`) tetap berbentuk lama `{error}` — KECUALI 403 di
  `/api/idempotency/resolve` (GET & POST) dan `/api/idempotency/summary`: `{ok:false, code:"forbidden", error}`.
- **`sent: false`** pada jawaban galat = server menjamin TIDAK ADA yang diteruskan ke Accurate (baris boleh dilaporkan `FAILED`
  lewat `/api/idempotency/complete` — hanya baris `PROCESSING` milik lock yang berubah).
- **C11**: jawaban Accurate selain `s:true` per baris = **Tidak pasti** (bukan Gagal, bukan Ditolak). Tidak ada jalur yang
  menghasilkan "Ditolak" dari jawaban Accurate. "Gagal" hanya untuk baris yang pasti tidak terkirim (`sent:false`, ditolak
  penjaga sebelum kirim).
- **Kemiripan riwayat** = identitas KASAR sama dengan sales-receipt di Accurate: pelanggan + tanggal (nilai filter pencarian)
  + {nomor faktur: nominal bayar}, TANPA akun/catatan/jumlah potongan (keputusan orkestrator 11 Okt). Tidak pernah menaikkan
  baris ke Terposting — hanya petunjuk/penahanan.

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
| 7b | 409 | `database_changed` | database yang DICATAT lock (baris `idempotency_log` ATAU override lock) ≠ database sesi (atau lock/override lama tanpa database, `lockDatabaseId:"tidak tercatat"`) — `{sent:false, lockDatabaseId}` |
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

Biaya: tiap paket membaca riwayat per kelompok pelanggan+tanggal = `list.do` (≤ 5 halaman) + `detail.do` per kandidat
(≤ 300), paling banyak 4 serentak, batas 60 dtk per paket (melewati batas = kelompok sisanya `UNREADABLE`; sesudah batas tidak
ada panggilan Accurate baru). `list.do` wajib `s:true` + `d` daftar + `sp.pageCount` angka (angka JSON atau teks angka seperti
`"1"`; ≥ 1, atau 0 hanya bila `d` kosong) — selain itu `UNREADABLE` (tanpa jumlah halaman = dianggap terpotong). Pra-deploy: pastikan `list.do` produksi membawa `sp.pageCount`.
Tindak lanjut (DITUNDA, orkestrator 10 Okt): satu `list.do` per tanggal (bukan per pelanggan) menekan biaya, tetapi mengubah
logika pratinjau bersama — belum dikerjakan.

**Identitas kasar (orkestrator 11 Okt, tinjauan A1/B1; bentuk asli `detail.do` per `S6e2-BUKTI-DETAIL-DO-2026-10-10.md`)**:
`detail.do` tidak membawa `invoiceNo` (nomor faktur di `detailInvoice[].invoice.number`) dan tidak membawa `customerNo` tingkat
atas. Dinormalkan di SATU tempat (`strukDariDetail`, pratinjau & server): `invoiceNo = invoiceNo ?? invoice.number`,
`paymentAmount`, `invoicePayment`. Baris DITAHAN bila ada SATU faktur baris yang nominalnya (`paymentAmount`, atau
`paymentAmount` + potongannya) = `paymentAmount` ATAU `invoicePayment` faktur yang SAMA di pelunasan MANA PUN di grup
pelanggan+tanggal — dicocokkan per faktur, bukan himpunan faktur (putaran 2, A-N1: pelunasan {I1, I2} terposting lalu baris {I1}
diunggah ulang = ditahan; sebaliknya juga). Arti `paymentAmount`/`invoicePayment` belum terbukti — lebih banyak menahan = aman.
Nomor faktur dibandingkan setelah `trim().toUpperCase()` di kedua sisi (penahanan, pratinjau, kandidat Selesaikan; A-N2) —
payload ke Accurate tidak diubah; `candidates[].invoiceNos` tetap tulisan Accurate. Item potongan TIDAK dibaca: akun/catatan/jumlah/bentuknya tidak
menahan dan tidak meloloskan. Tak terbaca (`detailInvoice` bukan daftar, baris tanpa nomor faktur, `paymentAmount` bukan angka,
`invoicePayment` ada tetapi bukan angka) = `ACCURATE_HISTORY_UNREADABLE` (ditahan). Identik tanpa nomor pelunasan tetap ditahan
(`receiptNumbers: []`). Pratinjau (`pratinjauDuplikat`) memakai aturan yang sama; `ACCURATE_HISTORY_UNREADABLE` = "tidak
terbaca", bukan aman — baris itu butuh override Finance seperti `ACCURATE_HISTORY`.

## 2. `POST /api/idempotency/lock` (BERUBAH)

Badan lama + **`allowHistoryKeys: string[]` (BARU)** — kunci baris MIRIP riwayat Accurate yang diizinkan Finance. Satu override
`{action:"allow_duplicate", blockReason:"ACCURATE_HISTORY"}` per kemunculan kunci di `keys`; gerbang sama dengan override lain
(403 tanpa `finance.override_duplicate`, 400 alasan < 15). Override dihabiskan proxy per `blockReason` (override riwayat tidak
bisa dipakai untuk blok lock, dan sebaliknya).
- Non-pratinjau tanpa `pelunasan.kirim` → **403** `{code:"PERMISSION_REQUIRED"}`. Pratinjau (`preview:true`) tetap untuk semua
  pengguna bersesi (baca-saja).
- Non-pratinjau dengan key memuat `ISI_KODE_AKUN_` → **400** `{code:"PLACEHOLDER_AKUN"}` (sebelum menulis).
- Gerbang override kini berkode: 403 `OVERRIDE_PERMISSION_REQUIRED`, 400 `OVERRIDE_REASON_REQUIRED`.
- **Non-pratinjau wajib `expectedDatabaseId`** (BARU): 400 `DATABASE_REQUIRED`; sesi tanpa database 400
  `ACCURATE_SESSION_INCOMPLETE`; database sesi berbeda 409 `database_changed` — semua sebelum menulis. Lock mencatat database itu
  di `idempotency_log."databaseId"`.
- Non-pratinjau: `key` setiap entri wajib diawali `PAY_<customerNo dipangkas>_<transDate dipangkas>_` (rumus sidik jari), dan
  setiap faktur di `invoiceNo` (dipisah koma) wajib juga segmen faktur di `key` (putaran 2, B-N2) — selain itu **400**
  `{code:"KEY_IDENTITY_MISMATCH"}` sebelum menulis (lib `kirimPelunasan` selalu memenuhinya).
- Jawaban sukses tidak berubah: `{ok, lockId, blockedKeys, blockedEntries}`.

## 3. `POST /api/idempotency/complete` — TIDAK berubah

## 4. `GET /api/idempotency/resolve?key=…&key=…` (BARU, baca-saja) — pratinjau pencarian Selesaikan

Izin `finance.resolve_unknown`. 1–50 `key`. Mencari di Accurate dengan sesi PEMANGGIL (database sesi kini): **kandidat** =
pelunasan di grup pelanggan+tanggal baris yang MENYENTUH faktur mana pun dari baris (berapa pun nominal/potongannya; faktur
dari segmen `key` saja — kolom `invoiceNo` kiriman klien tidak menentukan, putaran 2 B-N2). Tidak menulis apa pun.
```json
{"ok": true, "databaseId": "123", "databaseAlias": "PT A",
 "rows": [{"key": "PAY_…", "status": "UNKNOWN", "customerNo": "C1", "transDate": "01/10/2026", "invoiceNo": "INV-1",
           "amount": 1000, "updatedAt": "…", "ageSeconds": 900, "eligible": true,
           "found": true, "receiptNumbers": ["PR.2026.10.00012"],
           "candidates": [{"receiptNumber": "PR.2026.10.00012", "invoiceNos": ["INV-1"], "amount": 900, "transDate": "01/10/2026",
                           "invoices": [{"invoiceNo": "INV-1", "paymentAmount": 900, "invoicePayment": null}]}],
           "readError": null}]}
```
`found` = ada kandidat (BUKAN "identik": nominal bisa berbeda — tampilkan `candidates` agar Finance membandingkan `amount` baris
dengan `amount` kandidat lalu memilih `receiptNumber`-nya untuk `terposting`). Kandidat: `receiptNumber` = nomor pelunasan
Accurate (bisa `""` bila Accurate tak memberi nomor), `invoiceNos` = faktur yang dibayar pelunasan itu, `amount` = Σ
`paymentAmount`, `transDate` = tanggal Accurate (cadangan: tanggal pencarian), `invoices` = rincian per faktur
(`invoicePayment: null` = tidak dikirim Accurate). Bentuk kandidat yang sama dipakai di galat §5.
`eligible` = `UNKNOWN`, `SENDING` ≥ 2 mnt, atau `PROCESSING` > 15 mnt (basi lock). `found:null` + `readError` = riwayat gagal dibaca. 400 tanpa key /
> 50; 400 `ACCURATE_SESSION_INCOMPLETE`; 404 key tidak ada.

## 5. `POST /api/idempotency/resolve` (BARU) — Selesaikan

Izin `finance.resolve_unknown`. Badan `{key, decision:"terposting"|"tidak_ada", accurateNumber (wajib untuk terposting), reason
(≥ 15), checkedSource, expectedDatabaseId, acceptSimilar?}`. Server MENCARI dulu (sesi pemanggil, kandidat sama dengan §4), lalu
satu transaksi: status `SUCCESS` (terposting) / `FAILED` (tidak_ada = boleh dikirim ulang; proxy tetap menahan riwayat) + jejak
`idempotency_resolution` (siapa, kapan, database, sumber, alasan, nomor; tidak bisa diubah/dihapus).

**`acceptSimilar` (putaran 2, B-N1)**: `terposting` dengan kandidat yang TIDAK identik kasar dengan baris (himpunan faktur beda,
atau ada faktur bernominal lain menurut sidik jari kunci — mis. cicilan lain, atau koreksi nominal; sidik jari yang tidak terurai
pasti — Σ hasil urai ≠ `amount` baris, angka negatif — juga dianggap tidak identik) wajib `acceptSimilar: true`;
tanpa itu 409 `similar_not_identical`. Bila diterima, `checked_source` jejak diakhiri `[mirip: <nomor> Rp<nominal kandidat> ≠
Rp<nominal baris>]`.

**Cicilan yang BELUM terkirim (`hint: "takeover"`)**: `similar_found` dan `similar_not_identical` membawa `hint: "takeover"`. Bila
Finance menilai baris ini memang belum masuk Accurate, jalurnya BUKAN Selesaikan, melainkan kirim ulang dengan override takeover
Finance di lock: `kirimPelunasan(rows, {override: {allowLockedKeys: [key], overrideReason}})` → `POST /api/idempotency/lock`
`allowLockedKeys` + `overrideReason` (≥ 15; izin `finance.override_duplicate`; galat `OVERRIDE_PERMISSION_REQUIRED` /
`OVERRIDE_REASON_REQUIRED`; tercatat `idempotency_override` action `takeover`). Bila proxy lalu menahan `ACCURATE_HISTORY`
(nominal sama dengan pelunasan yang ada), tambah `allowHistoryKeys: [key]`.

| Status | `code` | Kapan |
|---|---|---|
| 200 | — | `{ok, status, resolutionId, receiptNumbers}` |
| 200 | — | `{ok, alreadyResolved:true, status}` — keputusan sama sudah berlaku (klik ganda), juga bila kalah balapan dari keputusan yang sama (dua tab serentak) |
| 400 | — / `DATABASE_REQUIRED` / `ACCURATE_SESSION_INCOMPLETE` | masukan tak sah (sebelum DB/Accurate) / sesi |
| 403 | `forbidden` | tanpa `finance.resolve_unknown` — `{ok:false, code:"forbidden", error}` (juga GET §4) |
| 404 | `not_found` | key tidak ada |
| 409 | `database_changed` | database sesi ≠ `expectedDatabaseId` |
| 409 | `not_eligible` | bukan UNKNOWN / SENDING ≥ 2 mnt / PROCESSING > 15 mnt; atau `tidak_ada` < 2 mnt |
| 409 | `wrong_database` | database lock ≠ database sesi — `{lockDatabaseId}` (buka database itu) |
| 409 | `database_unknown` | `tidak_ada` untuk baris lama tanpa database tercatat (bisa terposting di database lain); `terposting` BOLEH |
| 409 | `search_failed` | pencarian Accurate gagal / bentuk tak dikenali — tidak ada yang diubah |
| 409 | `number_mismatch` | `terposting` dengan nomor yang bukan kandidat §4 (persis maupun mirip — kandidat mirip DITERIMA) — `{receiptNumbers, candidates}` |
| 409 | `similar_found` | `tidak_ada` padahal ada kandidat (pelunasan pelanggan+tanggal yang menyentuh faktur baris, berapa pun nominal/potongan) — `{receiptNumbers, candidates, hint:"takeover"}`. Menggantikan `found_in_accurate`. |
| 409 | `similar_not_identical` | `terposting` dengan kandidat yang tidak identik kasar tanpa `acceptSimilar:true` — `{receiptNumbers, candidates, selected (bentuk kandidat), rowAmount, candidateAmount, difference (= rowAmount − candidateAmount; null bila rowAmount null), hint:"takeover"}` |
| 409 | `changed` | status berubah selama pencarian (CAS) |

## 6. `GET /api/idempotency/summary` (BARU, baca-saja) — Beranda Admin Incaso (BL-41)

Izin `pelunasan.kirim` ATAU `finance.resolve_unknown`.
```json
{"ok": true, "uncertain": {"unknown": 2, "sendingStale": 1, "total": 3}, "retryable": 4, "processingStale": 0,
 "perDatabase": [{"databaseId": "123", "label": "123", "uncertain": {"unknown": 2, "sendingStale": 0, "total": 2}, "retryable": 1, "processingStale": 0},
                 {"databaseId": null, "label": "tidak tercatat", "uncertain": {"unknown": 0, "sendingStale": 1, "total": 1}, "retryable": 3, "processingStale": 0}],
 "staleMinutes": 15, "asOf": "2026-10-10T08:00:00.000Z"}
```
`?rows=1` menambah `rows: [{key, status, customerNo, transDate, invoiceNo, amount, databaseId, updatedAt,
category:"uncertain"|"processingStale"|"retryable"}]` (UNKNOWN + SENDING ≥ 2 mnt + PROCESSING > 15 mnt + FAILED, terbaru dulu,
≤ 200, tanpa payload) dan `rowsTruncated`. Baris non-`retryable` di daftar = TEPAT baris yang boleh diselesaikan (§4 `eligible`).
`&database=X` menyaring `rows` (bukan hitungan) ke database lock X dan menambah `rowsDatabaseId: "X"`. 403 =
`{ok:false, code:"forbidden", error}`. Alias database tidak
disimpan (UI memetakan id → alias dari daftar database).
`uncertain` = Tidak pasti (tile 1; `sendingStale` = `SENDING` ≥ 2 mnt, SAMA dengan ambang Selesaikan). `retryable` = `FAILED`
(tidak terkirim, tile 2). `processingStale` = lock > 15 mnt yang tak pernah diteruskan (diblokir lock sebagai tidak pasti; boleh
diselesaikan; tampilkan bila > 0).
`perDatabase` hanya database yang punya angka > 0; `databaseId:null` = lock sebelum S6e-2 ("tidak tercatat").

## 7. Lib untuk wizard (bukan HTTP)

- `parsePelunasan(rows, opsi)` → `{payload, manualRows, counts: {read, skipped: [{row, reason}]}}` (BARU `counts`; `row` = nomor
  baris data mulai 1; `reason` ∈ `"KODE_OUTLET_KOSONG"`, `"TANPA_NOMINAL"`).
- `kirimPelunasan(rows, deps)` (`lib/pelunasan/kirim.ts`, BARU): lock → paket 100 → laporan per baris → complete.
  `deps = {postJson(url, body) → {status, data}, expectedDatabaseId, override?, cariRiwayat?, lapor?, chunkSize?}`.
  Hasil `{lockId, rows: [{index, paket, outcome:"terposting"|"gagal"|"tidak_pasti"|"ditahan", message, code?, receiptNumbers?, item?}]}`.
  Pra-cek klien: placeholder akun → semua baris `gagal` tanpa lock. Jawaban proxy `sent:false` hanya berarti `gagal` pada 4xx
  (401/403 selalu `gagal`); 5xx/2xx ber-`sent:false` = `tidak_pasti` (tinjauan A5). Baris `tidak_pasti` membawa `code` server
  bila jawaban proxy memuatnya (mis. 409 `database_changed` tanpa `sent:false`) — klasifikasi tetap tidak pasti.
  Lock mengirim `expectedDatabaseId`. Galat SEBELUM kirim (lock ditolak/terblokir/tak terbit/jaringan) melempar
  **`GalatKirim {code, status, sent:false}`** — `code` = kode server lock (`PERMISSION_REQUIRED`, `OVERRIDE_PERMISSION_REQUIRED`,
  `OVERRIDE_REASON_REQUIRED`, `PLACEHOLDER_AKUN`, `DATABASE_REQUIRED`, `ACCURATE_SESSION_INCOMPLETE`, `database_changed`) atau
  `HTTP_<status>`, `BLOCKED_KEYS`, `LOCK_NOT_ISSUED`, `NETWORK`. UI memetakan menurut `code`, bukan teks.

## 8. Prasyarat deploy

- **Kunci izin**: IT Support menambah `pelunasan.kirim` ke grup yang MENGIRIM pelunasan (Admin Incaso, Finance) SEBELUM deploy —
  tanpanya semua kirim sales-receipt non-admin 403. `seed-rbac-presets` tidak dijalankan ke produksi.
- **DDL**: `docs/handover/DDL_S6E2.sql` (IT Support, role pemilik, **SEBELUM image baru di-deploy**; idempoten) — kolom `idempotency_log."databaseId"`
  + kolom `idempotency_override.database_id` + tabel `idempotency_resolution` (juga dibuat migrate-pg entri `idempotency_s6e2` &
  `idempotency_override_database` bila `DATABASE_MIGRATION_URL` terpasang) + trigger append-only + REVOKE
  UPDATE/DELETE/TRUNCATE, GRANT SELECT/INSERT ke `accapi_app`.
- Lock yang dibuat sebelum deploy tidak bisa dikirim lagi (database tidak tercatat) — muat ulang `/api-wrapper`, ulangi dari Tinjau.

## Catatan perubahan sesudah commit kontrak (86ec53b7)

- §1: semua 409 `SALES_RECEIPT_LOCK_REQUIRED` kini juga membawa `sent:false`.
- §4: `eligible` untuk `PROCESSING` = > 15 mnt (basi lock), bukan 2 mnt — PROCESSING bisa sah lama selama unggah banyak paket.
- §7: hasil `kirimPelunasan` per baris membawa `paket` (nomor paket, mulai 1).
- (10 Okt, sesudah keputusan orkestrator) §1 7b, §2 `expectedDatabaseId` + kode gerbang override, §5 POST ADA, §6 `perDatabase` +
  `?rows=1`, §7 `GalatKirim`, §8 DDL_S6E2; sidik jari riwayat memakai bentuk ASLI `detail.do` (§1).
- (11 Okt, tinjauan S6e-2a A1/B1 + keputusan orkestrator) Kemiripan riwayat = identitas KASAR pelanggan + tanggal + {faktur:
  nominal}, tanpa potongan (§1; `normalisasiDetailAccurate` diganti `strukDariDetail`; item potongan tak dikenal tidak lagi
  `UNREADABLE`; nominal bukan angka kini `UNREADABLE`). §4 baris membawa `candidates`; `found`/`receiptNumbers` = kandidat yang
  MENYENTUH faktur baris (bukan identik). §5 `found_in_accurate` → **`similar_found`** (`{receiptNumbers, candidates}`);
  `terposting` menerima nomor kandidat mana pun; `number_mismatch` membawa `candidates`.
- (11 Okt, tinjauan A2–A4) §1 Biaya: `list.do` tanpa `sp.pageCount` angka / bukan `s:true` / tanpa `d` = `UNREADABLE`;
  pembacaan berhenti saat batas waktu (tanpa panggilan baru).
- (11 Okt, tinjauan B2) §1 7b: override lock juga mencatat database (`idempotency_override.database_id`); lock yang hanya
  berisi override `resend_success` kini ditolak 409 `database_changed` bila database sesi berbeda; override lama tanpa
  database = `"tidak tercatat"` (ditolak). §8: kolom baru di DDL_S6E2 + entri migrate-pg `idempotency_override_database`.
- (11 Okt, tinjauan RENDAH) §2 400 `KEY_IDENTITY_MISMATCH` (B3). §5 `alreadyResolved` juga untuk kalah CAS dari keputusan sama
  (B4); jejak `actor` = user id, bukan email (B5). §6 `sendingStale` = SENDING ≥ 2 mnt (dulu > 15), `rows` memuat PROCESSING basi
  (`category:"processingStale"`), saring database + `rowsDatabaseId` (B6). §7 `sent:false` hanya untuk 4xx (A5). §8 DDL SEBELUM
  image baru (B7).
- (11 Okt, kebutuhan UI wizard S6e-2b) §4/§5 kandidat berbentuk `{receiptNumber, invoiceNos, amount, transDate, invoices}`
  (dulu `{number, invoices}`); `terposting` MENERIMA nomor kandidat mirip (nomor di luar kandidat tetap `number_mismatch`).
  §6 saring baris = **`database=<id>`** (bukan `databaseId`). §7 baris `tidak_pasti` membawa `code` server bila ada. 403
  `/api/idempotency/resolve` & `/api/idempotency/summary` = `{ok:false, code:"forbidden", error}` (Aturan umum).
- (11 Okt, putaran 2 A-N1) §1 penahanan riwayat dicocokkan PER FAKTUR: satu faktur bernominal sama di pelunasan mana pun di
  grup = `ACCURATE_HISTORY` (dulu himpunan faktur harus sama persis). Bentuk jawaban tidak berubah.
- (11 Okt, putaran 2 A-N2) §1/§4/§5 nomor faktur dibandingkan tanpa beda huruf/spasi. Bentuk jawaban tidak berubah.
- (11 Okt, putaran 2 B-N1, REV-B H) §5 badan `acceptSimilar?`; 409 BARU `similar_not_identical` (kandidat tidak identik kasar);
  `similar_found` & `similar_not_identical` membawa `hint:"takeover"` (jalur cicilan belum terkirim = override takeover lock);
  `checked_source` jejak diberi penanda `[mirip: …]` bila diterima.
- (11 Okt, putaran 2 B-N2) §2 `KEY_IDENTITY_MISMATCH` juga bila faktur kolom `invoiceNo` bukan segmen `key`; §4/§5 kandidat
  ditentukan dari segmen `key` saja.
- (11 Okt, putaran 2 orkestrator) §1 `sp.pageCount` teks angka diterima; 0 hanya bila daftar kosong; hilang/bukan angka tetap
  `UNREADABLE`.
- (11 Okt, susulan S6e, tinjauan B RENDAH) §5 kandidat identik kasar hanya bila sidik jari kunci terurai PASTI: Σ (bayar +
  potongan) hasil urai = `amount` baris dan tidak ada angka negatif. Catatan potongan berpemisah (`x:0;INV-1|200|a:b`) tidak
  lagi bisa memalsukan nominal → `similar_not_identical` (wajib `acceptSimilar`). Baris lama tanpa `amount` juga wajib
  `acceptSimilar`. Bentuk jawaban tidak berubah.
