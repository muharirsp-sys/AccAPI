# RECKITT Purchase Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tambahkan rekonsiliasi Pembelian RECKITT dari Accurate XLSX dan `TXN_COMPINV_DTL.csv` pada localhost:3000.

**Architecture:** Perluas module Pembelian yang sudah ada dengan satu interface baru `reconcileReckittPurchases`, sambil memakai agregasi dan kontrak hasil yang sama. API memakai handler upload aman yang sudah ada; UI hanya menambah pilihan principal dan label RECKITT.

**Tech Stack:** TypeScript, Next.js App Router, SheetJS `xlsx`, React, Playwright.

## Global Constraints

- Kerjakan hanya pada branch `main` lokal; jangan push atau mengubah GitHub.
- Jangan menyentuh `.codex/`.
- Jangan menambah dependency atau fuzzy matching.
- Mapping exact `Product Code -> Kode BARANG Win2`.
- Master internal harus byte-identik dan SHA-256
  `19E3C171FDB48F06A58DA8C4572491218FE4723D9264F8691663C6B09A26CEBB`.
- Qty RECKITT = `Received Product Quantity`; DPP RECKITT = `Net Amount`.
- Toleransi DPP dan validasi formula adalah Rp1.
- TDD wajib: test harus gagal karena fitur belum ada sebelum produksi ditulis.

---

### Task 1: RECKITT purchase engine and internal master

**Files:**
- Modify: `lib/off-program-control/purchase-reconciliation.ts`
- Create: `lib/off-program-control/reckitt-purchase-reconciliation.test.ts`
- Create: `data/reconciliation/RECKITT_PURCHASE.xlsx`

**Interfaces:**
- Consumes: Accurate XLSX, pipe-delimited RECKITT CSV, mapping XLSX.
- Produces: `reconcileReckittPurchases(accurateBuffer, principalBuffer, mappingBuffer, options?)` returning `ReturnReconciliationOutput`.

- [ ] **Step 1: Write the failing engine test**

Test synthetic harus membuktikan exact invoice/product mapping, delimiter `|`,
qty, DPP, formula diskon, pajak, alokasi PPN Accurate, duplicate aggregation,
unmapped/ambiguous/invalid row behavior, source rows, dan toleransi Rp1.

- [ ] **Step 2: Verify RED**

Run:
`npx tsx lib/off-program-control/reckitt-purchase-reconciliation.test.ts`

Expected: FAIL karena `reconcileReckittPurchases` belum tersedia.

- [ ] **Step 3: Implement minimal parser and engine**

Reuse helper pembacaan XLSX, angka, agregasi, hasil, dan rekonsiliasi yang
sudah ada. Tambahkan parser mapping exact `Pvt Map 1`, parser Accurate nomor
`210\d{7}`, parser CSV `|`, formula validations, serta row-level
`INVALID_DATA`. Salin master sumber byte-for-byte ke path internal.

- [ ] **Step 4: Verify GREEN and real acceptance**

Run:

```text
npx tsx lib/off-program-control/reckitt-purchase-reconciliation.test.ts "C:\Users\Fiqhi Fauzan\Downloads\REckiit\rincian_faktur_pembelian_cvsuryaperkasa_260730121749.xlsx" "C:\Users\Fiqhi Fauzan\Downloads\REckiit\TXN_COMPINV_DTL.csv" "data\reconciliation\RECKITT_PURCHASE.xlsx"
```

Expected: PASS; 16/58 documents, 118/118 overlap rows, 118 MATCH,
674 MISSING_ACCURATE, 792 results.

- [ ] **Step 5: Commit**

Commit message: `feat(reconciliation): add reckitt purchase engine`

### Task 2: Authenticated RECKITT purchase endpoint

**Files:**
- Create: `app/api/reconciliation/reckitt/purchases/route.ts`
- Create: `lib/off-program-control/reckitt-purchase-route.test.ts`

**Interfaces:**
- Consumes: `reconcileReckittPurchases` and `RECKITT_PURCHASE.xlsx`.
- Produces: authenticated `POST /api/reconciliation/reckitt/purchases`.

- [ ] **Step 1: Write the failing route test**

Test auth-before-multipart, exact two fields, XLSX+CSV contract, extension,
MIME, size/signature, missing/corrupt master masking, route-local safe 422,
unknown error masking, and successful response.

- [ ] **Step 2: Verify RED**

Run: `npx tsx lib/off-program-control/reckitt-purchase-route.test.ts`

Expected: FAIL karena route belum tersedia.

- [ ] **Step 3: Implement minimal route**

Reuse `createKinoSalesPostHandler`, permission `reconciliation.run`,
`principalUpload: "csv"`, internal master path, dan predicate pesan parser
RECKITT yang hanya meneruskan kegagalan file unggahan.

- [ ] **Step 4: Verify GREEN**

Run: `npx tsx lib/off-program-control/reckitt-purchase-route.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

Commit message: `feat(reconciliation): expose reckitt purchase endpoint`

### Task 3: RECKITT purchase UI and integration

**Files:**
- Modify: `app/(dashboard)/reconciliation/page.tsx`
- Modify: `tests/reconciliation-ui.spec.ts`

**Interfaces:**
- Consumes: `/api/reconciliation/reckitt/purchases`.
- Produces: selectable RECKITT purchase flow and XLSX export.

- [ ] **Step 1: Write the failing UI test**

Perluas skenario Pembelian untuk membuktikan GODREJ tetap default, principal
select aktif pada Pembelian, switching ke RECKITT mereset file/hasil/error,
label `TXN_COMPINV_DTL RECKITT`, upload CSV, endpoint RECKITT, issue-first
display, exact export filename, dan tiga tema tetap bekerja.

- [ ] **Step 2: Verify RED**

Run:
`npx playwright test tests/reconciliation-ui.spec.ts --grep "Pembelian"`

Expected: FAIL karena RECKITT belum tersedia pada select Pembelian.

- [ ] **Step 3: Implement minimal UI**

Tambahkan `purchasePrinciples = ["GODREJ", "RECKITT"]`, aktifkan select hanya
pada Pembelian, pertahankan GODREJ default, buat label/accept dinamis, dan
reuse endpoint/export yang sudah berbasis principal.

- [ ] **Step 4: Verify feature and regressions**

Run:

```text
npx tsx lib/off-program-control/reckitt-purchase-reconciliation.test.ts
npx tsx lib/off-program-control/reckitt-purchase-route.test.ts
npx tsx lib/off-program-control/godrej-purchase-reconciliation.test.ts
npx tsx lib/off-program-control/godrej-purchase-route.test.ts
npx tsc --noEmit
npx eslint "lib/off-program-control/purchase-reconciliation.ts" "lib/off-program-control/reckitt-purchase-reconciliation.test.ts" "lib/off-program-control/reckitt-purchase-route.test.ts" "app/api/reconciliation/reckitt/purchases/route.ts" "app/(dashboard)/reconciliation/page.tsx" "tests/reconciliation-ui.spec.ts"
npm run build
npx playwright test tests/reconciliation-ui.spec.ts
```

Expected: seluruh command exit 0 dan build memuat endpoint RECKITT.

- [ ] **Step 5: Commit**

Commit message: `feat(reconciliation): add reckitt purchase UI`
