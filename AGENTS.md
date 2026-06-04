# AGENTS.md — OFF Program Control & Claim Workflow

Aturan bisnis dan aturan kerja untuk AI agent (Kilo / Claude / lainnya) yang
mengerjakan project ini. Wajib dibaca sebelum mengusulkan patch.

---

## 1. Konteks Project

Project ini adalah **web workflow internal kantor distribusi**.
Aplikasi ini **dipakai internal**, di belakang autentikasi, dan menjadi
sumber data untuk laporan akunting. Karena itu data integrity, audit
trail, dan kontrol akses adalah prioritas utama, bukan SEO atau estetika
landing page.

Project mengelola **dua workflow yang berurutan tapi terpisah**:

1. **OFF Program Control** (modul `off-program-control`)
   Pengajuan, review, approval internal, dan pembayaran internal atas
   program promosi/diskon. Sumber kebenaran: tabel `off_batch`,
   `off_batch_item`, `off_payment`, `off_audit_log`.

2. **Claim Workflow ke Principal** (modul `claim-workflow`)
   Penagihan klaim ke principal (DPP/PPN/PPh, nomor surat klaim, EC/CN
   dari principal). **Hanya boleh dibuat setelah OFF Batch selesai
   dibayar internal.** Sumber kebenaran: tabel `claim_workflow`,
   `claim_workflow_item`, `claim_payment`, `claim_audit_log`.

Kedua modul **tidak boleh dicampur** dalam satu patch tanpa alasan
eksplisit. Lihat 4.6.

---

## 2. Flow Status

Status di bawah ini diambil **persis** dari constants di kode. Jangan
mengarang status baru. Sumber:

- OFF: `lib/off-program-control/constants.ts` (`offStatuses`,
  `offFinanceStatuses`)
- Claim Workflow: `lib/claim-workflow/constants.ts`
  (`claimWorkflowStatuses`, `claimWorkflowOffRequirements`)

### 2A. OFF Program Control

`offBatch` punya beberapa kolom status yang bergerak paralel: `status`
(header), `smStatus`, `claimStatus`, `omStatus`, `financeStatus`,
`finalStatus`, plus boolean `locked`. Flow utamanya:

```
Draft
    ↓ (Supervisor submit)
Submitted to SM
    ↓ (Sales Manager approve)
Approved by SM
    ↓ (Claim review approve)
Claim Approved
    ↓ (Operational Manager approve)
OM Approved        →  financeStatus: Waiting Payment
    ↓ (Finance bayar)
Partial Paid / Paid
    ↓ (saat lunas)
finalStatus: Waiting Claim Final Verification
    ↓ (Claim final check)
Completed
```

Status return / cancel yang juga muncul di `offStatuses`:

- `Returned by SM` (Sales Manager return ke Supervisor)
- `Returned by Claim` (Claim return setelah Approved by SM)
- `Returned to Finance`
- `Cancelled by OM`

Status finance di `offFinanceStatuses`:
`Waiting Payment` → `Partial Paid` → `Paid` (dengan jalur `Need Correction`).

Status final di `finalStatus`:
`Not Started` → `Waiting Claim Final Verification` →
`Incomplete Documents` (opsional, return) → `Completed`.

### 2B. Claim Workflow ke Principal

`claim_workflow` baru boleh dibuat oleh role admin/claim **hanya jika** OFF
Batch sumbernya memenuhi `claimWorkflowOffRequirements`:

- `offBatch.omStatus === "Approved"` (status OM hasil approval di
  OFF Program Control)

Jadi Claim Workflow boleh disiapkan sejak OFF OM Approved, tidak perlu
menunggu Finance Paid + Final Completed. Hubungan ke OFF Completed
ditangani lewat **No Claim**, bukan lewat status sumber Claim Workflow.

#### No Claim utama

Phase R1 — Rewire OFF ↔ Claim No Claim:

