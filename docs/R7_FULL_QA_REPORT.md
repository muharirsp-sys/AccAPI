# R7 Full QA Report — Claim Workflow Staff Excel Mode

## 1. Executive Summary

**FAIL / HOLD** *(see Status Update below — partially resolved)*

Core R7 data flow secara backend cukup kuat: automated scripts R7h/R7g/R7c/R7d/R7e pass, seed R7 large sukses, API list/detail/report/export sukses, No Claim per row, tax formula, dokumen per submission, payment per submission, close per submission, dan create Claim from OFF tervalidasi lewat API.

Namun QA menemukan **RBAC blocker**: akun `staff` yang seharusnya read-only berhasil melakukan mutasi backend pada workflow Draft (`PATCH item tax`, `POST submissions/from-items`, dan `POST status` masuk ke validasi bisnis, bukan ditolak 403). Selain itu UI detail masih memiliki wiring legacy untuk payment/close workflow-level yang akan gagal untuk multi-No-Claim.

### Status Update (2026-06-02)

| Bug ID | Severity | Status | Notes |
|--------|----------|--------|-------|
| R7QA-001 (RBAC staff mutasi) | BLOCKER | **PARTIALLY FIXED** | Commit `5851fe6` adds `isReadOnly` flag for staff UI. Server-side 403 enforcement on all mutating routes still needs separate verification. |
| R7QA-002 (Payment UI legacy route) | HIGH | **OPEN** | UI `submitPayment` still calls `/api/claim-workflow/${id}/payments` (workflow-level), which returns 409 for multi-submission. No per-submission payment UI wired yet. |
| R7QA-003 (Close UI legacy route) | HIGH | **OPEN** | UI `submitClose` still calls `/api/claim-workflow/${id}/close` (workflow-level), which returns 409 for multi-submission. No per-submission close UI wired yet. |
| R7QA-004 (Staff terminology) | MEDIUM | **OPEN** | Technical terms (`claim_submission.noClaim`) still leak in staff-facing copy. |
| R7QA-005 (Default submission count) | MEDIUM | **FIXED** | Commit `234fe3c` adds `isActiveSubmission` filter; `submissionCount` no longer includes empty defaults. |

**Phase 1 blocker fixes** (4 commits: `fecaad6`, `68da8cb`, `234fe3c`, `5851fe6`) address R7QA-001 UI-side and R7QA-005 completely. See `PHASE1_FIX_SUMMARY.md` for full change log.

**Recommendation revised**: HOLD verdict now driven by R7QA-002/003 (payment/close UI wiring) rather than R7QA-001.

## 2. Environment

- Branch: `feat/r7-single-excel-claim-ui`
- Commit: `ec7b6fc chore(claim-workflow): add R7 data-flow report and demo seed`
- Dev URL: `http://localhost:3000`
- Login utama QA: `admin@local.test` role `admin`
- RBAC user QA: `staff@local.test` role `staff`
- Seed used: `node scripts/seed-demo-r7-large.mjs`
- DB backup: `sqlite-backup-before-r7-full-qa-20260602-112723.db`
- Browser automation: **NOT AVAILABLE**. Browser plugin failed with sandbox runtime error `windows sandbox failed: spawn setup refresh`; QA continued with HTTP/API checks and static UI inspection.

Seed summary:

- OFF batches: 56
- OFF batches free: 12
- Workflow single-submission: 36
- Workflow multi-submission: 8
- Total submissions: 68
- Total claim items: 158
- PDF stub: 180
- Claim payment rows: 52

## 3. Automated Validation

