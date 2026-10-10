# S6-0e — Kontrak API server Pembayaran & Finance (untuk UI S6a/S6b)

Cabang `feat/fiori-s6-0e-server-bayar` (basis `origin/feat/fiori` 37a73409). Zona AGENTS §3 UANG + AUTH.
FastAPI = `NEXT_PUBLIC_FASTAPI_BASE_URL` (port 8000, cookie sesi + `X-CSRF-Token` dari `GET /api/me`). Next = same-origin.

## Aturan umum

- **Galat**: `{ "ok": false, "error": "<kalimat Indonesia>", ...detail }`. Tanpa path/stack. Pengecualian warisan seluruh
  backend: 401 `"Unauthorized"`, 403 `"Forbidden"` / `"CSRF token invalid"` — UI memetakan **menurut kode status**, bukan teks.
- **Tanggal**: tanggal bisnis `YYYY-MM-DD`; jejak waktu yang ditampilkan berakhiran `_wita`/`Wita` atau ditandai "(WITA)"
  = `YYYY-MM-DD HH:MM:SS` UTC+8. Field mentah tanpa akhiran = jam server (produksi UTC) — jangan ditampilkan langsung.
- **Pratinjau**: `?dry_run=1` (atau badan JSON `"dry_run": true` untuk endpoint JSON). Pratinjau **tidak pernah menulis**,
  memakai kode yang sama dengan eksekusi, dan menjawab `200 {ok:true, dry_run:true, can_apply, ...laporan}` walau ada
  masalah (masalah = `can_apply:false` + `error`). Eksekusi pada data yang sama menghasilkan laporan yang sama.
- **Kunci BL-05** (`shared.payment_lock_reason`): rekaman **terkunci** bila `status_pembayaran = "Sudah Transfer"` ATAU
  posting Accurate `posted`/`unknown` (`failed` bergalat ambigu = `unknown`; `failed` berpesan jelas TIDAK terkunci).
  Satu-satunya isian yang tetap boleh di jalur Pembayaran: `ajukan` (centang pilihan layar). Bukti, tanggal transfer,
  status transfer/posting = milik Finance (`/payments/finance/update`). Nilai yang dikirim sama dengan yang tersimpan
  (angka/tanggal dinormalisasi) **bukan** perubahan. Entri kunci: `{record_id, no_lpb, principle, reason, fields?}`.

## 1. Pembayaran (FastAPI `routers/payments.py`)

### POST `/payments/update` — BERUBAH
Izin `payments.update`, CSRF. Badan `{items:[{record_id, <isian>…}]}` (sama seperti sebelumnya).
- 200 `{ok:true, updated, updated_ids, skipped}`.
- **409 (BARU)** bila satu item mengubah rekaman terkunci → **tidak ada yang disimpan** (semua-atau-tidak):
```json
{"ok": false, "error": "Simpan ditolak: rekaman yang sudah ditransfer/terposting terkunci — LPB-7 (sudah ditransfer). Tidak ada yang disimpan.",
 "locked": [{"record_id": "LPB-7", "no_lpb": "LPB-7", "principle": "PT ABC", "reason": "sudah ditransfer", "fields": ["nilai_invoice"]}]}
```
- 400 validasi lama (No. LPB, NON_LPB, angka AM-044).

### POST `/payments/delete` — BERUBAH
Izin `payments.delete`, CSRF. `{record_ids:[…]}` → 200 `{ok:true, deleted}`; **409** `{ok:false, error, locked:[…]}` bila satu saja
terkunci (tidak ada yang dihapus).

### POST `/payments/clear` — BERUBAH
Izin `payments.delete`, CSRF, `{confirm:"CLEAR PAYMENTS"}`. **409** `{ok:false, error, locked_count, locked:[≤20]}` bila ada rekaman
terkunci. (S6a membuang tombolnya dari layar.)

