# Godrej Return Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mengaktifkan GODREJ pada divisi Return memakai Accurate XLSX, Sale Returns CSV, dan master mapping internal.

**Architecture:** Reuse kontrak, agregator, status, tabel, ekspor, serta handler upload Return yang sudah ada. Tambahkan parser GODREJ khusus dengan mapping kode utama dan fallback nama exact-unik; endpoint dan UI hanya menjadi adaptor tipis.

**Tech Stack:** TypeScript, Next.js App Router, SheetJS `xlsx`, Playwright, Node assert tests.

## Global Constraints

- Kerjakan hanya di `main` lokal; jangan push atau mengubah GitHub.
- Jangan menambah dependency, halaman, tipe output, atau abstraksi spekulatif.
- Accurate hanya `RETUR PENJUALAN`; GODREJ hanya `Sale Return State = approved`.
- Key adalah `nomor RB/BFG | customer | kode produk Accurate`.
- Mapping memakai kode exact lebih dahulu, lalu nama `Skunit` exact-unik dari `Form Fix`; fuzzy matching dilarang.
- REM nol/ganda menjadi `INVALID_DATA`, bukan menggagalkan file.
- GODREJ `DPP = abs(Amount) / 1.11`; qty exact; toleransi DPP Rp1; pajak/total informasional.
- Semua 33 baris Accurate tetap terlihat.
- Acceptance nyata wajib `MATCH=6`, `MISSING_PRINCIPAL=27`, status lain `0`.
- Faktur, Return SHINZUI/KINO, Pembelian pasif, tiga tema, dan aksesibilitas harus tetap bekerja.

---

### Task 1: GODREJ Return Engine and Internal Master

**Files:**
- Modify: `lib/off-program-control/return-reconciliation.ts`
- Create: `lib/off-program-control/godrej-return-validation.test.ts`
- Create: `data/reconciliation/GODREJ_RETURN.xlsx`

**Interfaces:**
- Consumes: tiga buffer file dan kontrak `ReturnReconciliationOutput`.
- Produces:
  `reconcileGodrejReturns(accurate, principal, mapping, { dppTolerance?: number }): ReturnReconciliationOutput`.

- [ ] **Step 1: Write the failing engine test**

Test synthetic wajib membuktikan:

```ts
const output = reconcileGodrejReturns(accurate, csv, mapping, {
  dppTolerance: 1,
});
assert.equal(output.summary.MATCH, 1);
assert.equal(output.results[0].principalDpp, 11100 / 1.11);
```

Tambahkan kasus RED untuk filter approved, customer bentuk kurung/suffix,
mapping kode, fallback nama exact, nama ambigu/tidak ditemukan, REM nol/ganda,
angka kosong/NaN, normalisasi negatif menjadi magnitudo, anotasi kemasan versus
parenthetical deskriptif, agregasi key, toleransi tepat Rp1 dan lebih dari Rp1.
Test nyata harus assert 33/6 lines, summary 6/27/0, qty 42, serta total acceptance
dari Global Constraints.

- [ ] **Step 2: Run the engine test and verify RED**

Run:

```powershell
node --experimental-strip-types lib/off-program-control/godrej-return-validation.test.ts
```

Expected: FAIL karena `reconcileGodrejReturns` belum tersedia.

- [ ] **Step 3: Implement minimal parser and reconciliation**

Di `return-reconciliation.ts`:

```ts
export function reconcileGodrejReturns(
  accurateBuffer: Buffer | Uint8Array,
  principalBuffer: Buffer | Uint8Array,
  mappingBuffer: Buffer | Uint8Array,
  options: { dppTolerance?: number } = {},
): ReturnReconciliationOutput;
```

Implementasikan:

- CSV dibaca dengan dependency `xlsx` existing dan header exact:
  `Sale Return No.`, `CUSTOMER`, `Skunit`, `Quantity(Units)`, `Amount`,
  `Sale Return State`.
- Produk langsung dari `Pvt Map 1`; fallback nama exact-unik dari `Form Fix`.
- Bersihkan nama hanya dengan aturan deterministik pada spec.
- Customer dan REM wajib mengandung tepat satu token yang diizinkan.
- Reuse `reconcileParsedReturns`; principal unmapped masuk `UNMAPPED`.
- Error mapping konflik memuat nama produk internal yang aman, bukan isi header asing.