| Command | Result | Notes |
|---|---:|---|
| `git branch --show-current` | PASS | `feat/r7-single-excel-claim-ui` |
| `git status --short` | PASS | Clean before report creation |
| `npm.cmd exec tsc -- --noEmit --pretty false` | PASS | No diagnostics |
| `node --check scripts/init-db.mjs` | PASS | No syntax error |
| `node --check scripts/seed-demo-r7-large.mjs` | PASS | No syntax error |
| `node scripts/test-r7h-excel-input-mode.mjs` | PASS | 29/29 pass |
| `node scripts/test-r7g-excel-no-claim.mjs` | PASS | 36/36 pass |
| `node scripts/test-r7c-documents.mjs` | PASS | 88/88 pass |
| `node scripts/test-r7d-submission-payments.mjs` | PASS | 41/41 pass |
| `node scripts/test-r7e-close-reports.mjs` | PASS | 36/36 pass |
| `node scripts/init-db.mjs` | PASS | `SQLite tables are ready` |
| `node scripts/seed-demo-r7-large.mjs` | PASS | Seed R7 large completed |

## 4. Browser QA Matrix

| Area | Action/Button | Expected | Actual | Result | Severity | Notes |
|---|---|---|---|---|---|---|
| Claim Workflow List | Load `/claim-workflow` unauthenticated | Redirect/login required | 307 to login observed earlier; `/login` 200 | PASS | LOW | HTTP check, not visual browser |
| Claim Workflow List | API list workflows | BASE workflows visible | `GET /api/claim-workflow?limit=100` 200, target workflows found | PASS | LOW | Count 54 after prior non-BASE demo rows |
| Claim Workflow List | Reports link | Opens reports page | Reports API and export work; visual click NOT TESTED | PARTIAL | LOW | Browser unavailable |
| Claim Workflow List | Search/filter buttons | UI filters list without crash | Static code has tabs/status groups; visual interaction NOT TESTED | NOT TESTED | LOW | Browser unavailable |
| Detail Header | Open BASE multi detail | Detail returns workflow/items/submissions | `GET /api/claim-workflow/[id]` 200 for BASE-CLAIM-037/041 | PASS | LOW | API verified |
| Detail Header | Old mode switchers absent | No Master Detail/Accordion/Kartu/Fokus/Status Board in visible UI | Static code comments still mention old layouts, no active mode switcher labels found in rendered logic | PASS/PARTIAL | LOW | Visual NOT TESTED |
| Detail Header | No staff-facing technical terms | No `Submission` / `claim_submission` in main UI | UI copy includes technical text: `claim_submission.noClaim di backend` | FAIL | MEDIUM | Staff-facing copy leak |
| Toolbar | Search | Search by No Claim/outlet/random | Static code filters `excelSearch`; visual behavior NOT TESTED | NOT TESTED | LOW | Browser unavailable |
| Toolbar | Filter status | all/needs_no_claim/needs_docs/outstanding/paid/closed | Static code implements filters | PARTIAL | LOW | API data supports statuses |
| Toolbar | Distributor/Principal/Tahun/Bulan | Preview follows toolbar; no auto-save | Static code builds row draft; API save tested separately | PARTIAL | LOW | Browser unavailable |
| Toolbar | Siapkan Baris Claim | Creates per-item rows; idempotent | First call 201 `created=2`; second call 201 `created=0`, `skipped=2` | PASS | LOW | API verified |
| Toolbar | Refresh | Reloads data | `loadDetail()` wired to Refresh; dirty draft warning NOT TESTED | PARTIAL | MEDIUM | Potential UX risk: draft loss not browser-tested |
| Daftar Claim table | Required columns | No/DPP/PPN/PPH/Dokumen/Paid/Outstanding/Status/Aksi visible | Static code includes key columns; exact width/readability NOT TESTED | PARTIAL | LOW | Browser unavailable |
| Daftar Claim table | Horizontal scroll/readability | Usable on desktop | NOT TESTED | NOT TESTED | LOW | Browser unavailable |
| No Claim | Generate format | `01/SUPER-GCPI/05/2026` style | Automated R7g/R7h generator tests pass | PASS | LOW | UI click NOT TESTED |
| No Claim | Save manual No Claim | Backend accepts unique non-empty string | PATCH submission 200, sync item count 1 | PASS | LOW | API verified |
| No Claim | Empty No Claim | Rejected clearly | 400 `CLAIM_SUBMISSION_NO_CLAIM_EMPTY` | PASS | LOW | API verified |
| No Claim | Duplicate No Claim | Rejected clearly | 409 `CLAIM_SUBMISSION_NO_CLAIM_DUPLICATE` | PASS | LOW | API verified |
| No Claim | Multi workflow legacy noClaim | Legacy route disabled | Automated/static route coverage; multi-specific PATCH route works | PASS | LOW | API verified indirectly |
| DPP/PPN/PPH | Formula save | DPP 100000, PPN 11, PPH 15 => 96000 | PATCH item 200, PPN 11000, PPH 15000, claim 96000 | PASS | LOW | API verified |
| DPP/PPN/PPH | Invalid negative DPP | Reject | 400, clear message | PASS | LOW | API verified |
| DPP/PPN/PPH | Invalid PPN 150 | Reject | 400, clear message | PASS | LOW | API verified |
| DPP/PPN/PPH | Staff cannot edit | 403 expected | Staff PATCH Draft item returned 200 | FAIL | BLOCKER | RBAC escalation |
| Dokumen | Generate Letter/Summary/Kwitansi per row | Submission-specific PDF paths | All 3 POSTs 200, paths contain `submissions` | PASS | LOW | API verified |
| Dokumen | Open PDF | `application/pdf`, non-404 | GET claim-letter 200, PDF bytes returned | PASS | LOW | API verified |
| Dokumen | Legacy route on multi | 409, no workflow-level misuse | POST legacy claim-letter 409 `MULTI_SUBMISSION_LETTER_ROUTE_DISABLED` | PASS | LOW | API verified |
| Payment | Overpay | 409 `CLAIM_PAYMENT_OVERPAYMENT` | Got 409 expected code | PASS | LOW | API verified |
| Payment | Submission payment | 201 and remaining updates | POST per-submission payment 201 | PASS | LOW | API verified |
| Payment | Void payment | Recalc after void | Void cleanup 200, remaining restored | PASS | LOW | API verified |
| Payment | Legacy payment on multi | Should not be used by UI; backend 409 | Legacy payment returned 409 `MULTI_SUBMISSION_PAYMENT_ROUTE_DISABLED` | FAIL/PARTIAL | HIGH | UI `submitPayment` still points to workflow-level route |
| Outstanding | Per-row remaining | Uses submission active payments | API detail/report values consistent | PASS | LOW | API/DB verified |
| Close | Close not-paid | Reject | 409 `CLAIM_CLOSE_NOT_PAID` | PASS | LOW | API verified |
| Close | Close without note | Reject note empty | Covered by R7e script; target 041 has no paid sub | PASS/PARTIAL | LOW | Automated test pass |
| Close | Legacy close on multi | Should not be used by UI; backend 409 | Legacy close returned 409 `MULTI_SUBMISSION_CLOSE_ROUTE_DISABLED` | FAIL/PARTIAL | HIGH | UI `submitClose` still points to workflow-level route |
| Panduan | Collapsed by default | Collapsed | Static code `showPanduan=false` | PASS | LOW | Visual NOT TESTED |
| Panduan | Content staff-friendly | Explains quick flow | Content covers Siapkan/Generate/DPP/Dokumen/Outstanding; technical text elsewhere still leaks | PASS WITH ISSUE | MEDIUM | Static inspection |
| Reports | Summary JSON | Per submission rows | 200, rows returned | PASS | LOW | API verified |
| Reports | Paid JSON/export | Transaction rows + CSV | 200, CSV filename `claim-paid-report-20260602.csv` | PASS | LOW | API verified |
| Reports | Outstanding JSON/export | Outstanding rows + CSV | 200, CSV filename `claim-outstanding-report-20260602.csv` | PASS | LOW | API verified |
| OFF to Claim | Create from free OFF | Workflow + default submission created | 201, `defaultSubmissionId` present, detail has subs=1/items=2 | PASS | LOW | API verified |
| RBAC | Staff read-only | Staff can view, cannot mutate | Staff can mutate Draft workflow | FAIL | BLOCKER | API verified |
| Console | No browser console errors | No React/hydration/runtime warnings | NOT TESTED | NOT TESTED | MEDIUM | Browser automation unavailable |
| Network | No 500 normal flow | 2xx success / 4xx expected validation | No 500 observed in API simulations | PASS | LOW | HTTP/API verified |

