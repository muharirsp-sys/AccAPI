# SYSTEM_MAP.md
> Navigasi utama proyek — dibuat otomatis via trace-by-function/flow.
> Update file ini setiap kali ada modul baru atau perubahan arsitektur signifikan.

---

## Project Summary

**Tujuan:** ERP internal CV. Surya Perkasa — distributor yang mengelola biaya promosi off-program (OPC), klaim ke principal, pembayaran, SPPD, validasi data penjualan, dan integrasi Accurate ERP.

**Tech Stack Utama:**

| Layer | Teknologi |
|---|---|
| Frontend/API | Next.js 16 (App Router), React 19, TypeScript |
| Backend Sidecar | Python FastAPI (port 8000) |
| Database | SQLite via libSQL (`@libsql/client`) |
| ORM | Drizzle ORM + drizzle-kit |
| Auth | Better Auth 1.x (email/password, admin plugin, RBAC) |
| PDF | pdf-lib |
| Excel | xlsx |
| Email | nodemailer (SMTP) |
| Styling | Tailwind CSS 4 |
| State/Form | React Hook Form, Zod, TanStack React Table |
| Search (opsional) | Elasticsearch (fallback ke in-memory fuzzy) |
| ERP Eksternal | Accurate Online API (OAuth2 + proxy) |
| AI/OCR (opsional) | SumoPod API, OpenAI (Python backend) |

**Pola Arsitektur:**
- **Next.js App Router monorepo** — satu repo, dua runtime (Next.js + Python FastAPI).
- **Route Group** `(auth)` untuk halaman login/register, `(dashboard)` untuk seluruh halaman aplikasi yang dilindungi guard layout.
- Layer `lib/*` memisahkan business logic dari route handler.
- SQLite single-file sebagai database lokal (tidak cloud DB); opsi Turso/libSQL di production.
- RBAC tiga lapis: **Dynamic Permission-Group** (access_group + group_permission + user_group, default-deny) ∪ legacy **role global** (Better Auth) ∪ legacy **custom permissions** (user.permissions). Union resolver di `lib/rbac/resolve.ts`; sistem lama tetap berjalan selama transisi.
- Permission key format: `"module.action"` (mis. `"off_program_control.sm_approve"`). Sumber tunggal: `lib/rbac/registry.ts` (85 key). Endpoint wajib pakai `requirePermission`/`requirePermissionH` — key tidak terdaftar → 403.
- Email-domain role inference dihapus. OFF-specific role (`resolveOffRoleFromUser`) tetap ada untuk audit/state-machine, TIDAK untuk authz.

---

## Core Logic Flow (Function-Level Flowchart)

### 1. Autentikasi & Guard Halaman
```
Browser -> /login page
  -> app/(auth)/actions.ts [signIn(email, password)]
  -> lib/auth.ts [auth.api.signInWithEmailAndPassword]
  -> Better Auth + Drizzle SQLite (tabel user/session)
  -> Redirect /dashboard

Browser -> any /dashboard/* route
  -> app/(dashboard)/layout.tsx [DashboardLayout]
  -> lib/auth.ts [auth.api.getSession]
  -> lib/rbac.ts [canAccessPath(pathname, role, permissions)]  ← page-level (legacy)
  -> [OK] render SidebarLayout | [FAIL] redirect /login atau /

Browser -> any /api/* route (modul baru)
  -> requirePermission(request, "module.action")              ← API-level (baru)
     -> auth.api.getSession
     -> getUserPermissions(userId)                            ← lib/rbac/resolve.ts
        -> DB: user_group + group_permission (sistem baru)
        -> permissionMapForUser(role, permissions)            ← legacy union
     -> perms.has(key) ? proceed : 403
```

### 2. OFF Program Control — Buat & Submit Pengajuan
```
UI: OffProgramControlPage (tab supervisor)
  -> POST /api/off-program-control/batches
  -> batches/route.ts [POST]
     -> requireOffSession() — lib/off-program-control/helpers.ts
     -> canActorPerformOffAction(actor, "create_batch") — lib/off-program-control/access.ts
     -> getPrincipleByName() / findOffNoSuratConflicts() — lib/off-program-control/data.ts
     -> db.insert(offBatch) + db.insert(offBatchItem) — Drizzle SQLite
     -> writeOffAudit() — lib/off-program-control/helpers.ts
  <- { ok: true, batchId, noPengajuan }

UI: Supervisor submit batch
  -> POST /api/off-program-control/batches/[id]/submit
     -> canActorPerformOffAction(actor, "submit_batch")
     -> generateOffBatchPdf() — lib/off-program-control/pdf.ts [pdf-lib -> file system]
     -> db.update(offBatch, { status: "Submitted to SM" })
     -> writeOffAudit()
```