- No Claim utama disimpan di `claim_workflow.noClaim` (kolom
  `no_claim`). Saat di-assign via `PATCH /api/claim-workflow/[id]/no-claim`
  oleh role admin/claim, transaksi yang sama men-sync nilai itu ke semua
  `off_batch_item.noClaim` pada OFF batch terkait. Empty string ditolak
  di backend; partial unique index
  `idx_claim_workflow_no_claim_unique` memastikan tidak ada dua
  Claim Workflow yang punya No Claim sama.
- Audit yang ditulis: `no_claim_assigned` dan `no_claim_synced_to_off`
  di `claim_audit_log`.
- Mark Ready (`mark_ready`) tetap wajib menulis Ready to Submit dan
  ditambah validasi: `noClaim` harus ada, `claimLetterPdfPath` harus ada,
  **`summaryPdfPath` harus ada (Phase R2)**, **`receiptPdfPath` harus ada
  (Phase R2)**, `totalClaim > 0`, dan setiap item DPP/Nilai Klaim > 0.
- Generate Claim Letter PDF kini diizinkan sejak Draft / Need Revision
  agar user bisa generate PDF dulu sebelum Mark Ready. Re-generate juga
  diizinkan saat Ready to Submit / Submitted to Principal.

#### Tiga Dokumen Klaim (Phase R2)

Claim Workflow harus menghasilkan tiga dokumen sebelum Ready to Submit.
Semuanya disimpan sebagai metadata kolom di `claim_workflow` (Option A,
bukan tabel `claim_workflow_document`):

- `claim_letter_pdf_path` + `claim_letter_generated_at` + `claim_letter_generated_by`
- `summary_pdf_path` + `summary_generated_at` + `summary_generated_by` (R2 baru)
- `receipt_pdf_path` + `receipt_generated_at` + `receipt_generated_by` (R2 baru)

File aktif:
- Claim Letter → `runtime/claim-workflow/letters/`
- Summary → `runtime/claim-workflow/summaries/`
- Kwitansi Claim → `runtime/claim-workflow/receipts/`

Aturan:
- Generate POST hanya admin/claim. GET/download mengikuti `canActorReadClaimWorkflow`.
- Window status untuk generate ketiga dokumen: `Draft`, `Need Revision`,
  `Ready to Submit`, `Submitted to Principal`.
- Kwitansi Claim **bukan** payment receipt dari principal. Tidak menunggu
  `claim_payment`. Dipasangkan dengan Claim Letter dan Summary saat
  paket dokumen klaim dikirim ke principal.
- `return_to_draft` menghapus dan invalidate ketiga dokumen secara
  atomic: file di disk dihapus best-effort, kolom path direset NULL,
  audit metadata berisi `invalidatedClaimLetterPdfPath`,
  `invalidatedSummaryPdfPath`, `invalidatedReceiptPdfPath`.
- Audit action baru: `claim_summary_generated`, `claim_receipt_generated`.

Future: tabel `claim_workflow_document` akan dipertimbangkan kalau
business minta full versioning/compliance lintas regenerate (saat ini
tidak ada).

#### OFF Completed butuh No Claim Claim Workflow

Route `final-claim` di OFF (`POST /api/off-program-control/batches/[id]/final-claim`,
action `complete`) sekarang menolak request bila salah satu kondisi
berikut belum terpenuhi (di samping rule existing seperti Finance Paid):

- Claim Workflow untuk OFF batch ini belum dibuat.
- `claim_workflow.noClaim` belum di-assign.
- Salah satu `off_batch_item.noClaim` belum tersinkron (NULL/empty).

UI OFF Final Claim sekarang menampilkan No Claim per item sebagai
read-only — input manual ditiadakan supaya tidak terjadi divergence
antara Claim Workflow dan OFF.

#### Status Claim Workflow

Setelah dibuat, `claimWorkflow.status` bergerak di antara nilai berikut
(dari `claimWorkflowStatuses`):

```
Draft
    ↓ (mark ready)
Ready to Submit
    ↓ (submit ke principal)
Submitted to Principal
    ↓ (input pembayaran principal — R3)
Partially Paid → Paid
    ↓
Closed (R4)
```

Status non-linear yang valid:

- `Need Revision` (kembali ke Draft untuk koreksi item/pajak).
- `Outstanding` (klaim lewat deadline tanpa dibayar lengkap).
- `Cancelled` (pembatalan eksplisit oleh admin).