## 5. Bugs Found

### R7QA-001

- Severity: **BLOCKER**
- Area: RBAC / Claim Workflow API
- Steps:
  1. Login as `staff@local.test`.
  2. Open Draft workflow `BASE-CLAIM-001-RB` via API detail.
  3. Call `PATCH /api/claim-workflow/[id]/items/[itemId]` with DPP/PPN/PPH.
  4. Call `POST /api/claim-workflow/[id]/submissions/from-items`.
  5. Call `POST /api/claim-workflow/[id]/status` action `mark_ready`.
- Expected: All mutating actions return `403` because staff is read-only.
- Actual:
  - Detail response: `canEditItems=True`, `canGenerateClaimLetter=True`.
  - Staff tax PATCH returned `200`.
  - Staff `submissions/from-items` returned `201`.
  - Staff `mark_ready` did not return 403; it reached business validation and returned `422 CLAIM_WORKFLOW_NO_CLAIM_REQUIRED`.
- Evidence:
  - `STAFF_LOGIN role=staff`
  - `DRAFT_STAFF canEdit=True canGen=True status=Draft`
  - `STAFF_DRAFT_PATCH_TAX status=200`
  - `STAFF_PREP status=201`
  - `STAFF_MARK_READY status=422`
- Suggested fix: Audit `requireClaimSession` / actor role resolution and every Claim Workflow mutating route. Ensure backend checks use actual persisted `user.role`, not inferred OFF role, and ensure staff/viewer receives 403 before business validation.