### POST `/payments/upload` — BERUBAH (+ pratinjau)
Izin `payments.edit`, CSRF, multipart `file` (.xlsx/.xls).
- **Berkas backup PAYMENTS ditolak**: 400 `"Berkas ini backup PAYMENTS, bukan berkas LPB — gunakan Restore backup di Format SPPD."`
- `?dry_run=1` → 200:
```json
{"ok": true, "dry_run": true, "can_apply": false, "rows": 4, "total_nilai_win": 40.0, "total_nilai_invoice": 40.0,
 "duplicates": ["LPB-OLD"], "duplicates_in_file": ["lpb-d"],
 "invalid": ["baris 5: NILAI WIN tidak valid: 'abc'"], "error": "Angka tidak valid: … Upload dibatalkan."}
```
- Eksekusi: 200 `{ok:true, dry_run:false, added, ...laporan}`; 400 `{ok:false, error, ...laporan}` bila invalid / duplikat sistem /
  **duplikat di berkas (BARU — dulu baris kedua diam-diam menimpa)**. Satu masalah = tidak ada yang ditulis.

### POST `/payments/cart/create` — BERUBAH
Tanggal bayar bawaan (bila kosong) = **besok WITA**. **409** bila rekaman terkunci (mis. data lama "Ajukan Ulang" + posted):
`{ok:false, error:"Record LPB-1 sudah terposting di Accurate (PP/1010/1); tidak bisa diajukan ulang."}`.

### POST `/payments/cart/submit` — BERUBAH
Cek ulang di lock tulis: **409** `{ok:false, error, locked:[…]}` bila rekaman terposting/ditransfer setelah draf dibuat.

### GET `/payments/cart-info?draft=` — BERUBAH
404 generik `{ok:false, error:"Draft tidak ditemukan."}` untuk semua peran (dulu admin menerima PATH + id draf). Tanggal bawaan besok WITA.

### GET `/payments/submissions` — BARU (BL-50)
Izin `payments.view`. Baca-saja. Terbaru dulu. Pengajuan yang hanya ada di rekaman (data lama) ikut.
```json
{"ok": true, "data": [{
  "id": "1f2e3d4c", "sppd_no": "031/SPA/PDSB/X/2026", "created_at": "2026-10-09 02:00:00", "created_at_wita": "2026-10-09 10:00:00",
  "created_by": "betterauth|staff|a@x", "target_payment_date": "2026-10-10", "method": "BANK_PANIN", "route_label": "Bank Panin (SPPD)",
  "record_count": 2, "principles": ["PT ABC"], "total_invoice": 1700.0, "total_potongan": 200.0, "total_pembayaran": 1500.0,
  "transfer": {"Sudah Transfer": 1, "Belum Transfer": 1}, "posting": {"posted": 1, "belum": 1},
  "status": "sebagian", "status_label": "Sebagian ditransfer",
  "files": [{"label": "Invoice PT ABC (LPB)", "name": "invoice_1f2e3d4c_pt-abc_lpb.xlsx", "url": "/payments/files/invoice_1f2e3d4c_pt-abc_lpb.xlsx"}]}]}
```
- `method`: `BANK_PANIN` (rute SPPD) | `NON_PANIN`. `posting` kunci: `posted|unknown|failed|skipped|belum`.
- `status`: `kosong | tidak_pasti | terposting | dikembalikan | ditransfer | sebagian | menunggu_transfer` (urutan prioritas ini).
- `files` = HANYA berkas yang ada di disk; hasil restore backup (`files=[]`) → `[]`. Unduh: GET `/payments/files/{name}` (`payments.view`).

### GET `/payments/submissions/{id}` — BARU
Sama + `records:[{record_id, no_lpb, tipe_pengajuan, principle, invoice_no, nilai_invoice, potongan, nilai_pembayaran,
jenis_pembayaran, status_pembayaran, transfer_date, accurate_post_status, accurate_purchase_payment_number, locked_reason}]`,
`cart_items` (per `principle||tipe`: jenis_pembayaran, keterangan, potongan, …). 404 `{ok:false, error:"Pengajuan tidak ditemukan."}`.

## 2. Format SPPD (FastAPI `routers/sppd.py`, `main.py`)