### 3. OFF Program Control — Approval Chain (SM → Claim → OM → Finance)
```
SM Approve:
  -> PATCH /api/off-program-control/batches/[id]/sm-approve
     -> canActorPerformOffAction(actor, "sm_approve")
     -> db.update(offBatch, { smStatus: "Approved by SM" })
     -> writeOffAudit()

Claim Review:
  -> PATCH /api/off-program-control/batches/[id]/claim-review
     -> canActorPerformOffAction(actor, "claim_review")
     -> db.update(offBatch, { claimStatus: "Approved" })
     -> writeOffAudit()

OM Approve:
  -> PATCH /api/off-program-control/batches/[id]/om-decision
     -> canActorPerformOffAction(actor, "om_approve")
     -> db.update(offBatch) + db.insert(claimWorkflow) [auto-create]
     -> writeOffAudit()

Finance Payment:
  -> POST /api/off-program-control/batches/[id]/finance-payment
     -> canActorPerformOffAction(actor, "finance_payment")
     -> canProcessFinancePayment(batch) — lib/off-program-control/workflow.ts
     -> db.insert(offPayment) + db.update(offBatch, { financeStatus })
     -> writeOffAudit()
```

### 4. Claim Workflow — Input, Dokumen, Pembayaran
```
UI: ClaimWorkflow detail page (/claim-workflow/[id])
  -> GET /api/claim-workflow/[id]
     -> requireClaimSession() — lib/claim-workflow/access.ts
     -> canActorReadClaimWorkflow(actor)
     -> db.select(claimWorkflow + items + payments + submissions)

Input item klaim:
  -> PATCH /api/claim-workflow/[id]/items/[itemId]
     -> validateClaimItem() — lib/claim-workflow/calculations.ts
     -> db.update(claimWorkflowItem)

Generate Surat Klaim (PDF):
  -> POST /api/claim-workflow/[id]/claim-letter
     -> buildClaimLetterPdf() — lib/claim-workflow/pdf.ts [pdf-lib]
     -> writeFile() ke runtime/claim-workflow/letters/
     -> db.update(claimWorkflow, { claimLetterPdfPath })

Record pembayaran dari principal:
  -> POST /api/claim-workflow/[id]/payments
     -> db.insert(claimPayment)
     -> recalculateTotals() -> db.update(claimWorkflow, { totalPaid, remainingAmount })
```

### 5. Accurate ERP Sync & Proxy
```
UI: API Wrapper page (/api-wrapper)
  -> POST /api/proxy
     -> route.ts [POST] — forward ke Accurate API (sessionHost + Bearer apiKey)
     <- JSON response

Idempotency guard (bulk sales receipt):
  -> POST /api/idempotency/lock — cek & kunci fingerprint di SQLite idempotency_log
  -> [bulk POST ke Accurate]
  -> POST /api/idempotency/complete — tandai selesai

Data Sync (item/customer):
  -> lib/sync.ts [syncModule(moduleName, endpoint, creds)]
     -> AccuratePaginator() — generator async + 150ms throttle per page
     -> db.insert(item|customer).onConflictDoNothing() — SQLite local cache
     -> db.update(syncState, { lastPage, status })
```

### 6. Python FastAPI Backend (Validator & Payments)
```
Browser -> NEXT_PUBLIC_FASTAPI_BASE_URL (port 8000)
  -> python_backend/main.py [FastAPI app]
     -> /payments/upload — parse Excel LPB/backup, simpan ke payments.json dengan lock dan konflik 409 jika restore menimpa data existing
     -> /payments/finance/data — data finance approval
     -> /payments/finance/proof — upload bukti transfer
     -> /validator/upload — upload data penjualan/channel
     -> /validator/run — validator_engine.py [compare expected vs actual]
     -> /sppd/generate — render_sppd_docx() — buat DOCX SPPD
     -> auth.py — RBAC + rate limiter login internal FastAPI
```

---

## Clean Tree