Phase R3 — Principal Payment + Outstanding (Mei 2026):
- Pembayaran principal disimpan sebagai transaksi di `claim_payment`,
  bukan satu field flat. `totalPaid = sum(active payments)` dan
  `remainingAmount = max(totalClaim - totalPaid, 0)`.
- Status `Partially Paid` / `Paid` di-derive otomatis oleh route
  `POST /api/claim-workflow/[id]/payments` (dan diturunkan kembali oleh
  `POST .../payments/[paymentId]/void`). Status route umum (`mark_ready`,
  `return_to_draft`, `submit_to_principal`) tidak boleh dipakai untuk
  set `Partially Paid` / `Paid` secara manual supaya totals dan status
  tidak pernah drift.
- `Paid` hanya boleh ter-derive ketika `remainingAmount = 0` tepat; saldo
  Rp1 tetap `Partially Paid` agar dapat dilunasi dan kemudian di-close.
- Overpayment ditolak: `paymentAmount > remainingAmount` dijawab
  dengan code `CLAIM_PAYMENT_OVERPAYMENT`.

Phase R4 — Close Claim Workflow (Mei 2026):
- Transisi `Paid` → `Closed` hanya via endpoint dedicated
  `POST /api/claim-workflow/[id]/close`. Status route umum tidak boleh
  set `Closed` manual.
- Close gate (semua harus terpenuhi): actor admin/claim, status Paid,
  `noClaim` ada, `totalClaim > 0`, minimal 1 active payment, recalc
  `totalPaid >= totalClaim`, `remainingAmount = 0`, ketiga dokumen klaim
  PDF (Letter/Summary/Kwitansi) hadir, belum Closed/Cancelled, dan
  `note` non-empty wajib.
- Audit `claim_closed` ditulis dalam transaksi yang sama, lengkap dengan
  totalClaim/totalPaid/remainingAmount/noClaim/activePaymentCount/path
  ketiga PDF.
- Closed bersifat read-only untuk payment dan transition. Void payment
  ditolak setelah workflow Closed.
- Tidak butuh PEKA/EC/CN.

Phase R5 — Reporting / Export (Mei 2026):
- Endpoint JSON dan CSV untuk tiga laporan: Summary, Paid (transaction-
  based), Outstanding. Path `/api/claim-workflow/reports/<name>` dan
  `/api/claim-workflow/reports/<name>/export`.
- Outstanding report selalu menggunakan `remainingAmount = max(totalClaim
  - totalPaid, 0)` hasil recalc fresh dari `claim_payment` aktif. Tidak
  pernah trust cache buta.
- Status legacy PEKA/EC/CN tidak termasuk dataset atau filter laporan
  production; fallback tersebut hanya untuk menampilkan row DB lama.
- CSV: UTF-8 BOM, RFC 4180 escape, Content-Disposition attachment dengan
  pola filename `claim-<name>-report-YYYYMMDD.csv`. Angka raw tanpa
  format Rupiah supaya bisa dianalisa di Excel.
- UI `/claim-workflow/reports` menampilkan tab + filter ringan. Reports
  read-only, tidak ada PEKA/EC/CN.

Phase R7a — Multi No Claim + Direct Claim Source (Mei 2026, additive):
- Menambah tabel baru `claim_submission` sebagai container satu No Claim.
  Satu `claim_workflow` boleh punya banyak submission. Belum dipakai oleh
  route apapun di R7a — schema-only + backfill default submission per
  workflow lama.
- Kolom baru di `claim_workflow`: `source_type` (default `off_program`),
  `source_ref_id`, `aggregate_status`. Belum dipakai sebagai gate atau
  business logic; siap untuk R7e/R7f.
- Kolom baru (nullable) di `claim_workflow_item.claim_submission_id`,
  `claim_payment.claim_submission_id`,
  `claim_audit_log.{claim_submission_id, audit_scope}`.
