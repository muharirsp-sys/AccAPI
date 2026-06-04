# R7 — Multi No Claim + Direct Claim Source Plan

Dokumen ini berisi rencana phased untuk R7. Phase R7a (sekarang) hanya
menambah schema + backfill compatibility. Tidak ada route, UI, atau
behavior existing yang berubah di R7a.

---

## Kenapa R7 ada

Asumsi lama menyatakan:

```
1 Claim Workflow = 1 No Claim
```

Real world ternyata berbeda:

1. Tidak semua data klaim berasal dari OFF Program Control. Ada yang
   masuk via kwitansi langsung / direct claim.
2. No Claim tidak selalu mengikuti No Pengajuan OFF.
3. Dalam satu pengajuan bisa ada beberapa No Claim.
4. No Claim dapat dibuat per pengajuan, per program, per toko, atau
   custom grouping manual.

Kesimpulan arsitektur:
- `claim_workflow` menjadi **container** umum untuk klaim.
- `claim_submission` menjadi entity baru yang menampung **satu No Claim**.
- Dokumen / payment / outstanding / close akan pindah bertahap ke level
  submission.

---

## Mapping konsep

| Konsep                         | Tabel                          |
|-------------------------------|--------------------------------|
| Container klaim (header)      | `claim_workflow`               |
| Satu No Claim utuh            | `claim_submission` (R7a)       |
| Item klaim (link item OFF)    | `claim_workflow_item` + `claim_submission_id` (R7a) |
| Payment principal             | `claim_payment` + `claim_submission_id` (R7a) |
| Audit                         | `claim_audit_log` + scope kolom (R7a) |
| OFF batch (sumber)            | `off_batch`, `off_batch_item`  |

`claim_workflow.noClaim` lama **dipertahankan** sebagai cache display
selama transisi. Source-of-truth pindah ke `claim_submission.noClaim`
mulai R7b ke depan.

---

## Phased plan

| Phase | Scope ringkas                                                             | Status   |
|-------|---------------------------------------------------------------------------|----------|
| R7a   | Schema additive: `claim_submission` table + kolom baru di workflow/item/payment/audit + backfill default submission. | DONE     |
| R7b   | API submission CRUD, item assignment, recalc submission totals, default submission tetap valid. | DONE     |
| R7c   | Generate Claim Letter / Summary / Kwitansi PDF per submission. PDF path workflow lama jadi pointer ke primary submission. | DONE     |
| R7d   | Payment + outstanding pindah ke level submission. `recalcPaymentTotals` per submission. Workflow totals di-derive. | Pending  |
| R7e   | Close per submission. Workflow `aggregate_status` derived. Reports basis berubah ke submission row. | Pending  |
| R7f   | Direct kwitansi / manual source. Butuh table rebuild SQLite (`off_batch_id` → nullable). **Deferred** sampai backup penuh + persetujuan bisnis. | Deferred |
| R7g   | Excel-style No Claim generator (pola Godrej `seq/SUPER-GCPI/MM/YYYY`) + scope `per_item` + endpoint `POST /[id]/submissions/from-items`. Tidak menyentuh schema; default month/year pakai zona `Asia/Makassar`. | DONE     |
| R7h   | Excel BASE Input Mode UI: tabel mirip sheet BASE Godrej dengan inline edit DPP/PPN%/PPH%, kolom No.2/Bulan, dan generate No Claim per row. Default mode tampilan jadi `excel`. Reuse PATCH item + PATCH submission existing; tidak ada API baru. | DONE     |
| R7i   | Staff Excel Mode simplification: switcher disederhanakan jadi `[Daftar Claim] [Advanced]` dengan submode lama tersembunyi di Advanced. Istilah "Paket" diganti "No Claim/Baris Claim" di UI default. Form "Buat Paket" + workflow-level Document section disembunyikan dari default Daftar Claim untuk multi-submission. | DONE     |
| R7j   | Single Staff Excel Mode + Panduan Kerja Claim: hapus seluruh layout eksperimen (Master Detail / Accordion / Kartu / Fokus / Status Board) + Advanced switcher. Halaman detail hanya punya 1 mode tampilan: Daftar Claim. Tambah panel Detail Claim inline (expanded row) untuk dokumen + summary pembayaran per baris. Tambah tombol Panduan Kerja Claim sebagai help collapsible. Default tampilan: Header → Toolbar → Tabel Daftar Claim. Workflow-level Document section + Items raw + Pembayaran Principal + Close Workflow + Audit semuanya di balik collapsible "Teknis / Riwayat" (default tertutup). | DONE     |

Semua phase di atas additive. Tidak ada kolom dihapus / di-rename di
R7a-R7e. Tabel `claim_peka_report` / status PEKA tetap retired (lihat
`docs/CLAIM_WORKFLOW_AI_CONTEXT.md`).

---

## Schema R7a detail

### Tabel baru: `claim_submission`

Lihat `db/schema.ts` (`claimSubmission`) dan `scripts/init-db.mjs`
untuk DDL definitif. Highlights:

- `claim_workflow_id` FK NOT NULL — banyak submission per workflow.
- `no_claim` nullable. Partial unique index
  `idx_claim_submission_no_claim_unique` mencegah duplikasi global
  setelah di-assign.
- `scope` (default `per_pengajuan`) + `scope_label` mendokumentasikan
  cara grouping. Bukan untuk gating.
- Field totals/dokumen/close mirror `claim_workflow` agar future route
  per-submission bisa langsung dipakai.

### Kolom baru di tabel existing