### POST `/payments/sppd/upload` — BERUBAH (+ pratinjau)
Izin `sppd.upload_excel`, CSRF, multipart `file`. Laporan (pratinjau = eksekusi):
```json
{"ok": true, "dry_run": true, "can_apply": true, "updated": 1, "unchanged": 1,
 "changes": [{"record_id": "LPB-OLD", "no_lpb": "LPB-OLD", "principle": "PT ABC",
              "fields": [{"field": "keterangan", "old": "", "new": "baru"}, {"field": "nilai_invoice", "old": 1000.0, "new": 1500.0}]}],
 "unchanged_records": [ … ], "locked": [], "not_found": ["TIDAK-ADA"], "errors": [], "changed_fields": {"keterangan": 1, "nilai_invoice": 1},
 "ignored_columns": [], "blocked_columns": []}
```
- `updated` kini = rekaman yang **benar-benar** berubah (dulu = semua baris yang cocok).
- Eksekusi: **409** `{ok:false, error, locked:[{…, fields:[{field, old, new}]}], …}` bila baris rekaman terkunci mengubah sesuatu
  (seluruh unggahan ditolak); 400 `errors[0]` (No. LPB dipakai rekaman lain); 400 tak ada yang cocok.

### POST `/payments/sppd/restore-backup` — BARU
Izin **`sppd.edit_settings`** (izin setelan/nomor SPPD — restore ikut menaikkan nomor), CSRF, multipart `file` = berkas dari
`GET /payments/export`. `?dry_run=1` → ringkasan:
```json
{"ok": true, "dry_run": true, "can_apply": true, "records": 3, "submissions": 1, "new_submissions": 1, "draft_records": 1,
 "sppd": {"year": 2026, "last_sequence_before": 30, "max_restored": 45, "last_sequence_after": 45, "next_number": "046/SPA/PDSB/X/2026"},
 "conflicts": []}
```
- `draft_records` = rekaman tanpa pengajuan (istilah it08 "rekaman draf"). Keranjang (drafts) tidak ada di backup.
- Eksekusi 200 `{ok:true, dry_run:false, mode:"restore_backup", added, message, …ringkasan}`; 400 konflik (Record ID / No. LPB sudah ada,
  ganda di berkas) — tidak ada yang ditulis; 400 bukan berkas backup / angka-tanggal invalid. Nomor SPPD **tidak pernah turun** (D-05).