- Backfill via `npm run migrate:r7a-submissions` atau
  `node scripts/migrate-r7a-default-submission.mjs`. Idempotent, single
  transaction, refuse non-lokal `DATABASE_URL`. Lihat
  `docs/R7_MULTI_NO_CLAIM_PLAN.md`.
- Source-of-truth No Claim akan pindah ke `claim_submission.noClaim`
  bertahap di R7b–R7e. `claim_workflow.noClaim` dipertahankan sebagai
  cache display selama transisi.
- R7f (direct kwitansi/manual source) **deferred**: butuh table rebuild
  SQLite untuk `claim_workflow.off_batch_id` → nullable. Tidak boleh
  dijalankan tanpa backup penuh + persetujuan bisnis.
- Tidak mengembalikan PEKA / PVT / EC / CN. Status legacy tetap retired.

Phase R7b — Submission grouping + item assignment (Mei 2026, additive):
- API CRUD submission: `GET/POST /api/claim-workflow/[id]/submissions`
  dan `GET/PATCH /api/claim-workflow/[id]/submissions/[submissionId]`,
  plus `POST /api/claim-workflow/[id]/submissions/[submissionId]/items`
  untuk memindahkan item antar submission. Read-access mengikuti
  `canActorReadClaimWorkflow`; write hanya admin/claim saat workflow
  `Draft` atau `Need Revision`.
- Helper baru di `lib/claim-workflow/submissions.ts`:
  `getOrCreateDefaultSubmission`, `recalcSubmissionTotals`,
  `recalcWorkflowAggregateFromSubmissions`,
  `assertSubmissionBelongsToWorkflow`,
  `isSubmissionEditableWorkflowStatus`.
- `PATCH /api/claim-workflow/[id]/items/[itemId]` (edit pajak) sekarang
  recalc submission totals + workflow aggregate dalam transaksi yang
  sama. Item yang belum punya `claim_submission_id` di-fallback ke
  default submission via helper idempotent.
- Legacy `PATCH /api/claim-workflow/[id]/no-claim` menolak request bila
  workflow punya >1 submission (`MULTI_SUBMISSION_NO_CLAIM_ROUTE_DISABLED`).
  Bila workflow punya tepat 1 submission, route tersebut juga mirror
  ke `claim_submission.noClaim` supaya source-of-truth submission tetap
  konsisten.
- Detail API `GET /api/claim-workflow/[id]` mengembalikan `submissions[]`,
  `submissionCount`, `hasMultipleSubmissions`, `noClaimList`,
  `noClaimDisplay`. Field workflow lama (noClaim, totals, PDF paths,
  payment) tidak diubah destruktif.
- UI claim-workflow detail menambah section "Claim Submissions / No
  Claim Groups" + dropdown Submission per item. Dokumen, payment, dan
  close masih workflow-level sampai R7c/R7d.
- Audit baru memakai kolom `claim_audit_log.claim_submission_id` +
  `audit_scope`. Audit lama R1-R6 tetap workflow-scope (NULL).
- Tidak menyentuh PEKA / PVT / EC / CN. Tidak menulis status manual ke
  Paid / Closed.

Phase R7c — Documents per submission (Mei 2026, additive):
- Endpoint baru `POST/GET /api/claim-workflow/[id]/submissions/[submissionId]/{claim-letter,summary,receipt}`
  generate dan stream PDF per submission. Items di-fetch dengan filter
  `claim_submission_id`, totals + noClaim di header PDF override pakai
  data submission. Audit action tetap `claim_letter_generated` /
  `claim_summary_generated` / `claim_receipt_generated` dengan metadata
  `submissionId`, `noClaim`, `itemCount`, `totalClaim`, `documentType`,
  `filePath`, `audit_scope = "submission"`.
- Path file di submission tree
  `runtime/claim-workflow/{workflowId}/submissions/{submissionId}/{type}/`.
  Folder utama selalu pakai `submissionId` (immutable). No Claim hanya
  jadi prefix filename setelah `slugifyNoClaim` di
  `lib/claim-workflow/document-paths.ts`. Path validator umum
  `isPathInsideClaimDocumentRoot` menerima legacy dir + submission tree.