- `claim_workflow.{source_type, source_ref_id, aggregate_status}` —
  metadata sumber + status agregat. Belum dipakai di R7a; siap untuk
  R7e/R7f.
- `claim_workflow_item.claim_submission_id` (nullable) — backfill
  dilakukan oleh migration. Validasi 1 item → 1 submission diberlakukan
  di app layer mulai R7b.
- `claim_payment.claim_submission_id` (nullable) — pointer redundant.
  `claim_workflow_id` tetap dipertahankan sebagai cache.
- `claim_audit_log.{claim_submission_id, audit_scope}` — untuk audit
  yang scope-nya satu submission. Audit existing R1-R6 dibiarkan NULL /
  `audit_scope = "workflow"`.

---

## Backfill / migration instructions

### Prasyarat

1. DB lokal sudah punya schema R7a (tabel + kolom baru). Jalankan:
   ```
   node scripts/init-db.mjs
   ```
   Script ini idempotent (CREATE TABLE IF NOT EXISTS + ALTER TABLE ADD
   COLUMN). Aman di-run berkali-kali.

2. **Backup `sqlite.db`** sebelum lanjut — bukan karena R7a destruktif
   (R7a tidak destruktif), tapi sebagai best practice migrasi data:
   ```
   Copy-Item sqlite.db "sqlite-backup-r7a-$(Get-Date -Format yyyyMMdd-HHmmss).db"
   ```

### Jalankan backfill

Pakai npm script (preferred):
```
npm run migrate:r7a-submissions
```

Atau langsung:
```
node scripts/migrate-r7a-default-submission.mjs
```

### Apa yang dilakukan migration

Untuk setiap row `claim_workflow` lama, script:

1. Cek apakah workflow sudah punya minimal 1 `claim_submission`. Jika
   ya, **skip** (idempotent).
2. Insert satu default submission dengan:
   - `noClaim` + assigned metadata diturunkan dari workflow.
   - `scope = "per_pengajuan"`, `scopeLabel = claimWorkflowNo` (atau
     `"Pengajuan utama"`).
   - Status, totals, paths dokumen, close metadata mirror workflow.
3. Update `claim_workflow_item.claim_submission_id` untuk semua item di
   workflow itu yang masih NULL.
4. Update `claim_payment.claim_submission_id` untuk semua payment di
   workflow itu yang masih NULL.
5. Set `claim_workflow.source_type = "off_program"`,
   `source_ref_id = off_batch_id`, `aggregate_status = status` jika
   kolom-kolom tersebut masih kosong.

Migrasi dijalankan dalam **satu transaksi**. Jika ada error (mis. unique
conflict pada `no_claim`), transaksi rollback total dan tidak ada
perubahan partial.

### Verifikasi sesudah backfill

Cek di SQLite:

```sql
-- Setiap workflow harus punya minimal 1 submission.
SELECT COUNT(*) AS workflows_without_submission
FROM claim_workflow w
LEFT JOIN claim_submission s ON s.claim_workflow_id = w.id
WHERE s.id IS NULL;

-- Semua item harus sudah ter-link.
SELECT COUNT(*) AS items_unlinked
FROM claim_workflow_item
WHERE claim_submission_id IS NULL;

-- Semua payment harus sudah ter-link.
SELECT COUNT(*) AS payments_unlinked
FROM claim_payment
WHERE claim_submission_id IS NULL;
```

Ketiga query harus return 0 setelah backfill sukses.

---

## Yang tidak berubah di R7a

- Route OFF Program Control: tetap memvalidasi `claim_workflow.noClaim`
  untuk OFF Completed.
- Route Claim Workflow: assign No Claim, generate dokumen, payment,
  close, outstanding, reports — semuanya tetap operate di level
  workflow. Tidak menyentuh tabel `claim_submission` di R7a.
- UI: tidak ada perubahan.
- PDF path / file: tidak dipindah.
- Audit lama (`claim_audit_log` workflow-scope) tidak diubah.

---

## Phase R7b — Submission grouping + item assignment (DONE)

R7b menambah **API CRUD submission** dan helper recalc, serta minimal
UI section di detail page. Behavior R1-R6 tetap dipertahankan.

### Endpoint baru

| Endpoint | Method | Akses | Keterangan |
|----------|--------|-------|------------|
| `/api/claim-workflow/[id]/submissions` | GET | `canActorReadClaimWorkflow` | List submission per workflow + itemCount per submission. |
| `/api/claim-workflow/[id]/submissions` | POST | admin/claim, workflow Draft / Need Revision | Buat submission baru dengan scope, scopeLabel, optional noClaim. |
| `/api/claim-workflow/[id]/submissions/[submissionId]` | GET | read access | Detail submission + items yang ditugaskan. |
| `/api/claim-workflow/[id]/submissions/[submissionId]` | PATCH | admin/claim | Update scope / scopeLabel / noClaim (dengan partial unique check + sync ke off_batch_item untuk item submission). |
| `/api/claim-workflow/[id]/submissions/[submissionId]/items` | POST | admin/claim, workflow Draft / Need Revision | Pindahkan satu atau lebih item ke submission target. Recalc totals submission lama + target + workflow aggregate. |

### Helper baru di `lib/claim-workflow/submissions.ts`

- `getWorkflowSubmissions(workflowId, executor?)` — list ordered.
- `getOrCreateDefaultSubmission(executor, workflow, now?)` — idempotent
  fallback untuk workflow lama yang belum di-backfill (juga link item
  + payment yang masih NULL).
