# R7 Claim Workflow — Data Flow Scan + Simulation Report

Branch: `feat/r7-single-excel-claim-ui`
Date: 2026-05-29 (Asia/Makassar)
Scope: scan tabel + endpoint + UI page detail; simulasi end-to-end OFF → Claim
Workflow → No Claim → Dokumen → Pembayaran → Close.

---

## 1. Tabel & Relasi

| Tabel | Peran | Kolom kunci | Foreign key |
|-------|-------|------------|-------------|
| `off_batch` | Sumber pengajuan OFF | `id`, `no_pengajuan`, `om_status`, `final_status`, `locked` | — |
| `off_batch_item` | Baris item OFF | `id`, `batch_id`, `no_surat`, `nominal`, `no_claim` | `batch_id` → `off_batch.id` |
| `claim_workflow` | Container claim | `id`, `claim_workflow_no`, `off_batch_id`, `status`, `aggregate_status`, totals (cache), `no_claim` (legacy) | `off_batch_id` → `off_batch.id` |
| `claim_submission` | Unit No Claim (R7a) | `id`, `claim_workflow_id`, `scope` (`per_pengajuan` / `per_program` / `per_toko` / `per_item` / `custom`), `no_claim` (source-of-truth), totals, dokumen path | `claim_workflow_id` → `claim_workflow.id` |
| `claim_workflow_item` | Baris claim per item | `id`, `claim_workflow_id`, `claim_submission_id`, `dpp`, `ppn_rate`, `ppn_amount`, `pph_rate`, `pph_amount`, `nilai_klaim` | `claim_workflow_id`, `claim_submission_id`, `off_batch_item_id` |
| `claim_payment` | Pembayaran principal | `id`, `claim_workflow_id`, `claim_submission_id`, `payment_amount`, `voided_at` | `claim_workflow_id`, `claim_submission_id` |
| `claim_audit_log` | Append-only audit | `id`, `claim_workflow_id`, `claim_submission_id`, `audit_scope`, `action`, `from_status`, `to_status`, `note`, `metadata` | `claim_workflow_id` |

Source-of-truth `noClaim` ada di `claim_submission.noClaim`.
`claim_workflow.no_claim` di-mirror untuk single-submission (legacy/cache).

## 2. Status Flow (Production)

```
Draft → Need Revision (loop) → Ready to Submit → Submitted to Principal
      → Partially Paid → Paid → Closed
                         ↘ Outstanding (lewat deadline tanpa lunas)
                         ↘ Cancelled (manual)
```

Status legacy retired (R7 cleanup): `Waiting PEKA`, `EC Received`, `CN Received`,
`Waiting CN`, `EC Submitted`, `Report PEKA`. UI menampilkan via fallback
`displayClaimStatusLabel` tapi tidak diizinkan untuk transisi baru.

## 3. End-to-End Data Flow (Simulasi)

### Tahap 1 — OFF Approval (sebelum Claim)

1. Supervisor `POST /api/off-program-control/batches` create batch + items.
2. Sales Manager `POST .../sm-decision` approve → `sm_status=Approved by SM`,
   `locked=1`.
3. Claim review `POST .../claim-review` approve → `claim_status=Approved`,
   `om_status=Waiting Approval`.
4. OM `POST .../om-decision` approve → `om_status=Approved`,
   `finance_status=Waiting Payment`.
5. Finance `POST .../finance-payment` (partial → full) → `finance_status=Paid`,
   `final_status=Waiting Claim Final Verification`.

### Tahap 2 — Create Claim Workflow dari OFF (R7a/R7b)

Gate: `off_batch.om_status === "Approved"` (Phase R7 boundary; tidak harus
menunggu Finance Paid).

1. `POST /api/claim-workflow/from-off-batch` body `{ offBatchId }`.
2. Backend: insert `claim_workflow` + 1 default `claim_submission`
   (`scope=per_pengajuan`, `noClaim=null`) + 1 row `claim_workflow_item` per
   `off_batch_item`, dengan `claim_submission_id` di-link ke default
   submission.
3. Audit `create_from_off` ditulis `audit_scope=workflow`.

### Tahap 3 — Excel BASE Input Mode (R7g/R7h, default UI staff)

Halaman `app/(dashboard)/claim-workflow/[id]/page.tsx` post-R7j:

1. **Header ringkas** menampilkan total claim, paid, outstanding, jumlah
   No Claim.
2. **Panel Langkah Berikutnya** (`getWorkflowGuidance`) menyarankan aksi
   berikutnya berdasarkan state semua submission.
3. **Toolbar Daftar Claim**: search, filter, distributor (`SUPER`), principal
   (`GCPI`/`RB`/`KINO`/`MOTASA` via `guessPrincipalCode`), tahun, bulan default
   (Asia/Makassar).
4. **Tombol "Siapkan Baris Claim"** (banner amber) memanggil
   `POST /api/claim-workflow/[id]/submissions/from-items` mode `all_unassigned`.
   Setiap item klaim yang masih di submission `per_pengajuan` default
   dipindah ke submission baru `scope=per_item`. Idempotent.