- Constants baru di `lib/claim-workflow/constants.ts`:
  `claimDocumentTypes = { letter, summary, receipt }`.
- PDF generator (`generateClaimLetterPdf` / `generateClaimSummaryPdf` /
  `generateClaimReceiptPdf`) menerima optional `options.submission`.
  Bila disuplai, header + path memakai submission context. Tanpa
  submission → fallback ke pola workflow-level lama.
- Route legacy `POST /[id]/{claim-letter,summary,receipt}` menolak
  multi-submission dengan `MULTI_SUBMISSION_LETTER_ROUTE_DISABLED` /
  `MULTI_SUBMISSION_SUMMARY_ROUTE_DISABLED` /
  `MULTI_SUBMISSION_RECEIPT_ROUTE_DISABLED`. Single-submission tetap
  jalan, dengan mirror atomic ke `claim_submission.{type}PdfPath`.
- `POST /[id]/status` `return_to_draft` sekarang juga reset 3 PDF di
  setiap submission + unlink file (best-effort), supaya tidak ada PDF
  stale setelah balik ke Draft.
- Mark Ready / Close gate + reports tetap workflow cache di R7c. Akan
  pindah ke submission level di R7d/R7e.
- Tidak menyentuh OFF Program Control PDF generator.
- Tidak mengembalikan PEKA / PVT / EC / CN.

Status legacy `Waiting PEKA`, `EC Received`, dan `CN Received` sudah
**retired** (Mei 2026). Tidak boleh dipakai untuk transisi baru. Lihat
`docs/CLAIM_WORKFLOW_AI_CONTEXT.md` bagian "Cleanup PEKA / EC / CN" untuk
detail. UI menampilkan status legacy tersebut sebagai fallback
`Submitted to Principal` lewat `displayClaimStatusLabel` /
`isLegacyPekaStatus`.

### 2C. Aturan Transisi (Berlaku Untuk Kedua Workflow)

- Transisi hanya boleh **maju satu langkah** dari status saat ini, kecuali
  aksi `return` / `revisi` yang mengembalikan ke role/status sebelumnya.
- Setiap transisi **wajib divalidasi di backend** (route handler / API),
  bukan hanya di tombol UI.
- Setiap transisi **wajib menulis audit log** ke tabel yang sesuai
  (`off_audit_log` untuk OFF, `claim_audit_log` untuk Claim Workflow).
- Status final (`Completed` di OFF, `Closed` / `Cancelled` di Claim
  Workflow) bersifat final. Tidak boleh diubah lagi kecuali oleh `Admin`
  dengan alasan eksplisit dan tetap tercatat di audit log.

---

## 3. Role

Role berikut **terutama** berlaku untuk OFF Program Control. Mapping
role aktual diresolve di `lib/off-program-control/access.ts` (fungsi
`resolveOffRole`, `canPerformOffAction`).

| Role OFF              | Aksi yang diizinkan                                                 |
| --------------------- | ------------------------------------------------------------------- |
| Supervisor            | `create_batch`, `edit_returned_batch`, `submit_batch`               |
| Sales Manager         | `sm_approve`, `sm_return`                                           |
| Claim                 | `claim_review`, `claim_final`                                       |
| Operational Manager   | `om_approve`, `om_cancel`                                           |
| Finance               | `finance_payment`                                                   |
| Admin                 | Semua aksi di atas + maintenance master data, user, role, audit.    |

Aturan tambahan untuk **Claim Workflow ke principal** (lihat
`lib/claim-workflow/access.ts`):

- Pembuatan workflow dari OFF, edit pajak per item, dan transisi status
  hanya boleh dilakukan oleh role `admin` atau `claim`.
- Role lain dengan permission `claim_workflow.view` di RBAC modular hanya
  boleh melihat list/detail (read-only).
- Permission `claim_workflow.approve` di RBAC modular dipakai untuk akses
  audit Claim Workflow (manager-level read).

Aturan role umum:

- Satu user punya satu role primer. Multi-role hanya jika sudah ada
  desain eksplisit di codebase, jangan diasumsikan.