- `recalcSubmissionTotals(executor, submissionId, now?)` — sum dari
  item ditugaskan, update totalDpp/Ppn/Pph/Claim + remainingAmount.
  totalPaid submission masih dipertahankan apa adanya (R7d).
- `recalcWorkflowAggregateFromSubmissions(executor, workflowId, now?)` —
  sum submissions ke cache `claim_workflow.totalDpp/Ppn/Pph/Claim` +
  `aggregate_status` mirror dari `status`. totalPaid + remainingAmount
  workflow tetap pakai formula R3 sampai R7d.
- `assertSubmissionBelongsToWorkflow(submissionId, workflowId, executor?)` —
  guard standard.
- `isSubmissionEditableWorkflowStatus(status)` — true untuk Draft /
  Need Revision.

### Behavior change kecil (terdokumentasi)

- `PATCH /api/claim-workflow/[id]/items/[itemId]` (edit pajak):
  - Setelah update item totals, helper `getOrCreateDefaultSubmission`
    dipanggil bila item belum punya `claim_submission_id`. Kemudian
    `recalcSubmissionTotals` + `recalcWorkflowAggregateFromSubmissions`
    dijalankan dalam transaksi yang sama.
  - Audit `update_item_tax` sekarang membawa `claim_submission_id` +
    `audit_scope = "submission"` bila terkait submission.

- `PATCH /api/claim-workflow/[id]/no-claim` (legacy route):
  - Bila workflow punya >1 submission → tolak `409` dengan code
    `MULTI_SUBMISSION_NO_CLAIM_ROUTE_DISABLED`. User wajib pakai
    endpoint submission-specific.
  - Bila workflow punya 1 submission → mirror nilai noClaim ke
    submission tersebut secara atomic.
  - Bila workflow belum punya submission (DB lokal lama belum
    di-backfill) → tetap menulis cache workflow saja.

- `GET /api/claim-workflow/[id]` (detail):
  - Response sekarang membawa `submissions[]`, `submissionCount`,
    `hasMultipleSubmissions`, `noClaimList[]`, dan `noClaimDisplay`.
  - Field workflow lama (`noClaim`, totals, PDF paths, payment)
    tidak berubah.

### UI

- Detail page menambah section **Claim Submissions / No Claim Groups**
  read-only table + form create submission untuk admin/claim saat
  Draft / Need Revision. Kolom **Submission** ditambahkan di tabel
  item dengan dropdown untuk memindahkan item antar submission saat
  workflow editable dan ada >1 submission.
- Banner peringatan: dokumen klaim dan pembayaran principal masih
  berjalan di workflow-level sampai R7c/R7d.

---

## Phase R7c — Documents per submission (DONE)

R7c memindahkan generator Claim Letter / Summary / Kwitansi ke level
submission. Cache workflow tetap dipertahankan untuk Mark Ready / Close
gate (akan dipindah di R7d/R7e).

### Endpoint baru

| Endpoint | Method | Akses | Keterangan |
|----------|--------|-------|------------|
| `/api/claim-workflow/[id]/submissions/[submissionId]/claim-letter` | POST | admin/claim | Generate Claim Letter PDF per submission. Items difilter `claim_submission_id`. |
| `/api/claim-workflow/[id]/submissions/[submissionId]/claim-letter` | GET | read access | Stream PDF dari `claim_submission.claimLetterPdfPath`. |
| `/api/claim-workflow/[id]/submissions/[submissionId]/summary` | POST/GET | admin/claim / read access | Sama untuk Summary. |
| `/api/claim-workflow/[id]/submissions/[submissionId]/receipt` | POST/GET | admin/claim / read access | Sama untuk Kwitansi. |

### Path layout

```
runtime/claim-workflow/
  {workflowId}/submissions/{submissionId}/letter/{slug}-letter-{ts}.pdf
                                          /summary/{slug}-summary-{ts}.pdf
                                          /receipt/{slug}-receipt-{ts}.pdf
  letters/                ← LEGACY workflow-level (pra-R7c)
  summaries/              ← LEGACY workflow-level
  receipts/               ← LEGACY workflow-level
```

- Folder utama submission selalu pakai `submissionId` (immutable).
- `slug` di-derive dari `slugifyNoClaim(noClaim)`. Bila noClaim NULL/
  empty, fallback ke `submissionId`.
- Path validator umum `isPathInsideClaimDocumentRoot` menerima legacy
  dir maupun submission tree.

### Helper baru di `lib/claim-workflow/document-paths.ts`

- `CLAIM_DOCUMENT_ROOT_DIR`, `LEGACY_DOCUMENT_DIRS`.
- `getSubmissionDocumentDir(workflowId, submissionId, type)`.
- `slugifyNoClaim(value)`.
- `formatDocumentTimestamp(date)`.
- `buildSubmissionDocumentFilePath({ workflowId, submissionId, type, noClaim, generatedAt })`.
- `isPathInsideClaimDocumentRoot(path)`.
- `isPathInsideLegacyDir(path, type)`.
- `isPathInsideSubmissionDocumentDir({ workflowId, submissionId, type, targetPath })`.

### Constants baru di `lib/claim-workflow/constants.ts`

- `claimDocumentTypes = { letter, summary, receipt }`.
- `claimDocumentTypeList`, `isClaimDocumentType`, `ClaimDocumentType`.

### PDF generator signature change