```
AccAPI/_github_clean/
├── app/
│   ├── (auth)/
│   │   ├── login/page.tsx
│   │   ├── register/page.tsx
│   │   ├── forgot-password/page.tsx
│   │   └── reset-password/page.tsx
│   ├── (dashboard)/
│   │   ├── layout.tsx                  # Auth guard + RBAC gate semua halaman dashboard
│   │   ├── page.tsx                    # Home/dashboard utama
│   │   ├── off-program-control/
│   │   │   └── page.tsx                # Cockpit OPC (SPV/SM/Claim/OM/Finance/Audit tabs)
│   │   ├── claim-workflow/
│   │   │   ├── page.tsx                # Daftar claim workflow
│   │   │   ├── [id]/page.tsx           # Detail + aksi per workflow
│   │   │   └── reports/page.tsx        # Laporan outstanding/paid
│   │   ├── payments/
│   │   │   ├── page.tsx
│   │   │   ├── cart/[draftId]/page.tsx
│   │   │   └── sppd/page.tsx
│   │   ├── api-wrapper/
│   │   │   ├── page.tsx                # UI proxy Accurate ERP
│   │   │   └── parsers/                # Parser bulk sales receipt
│   │   ├── finance/page.tsx
│   │   ├── summary/page.tsx
│   │   ├── validator/page.tsx
│   │   ├── principles/page.tsx
│   │   ├── admin/users/                # User management + legacy RBAC editor
│   │   └── admin/groups/               # Dynamic RBAC: kelola Access Group + permission + member
│   └── api/
│       ├── auth/
│       │   ├── [...all]/route.ts       # Better Auth catch-all handler
│       │   ├── callback/route.ts       # Accurate OAuth callback
│       │   ├── db-list/route.ts
│       │   └── open-db/route.ts
│       ├── off-program-control/
│       │   ├── batches/
│       │   │   ├── route.ts            # GET list + POST create
│       │   │   └── [id]/
│       │   │       ├── route.ts        # GET detail + PATCH edit
│       │   │       ├── submit/route.ts
│       │   │       ├── sm-approve/route.ts
│       │   │       ├── sm-return/route.ts
│       │   │       ├── claim-review/route.ts
│       │   │       ├── final-claim/route.ts
│       │   │       ├── om-decision/route.ts
│       │   │       ├── finance-payment/route.ts
│       │   │       ├── refund/route.ts
│       │   │       ├── pdf/route.ts
│       │   │       ├── kwitansi/route.ts
│       │   │       └── audit/route.ts
│       │   ├── periods/route.ts        # Tutup periode per principal
│       │   ├── principles/route.ts
│       │   ├── discount/route.ts
│       │   ├── payments/[paymentId]/proof/route.ts
│       │   └── audit/route.ts          # Export audit log OPC
│       ├── claim-workflow/
│       │   ├── route.ts                # GET list (paginated/cursor)
│       │   ├── [id]/
│       │   │   ├── route.ts
│       │   │   ├── items/[itemId]/route.ts
│       │   │   ├── payments/route.ts + [paymentId]/void/route.ts
│       │   │   ├── claim-letter/route.ts
│       │   │   ├── receipt/route.ts
│       │   │   ├── summary/route.ts
│       │   │   ├── status/route.ts
│       │   │   ├── close/route.ts
│       │   │   ├── no-claim/route.ts
│       │   │   ├── audit/route.ts
│       │   │   ├── documents/generate-all/route.ts
│       │   │   └── submissions/        # Multi No Claim (Phase R7+)
│       │   ├── from-off-batch/[offBatchId]/route.ts
│       │   ├── outstanding/route.ts
│       │   └── reports/                # outstanding/paid/summary (+ export)
│       ├── idempotency/
│       │   ├── lock/route.ts           # Kunci fingerprint bulk upload
│       │   └── complete/route.ts
│       ├── proxy/route.ts              # Proxy ke Accurate ERP API
│       ├── webhook/accurate/route.ts   # Terima webhook dari Accurate
│       └── admin/
│           ├── bootstrap/route.ts      # One-time admin setup
│           ├── users/permissions/route.ts
│           └── groups/
│               ├── route.ts            # GET list + POST create Access Group
│               └── [id]/
│                   ├── route.ts        # GET detail + PATCH sync perms + DELETE
│                   └── members/route.ts # POST add / DELETE remove user dari group
├── components/
│   ├── SidebarLayout.tsx               # Shell navigasi dashboard
│   ├── DataTable.tsx                   # TanStack Table reusable
│   ├── PWAInstallPrompt.tsx
│   ├── ServiceWorkerRegistration.tsx
│   ├── ThemeSwitcher.tsx
│   ├── off-program-control/
│   │   ├── OffBreadcrumb.tsx
│   │   ├── OffGlobalSearch.tsx
│   │   └── OffNotificationBell.tsx
│   └── ui/                             # Input, Select, DatePickerField, AsyncSearchSelect
├── lib/
│   ├── auth.ts                         # Konfigurasi Better Auth server
│   ├── auth-client.ts                  # Better Auth client (browser)
│   ├── rbac.ts                         # RBAC legacy (union layer selama transisi)
│   ├── rbac/
│   │   ├── registry.ts                 # PERMISSION_REGISTRY — sumber tunggal 87 key
│   │   ├── resolve.ts                  # getUserPermissions, requirePermission/H, resolveRequestPermissions/H
│   │   └── registry.test.ts            # Self-check: integritas registry + scan route.ts
│   ├── db.ts                           # Drizzle client singleton
│   ├── email.ts                        # nodemailer sendEmail
│   ├── sync.ts                         # AccuratePaginator + syncModule
│   ├── apiFetcher.ts                   # Fetch helper client-side
│   ├── fuzzySearch.ts
│   ├── pdf-text.ts                     # uppercasePageText helper PDF
│   ├── off-program-control/
│   │   ├── index.ts                    # Re-export barrel
│   │   ├── access.ts                   # resolveOffRole, canPerformOffAction
│   │   ├── workflow.ts                 # canProcessFinancePayment, computeBatchProgress
│   │   ├── data.ts                     # getBatchWithItems, findOffNoSuratConflicts
│   │   ├── helpers.ts                  # requireOffSession, writeOffAudit, publicBatch
│   │   ├── payments.ts                 # computeOffPaymentSummary, computeOffFinancePaymentSummary
│   │   ├── pdf.ts                      # buildPdf (pengajuan OFF) + kwitansi
│   │   ├── reconciliation-pdf.ts       # PDF rekonsiliasi periode
│   │   ├── constants.ts                # offPrinciples, offFinanceStatuses, dll
│   │   ├── types.ts                    # OffBatchRow, OffItemRow, dll
│   │   ├── program-type.ts             # OFF_PROGRAM_TYPES, resolveProgramType
│   │   ├── search.ts                   # matchesSearch, buildSearchHaystack
│   │   ├── problematic.ts              # Validasi problem-code / item bermasalah
│   │   └── holidays.ts                 # Kalender hari libur nasional (deadline calc)
│   └── claim-workflow/
│       ├── index.ts                    # Re-export barrel
│       ├── access.ts                   # requireClaimSession, canActorReadClaimWorkflow
│       ├── calculations.ts             # Hitung DPP/PPN/PPh/nilaiKlaim
│       ├── audit.ts                    # writeClaimAudit
│       ├── pdf.ts                      # buildClaimLetterPdf (surat klaim)
│       ├── pdf-summary.ts              # buildClaimSummaryPdf
│       ├── pdf-receipt.ts              # buildClaimReceiptPdf
│       ├── reports.ts                  # Query laporan outstanding/paid
│       ├── submissions.ts              # Helper Multi No Claim (Phase R7a+)
│       ├── document-paths.ts           # Path builder dokumen klaim per submission
│       ├── no-claim-rules.ts           # Validasi aturan No Claim
│       ├── off-finance-gate.ts         # Gate: OPC harus lunas sebelum klaim tutup
│       ├── constants.ts                # Status list, label, dll
│       └── types.ts                    # ClaimWorkflowRow, ClaimSubmissionRow, dll
├── db/
│   └── schema.ts                       # Satu file Drizzle schema (semua tabel)
├── python_backend/
│   ├── main.py                         # FastAPI app — validator, payments, SPPD, finance
│   ├── auth.py                         # Auth + rate limiter Python backend
│   ├── payments.py                     # Template row builder untuk Excel
│   ├── validator_engine.py             # Engine validasi data penjualan vs diskon
│   ├── principle_matcher.py            # Fuzzy matcher nama principal
│   └── ui_templates.py                 # HTML UI templates (server-rendered)
├── scripts/
│   ├── init-db.mjs                     # Inisialisasi tabel SQLite pertama kali
│   ├── migrate-local.mjs               # Migrasi lokal (dev)
│   ├── migrate-opc-columns.mjs         # Migrasi kolom OPC
│   ├── seed-opc-dummy.mjs              # Seed 1.275 dummy batch OPC (testing)
│   └── test-r7*.mjs                    # Test script Phase R7 claim workflow
├── config/                             # Konfigurasi static (principles, dll)
├── public/                             # Static assets, icons, SW
├── .env.example                        # Template env lengkap
├── .env.local                          # Env lokal aktif (tidak di-commit)
├── drizzle.config.ts                   # Drizzle kit config (schema + output migrations)
├── next.config.ts                      # Next.js config
├── docker-compose.yml                  # Deploy: frontend + backend container
├── Dockerfile.frontend
├── Dockerfile.backend
└── proxy.ts                            # Dev proxy config
```

