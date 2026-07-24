# KINO Return Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mengaktifkan rekonsiliasi divisi Return untuk KINO memakai Rincian Faktur Accurate, SALES_DETAIL KINO, dan master mapping internal.

**Architecture:** Pertahankan kontrak hasil dan core status Return yang sudah dipakai SHINZUI. Tambahkan parser KINO khusus untuk `Sheet1` dan mapping `Table Pvt 1`, endpoint tipis baru, lalu perluas selector principle Return pada halaman yang sama.

**Tech Stack:** Next.js 16 App Router, TypeScript, React 19, `xlsx`, Playwright, handler multipart yang sudah ada.

## Global Constraints

- Kerjakan hanya pada branch `main` lokal; jangan push atau mengubah GitHub.
- Pengguna mengunggah tepat dua XLSX: Accurate dan SALES_DETAIL KINO.
- Master mapping disimpan byte-for-byte sebagai `data/reconciliation/KINO_RETURN.xlsx`.
- Accurate hanya `RETUR PENJUALAN`; KINO hanya `INVOICE_TYPE = RET01`.
- Kunci normal adalah invoice `1671-SRI-\d+` dari Accurate `REM` + pelanggan + produk internal hasil mapping.
- Mapping memakai `Table Pvt 1` sebagai sumber utama dan `Fix Mapping` hanya untuk kode principal yang hilang; mapping konflik tidak boleh ditebak.
- Accurate tanpa kandidat produk menjadi `MISSING_PRINCIPAL` bila invoice+pelanggan tidak ada di KINO; `UNMAPPED` hanya bila invoice+pelanggan ada tetapi produk tidak dapat dipetakan.
- Baris Accurate tanpa tepat satu invoice KINO menjadi `INVALID_DATA`, bukan menggagalkan seluruh proses.
- Semua baris Accurate tetap diperiksa; invoice yang tidak ada di SALES_DETAIL menjadi `MISSING_PRINCIPAL`.
- Qty dibandingkan exact; DPP memakai toleransi absolut Rp1.
- Pajak dan total hanya informasi.
- Jangan memakai tanggal sebagai kunci.
- Tidak ada dependency, halaman, database hasil, histori, atau refactor di luar alur rekonsiliasi.
- Faktur, Return SHINZUI, Pembelian pasif, dan tiga tema harus tetap bekerja.
- Acceptance nyata: `MATCH=10`, `MISSING_PRINCIPAL=14`, `INVALID_DATA=18`, status lain `0`; matched qty `17`, DPP `293828.8287`, pajak `18655.4053`, total `312484.2340`.

---

### Task 1: KINO Return Engine and Internal Mapping

**Files:**
- Modify: `lib/off-program-control/return-reconciliation.ts`
- Create: `lib/off-program-control/kino-return-validation.test.ts`
- Create: `data/reconciliation/KINO_RETURN.xlsx`

**Interfaces:**
- Consumes: tiga buffer XLSX dan kontrak `ReturnReconciliationOutput`.
- Produces:
  `reconcileKinoReturns(accurate, principal, mapping, { dppTolerance?: number }): ReturnReconciliationOutput`.

- [ ] **Step 1: Write failing synthetic tests**

Tambahkan helper workbook kecil dan uji:

```ts
const output = reconcileKinoReturns(accurate, principal, mapping, {
  dppTolerance: 1,
});
assert.equal(output.summary.MATCH, 1);
assert.equal(output.summary.INVALID_DATA, 1);
assert.equal(output.results.find((row) => row.status === "MATCH")?.dppDifference, 0);
```

Kasus wajib: `RET01` saja, total row diabaikan, mapping `Table Pvt 1`, invoice dari `REM`, customer memakai `CUSTCODE2`, tanda negatif diabsolutkan, formula DPP empat komponen, duplicate-key aggregation, Rp1 lolos, `>Rp1` mismatch, missing kedua arah, unmapped product, dan REM hilang/ambigu menjadi `INVALID_DATA`.

- [ ] **Step 2: Run RED**

Run:

```powershell
node --experimental-strip-types lib/off-program-control/kino-return-validation.test.ts
```

Expected: FAIL karena `reconcileKinoReturns` belum tersedia.

- [ ] **Step 3: Implement parser dan reuse core Return**

Tambahkan parser mapping:

```ts
function parseKinoReturnMappings(buffer: Buffer | Uint8Array): Map<string, string> {
  const rows = readRows(buffer, "Table Pvt 1");
  const header = findHeader(rows, ["KODE PCPL", "KODE BARANG WIN"]);
  const mappings = new Map<string, string>();
  for (let index = header.rowIndex + 1; index < rows.length; index++) {
    const principal = text(cell(rows[index], header.columns, "KODE PCPL"));
    const internal = text(cell(rows[index], header.columns, "KODE BARANG WIN"));
    if (!principal && !internal) continue;
    if (!principal || principal === "0") continue;
    if (!internal)
      throw new Error(`Table Pvt 1 tidak lengkap pada baris ${index + 1}`);
    const existing = mappings.get(principal);
    if (existing && existing !== internal)
      throw new Error(`Mapping produk KINO konflik untuk ${principal}`);
    mappings.set(principal, internal);
  }
  return mappings;
}
```

Lengkapi map dari sheet `Fix Mapping` untuk principal yang belum ada:

```ts
for (const principal of principalCodesFromFixMapping) {
  if (!mappings.has(principal.code))
    mappings.set(principal.code, principal.internal);
}
```

Jika satu principal menunjuk dua internal berbeda, lempar error mapping konflik.
Jangan memilih kandidat pertama untuk mapping ambigu.

Tambahkan parser principal yang:

```ts
const signedDpp =
  gross - lineDiscount - promoDiscount - cashDiscount;
```

Kemudian hasil disusun melalui helper core yang sama dengan SHINZUI:

```ts
export function reconcileKinoReturns(
  accurateBuffer: Buffer | Uint8Array,
  principalBuffer: Buffer | Uint8Array,
  mappingBuffer: Buffer | Uint8Array,
  options: { dppTolerance?: number } = {},
): ReturnReconciliationOutput;
```

Jangan mengubah perilaku `reconcileShinzuiReturns`.

- [ ] **Step 4: Add real-workbook acceptance**

Jika tiga argv diberikan, test membaca file nyata dan memastikan:

```ts
assert.deepEqual(real.summary, {
  MATCH: 10,
  QTY_MISMATCH: 0,
  VALUE_MISMATCH: 0,
  QTY_AND_VALUE_MISMATCH: 0,
  MISSING_ACCURATE: 0,
  MISSING_PRINCIPAL: 14,
  UNMAPPED: 0,
  INVALID_DATA: 18,
});
```

Matched rows harus menjumlah qty `17`, DPP `293828.8287`, pajak `18655.4053`, dan total `312484.2340`.

- [ ] **Step 5: Verify and commit**

Run synthetic, real acceptance, dan SHINZUI regression:

```powershell
node --experimental-strip-types lib/off-program-control/kino-return-validation.test.ts
node --experimental-strip-types lib/off-program-control/kino-return-validation.test.ts "C:\Users\Fiqhi Fauzan\Downloads\kino_return\rincian_faktur_penjualan_cvsuryaperkasa_260724132425.xlsx" "C:\Users\Fiqhi Fauzan\Downloads\kino_return\SALES_DETAIL_20.xlsx" "C:\Users\Fiqhi Fauzan\Downloads\kino_return\FIX_FORM MASTER BARANG - KINO NON FOOD.xlsx"
node --experimental-strip-types lib/off-program-control/shinzui-return-validation.test.ts
```

Commit:

```powershell
git add lib/off-program-control/return-reconciliation.ts lib/off-program-control/kino-return-validation.test.ts data/reconciliation/KINO_RETURN.xlsx
git commit -m "feat(reconciliation): add kino return engine"
```

### Task 2: Authenticated KINO Return API

**Files:**
- Create: `app/api/reconciliation/kino/returns/route.ts`
- Create: `lib/off-program-control/kino-return-route.test.ts`

**Interfaces:**
- Consumes: `reconcileKinoReturns` dan `createKinoSalesPostHandler`.
- Produces: `POST /api/reconciliation/kino/returns` dengan `accurateFile` dan `principalFile`.

- [ ] **Step 1: Write failing route tests**

Uji auth sebelum multipart, dua field wajib, master hilang, error parser aman `422`, XLSX rusak `422`, dan success:

```ts
assert.deepEqual(
  await response.json(),
  reconcileKinoReturns(accurate, principal, mapping),
);
```

- [ ] **Step 2: Run RED**

```powershell
node --experimental-strip-types lib/off-program-control/kino-return-route.test.ts
```

Expected: FAIL karena route belum ada.

- [ ] **Step 3: Implement thin route**