5. **Tabel** menampilkan satu row per `claim_workflow_item`. Editable: DPP,
   PPN%, PPH%, No. Urut, Bulan Claim. Read-only (calculated): PPN Value,
   PPH Value, Nilai Klaim.

### Tahap 4 — Generate No Claim per Row (R7g pattern)

1. User isi No. Urut + Bulan Claim per row.
2. Klik **Generate** → preview `${seq}/${distributor}-${principal}/${MM}/${YYYY}`,
   contoh `01/SUPER-GCPI/05/2026`.
3. Klik **Simpan** → `PATCH /api/claim-workflow/[id]/submissions/[submissionId]`
   body `{ noClaim }`. Backend transaksi:
   - update `claim_submission.no_claim`, `no_claim_assigned_at`,
     `no_claim_assigned_by`.
   - sync ke semua `off_batch_item` yang berkaitan via `claim_workflow_item`.
   - tulis audit `no_claim_assigned` + `no_claim_synced_to_off`,
     `audit_scope=submission`.
4. Backend memvalidasi:
   - non-empty
   - unique global (partial unique index `idx_claim_workflow_no_claim_unique`).

### Tahap 5 — Inline Edit DPP/PPN/PPH (R7h)

1. Klik **Simpan** row → `PATCH /api/claim-workflow/[id]/items/[itemId]`
   body `{ dpp, ppnRate, pphRate }`.
2. Backend transaksi:
   - update `claim_workflow_item` (recompute ppnAmount, pphAmount,
     nilaiKlaim via `calculateClaimAmount`).
   - panggil `recalcSubmissionTotals(submissionId)` → re-derive
     `claim_submission` totals dari semua item.
   - panggil `recalcWorkflowAggregateFromSubmissions(workflowId)` → re-derive
     `claim_workflow.total_*` dari semua submission.
   - audit `update_item_tax`, `audit_scope=submission`.

### Tahap 6 — Generate Dokumen (R7c via Detail panel inline R7j)

User klik **Detail** di row → expanded row inline menampilkan 3 kartu
(Letter/Summary/Kwitansi). Generate:

1. `POST /api/claim-workflow/[id]/submissions/[submissionId]/{claim-letter|summary|receipt}`.
2. Backend memvalidasi:
   - admin/claim role.
   - status workflow ∈ `{Draft, Need Revision, Ready to Submit, Submitted to Principal}`.
   - submission `noClaim` non-empty.
   - submission `total_claim > 0`.
3. PDF di-render via `pdf-lib`, disimpan ke
   `runtime/claim-workflow/{workflowId}/submissions/{submissionId}/{type}/`.
4. Update `claim_submission.{type}_pdf_path` + `..._generated_at` +
   `..._generated_by`.
5. Audit `claim_letter_generated` / `claim_summary_generated` /
   `claim_receipt_generated`, `audit_scope=submission`.

### Tahap 7 — Mark Ready (R7b)

`POST /api/claim-workflow/[id]/status` action `mark_ready`. Gate:
- semua submission punya `noClaim` non-empty.
- semua submission punya 3 PDF (claimLetter, summary, receipt).
- semua submission punya `total_claim > 0`.
- setiap item DPP > 0 dan Nilai Klaim > 0.

Sukses → workflow `status="Ready to Submit"`. Audit `mark_ready` workflow-scope.

### Tahap 8 — Submit to Principal (R7b)

`POST .../status` action `submit_to_principal`.
Sukses → workflow `status="Submitted to Principal"`,
`submitted_to_principal_at=now`. Cascade ke semua submission. Audit
`submit_to_principal`.

### Tahap 9 — Pembayaran Principal per Submission (R7d)

1. `POST /api/claim-workflow/[id]/submissions/[submissionId]/payments` body
   `{ paymentDate, paymentAmount, paymentType?, paymentNote? }`.
2. Backend:
   - validasi: workflow status ∈ submitted/partial/paid, submission belum
     closed, `payment_amount > 0`, `payment_amount <= remainingAmount`
     (overpayment 409 `CLAIM_PAYMENT_OVERPAYMENT`), submission punya
     `noClaim`, `total_claim > 0`.
   - insert `claim_payment` row dengan `claim_submission_id` set.
   - panggil `recalcSubmissionPayment` → recalc `total_paid` dari sum
     payment aktif (`voided_at IS NULL`); set status:
     - `total_paid = 0` → `Submitted to Principal`
     - `total_paid >= total_claim` → `Paid`
     - else → `Partially Paid`
   - panggil `recalcWorkflowAggregateFromSubmissions` → derive
     `claim_workflow.total_paid` + `aggregate_status`.
   - audit `claim_payment_created`, `audit_scope=submission`.

Void payment: `POST .../payments/[paymentId]/void` body `{ reason }`.
- set `voided_at`, `voided_by`, `void_reason`.
- recalc submission + workflow aggregate.
- audit `claim_payment_voided`.

### Tahap 10 — Close per Submission (R7e)