- Mapping role ke transisi status **harus dibaca dari kode/DB yang ada**
  (`lib/off-program-control/access.ts`, `lib/claim-workflow/access.ts`,
  `lib/rbac.ts`). Jangan mengarang. Kalau belum ada, tanyakan dulu
  sebelum membuat.
- Jangan pernah percaya `role` atau `userId` yang dikirim dari client
  body. Ambil dari session via `requireOffSession` /
  `requireClaimSession`.

---

## 4. Aturan Wajib (Hard Rules)

Aturan ini tidak boleh dilanggar oleh patch apa pun.

### 4.1 Keamanan & Permission

- **Permission wajib dicek di backend / API route**. Setiap handler yang
  mengubah status, mengedit field terkunci, atau mengakses data lintas
  cabang/tim, harus memvalidasi role + kepemilikan record di server.
- **Frontend hanya membantu UX**, bukan sumber keamanan. Menyembunyikan
  tombol di UI tidak menggantikan pengecekan di backend.
- Jangan pernah percaya `role` atau `userId` yang dikirim dari client body.
  Ambil dari session/auth context server-side.

### 4.2 Audit Log

- **Semua perubahan status wajib masuk audit log**, termasuk return/revisi
  dan koreksi oleh Admin.
- Tabel audit:
  - OFF → `off_audit_log` via helper `writeOffAudit`
    (`lib/off-program-control/data.ts`).
  - Claim Workflow → `claim_audit_log` via helper `writeClaimAudit`
    (`lib/claim-workflow/audit.ts`).
- Minimal field audit yang harus diisi: `batchId`/`claimWorkflowId`,
  `actorId`, `actorName`, `actorRole`, `action`, `fromStatus`, `toStatus`,
  `note` (wajib untuk return/revisi), `metadata` opsional, `createdAt`.
- Audit log **append-only**. Jangan pernah update atau delete row audit
  yang sudah ada.

### 4.3 Return / Revisi

- Setiap aksi `return` / `revisi` (mis. `sm_return`, `claim_return`,
  `om_cancel`, `return_to_draft` Claim Workflow) **wajib menyertakan
  alasan** (string non-kosong). Backend harus menolak request tanpa alasan.
- Khusus Claim Workflow `return_to_draft` (`Ready to Submit` → `Draft`):
  backend di `app/api/claim-workflow/[id]/status/route.ts` mengembalikan
  HTTP 400 dengan code `RETURN_TO_DRAFT_NOTE_REQUIRED` saat `note` kosong
  / blank. Alasan wajib karena aksi ini menginvalidasi Claim Letter PDF
  aktif dan membuka kembali tax editing per item; audit log harus
  mencatat sebabnya. UI detail page wajib prompt input alasan dan tolak
  blank sebelum hit API.
- Alasan return ikut tercatat di audit log (`note`) dan ditampilkan ke
  role sebelumnya supaya bisa diperbaiki.

### 4.4 Field Terkunci Setelah Approval

- Field yang sudah terkunci pada tahap tertentu **tidak boleh diedit**
  lagi melalui flow normal. Contoh:
  - Item OFF setelah `omStatus = Approved` (mengaktifkan
    `offBatch.locked = true`).
  - Nominal pembayaran setelah `financeStatus = Paid`.
  - Pajak/DPP/Nilai Klaim per item setelah Claim Workflow keluar dari
    status `Draft` / `Need Revision`.
- Koreksi hanya boleh dilakukan oleh `Admin` dengan jalur khusus dan
  tetap menulis audit log.
- Jangan menambahkan endpoint generic "update any field" tanpa
  pengecekan field-level dan status-level.

### 4.5 Integritas Kode

- **Jangan mengarang** nama file, nama field DB, nama table, nama route,
  atau nama helper. Kalau belum yakin, baca file dulu (Read / Grep / Glob)
  atau tanyakan.
- **Sebelum patch route, agent wajib membaca file route terkait
  end-to-end** (handler, helper di `lib/`, dan schema di `db/schema.ts`
  yang dipakai). Patch buta tanpa membaca file tidak diterima.
- **Kerjakan bertahap.** Selesaikan satu perubahan kecil, verifikasi,
  baru lanjut. Hindari mengubah banyak modul sekaligus.