### POST `/api/bank-data/replace-principle-name` — BERUBAH (+ pratinjau, CSRF)
Izin `payments.edit`, **CSRF (BARU)**. `{old_name, new_name, dry_run?}`. Rekaman terkunci **dilewati dan dihitung** (it08 "tidak diubah: N").
```json
{"ok": true, "dry_run": true, "matched": 2, "replaced": 1, "locked_skipped": 1, "locked": [{"record_id": "LPB-TRF", "reason": "sudah terposting di Accurate", "…": "…"}],
 "per_status": {"Draf": 1, "Sudah Transfer": 1},
 "finance_mapping": {"old_name_has_mapping": true, "new_name_has_mapping": false, "needs_remap": true},
 "samples": ["LPB-OLD"], "old_name": "PT ABC", "new_name": "PT ABC BARU", "message": "Pratinjau: 1 rekaman akan diganti; 1 terkunci dilewati."}
```
`needs_remap` = mapping vendor/bank Finance berkunci nama lama; rekaman yang diganti perlu mapping baru (it08 #15).

### POST `/api/bank-data/auto-fix-names` — BERUBAH
Eksekusi (`confirm:true`) kini butuh **CSRF**. `changes[]` mendapat `locked` (jumlah terkunci, tidak di-rename); `count` = yang diubah.

### POST `/api/bank-data/upload` — BERUBAH
**CSRF (BARU)**. Tetap menimpa master rekening tanpa cadangan (S6a membuang tombolnya; lihat pertanyaan terbuka).

## 3. Finance

### POST `/payments/finance/update` (FastAPI) — BERUBAH
- **BL-49**: `status_pembayaran` `"Belum Transfer"`/`"Ajukan Ulang"` → **409** bila posting `posted`/`unknown`:
  `"LPB A sudah terposting di Accurate (PP/1010/1); status tidak bisa dikembalikan ke Ajukan Ulang."` /
  `"Posting Accurate LPB A TIDAK PASTI; selesaikan dulu (periksa Accurate) sebelum mengembalikan ke Belum Transfer."`
  Grup per principal = semua-atau-tidak.
- **Izin**: `finance.update` (seperti dulu) ATAU **`finance.resolve_unknown` saja** untuk penyelesaian: setiap item
  `status_pembayaran:"Sudah Transfer"`, `accurate_post_status` `posted|failed`, `resolution_note` ≥ 15, dan rekaman `unknown`.
  Data transfer/bukti dari permintaan diabaikan. Selain itu 403 `{ok:false, error:"Tanpa finance.update hanya boleh menyelesaikan posting TIDAK PASTI: …"}`.

### GET `/payments/finance/data` (FastAPI) — BERUBAH
Per baris kelompok tambahan: `accurate_posted_by` (identitas sesi FastAPI, mis. `betterauth|finance|a@x`), `accurate_posted_at`
(**WITA**), `accurate_post_resolution` `null | {from, to, source:"manual_attestation", by, at (WITA), note}`.

### GET `/api/finance/purchase-payment/attempts` (Next) — BARU
Izin `finance.view`. Baca-saja. `?invoices=INV-1,INV-2&invoices=INV-3` — satu parameter = satu kelompok (nomor faktur
`detail_invoices[].invoiceNo` baris Finance), maks. 100. Subjek = `purchasePaymentSubject` (format kunci attempt tidak berubah).
```json
{"ok": true, "data": [{"invoices": ["INV-1", "INV-2"], "subjectKey": "INV-1,INV-2", "attempt": {
  "attemptId": "…", "state": "sending", "status": "stale", "stale": true, "accurateNumber": "", "accurateId": "",
  "actor": "<user id>", "actorName": "Finance A", "targetDbId": "1234567", "generation": 0, "ageSeconds": 412,
  "createdAt": "2026-10-10T01:00:00.000Z", "createdAtWita": "2026-10-10 09:00:00", "updatedAt": "…", "updatedAtWita": "…",
  "message": "", "resolution": null}},
  {"invoices": ["INV-3"], "subjectKey": "INV-3", "attempt": null}]}
```
- `status`: `sending` (segar) | `stale` (sending ≥ 2 menit menurut jam DB — tidak pasti, bukan "sedang") | `posted` | `unknown` |
  `failed` (rejected / not_sent / resolved_absent = boleh dikirim ulang). `attempt:null` = belum pernah diposting lewat server.
- `targetDbId` = id database Accurate; nama database dari `/api/auth/accurate-session` (`databaseAlias`) bila sama.
- 400 `{ok:false, error:"Parameter invoices wajib: …"}` / `"Maksimal 100 kelompok per permintaan."`; 401/403 `{ok:false, error}`;
  503 `{ok:false, error:"Status posting tidak bisa dibaca dari database. Coba lagi."}`.

## 4. VariantNote — TIDAK dikerjakan di S6-0e (untuk S6a/S6b)

| Butir | Keadaan sekarang | Yang dibutuhkan |
|---|---|---|
| BL-33 riwayat nilai lama → baru | Tidak ada penyimpanan riwayat; audit log hanya jumlah/sampel. | Penyimpanan baru (skema, zona §3). UI tampilkan varian "riwayat belum tersedia". |
| Konkurensi optimis `/payments/update` | UI mengirim `source_updated_at`, server mengabaikannya; tulis terakhir menang (di dalam satu lock). | Versi per rekaman + 409 basi. |
| Pemilih pemasok/rekening (S6b) | Mapping diketik bebas (`/payments/finance/mapping`). | GET proxy baca-saja `vendor/list.do`, `glaccount/list.do`. |
| Rekaman "Belum Transfer" (sudah diajukan) | Masih bisa diubah lewat `/payments/update` / Excel SPPD (BL-49 bagian "terkunci kecuali dikembalikan" belum). | Keputusan owner (lihat laporan). |
| Restore backup di layar | Server siap; halaman Pembayaran lama masih bertuliskan "backup export PAYMENTS untuk restore" tetapi kini ditolak. | Tombol Restore di Format SPPD (S6a). |