---

## Module Map (The Chapters)

### Auth & Session

| File | Fungsi Utama | Peran |
|---|---|---|
| `lib/auth.ts` | `auth` (betterAuth instance) | Konfigurasi server auth: email/password, admin plugin, SQLite adapter, email reset/verify |
| `lib/auth-client.ts` | `authClient` | Client-side Better Auth hooks untuk browser |
| `lib/rbac.ts` | `canAccess`, `canAccessPath`, `permissionMapForUser`, `normalizeRole` | RBAC legacy: preset per role, custom per-user — masih aktif sebagai legacy union layer |
| `lib/rbac/registry.ts` | `PERMISSION_REGISTRY`, `allPermissionKeys`, `isValidPermissionKey` | **Sumber tunggal** 85 permission key (`module.action`). Zero import — pure data. Test-guard scan semua route.ts saat CI |
| `lib/rbac/resolve.ts` | `getUserPermissions`, `requirePermission`, `requirePermissionH`, `resolveRequestPermissions`, `resolveRequestPermissionsH` | Union resolver: DB group + legacy role/permissions. Guard endpoint default-deny. `requirePermissionH` untuk route pakai `next/headers` |
| `lib/rbac/registry.test.ts` | self-check script | Validasi integritas registry + scan semua route.ts: gagal jika ada key tidak terdaftar. Jalankan: `node --experimental-strip-types lib/rbac/registry.test.ts` |
| `app/(dashboard)/layout.tsx` | `DashboardLayout` | Guard semua halaman dashboard: session check + RBAC path check |
| `app/(dashboard)/admin/users/` | `UserManagement` | UI kelola user internal, set role, set legacy custom permission |
| `app/(dashboard)/admin/groups/` | `GroupManagement` | **UI Dynamic RBAC**: buat/edit Access Group, assign permission key per group, assign user ke group |
| `app/api/auth/[...all]/route.ts` | Better Auth catch-all | Mount semua endpoint auth Better Auth |
| `app/api/admin/bootstrap/route.ts` | `POST` | One-time setup akun admin pertama via token |
| `app/api/admin/groups/route.ts` | `GET`, `POST` | List + buat Access Group; gate: `users.manage` |
| `app/api/admin/groups/[id]/route.ts` | `GET`, `PATCH`, `DELETE` | Detail + sync permission + hapus group; tulis `permission_audit_log` |
| `app/api/admin/groups/[id]/members/route.ts` | `POST`, `DELETE` | Assign/remove user dari group; tulis `permission_audit_log` |

