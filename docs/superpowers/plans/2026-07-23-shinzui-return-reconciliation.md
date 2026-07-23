# Shinzui Return Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mengaktifkan rekonsiliasi divisi Return untuk SHINZUI dengan dua upload, master mapping internal, pencocokan invoice+produk+pelanggan, qty exact, dan toleransi DPP Rp1.

**Architecture:** Tambahkan engine Return murni yang memakai parser XLSX/mapping yang sudah terbukti tanpa mengubah kontrak Faktur. Route baru tetap memakai handler upload generik. Halaman yang sama memilih endpoint dan copy berdasarkan divisi, sementara Pembelian tetap pasif.

**Tech Stack:** Next.js 16 App Router, TypeScript, React 19, `xlsx`, Playwright, handler multipart yang sudah ada.

## Global Constraints

- Kerjakan pada branch `main` lokal yang sudah diizinkan user; jangan push atau mengubah GitHub.
- User mengunggah tepat dua XLSX: Accurate dan PenjualanInvoice principal.
- Master mapping disimpan di `data/reconciliation/SHINZUI.xlsx` dan sheet `Fix Mapping` menjadi sumber mapping.
- Accurate hanya Retur Penjualan; principal hanya `RETUR`; semua `PROMO` diabaikan.
- Key adalah invoice `INVGTS...` dari REM + kode produk mapped + kode pelanggan.
- Kuantitas dibandingkan exact setelah absolut; DPP dibandingkan dengan toleransi absolut Rp1.
- Pajak/total sesudah pajak tidak menentukan status.
- Jangan memakai tanggal sebagai key.
- Sampel nyata harus menghasilkan 11 MATCH, qty 29, DPP Rp361.351,3503.
- Tidak ada dependency baru, histori, persistence hasil, atau refactor di luar jalur rekonsiliasi.

---

### Task 1: Pure Return Engine and Master Mapping

**Files:**
- Create: `lib/off-program-control/return-reconciliation.ts`
- Create: `lib/off-program-control/shinzui-return-validation.test.ts`
- Create: `data/reconciliation/SHINZUI.xlsx` (copy persis workbook mapping yang diberikan user)

**Interfaces:**
- Consumes: XLSX buffers; `parseShinzuiMappings` mapping contract from `sales-reconciliation.ts` where appropriate.
- Produces:
  - `type ReturnStatus = "MATCH" | "QTY_MISMATCH" | "VALUE_MISMATCH" | "QTY_AND_VALUE_MISMATCH" | "MISSING_ACCURATE" | "MISSING_PRINCIPAL" | "UNMAPPED" | "INVALID_DATA"`
  - `interface ReturnReconciliationResult` with `invoiceNumber`, `customerCode`, `accurateProductCode`, `principalProductCode`, quantities, DPP values/difference, tax/total informational values, status, warnings, source rows.
  - `interface ReturnReconciliationOutput` with canonical source lines, `results`, and full status summary.
  - `reconcileShinzuiReturns(accurate, principal, mapping, { dppTolerance?: number }): ReturnReconciliationOutput`.

- [ ] **Step 1: Write failing synthetic tests**

Create workbook helpers in the test and assert: RETUR sign normalization, PROMO ignored, composite key includes customer, duplicate-key aggregation, qty mismatch, DPP mismatch at `> 1`, both mismatch, missing directions, unmapped code, and ambiguous/missing REM rejection.

```ts
const output = reconcileShinzuiReturns(accurate, principal, mapping, {
  dppTolerance: 1,
});
assert.equal(output.summary.MATCH, 1);
assert.equal(output.results[0].dppDifference, 0);
```

- [ ] **Step 2: Run the test and confirm failure**

Run: `node --experimental-strip-types lib/off-program-control/shinzui-return-validation.test.ts`
Expected: FAIL because `return-reconciliation.ts` does not exist.

- [ ] **Step 3: Implement the minimal parser and engine**

Read the Accurate sheet `Rincian Faktur Penjualan` using nonblank headers, filter normalized `JENIS_TRANSAKSI` containing `RETUR PENJUALAN`, extract exactly one `INVGTS\d+-\d+-\d+` from `REM`, and use positive absolute qty/DPP/tax/total. Read principal sheet `PenjualanInvoice`, header row containing `INV Num`, filter exact `RETUR`, ignore every other class, normalize signs, and map products through every nonzero `PCPL KODE 1..5` from `Fix Mapping`. Aggregate by `${invoice}|${principalProduct}|${customer}` and classify deterministically.

- [ ] **Step 4: Add real-workbook acceptance**

Allow three optional argv paths. When present, assert the supplied files produce 11 results, 11 MATCH, total accurate/principal qty 29, and total DPP within `0.0001` of `361351.3503`.

Run:
`node --experimental-strip-types lib/off-program-control/shinzui-return-validation.test.ts "C:\Users\Fiqhi Fauzan\Downloads\shnzui_rerturn\rincian_faktur_penjualan_cvsuryaperkasa_260723085915.xlsx" "C:\Users\Fiqhi Fauzan\Downloads\shnzui_rerturn\PenjualanInvoice16.xlsx" "C:\Users\Fiqhi Fauzan\Downloads\shnzui_rerturn\FIX FORM MASTER BARANG - SHINZUI.xlsx"`
Expected: PASS with 11/11 MATCH.

- [ ] **Step 5: Commit**