`generateClaimLetterPdf(workflow, items, generatedAt, options?)`,
`generateClaimSummaryPdf(workflow, items, generatedAt, options?)`,
`generateClaimReceiptPdf(workflow, items, generatedAt, options?)` —
`options.submission?: ClaimSubmissionRow | null`.

- Bila submission disuplai: header PDF override `noClaim` + totals
  pakai data submission. Items WAJIB sudah difilter caller. File path
  ditulis di submission tree.
- Tanpa submission: legacy workflow-level path + header workflow.

### Behavior change kecil

- `POST /[id]/{claim-letter,summary,receipt}` (legacy):
  - Multi-submission → 409 `MULTI_SUBMISSION_LETTER_ROUTE_DISABLED` /
    `..._SUMMARY_..._DISABLED` / `..._RECEIPT_..._DISABLED`.
  - Single submission → tulis cache workflow + mirror ke submission
    tunggal (atomic) supaya kedua source-of-truth konsisten.
  - Workflow tanpa submission → tulis cache workflow saja (audit pakai
    `audit_scope = "workflow"`).
- `POST /[id]/status` `return_to_draft`:
  - Tetap invalidate 3 PDF cache workflow.
  - **R7c**: juga loop semua submission → reset 3 path PDF + unlink
    file di submission tree (best-effort).
  - Audit metadata `invalidatedSubmissionPdfPaths` mencantumkan
    `{submissionId, type, path}` per file yang di-invalidate.

### Audit

Audit action tetap sama (`claim_letter_generated`, `claim_summary_generated`,
`claim_receipt_generated`). Metadata baru: `workflowId`, `submissionId`,
`noClaim`, `itemCount`, `totalClaim`, `documentType`, `filePath`,
`workflowMirror` (saat lewat route legacy), `viaLegacyWorkflowRoute`.

### UI

Detail page section "Claim Submissions / No Claim Groups" sekarang
menampilkan **3 chip per submission**: Letter / Summary / Kwitansi.
Setiap chip:
- Link "PDF" hijau bila path tersedia (download via endpoint per submission).
- Tombol "Gen / Re" indigo untuk generate / regenerate (admin/claim,
  workflow editable, items > 0, totalClaim > 0).

Banner amber di section "Dokumen Klaim" workflow-level mengingatkan user
bila workflow multi-submission.

### Yang BELUM diubah

- Mark Ready gate (workflow cache).
- Close gate (workflow cache).
- Reports / Outstanding (workflow basis).
- OFF Program Control PDF (terpisah total).

---

## R7f deferred — direct kwitansi / manual

- `claim_workflow.off_batch_id` saat ini `NOT NULL UNIQUE`. SQLite
  tidak punya `ALTER COLUMN DROP NOT NULL` — perubahannya butuh table
  rebuild (CREATE NEW + COPY + RENAME).
- R7f akan dijalankan terpisah dengan **backup penuh** SQLite + verifikasi
  row count sebelum/sesudah.
- Sebelum R7f, direct kwitansi/manual claim **belum didukung** oleh
  schema. Jangan mencoba membuat workflow tanpa OFF batch sampai R7f
  selesai.

---

## Phase R7g — Excel-style No Claim Generator + Per Item Package (DONE)

R7g membawa pola No Claim sheet BASE Godrej ke web tanpa menyentuh
schema. Tidak ada migration baru. Source-of-truth tetap
`claim_submission.noClaim`.

### Pola No Claim

```
{sequence}/{distributorCode}-{principalCode}/{MM}/{YYYY}
```

Contoh: `01/SUPER-GCPI/02/2026`, `130/SUPER-GCPI/04/2026`.

Aturan formatting sequence di UI:
- Trim spasi.
- Numeric `1`-`9` → pad menjadi 2 digit (`01`-`09`).
- Numeric `10` ke atas dipertahankan apa adanya (tidak dipaksa 3 digit).
- String non-numeric dibiarkan apa adanya.

Default principal code untuk Godrej: `GCPI` (helper `guessPrincipalCode`
mendeteksi kata "godrej" / "gcpi" di `workflow.principleName`, fallback
tetap `GCPI`).

### Default Bulan/Tahun — Asia/Makassar

Helper `getMakassarDateParts(date = new Date())` mengembalikan
`{ year, month, day }` (4/2/2 digit) memakai
`Intl.DateTimeFormat` dengan `timeZone: "Asia/Makassar"`. Default
generator memakai bulan/tahun Makassar saat user pertama kali masuk
mode "Generate dari Excel".

User tetap bebas mengganti bulan/tahun setelahnya. Helper hanya untuk
default, bukan untuk memaksa data lama berubah.

### UI Generator (per submission)

- Editor No Claim per paket sekarang punya toggle:
  - **Input Manual** (default) — perilaku lama.
  - **Generate dari Excel** — form 5 field (Nomor Urut, Kode Distributor,
    Kode Principal, Bulan, Tahun) + preview live + tombol "Gunakan No
    Claim Ini" yang menyalin preview ke draft input manual. User tetap
    klik **Save** memakai handler PATCH submission existing — tidak ada
    auto-save.
- Validasi client-side: sequence wajib, distributor wajib, principal
  wajib, bulan format `^\d{2}$` dan range 01-12, tahun format `^\d{4}$`.
  Validasi backend tetap lewat PATCH submission (no_claim non-empty,
  unique).

### Scope Baru: `per_item`

- Konstanta: `claimSubmissionScopes.perItem = "per_item"`.
- Label UI: **"Per Baris / Item"**.
- Helper text:
  > Satu item/baris klaim menjadi satu Paket No Claim. Ini paling mirip
  > sheet BASE di Excel.