### R7QA-002

- Severity: **HIGH**
- Area: Payment UI / Multi-No-Claim
- Steps:
  1. Open multi workflow such as `BASE-CLAIM-041-RB`.
  2. Static inspect detail page handlers.
  3. API test legacy workflow payment route on multi workflow.
- Expected: Staff row Detail uses `POST /api/claim-workflow/[id]/submissions/[submissionId]/payments`.
- Actual:
  - UI handler `submitPayment` still calls `/api/claim-workflow/${id}/payments`.
  - Backend correctly rejects legacy route on multi workflow with `409 MULTI_SUBMISSION_PAYMENT_ROUTE_DISABLED`.
  - Row Detail panel shows payment summary, but no per-row payment input was found in static UI section.
- Evidence:
  - Static: `app/(dashboard)/claim-workflow/[id]/page.tsx` fetch at legacy `/payments`.
  - API: `LEGACY_PAY_MULTI status=409 code=MULTI_SUBMISSION_PAYMENT_ROUTE_DISABLED`.
- Suggested fix: Add per-row/submission payment controls in row Detail and wire to submission-level route. Hide/disable legacy workflow payment controls for multi workflows.

### R7QA-003

- Severity: **HIGH**
- Area: Close UI / Multi-No-Claim
- Steps:
  1. Open multi workflow such as `BASE-CLAIM-041-RB`.
  2. Static inspect close handler.
  3. API test legacy close on multi workflow.
- Expected: Close action per row uses `POST /api/claim-workflow/[id]/submissions/[submissionId]/close`.
- Actual:
  - UI `submitClose` still calls `/api/claim-workflow/${id}/close`.
  - Backend correctly rejects legacy close on multi with `409 MULTI_SUBMISSION_CLOSE_ROUTE_DISABLED`.
  - Row Detail panel did not show a per-submission close control in static inspection.