`POST /api/claim-workflow/[id]/submissions/[submissionId]/close` body
`{ note }`. Gate:
- admin/claim only.
- submission status = `Paid`.
- `noClaim` non-empty.
- `total_claim > 0`.
- minimal 1 active payment.
- recalc `total_paid >= total_claim`.
- 3 PDF tersedia.
- belum closed/cancelled.
- `note` non-empty wajib.

Sukses → `claim_submission.status="Closed"`, `closed_at`, `closed_by`,
`close_note`. Workflow aggregate berubah jadi `Closed` saat semua submission
closed.

### Tahap 11 — Reports (R7e)

- `GET /api/claim-workflow/reports/summary` — semua workflow + submission.
- `GET /api/claim-workflow/reports/paid` — basis `claim_payment` aktif.
- `GET /api/claim-workflow/reports/outstanding` — `remainingAmount > 0`,
  `total_claim - total_paid` di-recalc fresh.
- Setiap report punya endpoint CSV `/export` (UTF-8 BOM, RFC 4180).

---

## 4. Frontend Page Detail (post-R7j)

Default render order setelah cleanup:

1. Header workflow ringkas.
2. Panel Langkah Berikutnya (warning/success).
3. Section **Daftar Claim**:
   - Tombol Panduan Kerja Claim (collapsible, default tertutup).
   - Banner Siapkan Baris Claim (saat ada item belum dipaketkan).
   - Toolbar (search/filter/distributor/principal/year/month).
   - Tabel BASE 19 kolom (1 row = 1 `claim_workflow_item`).
   - Detail panel inline (expanded row, max 1 row terbuka).
4. Card collapsible **Teknis / Riwayat** (default tertutup):
   - Items raw table + dropdown pemindahan submission (legacy R7b UI).
   - Pembayaran Principal workflow-level (form + history + void).
   - Close Workflow workflow-level.
   - Audit log.

Tidak ada lagi mode switcher, layout eksperimen, section "Paket No Claim",
form "Buat Paket No Claim Baru", section "Dokumen Klaim" workflow-level di
default view.

---

## 5. Observasi & Pain Points

### 5.1 Single source of truth conflict

`claim_workflow.no_claim` masih di-mirror untuk single-submission. Saat
multi-No-Claim, kolom ini bisa stale. Frontend post-R7j tidak menampilkannya
lagi, tapi audit + reports legacy mungkin masih membacanya.

**Mitigasi seed**: noClaim mirror selalu di-update saat seed bikin
single-submission workflow; multi-submission seed sengaja membiarkan
`claim_workflow.no_claim = null` agar drift terlihat.

### 5.2 Item assignment

Pemindahan item antar submission dilakukan via dropdown di tabel raw items
(masih di section Teknis / Riwayat). Saat seed multi-No-Claim, item dipisah
manual ke beberapa submission per_item dengan noClaim berbeda. Backend recalc
otomatis menjaga totals submission.

### 5.3 Generate dokumen di Detail panel inline

Gate generate dokumen (R7c) memvalidasi total > 0 + noClaim non-empty +
status di window `{Draft, Need Revision, Ready to Submit, Submitted to Principal}`.
Setelah submission `Closed`, generate ditolak `409`.

### 5.4 Outstanding vs Paid status

Status `Outstanding` di-set manual (audit `demo_seed_advance_status`) di seed
karena production tidak punya endpoint resmi untuk transisi otomatis ke
Outstanding (biasanya batch CRON). Demo: workflow yang lewat `submittedToPrincipalAt + 30d`
tanpa pembayaran ditandai `Outstanding`.

### 5.5 Sequence noClaim

Format Excel: `{seq}/{SUPER}-{principal}/{MM}/{YYYY}`. Sequence per principal
harus unique secara global (partial unique index). Seed memakai format
`{seq}/SUPER-{principal_code}/05/2026` dengan sequence lintas workflow agar
tidak duplikat.

---

## 6. Seed Baru — `scripts/seed-demo-r7-large.mjs`

Karakteristik:
- Prefix `BASE-OFF-*` dan `BASE/CLAIM/*` untuk membedakan dari seed lama.
- Cleanup idempotent untuk prefix `BASE-` (seed lama `DEMO-` tetap aman).
- 4 principal: RB, KINO, GDI (Godrej → GCPI), MOTASA.
- 8 status workflow × 4 principal × 1 = 32 single-submission workflow.
- 4 principal × 2 = 8 multi-No-Claim workflow (3-5 submission per_item per workflow).
- 12 OFF batch tambahan tanpa claim_workflow (siap dijadikan claim baru oleh user).
- Variasi: DPP 2-15 juta, PPN 0/11, PPH 0/2, paid fraction 0/30/50/75/100.
- Multiple payment row per submission untuk partial paid case.
- 3 PDF stub (Letter/Summary/Kwitansi) untuk semua submission selain Draft/Need Revision.

Total ekspektasi:
- ~52 OFF batch (40 sumber claim + 12 free).
- ~40 claim_workflow (32 single + 8 multi).
- ~64 claim_submission (32 default + 32 per_item).
- ~120-160 claim_workflow_item.
- ~50-100 claim_payment row (varied).
- ~250+ audit row.
- ~100-130 PDF stub di `runtime/claim-workflow/`.