### OFF Program Control (OPC)

| File | Fungsi Utama | Peran |
|---|---|---|
| `lib/off-program-control/access.ts` | `resolveOffRole`, `getOffAccessibleTabs`, `canPerformOffAction` | Resolver role OPC domain-specific (7 role: admin/SPV/SM/claim/OM/finance/sales) |
| `lib/off-program-control/helpers.ts` | `requireOffSession`, `writeOffAudit`, `publicBatch`, `buildNoPengajuan` | Session resolver OPC, audit writer, serializer output batch |
| `lib/off-program-control/workflow.ts` | `canProcessFinancePayment`, `computeBatchProgress`, `hasMinimalFinalChecklist` | Guard transisi status workflow OPC |
| `lib/off-program-control/data.ts` | `getBatchWithItems`, `findOffNoSuratConflicts`, `isOffPeriodClosedForBatch` | Query compound batch+items, validasi duplikat No Surat, cek tutup periode |
| `lib/off-program-control/payments.ts` | `computeOffPaymentSummary`, `computeOffFinancePaymentSummary` | Kalkulasi total tunai/transfer, sisa bayar, status lunas |
| `lib/off-program-control/pdf.ts` | `buildPdf`, `generateOffBatchPdf`, `generateOffKwitansiPdf` | Cetak PDF pengajuan OPC (summary + kwitansi) via pdf-lib |
| `lib/off-program-control/reconciliation-pdf.ts` | `generateReconciliationPdf` | PDF rekonsiliasi periode per principal |
| `app/api/off-program-control/batches/route.ts` | `GET`, `POST` | Daftar + buat batch OPC (filter periode, search Elasticsearch/lokal) |
| `app/api/off-program-control/batches/[id]/route.ts` | `GET`, `PATCH` | Detail + revisi batch |
| `app/api/off-program-control/batches/[id]/submit/route.ts` | `POST` | Submit ke SM, generate PDF |
| `app/api/off-program-control/batches/[id]/sm-approve/route.ts` | `POST` | Persetujuan SM |
| `app/api/off-program-control/batches/[id]/claim-review/route.ts` | `POST` | Review & approve Claim |
| `app/api/off-program-control/batches/[id]/finance-payment/route.ts` | `POST` | Input pembayaran Finance |
| `app/api/off-program-control/batches/[id]/refund/route.ts` | `POST` | Submit refund kelebihan bayar |
| `app/(dashboard)/off-program-control/page.tsx` | `OffProgramControlPage` + tab components | Cockpit OPC full — semua role, semua tab, form/tabel per role |

### Claim Workflow