Salin master byte-for-byte:

```powershell
Copy-Item -LiteralPath 'C:\Users\Fiqhi Fauzan\Downloads\godrej\FIX FORM MASTER BARANG - GDI.xlsx' -Destination 'data\reconciliation\GODREJ_RETURN.xlsx'
```

- [ ] **Step 4: Run GREEN and regressions**

```powershell
node --experimental-strip-types lib/off-program-control/godrej-return-validation.test.ts
node --experimental-strip-types lib/off-program-control/godrej-return-validation.test.ts "C:\Users\Fiqhi Fauzan\Downloads\godrej\rincian_faktur_penjualan_cvsuryaperkasa_260729083809.xlsx" "C:\Users\Fiqhi Fauzan\Downloads\godrej\Salereturns18.csv" "C:\Users\Fiqhi Fauzan\Downloads\godrej\FIX FORM MASTER BARANG - GDI.xlsx"
node --experimental-strip-types lib/off-program-control/kino-return-validation.test.ts
node --experimental-strip-types lib/off-program-control/shinzui-return-validation.test.ts
npx tsc --noEmit
```

Expected: seluruhnya PASS dan hash master sumber/internal sama.

- [ ] **Step 5: Commit**

```powershell
git add lib/off-program-control/return-reconciliation.ts lib/off-program-control/godrej-return-validation.test.ts data/reconciliation/GODREJ_RETURN.xlsx
git commit -m "feat(reconciliation): add godrej return engine"
```

### Task 2: Authenticated GODREJ Return API

**Files:**
- Create: `app/api/reconciliation/godrej/returns/route.ts`
- Create: `lib/off-program-control/godrej-return-route.test.ts`
- Modify: `lib/off-program-control/kino-sales-route.ts`

**Interfaces:**
- Consumes: `reconcileGodrejReturns` dan `createKinoSalesPostHandler`.
- Produces: `POST /api/reconciliation/godrej/returns`.

- [ ] **Step 1: Write failing route test**

Test handler wajib mencakup auth sebelum multipart, permission 403, dua field
exact, XLSX+CSV extension/MIME, duplicate/extra field, ZIP/NUL/size, missing
master, known parser errors 422, arbitrary `DATABASE PASSWORD` masked 500,
dan success parity dengan engine nyata.

- [ ] **Step 2: Run route test and verify RED**

```powershell
node --experimental-strip-types lib/off-program-control/godrej-return-route.test.ts
```

Expected: FAIL karena route belum ada.

- [ ] **Step 3: Implement thin route**

```ts
export const POST = createKinoSalesPostHandler({
  principalUpload: {
    kind: "csv",
    extensions: [".csv"],
    mimeTypes: CSV_MIME_TYPES,
  },
  loadMapping: () =>
    readFile(path.join(process.cwd(), "data", "reconciliation", "GODREJ_RETURN.xlsx")),
  reconcile: (accurate, principal, mapping) =>
    reconcileGodrejReturns(accurate, principal, mapping, { dppTolerance: 1 }),
  missingMappingMessage: "Master mapping GODREJ Return tidak tersedia.",
});
```

Tambahkan hanya header GODREJ Return yang dikenal ke safe allowlist. Jangan
memperlebar regex sehingga header asing dapat bocor.

- [ ] **Step 4: Run GREEN and route regressions**

```powershell
node --experimental-strip-types lib/off-program-control/godrej-return-route.test.ts
node --experimental-strip-types lib/off-program-control/kino-return-route.test.ts
node --experimental-strip-types lib/off-program-control/shinzui-return-route.test.ts
node --experimental-strip-types lib/off-program-control/godrej-sales-route.test.ts
node --experimental-strip-types lib/off-program-control/kino-sales-route.test.ts
npx eslint app/api/reconciliation/godrej/returns/route.ts lib/off-program-control/kino-sales-route.ts lib/off-program-control/godrej-return-route.test.ts
npx tsc --noEmit
```

- [ ] **Step 5: Commit**

