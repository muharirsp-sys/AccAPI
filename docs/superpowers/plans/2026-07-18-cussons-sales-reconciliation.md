# CUSSONS Sales Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add local CUSSONS sales-invoice reconciliation for an Accurate `.xlsx` plus CUSSONS `detail.csv`, producing the verified 39 matches and 13 Accurate-only results.

**Architecture:** Reuse the canonical sales reconciliation engine, authenticated upload handler, dynamic UI, statuses, issue-first display, and export. Add only a CUSSONS-specific TI extractor, `Form Fix` mapping parser, CSV principal parser, narrow CSV upload configuration, route adapter, and UI option.

**Tech Stack:** Next.js 16, TypeScript, Node assert self-checks, installed `xlsx`, Playwright, ESLint.

## Global Constraints

- Work only in `D:\MAGANG\OFF PROGRAM CONTROL AFTER REVISI\.worktrees\shinzui-reconciliation`; never merge to `main`, push, or deploy.
- No new dependency and no generic upload framework or page redesign.
- Uploads are exactly Accurate `.xlsx` plus principal `detail.csv`; the local master is `data/reconciliation/CUSSONS.xlsx` and remains ignored/uncommitted.
- Mapping is only sheet `Form Fix`, physical header row 5: `Kode Pcpl`, `ISI/CTN`, `SATUAN Fix Win`, `Kode BARANG Win2`.
- Key is standalone `TI\d{6}` invoice plus mapped Accurate SKU; TI extraction must not change existing principal behavior.
- `EA` quantity is direct; `CS` is `Product Quantity × ISI/CTN`; unsupported UOM or bad CS pack is `UNIT_CONVERSION_ERROR`.
- Only `Selling Type = S`, `Tax Code = PPN_Output`, and `Tax Percentage 1 = 11` are valid.
- Required numeric input failure rejects the upload with 422; valid numeric formula/tax/selling inconsistencies are per-key `INVALID_DATA`.
- Row formulas validate at four decimals with maximum difference 0.0001; aggregate comparison keeps Rp1 tolerance and exact quantity.
- Error precedence is `INVALID_DATA > UNIT_CONVERSION_ERROR > UNMAPPED_SKU > OK`.
- Real acceptance is 52 results: 39 `MATCH`, 13 `MISSING_PRINCIPAL` from `TI125941`, every other status 0.

---

### Task 1: TI Extraction and CUSSONS Mapping

**Files:**
- Modify: `lib/off-program-control/sales-reconciliation.ts:130-265,461-624`
- Create/Test: `lib/off-program-control/cussons-sales-validation.test.ts`

**Interfaces:**
- Produces: `parseAccurateSales(buffer, options?)`, `parseCussonsMappings(buffer)` and CUSSONS mapping types.
- Preserves: default `parseAccurateSales(buffer)` behavior for KINO, GODREJ, SHINZUI, and MOTASA.

- [ ] **Step 1: Write failing tests for isolated TI extraction and mapping**

Add self-checks that call the wished-for APIs:

```ts
const tiOptions = { orderNumber: cussonsOrderNumber };
assert.equal(parseAccurateSales(accurateWithRem("TI125970"), tiOptions)[0].orderNumber, "TI125970");
assert.throws(() => parseAccurateSales(accurateWithRem("XTI125970Y"), tiOptions), /nomor faktur/i);
assert.throws(() => parseAccurateSales(accurateWithRem("TI125970 TI125971"), tiOptions), /tepat satu/i);
assert.throws(() => parseAccurateSales(accurateWithRem("TI125970")), /nomor faktur/i);

const mapped = parseCussonsMappings(formFixAtRow5([
  ["100113936", 12, "PACK", "C1284002004510"],
]));
assert.equal(mapped.products.get("100113936")?.productCodeInternal, "C1284002004510");
assert.equal(mapped.products.get("100113936")?.caseSize, 12);
```

Cover header at physical rows 4/5/6, blank principal rows, identical duplicates, conflicting targets, EA with blank pack, and CS pack 0.

- [ ] **Step 2: Run RED**

Run:

```powershell
node --experimental-strip-types lib/off-program-control/cussons-sales-validation.test.ts
```

Expected: FAIL because `cussonsOrderNumber` and `parseCussonsMappings` are not exported.

- [ ] **Step 3: Implement the minimum isolated extractor and mapping parser**

Use an option instead of changing the global extractor:

```ts
type AccurateParseOptions = {
  orderNumber?: (value: unknown, label: string, row: number) => string;
};

export function cussonsOrderNumber(value: unknown, label: string, row: number) {
  const matches = normalize(value).match(/(?<![A-Z0-9])TI\d{6}(?![A-Z0-9])/g) ?? [];
  if (matches.length !== 1) throw new Error(`${label} baris ${row} harus memiliki tepat satu nomor TI`);
  return matches[0];
}
```

`parseAccurateSales` uses `options.orderNumber ?? orderNumber`. `parseCussonsMappings` calls `mappingRows(buffer, "Form Fix", requiredHeaders, 5)`, skips blank principal codes, keeps identical duplicates, and localizes conflicts to that SKU.

- [ ] **Step 4: Run GREEN and regressions**

```powershell
node --experimental-strip-types lib/off-program-control/cussons-sales-validation.test.ts
node --experimental-strip-types lib/off-program-control/sales-reconciliation.test.ts
node --experimental-strip-types lib/off-program-control/motasa-sales-validation.test.ts
```

Expected: all exit 0 and print `OK`.

- [ ] **Step 5: Commit Task 1**

```powershell
git add lib/off-program-control/sales-reconciliation.ts lib/off-program-control/cussons-sales-validation.test.ts
git commit -m "feat(reconciliation): parse cussons mapping"
```

### Task 2: CUSSONS CSV Parser, Aggregation, and Reconciliation

**Files:**
- Modify: `lib/off-program-control/sales-reconciliation.ts:1111-1415`
- Modify/Test: `lib/off-program-control/cussons-sales-validation.test.ts`

**Interfaces:**
- Consumes: `CussonsMappings`, `cussonsOrderNumber`, canonical `SalesLine`, `reconcileLines`.
- Produces: `parseCussonsSales(buffer, mappings)` and `reconcileCussonsSales(accurate, principal, mapping, options?)`.

- [ ] **Step 1: Write failing parser, precedence, and real-file tests**

Test quoted CSV, BOM/CRLF, required headers, blank/nonfinite/negative required numerics, EA, CS ×12, formula/tax/selling failures, sentinel keys, and reversed row order:

```ts
assert.equal(parseCussonsSales(csv(eaRow()), mappings)[0].quantitySmallest, 3);
assert.equal(parseCussonsSales(csv(csRow({ "Product Quantity": 2 })), mappings)[0].quantitySmallest, 24);
assert.throws(() => parseCussonsSales(csv(eaRow({ "Gross Amount": "" })), mappings), /Gross Amount/);
assert.equal(parseCussonsSales(csv(eaRow({ "Selling Type": "R" })), mappings)[0].mappingStatus, "INVALID_DATA");
assert.equal(parseCussonsSales(csv(unmappedRow()), mappings)[0].productCodeInternal, "CUSSONS_INVALID:999999999");
```

When three CLI paths are supplied, assert the exact acceptance contract from Global Constraints plus matched totals and `amountDifferences.length === 0`.

- [ ] **Step 2: Run RED**

```powershell
node --experimental-strip-types lib/off-program-control/cussons-sales-validation.test.ts "C:\Users\Fiqhi Fauzan\Downloads\cussons\rincian_faktur_penjualan_cvsuryaperkasa_260718132508.xlsx" "C:\Users\Fiqhi Fauzan\Downloads\cussons\detail.csv" "C:\Users\Fiqhi Fauzan\Downloads\cussons\FIX_FORM MASTER BARANG - CUSSONS.xlsx"
```

Expected: FAIL because `parseCussonsSales`/`reconcileCussonsSales` do not exist.

- [ ] **Step 3: Implement CSV parsing and formula validation**