- **Jangan refactor besar tanpa alasan** dan tanpa persetujuan. Refactor
  hanya boleh kalau memang dibutuhkan untuk menyelesaikan task, dan
  scope-nya disebutkan eksplisit.
- Ikuti konvensi codebase yang sudah ada (struktur folder, nama, style).
  Jangan memperkenalkan library baru tanpa alasan jelas.

### 4.6 Batas Modul OFF vs Claim Workflow

- Modul `off-program-control` dan `claim-workflow` **tidak boleh dicampur
  dalam satu patch** kecuali memang menyentuh boundary `from-off-batch`
  (pembuatan Claim Workflow dari OFF Batch yang sudah `omStatus = "Approved"`)
  atau sinkronisasi No Claim yang menjadi gate OFF final completion.
- Helper, status, dan tipe milik salah satu modul **tidak boleh
  diimport silang** ke modul lainnya, kecuali yang sudah ada di kode
  (mis. `ClaimActor` extends `OffActor`, `requireClaimSession` membungkus
  `requireOffSession`). Jangan membuat ketergantungan baru tanpa
  konfirmasi.
- Status OFF (mis. `Approved by SM`, `OM Approved`) **bukan** status
  Claim Workflow. Status Claim Workflow (mis. `Submitted to Principal`,
  `Partially Paid`, `Closed`) **bukan** status OFF. Jangan menyamakan.
- Audit OFF ditulis ke `off_audit_log`, audit Claim Workflow ditulis ke
  `claim_audit_log`. Jangan menulis audit Claim ke tabel OFF atau
  sebaliknya.

---

## 5. Format Jawaban Coding

Setiap kali agent memberikan patch atau perubahan kode, jawaban **wajib**
memuat lima bagian berikut, dalam urutan ini:

1. **Apa yang diubah**
   Ringkas perubahan dalam 1-3 kalimat. Sebut entitas/komponen yang
   tersentuh (mis. "menambahkan validasi role di route approve OM").

2. **Kenapa diubah**
   Alasan bisnis atau teknis. Hubungkan ke aturan di dokumen ini bila
   relevan (mis. "memastikan permission dicek di backend, sesuai 4.1").

3. **File yang disentuh**
   Daftar path file dengan format `path/to/file.ext` (boleh +
   `:line` untuk lokasi spesifik). Hanya cantumkan file yang benar-benar
   diubah.

4. **Risiko**
   Apa yang bisa rusak: regresi flow, dampak ke data lama, kompatibilitas
   role lain, kemungkinan migrasi DB, dampak performa. Tulis "Rendah" /
   "Sedang" / "Tinggi" + alasan singkat.

5. **Cara testing**
   Langkah verifikasi konkret: command build/test yang harus dijalankan,
   skenario manual per role (mis. "login sebagai Supervisor → submit
   draft → cek status berubah ke `Submitted to SM` dan audit log
   `off_audit_log` bertambah 1 row").

Kalau salah satu bagian benar-benar tidak relevan (mis. perubahan
dokumentasi murni), tetap tulis bagian itu dengan keterangan singkat,
jangan dihapus.

---

## 6. Default Behavior Agent

- Sebelum patch route: baca file handler target, helper di `lib/` yang
  dipakainya, dan schema di `db/schema.ts` yang relevan. Pastikan nama
  identifier sesuai kode nyata.
- Saat ragu antara dua interpretasi aturan bisnis: tanya dulu, jangan
  asumsi.
- Saat patch menyentuh status atau permission: kutip nama konstanta
  persis dari `lib/off-program-control/constants.ts` /
  `lib/claim-workflow/constants.ts` / `lib/rbac.ts`. Jangan paraphrase.
- Jangan mencampur modul `off-program-control` dan `claim-workflow` dalam
  satu patch kecuali memang menyentuh boundary `from-off-batch`.
- Jangan menjalankan perintah destruktif (drop table, reset DB,
  force push, hapus folder besar) tanpa permintaan eksplisit.
- Jangan commit otomatis. Commit hanya saat user memintanya.