```powershell
git add app/api/reconciliation/godrej/returns/route.ts lib/off-program-control/godrej-return-route.test.ts lib/off-program-control/kino-sales-route.ts
git commit -m "feat(reconciliation): expose godrej return endpoint"
```

### Task 3: GODREJ in Return UI

**Files:**
- Modify: `app/(dashboard)/reconciliation/page.tsx`
- Modify: `tests/reconciliation-ui.spec.ts`

**Interfaces:**
- Consumes: `/api/reconciliation/godrej/returns`.
- Produces: Return selector `SHINZUI | KINO | GODREJ`, dynamic CSV upload,
  results, causes, and export.

- [ ] **Step 1: Write failing Playwright test**

Test behavioral wajib:

```ts
await page.getByRole("button", { name: "Return" }).click();
await page.getByLabel("Prinsipal").selectOption("GODREJ");
await expect(page.getByLabel("Sale Returns GODREJ")).toHaveAttribute(
  "accept",
  ".csv,text/csv,application/csv",
);
```

Mock `/api/reconciliation/godrej/returns`, assert multipart dikirim ke endpoint
tersebut, masalah tampil lebih dahulu, label/cause/column memakai GODREJ,
switching menghapus state lama, dan workbook ekspor bernama
`rekonsiliasi-return-godrej-YYYY-MM-DD.xlsx` serta memuat penyebab/baris sumber.

- [ ] **Step 2: Run test and verify RED**

```powershell
npx playwright test tests/reconciliation-ui.spec.ts -g "GODREJ Return"
```

Expected: FAIL karena GODREJ belum ada pada selector Return.

- [ ] **Step 3: Implement minimal dynamic UI**

```ts
const returnPrinciples = ["SHINZUI", "KINO", "GODREJ"] as const;
```

Gunakan kondisi CSV hanya untuk Return GODREJ dan Faktur CUSSONS. Reuse endpoint,
table, cause, reset, dan export dinamis yang sudah ada; jangan buat cabang tabel
atau komponen baru.

- [ ] **Step 4: Run GREEN and full regressions**

```powershell
npx playwright test tests/reconciliation-ui.spec.ts
npx eslint "app/(dashboard)/reconciliation/page.tsx" tests/reconciliation-ui.spec.ts
npx tsc --noEmit
npm run build
```

Expected: seluruh reconciliation UI, tema, Faktur, Return SHINZUI/KINO, dan
Pembelian pasif tetap PASS.

- [ ] **Step 5: Commit**

```powershell
git add "app/(dashboard)/reconciliation/page.tsx" tests/reconciliation-ui.spec.ts
git commit -m "feat(reconciliation): add godrej return UI"
```

### Task 4: Integrated Verification

**Files:**
- Modify only files with failures attributable to GODREJ Return.

- [ ] **Step 1: Run all backend tests**

```powershell
Get-ChildItem lib/off-program-control -Filter *.test.ts | ForEach-Object {
  node --experimental-strip-types $_.FullName
  if ($LASTEXITCODE -ne 0) { throw "Test gagal: $($_.Name)" }
}
```

- [ ] **Step 2: Run type, lint, build, and UI**

```powershell
npx tsc --noEmit
npx eslint "app/(dashboard)/reconciliation/page.tsx" app/api/reconciliation/godrej/returns/route.ts lib/off-program-control/return-reconciliation.ts lib/off-program-control/kino-sales-route.ts tests/reconciliation-ui.spec.ts
npm run build
npx playwright test tests/reconciliation-ui.spec.ts
```

- [ ] **Step 3: Run authenticated real HTTP acceptance**

Login lokal, POST dua file nyata ke `/api/reconciliation/godrej/returns`, lalu
assert HTTP 200, 33 result, `MATCH=6`, `MISSING_PRINCIPAL=27`, status lain 0,
dan enam row matched memiliki qty/DPP sesuai Global Constraints.

- [ ] **Step 4: Final checks**

```powershell
git diff --check
git status --short
```

Pastikan hanya `.codex/` dan workspace SDD yang tidak dilacak, server lokal
tetap dapat diakses pada port 3000, dan tidak ada push.