```ts
export const POST = createKinoSalesPostHandler({
  authorize: async (request) =>
    (await requirePermission(request, "reconciliation.run")).response,
  readMapping: () =>
    readFile(path.join(process.cwd(), "data", "reconciliation", "KINO_RETURN.xlsx")),
  reconcile: (accurate, principal, mapping) =>
    reconcileKinoReturns(accurate, principal, mapping, { dppTolerance: 1 }),
  missingMappingMessage: "Master mapping KINO Return tidak tersedia.",
});
```

- [ ] **Step 4: Verify and commit**

```powershell
node --experimental-strip-types lib/off-program-control/kino-return-route.test.ts
node --experimental-strip-types lib/off-program-control/shinzui-return-route.test.ts
git add app/api/reconciliation/kino/returns/route.ts lib/off-program-control/kino-return-route.test.ts
git commit -m "feat(reconciliation): expose kino return endpoint"
```

### Task 3: KINO in Return UI

**Files:**
- Modify: `app/(dashboard)/reconciliation/page.tsx`
- Modify: `tests/reconciliation-ui.spec.ts`

**Interfaces:**
- Consumes: endpoint `/api/reconciliation/kino/returns`.
- Produces: selector Return `SHINZUI | KINO`, label upload dinamis, endpoint dan filename ekspor dinamis.

- [ ] **Step 1: Write failing Playwright assertions**

Tambahkan skenario KINO Return yang memastikan:

```ts
await page.getByRole("button", { name: "Return" }).click();
await page.getByLabel("Prinsipal").selectOption("KINO");
await expect(page.getByLabel("Sales Detail KINO")).toBeVisible();
```

Mock `/api/reconciliation/kino/returns`, pastikan request menuju route tersebut, hasil masalah tampil dahulu, ekspor bernama `rekonsiliasi-return-kino-*.xlsx`, switching menghapus hasil lama, SHINZUI tetap tersedia, Pembelian pasif, dan tema tetap tercakup.

- [ ] **Step 2: Run RED**

```powershell
npx playwright test tests/reconciliation-ui.spec.ts --project=msedge --workers=1
```

Expected: dengan `PLAYWRIGHT_AUTH_EMAIL` dan `PLAYWRIGHT_AUTH_PASSWORD` yang
sudah tersedia pada environment lokal, FAIL karena KINO belum ada di selector
Return.

- [ ] **Step 3: Implement minimum UI change**

Ganti hardcode SHINZUI dengan pilihan principle Return:

```ts
const returnPrinciples = ["SHINZUI", "KINO"] as const;
const endpoint =
  division === "RETURN"
    ? `/api/reconciliation/${principal.toLowerCase()}/returns`
    : `/api/reconciliation/${principal.toLowerCase()}/sales`;
```

Gunakan label dan filename berdasarkan principle tanpa membuat halaman/state baru.

- [ ] **Step 4: Verify and commit**

Run Playwright, TypeScript scoped, dan ESLint lalu commit:

```powershell
git add 'app/(dashboard)/reconciliation/page.tsx' tests/reconciliation-ui.spec.ts
git commit -m "feat(reconciliation): add kino return UI"
```

### Task 4: Integrated Local Verification

**Files:**
- Modify only files with confirmed failures attributable to KINO Return.

**Interfaces:**
- Consumes: Tasks 1-3.
- Produces: verified local `main`, tanpa push.

- [ ] **Step 1: Run static and reconciliation checks**

```powershell
npm exec tsc -- --noEmit --incremental false
```

Run seluruh `lib/off-program-control/*.test.ts`; expected semua PASS.

- [ ] **Step 2: Run production build**

```powershell
npm run build
```

Expected: compile, TypeScript, dan static generation PASS.

- [ ] **Step 3: Run authenticated UI and real HTTP simulation**

Pertahankan PostgreSQL WSL aktif, start local production server, lalu:

```powershell
npx playwright test tests/reconciliation-ui.spec.ts --project=msedge --workers=1
```

POST dua workbook nyata ke `/api/reconciliation/kino/returns`; assert HTTP `200` dan summary acceptance sesuai Global Constraints.

- [ ] **Step 4: Verify Git scope**

```powershell
git diff --check
git status --short --branch
```

Expected: `.codex/` tidak staged/committed; tidak ada push.

- [ ] **Step 5: Commit only confirmed integration fix**

Jika dan hanya jika verifikasi memerlukan perubahan:

```powershell
git commit -m "fix(reconciliation): complete kino return verification"
```