| File | Fungsi Utama | Peran |
|---|---|---|
| `lib/claim-workflow/access.ts` | `requireClaimSession`, `canActorReadClaimWorkflow`, `canActorWriteClaimWorkflow` | Resolver session klaim, gate baca/tulis workflow |
| `lib/claim-workflow/calculations.ts` | `calcClaimItemTotals`, `recalcWorkflowTotals` | Hitung DPP/PPN/PPh/nilaiKlaim per item dan agregasi workflow |
| `lib/claim-workflow/pdf.ts` | `buildClaimLetterPdf` | Generate surat klaim ke principal (pdf-lib) |
| `lib/claim-workflow/pdf-summary.ts` | `buildClaimSummaryPdf` | Generate rekapitulasi klaim (pdf-lib) |
| `lib/claim-workflow/pdf-receipt.ts` | `buildClaimReceiptPdf` | Generate kwitansi penerimaan klaim (pdf-lib) |
| `lib/claim-workflow/reports.ts` | `getOutstandingReport`, `getPaidReport`, `getSummaryReport` | Query laporan klaim (outstanding/paid/summary) |
| `lib/claim-workflow/submissions.ts` | `createDefaultSubmission`, `backfillDefaultSubmission` | Helper Multi No Claim: satu workflow bisa banyak submission |
| `lib/claim-workflow/document-paths.ts` | `buildSubmissionDocumentFilePath` | Resolver path file dokumen per submission |
| `lib/claim-workflow/no-claim-rules.ts` | `validateNoClaimAssignment` | Validasi aturan bisnis penugasan No Claim |
| `lib/claim-workflow/off-finance-gate.ts` | `checkOffFinanceGate` | Gate: OPC harus sudah Paid sebelum klaim bisa Close |
| `app/api/claim-workflow/route.ts` | `GET` | Daftar workflow (cursor pagination, filter status/principal) |
| `app/api/claim-workflow/[id]/route.ts` | `GET`, `PATCH` | Detail + update workflow |
| `app/api/claim-workflow/[id]/claim-letter/route.ts` | `POST`, `GET` | Generate + serve PDF surat klaim |
| `app/api/claim-workflow/[id]/payments/route.ts` | `GET`, `POST` | Daftar + tambah pembayaran dari principal |
| `app/api/claim-workflow/[id]/submissions/` | routes | Multi-submission: CRUD + dokumen per submission (Phase R7+) |
| `app/api/claim-workflow/reports/` | routes | Laporan + export Excel outstanding/paid/summary |

### Accurate ERP Integration

| File | Fungsi Utama | Peran |
|---|---|---|
| `lib/sync.ts` | `AccuratePaginator`, `syncModule` | Sync paginated data Accurate ke SQLite lokal (item/customer) dengan checkpoint |
| `app/api/proxy/route.ts` | `POST` | Forward request ke Accurate API (autentikasi + payload flattening) |
| `app/api/auth/callback/route.ts` | `GET` | OAuth2 callback dari Accurate (tukar code ke token) |
| `app/api/webhook/accurate/route.ts` | `POST` | Terima event webhook dari Accurate (IP whitelist + simpan log) |
| `app/(dashboard)/api-wrapper/page.tsx` | UI | Antarmuka manual query/bulk-submit ke Accurate |
| `app/(dashboard)/api-wrapper/parsers/` | `parsePurchaseReturnBulkSave` | Parse Excel ke payload bulk API Accurate |

### Python FastAPI Backend

| File | Fungsi Utama | Peran |
|---|---|---|
| `python_backend/main.py` | FastAPI app (~60 route) | Validator data penjualan, payments management dengan lock request payments.json + konflik 409, SPPD DOCX generation, finance approval |
| `python_backend/validator_engine.py` | `extract_pdf_text_safe`, `read_upload_file_limited` | Engine ekstraksi & validasi data (PDF/Excel) |
| `python_backend/payments.py` | `lpb_upload_template_rows`, `validator_*_template_rows` | Template row builder untuk Excel upload |
| `python_backend/principle_matcher.py` | `find_best_match`, `normalize_principle_name` | Fuzzy matching nama principal antar dataset |
| `python_backend/auth.py` | `LoginRateLimiter`, `build_security_headers` | Rate limiter login + security headers Python backend |
| `python_backend/ui_templates.py` | `inject_world_class_ui` | HTML UI untuk halaman server-rendered Python backend |

### Idempotency & Utilities

| File | Fungsi Utama | Peran |
|---|---|---|
| `app/api/idempotency/lock/route.ts` | `POST` | Kunci fingerprint bulk upload sales receipt (cegah submit ganda) |
| `app/api/idempotency/complete/route.ts` | `POST` | Tandai idempotency key selesai diproses |
| `lib/fuzzySearch.ts` | `fuzzySearch` | Pencarian fuzzy in-memory fallback |
| `lib/pdf-text.ts` | `uppercasePageText` | Uppercase teks untuk header PDF |
| `lib/off-program-control/holidays.ts` | `isHoliday`, `getNextWorkday` | Kalender hari libur untuk kalkulasi deadline |