- Evidence:
  - Static: `app/(dashboard)/claim-workflow/[id]/page.tsx` close fetch at `/close`.
  - API: `LEGACY_CLOSE_MULTI status=409 code=MULTI_SUBMISSION_CLOSE_ROUTE_DISABLED`.
- Suggested fix: Add per-row close UI and wire to submission close endpoint; keep workflow-level close only for single-submission compatibility or technical/admin panel with clear warning.

### R7QA-004

- Severity: **MEDIUM**
- Area: Staff UI terminology
- Steps:
  1. Static inspect `app/(dashboard)/claim-workflow/[id]/page.tsx`.
  2. Check staff-facing copy around Daftar Claim.
- Expected: No technical terms like `claim_submission` / internal schema names in staff UI.
- Actual: Visible copy includes `claim_submission.noClaim di backend; UI staff memakai istilah...`.
- Evidence: Static match around Daftar Claim text.
- Suggested fix: Replace with plain business language, e.g. "No Claim disimpan per baris klaim".

### R7QA-005

- Severity: **MEDIUM**
- Area: Siapkan Baris Claim / count display
- Steps:
  1. Use `BASE-CLAIM-001-RB` (Draft single-submission, 2 items).
  2. POST `submissions/from-items`.
  3. Reload detail.
- Expected: Two claim rows ready and count display not misleading.
- Actual:
  - First call created 2 per-item submissions.
  - Detail after prep: `submissionCount=3`, `hasMultipleSubmissions=True`.
  - The original default submission remains empty, so header metric "Jumlah No Claim" can overcount compared with real item rows.
- Evidence:
  - `PREP1 created=2`
  - `DETAIL_AFTER_PREP subs=3 multiple=True`
  - `noClaimDisplay=Multiple No Claim (2)`
- Suggested fix: Either exclude empty default submissions from staff-facing count or convert/delete/archive empty default after per-item conversion if business allows.

## 6. UX Issues

- Staff-facing UI still leaks backend naming (`claim_submission.noClaim`) in copy.
- "Teknis / Riwayat" is intentionally collapsed, but still contains raw/legacy workflow-level sections that may confuse staff if opened.
- Payment and close are described in row Detail guidance, but static UI inspection found summary/status display, not clear per-row action controls.
- `Siapkan Baris Claim` is idempotent, but after converting single workflow to per-item rows, the empty default submission may make "Jumlah No Claim" misleading.
- Browser visual width/readability could not be verified; table is large and likely needs visual QA on real browser before approval.
- Refresh dirty-draft behavior could not be verified visually; if draft inputs are discarded silently, staff may lose unsaved No Claim/tax edits.

## 7. Not Tested

- Browser click-by-click visual QA: Browser runtime unavailable in sandbox (`windows sandbox failed: spawn setup refresh`).
- DevTools console warnings: NOT TESTED due browser runtime failure.
- Hydration/React key warnings: NOT TESTED due browser runtime failure.
- Real visual table width, horizontal scroll, dark-mode contrast, row height: NOT TESTED due browser runtime failure.
- CSV downloaded file opening in Excel: API response/header tested, actual Excel open NOT TESTED.
- Manual button clicks for search/filter/open detail/reports: static/API equivalent tested, visual clicks NOT TESTED.
- Valid close of a paid row in seeded `BASE-CLAIM-041-RB`: target workflow has all rows `Partially Paid`; close behavior covered by automated R7e script and API reject cases.

## 8. Data Consistency Check

Targeted DB checks after QA actions:

- Duplicate `claim_submission.no_claim`: none found.
- `claim_workflow_item.claim_submission_id IS NULL`: 0 rows.
- Submission totals vs sum assigned items: 0 mismatches.
- Workflow totals/payment/remaining vs sum submissions/active payments for BASE/CLM-BASE data: 0 mismatches.

Key action evidence:

- No Claim save synced 1 OFF item.
- Duplicate No Claim returned 409 and did not create duplicate.
- Document generation wrote submission-specific paths and legacy multi route returned 409.
- Payment overpay returned 409.
- Create from OFF created default submission and linked items immediately.