- Scope ini hanya nilai string; tidak ada perubahan schema. Semua aturan
  R7b–R7e (CRUD, dokumen, payment, close, reports) berjalan sama untuk
  scope ini.

### Endpoint Baru: Buat Paket per Item

```
POST /api/claim-workflow/[id]/submissions/from-items
```

Body:

```json
{ "mode": "all_unassigned" | "all_items" }
```

- Default mode: `all_unassigned` (UI memakai ini).
- Akses: admin/claim only. Workflow harus berstatus `Draft` atau
  `Need Revision`. Workflow `Closed` ditolak (`CLAIM_SUBMISSION_WORKFLOW_CLOSED`).
- Behavior:
  1. Ambil semua `claim_workflow_item` untuk workflow.
  2. Skip item yang sudah berada di submission scope `per_item` (untuk
     kedua mode di R7g — idempotent guarantee).
  3. Untuk setiap target item:
     - Insert `claim_submission` dengan `scope = per_item`,
       `noClaim = null`, `scopeLabel` di-derive dari item (prioritas:
       `outlet` → `jenisPromosi` → `periode` → `noSurat` → fallback
       `Item Klaim {short id}`).
     - Update `claim_workflow_item.claim_submission_id` ke submission
       baru.
     - Recalc totals submission baru via `recalcSubmissionTotals`.
  4. Recalc totals submission lama yang ditinggalkan.
  5. Recalc workflow aggregate via `recalcWorkflowAggregateFromSubmissions`.
  6. Audit `claim_submissions_created_per_item` dengan metadata
     `mode`, `createdCount`, `createdSubmissionIds`, `affectedItemIds`,
     `previousSubmissionIds`, `workflowAggregate`.
- Return: `{ ok, createdCount, skippedCount, createdSubmissionIds,
  affectedItemIds }`.
- **Tidak** auto-generate No Claim. User mengisi belakangan via
  generator/manual editor.
- Submission lama (mis. `per_pengajuan` default) **tidak** dihapus
  walau tertinggal kosong — preserve audit history.

### UI Action

Card "Buat Paket per Baris / Item" tampil di section Paket No Claim
(hanya saat `canEditItems` + workflow editable). Tombol memanggil
endpoint di atas dengan `mode = all_unassigned`. Toast sukses:
"{N} paket per item dibuat." atau "Semua item sudah memiliki paket."
saat `createdCount = 0`.

### Test

`scripts/test-r7g-excel-no-claim.mjs` — 36 assertion:

- Helper `getMakassarDateParts` (year/month/day format + fixed instant
  2026-02-15 UTC = 2026-02-15 WITA).
- Generator formatting (sequence 1/9/10/130 + month/year).
- Validasi (empty sequence, month 13, month abc, year 26, missing
  distributor, valid draft).
- Endpoint `from-items` (2 item → 2 paket per_item, totals benar,
  workflow aggregate benar, idempotent rerun → 0 baru, workflow kosong
  → 0 baru).

Cleanup memakai prefix `R7G-TEST-`.

### Yang TIDAK diubah

- Schema database (tidak ada ALTER/DROP/RENAME).
- Payment / outstanding / close / reports behavior.
- Dokumen behavior R7c.
- Source-of-truth `claim_submission.noClaim` (tetap).
- `claim_workflow.noClaim` legacy/cache untuk single-submission.
- PEKA / EC / CN tetap retired.
- R7f direct/manual source masih deferred.

---

## Phase R7h — Excel BASE Input Mode (DONE)

R7h hanya menyentuh frontend halaman detail Claim Workflow. Tidak ada
endpoint baru, schema berubah, atau perubahan business logic. Semua
save tetap lewat endpoint existing R7b/R7g.

### Mode tampilan baru

`SUBMISSION_LAYOUT_OPTIONS` sekarang berisi 6 opsi: `excel` (default),
`master`, `accordion`, `card`, `focus`, `board`. localStorage key
`claimWorkflowSubmissionLayoutMode` menerima nilai `excel` di samping
yang lama.

- Default: **Excel Input** — tabel mirip sheet BASE Godrej.
- Mode lama (Master / Accordion / Kartu / Fokus / Status Board) tetap
  tersedia sebagai Advanced.

### Tabel Excel Input

Satu baris = satu `claim_workflow_item`. Submission resolved via
`item.claimSubmissionId`. Kolom:

```
No. | No Claim | Perihal | Periode | Surat Program | Outlet | DPP |
PPN % | PPN Value | PPH % | PPH Value | Nilai Klaim | No.2 | Bulan |
Dokumen | Paid | Outstanding | Status | Aksi
```

Toolbar di atas tabel:

- Search (No Surat / Outlet / Perihal / No Claim).
- Filter status: `Semua` / `Belum No Claim` / `Belum Dokumen` /
  `Outstanding` / `Paid`.
- Global generator settings: Distributor (`SUPER`), Principal (`GCPI`,
  ditebak via `guessPrincipalCode(workflow.principleName)`), Tahun, Bulan
  default. Default tahun/bulan saat mount diambil dari
  `getMakassarDateParts()` (Asia/Makassar).
- Tombol "Buat Paket per Baris / Item" reuse endpoint R7g
  `POST /[id]/submissions/from-items` mode `all_unassigned`.
- Tombol "Refresh".

### Inline edit per row

- **No.2** + **Bulan** — input ringan; tombol "Generate" menyusun
  `formatNoClaimSequence(seq)/{distributor}-{principal}/{month}/{year}`
  dan mengisi draft No Claim. Tidak auto-save.