---

## Data & Config

### Env Config
- **`.env.example`** — template lengkap semua variabel (tidak mengandung secret)
- **`.env.local`** — env aktif lokal (tidak di-commit ke git)

**Variabel kunci:**

| Variabel | Fungsi |
|---|---|
| `DATABASE_URL` | Path SQLite (`file:sqlite.db` lokal / `file:/app/data/sqlite.db` Docker) |
| `BETTER_AUTH_URL` / `BETTER_AUTH_SECRET` | Base URL + secret Better Auth |
| `NEXT_PUBLIC_APP_URL` | URL publik Next.js (browser) |
| `NEXT_PUBLIC_FASTAPI_BASE_URL` | URL Python backend (browser) |
| `ACCURATE_CLIENT_ID` / `ACCURATE_CLIENT_SECRET` | OAuth2 Accurate |
| `ADMIN_SETUP_TOKEN` | Token one-time bootstrap admin pertama |
| `SMTP_*` | Konfigurasi email (host/port/user/pass/from) |
| `SUMOPOD_API_KEY` | AI/OCR backend (opsional) |

### Skema Data (Tabel Inti & Relasi)

```
user ──────────────────────────── session (userId)
  │                                account (userId)
  │                                verification
  │
  └─ [auth only, tidak FK ke domain]

off_batch ──── off_batch_item (batchId)
  │        ├── off_payment (batchId)
  │        ├── off_refund (batchId)
  │        ├── off_notification (batchId)
  │        └── off_audit_log (batchId)
  │
  └─────────── off_period_closure (principleCode + bulan + tahun)

off_discount_submission ─── off_discount_audit_log (submissionId)

claim_workflow (offBatchId -> off_batch.id) [1:1 unique]
  ├── claim_workflow_item (claimWorkflowId)
  ├── claim_payment (claimWorkflowId)
  ├── claim_audit_log (claimWorkflowId)
  └── claim_submission (claimWorkflowId) [1:N, Phase R7+]
        ├── claim_workflow_item.claimSubmissionId
        └── claim_payment.claimSubmissionId

sync_state [checkpoint per modul]
item [cache Accurate items]
customer [cache Accurate customers]
idempotency_log [fingerprint bulk upload]

# Dynamic RBAC (additive — Fase 2/4; user.role & user.permissions TIDAK dihapus)
access_group ──── group_permission (group_id)   [permission_key = "module.action"]
  └──────────── user_group (group_id + user_id)  [akses user = UNION group]
permission_audit_log [siapa ubah group/permission siapa, kapan]
```

**Status Lifecycle offBatch:**
`Draft -> Submitted to SM -> [Returned by SM] -> Approved by SM -> Claim Approved -> Ready for OM -> Approved by OM -> Waiting Payment -> Partial Paid -> Paid -> [Cancelled / Cancelled by OM]`

**Status Lifecycle claimWorkflow:**
`Draft -> In Progress -> Submitted -> Paid -> Partially Paid -> Closed / Overpaid`

### Migrasi & Seed

| File | Fungsi |
|---|---|
| `scripts/init-db.mjs` | Buat semua tabel SQLite dari schema (dev pertama kali) |
| `scripts/migrate-local.mjs` | Jalankan migrasi drizzle-kit lokal |
| `scripts/migrate-opc-columns.mjs` | Migrasi tambahan kolom OPC |
| `db/migrations/` | Output drizzle-kit (SQL migration files) |
| `scripts/seed-opc-dummy.mjs` | 1.275 batch dummy OPC (51 batch x 25 principal, semua 12 problem code) |
| `scripts/migrate-rbac-groups.mjs` | Buat tabel Dynamic RBAC (access_group, group_permission, user_group, permission_audit_log) — additive & idempotent |
| `scripts/seed-rbac-presets.ts` | Seed 11 Access Group preset + backfill user_group dari user.role (`node --experimental-strip-types`) — backward-compat, idempotent |

### Output & Runtime Artifacts

| Path | Isi |
|---|---|
| `sqlite.db` | Database SQLite utama (+ WAL/SHM) |
| `runtime/off-program-control/` | PDF pengajuan OPC |
| `runtime/claim-workflow/` | PDF surat klaim, summary, kwitansi, per-submission |
| `runtime_logs/` | Log runtime (dipakai Python backend) |
| `webhook_events.log` | Log event webhook Accurate (append-only) |

---

## External Integrations