Use installed `xlsx` to read the CSV first sheet. Convert authoritative amounts once with the existing four-decimal `money()` scale. Validate formulas using scaled integers with maximum difference 1 scaled unit:

```ts
const gross = money(required(row, "Gross Amount"));
const skuDiscount = money(required(row, "Discount Amount"));
const customerDiscount = money(required(row, "Customer Discount"));
const dpp = money(required(row, "Amount After SKU Disc")) - customerDiscount;
const tax = money(required(row, "Total Tax Amount"));
const net = money(required(row, "Total Net Amount"));
```

Use mapped internal SKU for valid mappings. Use `CUSSONS_INVALID:${normalizedSku}` for unmapped/conflicting mappings. Fix shared aggregation so a higher-ranked error replaces a lower-ranked error regardless of row order.

- [ ] **Step 4: Implement the wrapper and run GREEN**

`reconcileCussonsSales` parses Accurate with `{ orderNumber: cussonsOrderNumber }`, parses principal with mappings, then calls `reconcileLines` with default value tolerance 1.

Run the RED command again plus:

```powershell
node --experimental-strip-types lib/off-program-control/godrej-sales-validation.test.ts
node --experimental-strip-types lib/off-program-control/shinzui-sales-validation.test.ts
node --experimental-strip-types lib/off-program-control/motasa-sales-validation.test.ts
```

Expected: 52 results, 39 matches, 13 Accurate-only, all commands exit 0.

- [ ] **Step 5: Commit Task 2**

```powershell
git add lib/off-program-control/sales-reconciliation.ts lib/off-program-control/cussons-sales-validation.test.ts
git commit -m "feat(reconciliation): reconcile cussons sales"
```

### Task 3: CSV Upload Contract, Route, and Local Master

**Files:**
- Modify: `lib/off-program-control/kino-sales-route.ts:1-166`
- Create/Test: `lib/off-program-control/cussons-sales-route.test.ts`
- Create: `app/api/reconciliation/cussons/sales/route.ts`
- Local ignored data: `data/reconciliation/CUSSONS.xlsx`

**Interfaces:**
- Consumes: `reconcileCussonsSales`.
- Produces: authenticated `POST /api/reconciliation/cussons/sales` with Accurate XLSX and principal CSV.
- Preserves: default two-XLSX handler behavior for every existing route.

- [ ] **Step 1: Write failing route/handler tests**

Create a CUSSONS handler from the shared factory and test:

```ts
const handler = createKinoSalesPostHandler({
  ...deps,
  principalUpload: { kind: "csv", extensions: [".csv"], mimeTypes: CSV_MIME_TYPES },
});
```

Cover auth, missing/duplicate/unknown fields and MIME/extension (400), >10 MB (413), bad Accurate ZIP/empty or NUL CSV/missing header/numeric/parser (422), hidden-path master error (500), and success buffer order. Re-run the KINO handler test to prove defaults remain unchanged.

- [ ] **Step 2: Run RED**

```powershell
node --experimental-strip-types lib/off-program-control/cussons-sales-route.test.ts
```

Expected: FAIL because CSV configuration and route do not exist.

- [ ] **Step 3: Implement narrow CSV configuration and route**

Keep existing defaults. CSV accepts `text/csv`, `application/csv`, `application/vnd.ms-excel`, `text/plain`, `application/octet-stream`, or empty MIME; it must be nonempty and contain no NUL, and it must not receive ZIP validation.

Route adapter:

```ts
export const POST = createKinoSalesPostHandler({
  mappingPath: path.join(process.cwd(), "data", "reconciliation", "CUSSONS.xlsx"),
  missingMappingMessage: "Master mapping CUSSONS belum tersedia.",
  principalUpload: { kind: "csv" },
  reconcile: (accurate, principal, mapping) => reconcileCussonsSales(accurate, principal, mapping, { valueTolerance: 1 }),
});
```

Copy the supplied master to the local ignored path and verify it is ignored; never stage it.

- [ ] **Step 4: Run GREEN, regressions, and ignore checks**