- **No Claim** — input langsung; bisa dipakai untuk menyimpan No Claim
  manual yang tidak sesuai pola Excel.
- **DPP / PPN % / PPH %** — input numeric. Calculated cell
  (PPN Value, PPH Value, Nilai Klaim) di-derive di frontend pakai
  rumus `Nilai Klaim = DPP + DPP*PPN/100 - DPP*PPH/100`.

Save row memanggil:
- `PATCH /api/claim-workflow/[id]/items/[itemId]` — bila DPP/PPN/PPH
  berubah. Field `dpp`, `ppnRate`, `pphRate` (mirror route existing).
- `PATCH /api/claim-workflow/[id]/submissions/[submissionId]` — bila
  No Claim berubah, dengan body `{ noClaim }`. Item harus sudah
  ter-link ke submission (kalau belum, tampilkan toast minta klik
  "Buat Paket per Baris / Item" dulu).

Validasi client-side mirror backend: `dpp >= 0`, `0 <= ppnRate <= 100`,
`0 <= pphRate <= 100`, `noClaim` non-empty saat dirty.

### Kolom Dokumen / Paid / Outstanding

Read-only ringkas:
- Dokumen: counter `X/3` (Letter / Summary / Kwitansi) per submission.
- Paid: `submission.totalPaid`.
- Outstanding: `submission.remainingAmount`, ditampilkan "Lunas" saat 0.
- Status: badge submission.

Aksi per row: **Generate** (susun preview), **Simpan** (PATCH item +
submission), **Kelola Paket** — set `submissionLayoutMode = "master"`
dan `selectedSubmissionId = sub.id` agar user pindah ke Advanced Master
Detail untuk mengelola dokumen/payment/close per paket.

### Backward Compatibility

- Mode lama tetap dipertahankan (no breaking layout removal).
- Workflow-level No Claim editor tetap di section legacy untuk
  single-submission.
- `claim_submission.noClaim` tetap source-of-truth.
- Schema database tidak berubah.
- PEKA / EC / CN tetap retired.
- R7f direct/manual source masih deferred.

### Test

`scripts/test-r7h-excel-input-mode.mjs` — 29 assertion:
- Pure helper: `parseNoClaimComponents` (valid/empty/freeform/missing
  year), `buildNoClaim`, `calculateClaimPreview` (rumus DPP+PPN-PPH).
- Endpoint flow: PATCH item tax (rate, recalc submission/workflow
  cache), PATCH submission noClaim (success + empty rejected), validasi
  (PPN > 100, DPP < 0).

Cleanup memakai prefix `R7H-TEST-`.

---

## Phase R7i — Staff Excel Mode simplification (DONE)

R7i hanya menyentuh frontend `app/(dashboard)/claim-workflow/[id]/page.tsx`
dan dokumentasi. Tidak ada endpoint baru, schema tetap, dan semua aksi
backend (R7b/R7c/R7d/R7e/R7g/R7h) dipertahankan.

### Tujuan

Menyederhanakan halaman detail Claim Workflow agar staff merasa
mengisi sheet BASE Excel, bukan mengelola "Paket / Submission". Konsep
internal R7 (`claim_submission`, `claim_workflow_item`) tetap berjalan
di belakang layar. Source-of-truth No Claim tetap
`claim_submission.noClaim`.

### Perubahan UI utama

- **Switcher 2 tier**:
  - Primary: `[Daftar Claim] [Advanced]`. Default `Daftar Claim`.
  - Secondary submode (hanya muncul saat Advanced): `Master Detail` /
    `Accordion` / `Kartu` / `Fokus` / `Status Board`. Visual lebih kecil
    dan diberi caption "Advanced: gunakan hanya jika perlu menggabungkan/
    memecah baris claim atau mengelola detail dokumen, payment, dan
    close."
  - localStorage key tetap `claimWorkflowSubmissionLayoutMode`. Nilai
    `excel` aktif Daftar Claim, lima nilai lain otomatis aktif Advanced
    sesuai submode tersimpan.

- **Heading section**: `"Paket No Claim"` → `"Daftar Claim"`. Subtitle:
  `"Input No Claim, DPP, PPN, dan PPH seperti sheet BASE."` Helper:
  `"Satu baris claim dapat menjadi satu No Claim."`

- **Header workflow**: badge `"{N} Paket No Claim"` →
  `"{N} No Claim"`. Summary card `"Paket No Claim"` →
  `"Jumlah No Claim"`. Helper text adaptive:
  - multi: `"Setiap baris claim dapat memiliki No Claim sendiri."`
  - single: `"Isi No Claim dan nilai klaim seperti di Excel BASE."`

- **No Claim container info (multi)**: heading
  `"No Claim diatur per Paket Klaim"` →
  `"No Claim per Baris"`. Tombol `"Lihat Paket No Claim"` →
  `"Buka Daftar Claim"`. Badge `"{N} Paket No Claim"` →
  `"{N} No Claim"`.

- **Card "Buat Paket per Baris / Item"** dipindah ke Advanced. Default
  Daftar Claim cuma menampilkan banner kompak amber:
  `"Ada baris claim yang belum siap diberi No Claim."` + tombol
  `"Siapkan Baris Claim"` saat ada item belum dipaketkan; atau
  `"Semua baris claim sudah siap diberi No Claim."` saat semua item
  sudah berada di submission scope `per_item`. Banner hilang jika
  workflow belum punya item klaim.