```bash
git add lib/off-program-control/return-reconciliation.ts lib/off-program-control/shinzui-return-validation.test.ts data/reconciliation/SHINZUI.xlsx
git commit -m "feat(reconciliation): add shinzui return engine"
```

### Task 2: Authenticated Return API

**Files:**
- Create: `app/api/reconciliation/shinzui/returns/route.ts`
- Create: `lib/off-program-control/shinzui-return-route.test.ts`
- Modify: `lib/off-program-control/kino-sales-route.ts` only if a safe Return parser message must be added.

**Interfaces:**
- Consumes: `reconcileShinzuiReturns` from Task 1 and `createKinoSalesPostHandler`.
- Produces: `POST /api/reconciliation/shinzui/returns` accepting `accurateFile` and `principalFile` XLSX.

- [ ] **Step 1: Write failing route tests**

Assert auth happens before multipart parsing, only two expected file fields are accepted, master absence returns the SHINZUI message, parser errors are 422 without stack/path leakage, and success response equals the injected engine result.

- [ ] **Step 2: Run and confirm failure**

Run: `node --experimental-strip-types lib/off-program-control/shinzui-return-route.test.ts`
Expected: FAIL because the Return route/test adapter does not exist.

- [ ] **Step 3: Implement thin route**

```ts
export const POST = createKinoSalesPostHandler({
  authorize: async (request) =>
    (await requirePermission(request, "reconciliation.run")).response,
  readMapping: () =>
    readFile(path.join(process.cwd(), "data", "reconciliation", "SHINZUI.xlsx")),
  reconcile: (accurate, principal, mapping) =>
    reconcileShinzuiReturns(accurate, principal, mapping, { dppTolerance: 1 }),
  missingMappingMessage: "Master mapping SHINZUI tidak tersedia.",
});
```

- [ ] **Step 4: Run route and engine tests**

Run both Task 1 and Task 2 commands. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/api/reconciliation/shinzui/returns/route.ts lib/off-program-control/shinzui-return-route.test.ts lib/off-program-control/kino-sales-route.ts
git commit -m "feat(reconciliation): expose shinzui return endpoint"
```

### Task 3: Return UI Integration

**Files:**
- Modify: `app/(dashboard)/reconciliation/page.tsx`
- Modify: `tests/reconciliation-ui.spec.ts`

**Interfaces:**
- Consumes: `ReturnReconciliationOutput` and `/api/reconciliation/shinzui/returns`.
- Produces: active Faktur/Return selector, SHINZUI-only Return UI, result focus/filter/export, and unchanged Faktur/Pembelian behavior.

- [ ] **Step 1: Change UI tests first**

Replace the assertion that Return is non-interactive with an accessible button/tab. Add a mocked `/api/reconciliation/shinzui/returns` response and assert: selecting Return resets old files/results/errors, principal is forced to SHINZUI, upload labels describe Accurate and PenjualanInvoice, submit calls `/returns`, issues become default when present, detail shows invoice/customer/product/qty/DPP reasons, export uses a Return filename, and Pembelian remains `Belum aktif`. Preserve theme coverage.

- [ ] **Step 2: Run UI test and confirm failure**

Run: `npx playwright test tests/reconciliation-ui.spec.ts`
Expected: FAIL because Return is still passive.

- [ ] **Step 3: Implement minimal division-aware UI**

Add `type Division = "FAKTUR" | "RETURN"`, keep Faktur principals unchanged, force Return principal to `SHINZUI`, derive endpoint as `/sales` or `/returns`, and centralize one reset function used by division/principal changes. Use Return-specific columns and labels; do not add a new page, state library, or persistence.

- [ ] **Step 4: Verify UI and existing behavior**

Run: `npx playwright test tests/reconciliation-ui.spec.ts`
Expected: all reconciliation UI scenarios PASS.

- [ ] **Step 5: Commit**

```bash
git add 'app/(dashboard)/reconciliation/page.tsx' tests/reconciliation-ui.spec.ts
git commit -m "feat(reconciliation): activate shinzui return UI"
```

### Task 4: Integrated Verification

**Files:**
- Modify only files with confirmed test failures attributable to this feature.

**Interfaces:**
- Consumes: Tasks 1-3.
- Produces: verified local main implementation.

- [ ] **Step 1: Run TypeScript and focused self-checks**

Run: `npm exec tsc -- --noEmit --incremental false`
Run all existing nine reconciliation self-checks plus both new Return checks using `node --experimental-strip-types`.
Expected: PASS.

- [ ] **Step 2: Run build with local runtime excluded from scanning**

Because `runtime/` contains an ignored historical project snapshot, first verify TypeScript against tracked code; if `next build` scans `runtime/`, add exactly `"runtime/**"` to `tsconfig.json` exclude and rerun.

Run: `npm run build`
Expected: compiled, TypeScript, and static generation PASS; existing non-fatal runtime trace warning may remain.

- [ ] **Step 3: Simulate authenticated HTTP flow**

Start/reuse localhost:3000, authenticate with the local test admin without logging password/cookies, POST the three real input buffers as the two reports plus internal master through `/api/reconciliation/shinzui/returns`, and assert HTTP 200 with 11 MATCH.

- [ ] **Step 4: Verify Git scope**

Run: `git diff --check` and `git status --short --branch`.
Expected: only planned local commits; `.codex/` scratch remains untracked/ignored from commits; no push.

- [ ] **Step 5: Commit any verified integration-only fix**

If and only if Step 1-3 required a source/config fix, commit only that fix as `fix(reconciliation): complete shinzui return verification`.