## 9. Recommendation

**HOLD**

Do not approve for staff-facing production until RBAC is fixed. Data flow and R7 backend mechanics look healthy, but read-only staff mutating Draft workflows is a release blocker.

## 10. Next Fix Plan

1. Fix Claim Workflow RBAC so `staff` / view-only users cannot call mutating routes:
   - `PATCH /api/claim-workflow/[id]/items/[itemId]`
   - `POST /api/claim-workflow/[id]/submissions/from-items`
   - `PATCH /api/claim-workflow/[id]/submissions/[submissionId]`
   - document generation routes
   - payment/void/close/status routes
2. Add regression tests for staff role expecting 403 before business validation.
3. Wire multi workflow payment UI to `POST /api/claim-workflow/[id]/submissions/[submissionId]/payments`.
4. Wire multi workflow close UI to `POST /api/claim-workflow/[id]/submissions/[submissionId]/close`.
5. Remove staff-facing technical schema text (`claim_submission`) from UI copy.
6. Adjust "Jumlah No Claim" / empty default submission display after `Siapkan Baris Claim`.
7. Repeat visual browser QA on a local browser session to verify table width, disabled states, console warnings, and actual clicks.

## Generate No Claim Fix Check

- Root cause: handler `Generate` di row Daftar Claim membangun No Claim dari draft render lokal dan validasi ad-hoc. Patch dibuat agar klik Generate selalu membaca draft row terbaru, memakai helper `validateNoClaimGenerator` + `buildNoClaimPreview`, lalu menulis `sequence`, `month`, dan `noClaimDraft` sekaligus ke state row.
- File changed: `app/(dashboard)/claim-workflow/[id]/page.tsx`.
- Validation:
  - `npm.cmd exec tsc -- --noEmit --pretty false`: PASS.
  - `node scripts/test-r7h-excel-input-mode.mjs`: PASS, 29/29.
  - `node scripts/test-r7g-excel-no-claim.mjs`: PASS, 36/36.
- Manual/browser result: NOT TESTED. In-app browser gagal start di environment ini dengan error Windows sandbox; dev server lama sudah memegang port 3000, dan attempt server baru tertahan lock `.next/dev/lock`.
- Remaining issues: RBAC staff mutation blocker, payment legacy UI, close legacy UI, copy teknis staff-facing, dan count default submission kosong masih belum disentuh pada fix ini.

## Staff View Mode A/B Check

- Opsi A behavior: default `Simple`; header ringkas, switch tampilan, Daftar Claim tetap menjadi fokus utama, panel Detail Claim hanya muncul setelah klik tombol `Detail` pada row.
- Opsi B behavior: mode `Dengan Berkas Claim` menampilkan section ringkas `Berkas Claim` di atas Daftar Claim. Satu Berkas Claim dijelaskan sebagai satu No Claim; cards menampilkan No Claim, item, total claim, dokumen X/3, paid, outstanding, dan status.
- Count aktif vs submission kosong: header memakai `Baris Claim`, `No Claim Aktif`, dan `Berkas Aktif`. Submission kosong tidak masuk count aktif; mode B menampilkan jumlah berkas kosong yang diabaikan dan card muted bila tetap ada di data.
- Detail Claim: panel bersama untuk dua mode sekarang menampilkan Ringkasan Baris Claim, Berkas Claim, No Claim, DPP/PPN/PPH/Nilai Klaim, dokumen, payment summary, outstanding, dan status close tanpa raw submission id.
- Validation:
  - `npm.cmd exec tsc -- --noEmit --pretty false`: PASS.
  - `node scripts/test-r7h-excel-input-mode.mjs`: PASS, 29/29.
  - `node scripts/test-r7g-excel-no-claim.mjs`: PASS, 36/36.
- Manual/browser result: NOT TESTED. In-app browser masih gagal start di environment Windows sandbox, sehingga switch UI dan click Generate belum bisa diverifikasi visual dari sini.