- **Form "Buat Paket No Claim Baru"** dipindah ke Advanced + diberi
  label `"Buat Kelompok Claim Manual"` + helper text untuk admin/claim.

- **Toolbar Excel Input**: tombol `"Buat Paket per Baris / Item"` →
  `"Siapkan Baris Claim"`.

- **Tabel kolom**: `No.2` → `No. Urut`, `Bulan` → `Bulan Claim`. Aksi
  per row `Kelola Paket` → `Kelola Detail` (klik beralih ke Advanced
  Master Detail dan select submission row).

- **Pesan UX staff-friendly**:
  - `"Item belum punya Paket No Claim. Klik 'Buat Paket per Baris /
    Item' di toolbar."` → `"Baris ini belum siap diberi No Claim. Klik
    'Siapkan Baris Claim' di toolbar."`
  - Cell row tanpa submission: `"Belum punya paket"` → `"Belum siap"`.

- **Workflow-level Document section**: disembunyikan dari default
  Daftar Claim saat workflow multi-submission. Tetap muncul di Advanced
  atau saat single-submission. Banner amber multi diperhalus:
  `"Workflow memiliki beberapa No Claim. Dokumen dibuat per No Claim.
  Klik "Kelola Detail" pada baris claim, atau gunakan Advanced untuk
  generate per No Claim."`

- **Master Detail panels**: label `"Detail Paket Terpilih"` →
  `"Detail No Claim Terpilih"`, aria-label `"Pilih paket"` →
  `"Pilih No Claim"`, `"Daftar Paket No Claim"` → `"Daftar No Claim"`,
  empty state `"Belum ada Paket No Claim."` → `"Belum ada No Claim."`,
  `"Pilih paket di kiri ..."` → `"Pilih No Claim di kiri ..."`.

### Yang TIDAK diubah

- Schema database. Tidak ada ALTER/DROP/RENAME.
- Backend endpoint. PATCH item, PATCH submission, POST submissions,
  POST submissions/from-items, generate dokumen, payment, close,
  reports — semua identik R7b–R7h.
- Business logic R7c/R7d/R7e/R7g/R7h.
- Section "Items" di bawah tabel (raw items table) — dipertahankan
  apa adanya untuk konsistensi flow item assignment lama. Dropdown
  pemindahan item antar submission masih di sana.
- Section Pembayaran Principal + Close Workflow workflow-level —
  tetap muncul karena belum dipindah ke per submission di UI default.
- Audit log section — tetap.
- PEKA / EC / CN tetap retired.
- R7f direct/manual source masih deferred.

### Test

Tidak ada test baru di R7i (perubahan murni presentational; backend
contract tidak berubah). Regression suite tetap dijalankan:
`scripts/test-r7c-documents.mjs`, `scripts/test-r7d-submission-payments.mjs`,
`scripts/test-r7e-close-reports.mjs`, `scripts/test-r7g-excel-no-claim.mjs`,
`scripts/test-r7h-excel-input-mode.mjs` — semua 0 FAIL.

---

## Phase R7j — Single Staff Excel Mode + Panduan Kerja Claim (DONE)

R7j hanya menyentuh frontend halaman detail dan dokumentasi. Tidak ada
endpoint baru, schema tidak berubah, business logic R7b–R7i tetap sama.

### Tujuan

Menyederhanakan halaman detail Claim Workflow menjadi satu mode
tampilan saja: **Daftar Claim** (Excel BASE). Semua layout eksperimen
sebelumnya dihapus dari kode supaya halaman lebih ringkas dan staff
tidak melihat mode pilihan apa pun. Tambah fitur **Panduan Kerja Claim**
sebagai help collapsible untuk mengajari staff cara mengerjakan workflow
claim end-to-end.

### Yang Dihapus

- Layout eksperimen: Master Detail, Accordion, Kartu, Fokus, Status
  Board (~400 baris JSX dihapus dari `page.tsx`).
- Switcher 2-tier `[Daftar Claim] [Advanced]` + submode kecil.
- Konstanta `SUBMISSION_LAYOUT_OPTIONS`, `ADVANCED_SUBMODES`,
  `ALLOWED_LAYOUT_MODES`, helper `isAdvancedSubmode`,
  `readStoredLayoutMode`, type `SubmissionLayoutMode`.
- useEffect hidrasi + persist localStorage layout mode.
- useEffect accordion default-open + ref `accordionInitializedKeyRef`.
- Helper `renderSubmissionDetailPanel` + `getSubmissionItems` (dipakai
  hanya oleh advanced layouts).
- Card Advanced "Buat Paket per Baris / Item" + form "Buat Kelompok
  Claim Manual" — keduanya dihapus dari default view. Endpoint
  `POST /[id]/submissions` tetap ada di backend tapi tidak dipanggil
  dari UI staff R7j.

### Yang Ditambah

- **Panduan Kerja Claim**: tombol di pojok kanan section Daftar Claim
  (`showPanduan` state). Default collapsed. Saat dibuka menampilkan:
  - Urutan kerja 10 langkah.
  - Penjelasan 13 kolom tabel (grid 2 kolom).
  - Rumus (PPN Value, PPH Value, Nilai Klaim, Outstanding).
  - Troubleshooting (4 skenario).
  - Catatan penting (format Excel, zona Makassar, sync OFF).
