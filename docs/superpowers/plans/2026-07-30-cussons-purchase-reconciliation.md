# CUSSONS Purchase Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add tested CUSSONS purchase reconciliation from engine through local web UI.

**Architecture:** Parameterize the existing RECKITT purchase parsers where the two formats differ, reuse the shared reconciliation and upload handlers, and reuse the existing CUSSONS internal master. Add only the CUSSONS adapter, endpoint, UI option, and focused tests.

**Tech Stack:** TypeScript, Next.js App Router, SheetJS `xlsx`, Playwright.

## Global Constraints

- Work only on local `main`; do not push or modify GitHub.
- Reuse `data/reconciliation/CUSSONS_RETURN.xlsx`; do not duplicate the master.
- Mapping source is exact `Form Fix` through `parseCussonsMappings()`; no fuzzy matching.
- Invoice key is exactly `\b1\d{8}\b` from Accurate `REM` and `^1\d{8}$` in principal.
- Accurate `QTY` is canonical and must not be multiplied by `ISI/CTN`.
- Principal `UOM Code=CS`, `Default UOM=EA`, formulas and DPP tolerance Rp1.
- Ambiguous mappings are row-level `INVALID_DATA`.
- Real acceptance is exactly 246 MATCH, 812 MISSING_ACCURATE, 3 MISSING_PRINCIPAL, 12 INVALID_DATA, 1,073 total.
- Authenticate before multipart and mask internal master errors.
- `GODREJ` remains the default Pembelian principal.
- No new dependency or unrequested abstraction.

---

### Task 1: CUSSONS purchase engine

**Files:**
- Modify: `lib/off-program-control/purchase-reconciliation.ts`
- Create: `lib/off-program-control/cussons-purchase-reconciliation.test.ts`

**Interfaces:**
- Consumes: `parseCussonsMappings(buffer)` and existing `reconcile(...)`.
- Produces: `reconcileCussonsPurchases(accurateBuffer, principalBuffer, mappingBuffer, options?)`.

- [ ] **Step 1: Write the failing engine test**

Cover exact invoice parsing, comma CSV, raw Accurate quantity, `CS/EA`, quantity
consistency, blank optional money, Rp1 formula tolerance, proportional PPN,
exact mapping conflicts, duplicate aggregation, source rows, all result
statuses, and the real acceptance counts.

- [ ] **Step 2: Run the test and verify RED**

Run: `npx tsx lib/off-program-control/cussons-purchase-reconciliation.test.ts`

Expected: fail because `reconcileCussonsPurchases` does not exist.

- [ ] **Step 3: Implement the minimum adapter**

Import and reuse `parseCussonsMappings`. Parameterize the existing
code-mapped Accurate/principal parser for invoice regex/label and allowed UOM,
then export `reconcileCussonsPurchases`. Keep aggregation and result logic
unchanged.

- [ ] **Step 4: Verify GREEN and regressions**

Run:

```text
npx tsx lib/off-program-control/cussons-purchase-reconciliation.test.ts
npx tsx lib/off-program-control/cussons-purchase-reconciliation.test.ts "<Accurate path>" "<CSV path>" "data/reconciliation/CUSSONS_RETURN.xlsx"
npx tsx lib/off-program-control/reckitt-purchase-reconciliation.test.ts
npx tsx lib/off-program-control/godrej-purchase-reconciliation.test.ts
npx tsc --noEmit
git diff --check
```

- [ ] **Step 5: Commit Task 1**

Commit only the engine and engine test.

### Task 2: CUSSONS purchase endpoint

**Files:**
- Create: `app/api/reconciliation/cussons/purchases/route.ts`
- Create: `lib/off-program-control/cussons-purchase-route.test.ts`

**Interfaces:**
- Consumes: `reconcileCussonsPurchases`.
- Produces: authenticated `POST /api/reconciliation/cussons/purchases`.

- [ ] **Step 1: Write a failing route test**

Cover auth-before-`formData`, missing/wrong/oversized XLSX and CSV, NUL CSV,
safe user parser errors, masked missing/corrupt internal master errors, exact
mapping path, engine call, and success response.

- [ ] **Step 2: Run the test and verify RED**

Run: `npx tsx lib/off-program-control/cussons-purchase-route.test.ts`

Expected: fail because the route module does not exist.

- [ ] **Step 3: Implement the route with the shared handler**

Use `createKinoSalesPostHandler`, load
`data/reconciliation/CUSSONS_RETURN.xlsx`, call
`reconcileCussonsPurchases(..., { dppTolerance: 1 })`, and preserve the
existing safe-error boundary.

- [ ] **Step 4: Verify GREEN and route regressions**

Run the CUSSONS, RECKITT, and GODREJ purchase route tests, TypeScript, scoped
ESLint, and `git diff --check`.

- [ ] **Step 5: Commit Task 2**

Commit only the route and route test.

### Task 3: CUSSONS purchase UI

**Files:**
- Modify: `app/(dashboard)/reconciliation/page.tsx`
- Modify: `tests/reconciliation-ui.spec.ts`

**Interfaces:**
- Consumes: `POST /api/reconciliation/cussons/purchases`.
- Produces: CUSSONS purchase selection, upload, issue-first results, and export.

- [ ] **Step 1: Extend the UI test and verify RED**

Assert GODREJ remains default; CUSSONS appears only for Pembelian; switching
clears state; label/accept/help text are exact; multipart targets the CUSSONS
endpoint; results remain issue-first; export is
`rekonsiliasi-pembelian-cussons-YYYY-MM-DD.xlsx`; all themes still work.

- [ ] **Step 2: Implement the minimum UI branch**

Add `CUSSONS` to `purchasePrinciples` and reuse the existing RECKITT
`TXN_COMPINV_DTL` branch for label, CSV accept, endpoint, result headings, and
export naming. Do not change the GODREJ default.

- [ ] **Step 3: Verify GREEN and regressions**

Run Playwright discovery and the focused UI test when authentication is
available; always run engine/route regressions, TypeScript, scoped ESLint,
production build, and `git diff --check`.

- [ ] **Step 4: Commit Task 3**

Commit only the page and UI test.