```powershell
node --experimental-strip-types lib/off-program-control/cussons-sales-route.test.ts
node --experimental-strip-types lib/off-program-control/kino-sales-route.test.ts
node --experimental-strip-types lib/off-program-control/godrej-sales-route.test.ts
node --experimental-strip-types lib/off-program-control/shinzui-sales-route.test.ts
git check-ignore -v data/reconciliation/CUSSONS.xlsx
```

Expected: all tests exit 0; ignore output names the XLSX ignore rule.

- [ ] **Step 5: Commit Task 3 source only**

```powershell
git add lib/off-program-control/kino-sales-route.ts lib/off-program-control/cussons-sales-route.test.ts app/api/reconciliation/cussons/sales/route.ts
git commit -m "feat(reconciliation): expose local cussons endpoint"
```

### Task 4: CUSSONS UI and Final Local Verification

**Files:**
- Modify: `app/(dashboard)/reconciliation/page.tsx:22,235-486`
- Modify/Test: `tests/reconciliation-ui.spec.ts:64-274`

**Interfaces:**
- Consumes: `/api/reconciliation/cussons/sales` and the existing result contract.
- Produces: CUSSONS selection, `.csv` principal input, issue-first display, causes, and full export.

- [ ] **Step 1: Write failing UI test**

Add CUSSONS to the existing progressive scenario. Assert option, `Detail CUSSONS`, principal `accept` including `.csv`, button gating, endpoint, `ISSUES_ONLY`, cause for `TI125941`, ALL-results visibility, and `hasil-rekonsiliasi-cussons-YYYY-MM-DD.xlsx` filename. Use a CSV `File` helper instead of an XLSX buffer for the principal input.

- [ ] **Step 2: Run RED**

```powershell
$env:PLAYWRIGHT_BASE_URL='http://localhost:3000'; npx playwright test tests/reconciliation-ui.spec.ts --project=msedge
```

Expected: FAIL because the CUSSONS option is missing.

- [ ] **Step 3: Implement the minimal dynamic UI changes**

Add `CUSSONS` to `Principal` and the dropdown. Derive principal label, accept string, and help text from the selected principal; leave Accurate as XLSX and reuse existing endpoint, clearing, filter, causes, themes, and export logic.

- [ ] **Step 4: Run final verification**

```powershell
node --experimental-strip-types lib/off-program-control/cussons-sales-validation.test.ts "C:\Users\Fiqhi Fauzan\Downloads\cussons\rincian_faktur_penjualan_cvsuryaperkasa_260718132508.xlsx" "C:\Users\Fiqhi Fauzan\Downloads\cussons\detail.csv" "D:\MAGANG\OFF PROGRAM CONTROL AFTER REVISI\.worktrees\shinzui-reconciliation\data\reconciliation\CUSSONS.xlsx"
node --experimental-strip-types lib/off-program-control/cussons-sales-route.test.ts
node --experimental-strip-types lib/off-program-control/sales-reconciliation.test.ts
node --experimental-strip-types lib/off-program-control/godrej-sales-validation.test.ts
node --experimental-strip-types lib/off-program-control/shinzui-sales-validation.test.ts
node --experimental-strip-types lib/off-program-control/motasa-sales-validation.test.ts
npx eslint "lib/off-program-control/sales-reconciliation.ts" "lib/off-program-control/cussons-sales-validation.test.ts" "lib/off-program-control/kino-sales-route.ts" "lib/off-program-control/cussons-sales-route.test.ts" "app/api/reconciliation/cussons/sales/route.ts" "app/(dashboard)/reconciliation/page.tsx" "tests/reconciliation-ui.spec.ts"
$env:PLAYWRIGHT_BASE_URL='http://localhost:3000'; npx playwright test tests/reconciliation-ui.spec.ts --project=msedge
npx next build --webpack
```

Expected: all commands exit 0; build lists `/api/reconciliation/cussons/sales` and `/reconciliation`; localhost:3000 shows CUSSONS from this worktree.

- [ ] **Step 5: Commit Task 4**

```powershell
git add "app/(dashboard)/reconciliation/page.tsx" tests/reconciliation-ui.spec.ts
git commit -m "feat(reconciliation): add cussons to local ui"
```