- **Detail Claim panel** (expanded row inline): tombol "Detail" di
  kolom Aksi setiap row. Klik → row expand jadi `<tr colSpan=19>` di
  bawah row utama dengan:
  - Header: scope label + No Claim mono.
  - Ringkasan nilai: DPP / PPN / PPH / Nilai Klaim.
  - Dokumen 3 kartu (Letter / Summary / Kwitansi) dengan tombol Buka PDF
    + Generate / Regenerate (reuse R7c handler `generateSubmissionDocument`).
  - Summary pembayaran read-only: Total Paid / Outstanding / Status.
  - Helper note: pencatatan pembayaran principal + close masih lewat
    section workflow-level di bawah halaman.
  - Hanya satu row bisa expand sekaligus (state `excelDetailRowId`).

### Workflow-level Document Section

- Sekarang hanya muncul untuk **single-submission** workflow saja.
  Untuk multi-No-Claim, dokumen dikelola lewat tombol Detail per row.
- Helper amber multi-submission dihapus karena sudah ditangani lewat
  Detail panel inline.

### Backend tetap submission

- `claim_submission` tetap ada sebagai container No Claim di DB.
- `claim_submission.noClaim` tetap source-of-truth.
- Semua endpoint R7b/R7c/R7d/R7e/R7g/R7h tetap berfungsi — UI hanya
  berhenti memanggil endpoint POST submission (Buat Kelompok Manual).
- Endpoint POST submissions/from-items + PATCH submission noClaim +
  PATCH item tax + generate document tetap dipakai.

### Yang TIDAK diubah

- Schema database. Tidak ada ALTER/DROP/RENAME.
- Backend route. Endpoint generate dokumen, payment, close, reports —
  semua identik R7b–R7i.
- Business logic R7c/R7d/R7e/R7g.
- Section "Items" raw table di bawah, "Pembayaran Principal", "Close
  Workflow", dan "Audit" — tetap muncul untuk admin/claim. Asumsi:
  tidak dipindah ke per-row di R7j karena di luar scope yang
  diizinkan.
- PEKA / EC / CN tetap retired.
- R7f direct/manual source masih deferred.

### Test

Tidak ada test baru di R7j (perubahan murni presentational; backend
kontrak tidak berubah). Regression suite tetap dijalankan dan semua
hijau:
- `scripts/test-r7c-documents.mjs` — 88 PASS
- `scripts/test-r7d-submission-payments.mjs` — 41 PASS
- `scripts/test-r7e-close-reports.mjs` — 36 PASS
- `scripts/test-r7g-excel-no-claim.mjs` — 36 PASS
- `scripts/test-r7h-excel-input-mode.mjs` — 29 PASS

### Corrective pass (R7j-2)

Pass koreksi setelah review menunjukkan beberapa section teknis masih
mendominasi default view:

- **Hapus** section "No Claim per Baris" multi (`hasMultipleSubmissions ? ...`)
  + section "No Claim" single workflow-level. Editor No Claim sekarang
  hanya per-baris di kolom Daftar Claim + tombol Detail.
- **Hapus** section "Dokumen Klaim" workflow-level (sebelumnya hanya
  hidden untuk multi). Generate dokumen sekarang hanya lewat tombol
  Detail per baris claim.
- **Wrap** section "Items" raw table + "Pembayaran Principal" workflow-level
  + "Close Workflow" + "Audit" ke dalam satu collapsible card bertajuk
  **"Teknis / Riwayat"** (state `showTechnical`, default false). Klik
  toggle untuk membuka. Section ini fungsional tapi tidak terlihat
  default; dipertahankan supaya admin/claim tetap bisa pencatat
  pembayaran principal + close workflow + lihat audit log tanpa
  mengganggu staff yang fokus mengisi tabel BASE.
- **Rename** id anchor `paket-no-claim-section` → `daftar-claim-section`.
- **Rename** copy guidance: "X paket selesai" → "X baris selesai",
  "Buat paket pertama" → "Buat baris claim pertama", "Pilih paket"
  → "Pilih baris claim", "Close paket" → "Close baris", "Cek detail
  paket" → "Cek detail baris", confirm "Buat satu Paket No Claim..."
  → "Siapkan satu baris claim...".

Default page order final:
1. Header Ringkasan workflow.
2. Panel "Langkah Berikutnya".
3. Section **Daftar Claim** (heading + Panduan Kerja Claim collapsed +
   banner Siapkan Baris Claim + toolbar + tabel + Detail Claim panel).
4. Collapsible **Teknis / Riwayat** (Items / Pembayaran / Close /
   Audit, default tertutup).

Net file size: 4446 → 3183 baris (-1263).

---

## No PEKA — tetap retired

R7 tidak mengembalikan PEKA / PVT / EC / CN. Status legacy tersebut
hanya boleh muncul sebagai fallback display di UI lama (`isLegacyPekaStatus`,
`displayClaimStatusLabel`) untuk row DB yang masih menyimpannya.

---

## Referensi file

- `db/schema.ts` — definisi `claimSubmission` + kolom baru.
- `scripts/init-db.mjs` — DDL schema + ALTER tables.
- `scripts/migrate-r7a-default-submission.mjs` — backfill.
- `scripts/reset-data.mjs` — cleanup order termasuk `claim_submission`.
- `lib/claim-workflow/constants.ts` — `claimSubmissionScopes`,
  `claimSubmissionStatuses`, `claimWorkflowSourceTypes`,
  `claimAuditScopes`.
- `lib/claim-workflow/types.ts` — `ClaimSubmissionRow`.
- `lib/claim-workflow/submissions.ts` — pure helper
  `buildDefaultSubmissionFromWorkflow`.
- `lib/claim-workflow/index.ts` — re-export.