| Service | Tipe | Modul Pemangil |
|---|---|---|
| **Accurate Online ERP** | REST API (OAuth2, Bearer token) | `lib/sync.ts`, `app/api/proxy/route.ts`, `app/api/auth/callback/route.ts` |
| **Accurate Webhook** | Inbound HTTP POST (IP whitelist) | `app/api/webhook/accurate/route.ts` |
| **SMTP Email** | Outbound (nodemailer) | `lib/email.ts` <- `lib/auth.ts` (reset/verifikasi) |
| **Elasticsearch** (opsional) | REST search index | `lib/off-program-control/search.ts` <- `app/api/off-program-control/batches/route.ts` |
| **SumoPod AI / OpenAI** (opsional) | LLM/OCR API | `python_backend/main.py` (validator + dokumen) |

---

## Insentif Sales — Kalkulasi Insentif

Dua model insentif hidup berdampingan, dipisah oleh `channel`:

| Model | Berlaku | Logic | File |
|---|---|---|---|
| **Strata-DB** (4 KPI: Value/EC/AO/IA, rata-rata) | channel non-GT | `lookupTierFromDb` (tabel `incentive_tiers`, nominal per jenjang %) | `lib/insentif-sales.ts` |
| **Konstanta-bobot** (2 KPI: AO 70% + Value 30%) | channel **GT** | `computeExclusive` / `computeMix` (pure) | `lib/insentif-sales-calc.ts` |

Konstanta-bobot (GT):
- Pengali %: `<0.90→0`, `0.90–1.00→aktual`, `>1.00→cap 1.00`. Target AO konstan **240**.
- Distributor bayar = `konstanta − total_support` (floor 0), split 70/30 × pencapaian.
- **Exclusive** (1 principle): konstanta 1jt. **Mix** (n principle): 2=1jt, 3=1.2jt, 4=1.4jt, 5=1.5jt (cap). Value mix global → dialokasikan proporsional `target_value` per principle.
- **Status Insentif** (`distributor_principle`/`distributor`/`principle`): hanya 2 pertama ikut skema & masuk count; `principle` (full principle, mis. Motasa/Heinz) tidak dihitung. **Tipe Sales** (`mix`/`exclusive`) di kolom target.
- Kolom DB: `sales_targets.tipe_sales`, `sales_targets.status_insentif`. Support per `salesCode+principle+period` di tabel **`incentive_support`** (diisi Finance saat payout).

Alur: target Excel (kolom Tipe Sales + Status Insentif, kunci upsert `salesCode+principle+period`) → `dashboard/route.ts` (GT pakai calc baru, non-GT strata; achievement 4-KPI tetap untuk semua) → Finance input support (`/api/insentif-sales/support`) → dashboard hitung ulang.

Self-check: `node --experimental-strip-types lib/insentif-sales-calc.test.ts` (Case 1 exclusive=300rb, Case 2 mix=500rb sebagai angka acuan).

---

## Risks / Blind Spots

| Area | Catatan |
|---|---|
| **Python backend integrasi Next.js** | Tidak ada shared session antar Next.js dan FastAPI. FastAPI punya auth sendiri (`auth.py`); sinkronisasi user hanya via filesystem/env, bukan DB shared. |
| **Elasticsearch optional** | Jika env tidak di-set, search fallback ke in-memory fuzzy. Perilaku ini tidak eksplisit diuji di test script. |
| **PPh HOLD** | Kolom PPh disiapkan di schema tapi perhitungan final ditahan (`// PPh HOLD` tersebar di beberapa file). Belum aktif secara bisnis. |
| **Phase R7 (Multi No Claim)** | Fitur `claim_submission` tabel (R7a+) masih dalam rollout bertahap. Phase R7b-R7k tercakup di `scripts/test-r7*.mjs` tapi belum semua route production-ready. |
| **Webhook Accurate IP whitelist** | Kode whitelist ada tapi baris `return 403` dikomentari. Di production, IP filtering harus diaktifkan manual. |
| **`config/`** | Folder berisi data statik (principles, dll) — tidak ter-trace penuh karena bukan TypeScript eksportabel; kemungkinan JSON/YAML. |
| **`runtime/` path** | Direktori file PDF dibuat dinamis saat runtime. Tidak ada cleanup otomatis; bisa membesar di production jika tidak ada cron/purge. |
| **`app/(dashboard)/finance/page.tsx`** | Memanggil Python FastAPI backend langsung via `NEXT_PUBLIC_FASTAPI_BASE_URL`. Jika backend mati, halaman finance tidak berfungsi. |
| **Docker vs dev** | `drizzle.config.ts` hardcode `file:sqlite.db` (bukan env). Perlu disesuaikan jika path container berbeda dari root. |
| **`rekprinciple.xlsx`** | File Excel di root — tidak jelas apakah dipakai runtime atau hanya referensi manual. |
