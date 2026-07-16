# MOTASA Sales Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Menambahkan rekonsiliasi faktur MOTASA lokal yang memasangkan `No.INV` dengan token MK pada `REM`, mengonversi KRT/SCH, menghitung diskon bertingkat dan PPN 11%, lalu menampilkan seluruh selisih pada UI yang sudah ada.

**Architecture:** Tambahkan parser MOTASA khusus di `sales-reconciliation.ts`, tetapi tetap gunakan parser Accurate, canonical line, agregasi, status, toleransi, upload handler, UI, dan ekspor bersama. Master mapping dibaca dari `Form Fix` pada file lokal `data/reconciliation/MOTASA.xlsx`; tidak ada engine, dependency, atau halaman baru.

**Tech Stack:** Next.js 16, TypeScript, React 19, SheetJS `xlsx`, Node assert self-checks, Playwright, ESLint.

## Global Constraints

- Kerjakan hanya pada worktree lokal `D:\MAGANG\OFF PROGRAM CONTROL AFTER REVISI\.worktrees\shinzui-reconciliation`; jangan mengubah `main`, push, atau deploy.
- Jangan menambah dependency atau membuat abstraksi konfigurasi principal generik.
- Mapping authoritative hanya `Form Fix`; jangan fallback ke `Fix Mapping` atau `Query Map.BrgDoubleDms`.
- Seluruh kode/identifier dibaca sebagai teks; toleransi perbandingan nilai tetap Rp1.
- Seluruh baris Accurate tetap masuk union hasil; data Accurate tanpa pasangan MOTASA wajib menjadi `MISSING_PRINCIPAL`.
- Pertahankan API output kompatibel, termasuk nama `kinoLines` dan helper `createKinoSalesPostHandler`.

---

## File Structure

- Modify `lib/off-program-control/sales-reconciliation.ts`: token MK, parser mapping, parser Sales Order, rumus nilai, dan wrapper reconcile MOTASA.
- Create `lib/off-program-control/motasa-sales-validation.test.ts`: self-check sintetis serta acceptance tiga file nyata.
- Modify `lib/off-program-control/kino-sales-route.ts`: whitelist pesan parser MOTASA yang aman.
- Modify `lib/off-program-control/kino-sales-route.test.ts`: memastikan pesan MOTASA aman dan detail internal tetap disamarkan.
- Create `app/api/reconciliation/motasa/sales/route.ts`: wiring permission, mapping lokal, tolerance Rp1, dan pesan master hilang.
- Create local ignored `data/reconciliation/MOTASA.xlsx`: salinan byte-for-byte master mapping yang diberikan; jangan stage.
- Modify `app/(dashboard)/reconciliation/page.tsx`: tambah type dan option MOTASA saja.
- Modify `tests/reconciliation-ui.spec.ts`: satu alur MOTASA pada workflow UI yang sudah ada.

---

### Task 1: Token MK dan Parser Mapping MOTASA

**Files:**
- Modify: `lib/off-program-control/sales-reconciliation.ts:130-158,213-442`
- Create: `lib/off-program-control/motasa-sales-validation.test.ts`

**Interfaces:**
- Consumes: `text`, `unit`, `finite`, `mappingRows`, `value`, `parseAccurateSales` dari engine bersama.
- Produces: `parseMotasaMappings(buffer: Buffer | Uint8Array): MotasaMappings`; `orderNumber(...)` dapat mengekstrak tepat satu `MK\d{10}`.

- [ ] **Step 1: Tulis self-check yang gagal untuk header baris 5, mapping, konflik, dan suffix `<PF>`**

Create `lib/off-program-control/motasa-sales-validation.test.ts` dengan isi awal berikut:

```ts
import assert from "node:assert/strict";
import * as XLSX from "xlsx";
import {
  parseAccurateSales,
  parseMotasaMappings,
} from "./sales-reconciliation.ts";

function workbook(sheets: Record<string, unknown[][]>): Buffer {
  const book = XLSX.utils.book_new();
  for (const [name, rows] of Object.entries(sheets))
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), name);
  return XLSX.write(book, { type: "buffer", bookType: "xlsx" });
}

function formFix(...rows: unknown[][]): Buffer {
  return workbook({
    "Form Fix": [
      ["UPDATE TGL"],
      [],
      ["PASTE NAMA DAN CODE PRINCIPLE"],
      ["ISI SESUAIKAN ANTARA DMS vs WIN"],
      ["Kode BARANG Win2", "ISI/CTN", "SATUAN Fix Win"],
      ...rows,
    ],
  });
}

const mappings = parseMotasaMappings(
  formFix(
    ["M4030000000010", 576, "SCH"],
    ["M4011003000010", 192, "SCH"],
  ),
);
assert.deepEqual(mappings.products.get("M4030000000010"), {
  unit: "SCH",
  caseSize: 576,
  mappingStatus: "OK",
});

const badSize = parseMotasaMappings(
  formFix(["BAD-SIZE", 0, "SCH"]),
);
assert.equal(
  badSize.products.get("BAD-SIZE")?.mappingStatus,
  "UNIT_CONVERSION_ERROR",
);

const conflict = parseMotasaMappings(
  formFix(["DUP", 12, "SCH"], ["DUP", 120, "SCH"]),
);
assert.equal(conflict.products.get("DUP")?.mappingStatus, "INVALID_DATA");

const accurate = workbook({
  "Rincian Faktur Penjualan": [
    [
      "NO_NOTA", "TANGGAL", "KODE PELANGGAN INDUK", "KODE_SALESMAN",
      "KODE_BARANG", "QTY_SATUANKECIL", "SATUAN_KECIL", "NILAI JUAL",
      "POTONGAN", "DPP", "NILAI_PAJAK", "JUMLAH", "REM",
      "JENIS_TRANSAKSI",
    ],
    [
      "INV-1", 46216, "C-1", "S-1", "M4030000000010", 576, "SCH",
      100, 0, 100, 11, 111, "MK2260714005<PF>", "1. Penjualan Bruto",
    ],
  ],
});
assert.equal(parseAccurateSales(accurate)[0]?.orderNumber, "MK2260714005");

console.log("OK - token dan mapping MOTASA tervalidasi.");
```

- [ ] **Step 2: Jalankan test dan pastikan RED**

Run:

```powershell
node --experimental-strip-types lib/off-program-control/motasa-sales-validation.test.ts
```

Expected: FAIL karena `parseMotasaMappings` belum diekspor atau token MK belum dikenali.

- [ ] **Step 3: Tambahkan token MK dan parameter batas pencarian header**

Di `orderNumber(...)`, tambahkan MOTASA ke kumpulan token tanpa mengubah pola principal lain:

```ts
const normalized = text(value),
  kino = normalized.match(/1671-SOP-\d+/g) ?? [],
  godrej = [...normalized.matchAll(/(?:FK\/BFG|FK|BFG)-(\d+)/g)].map(
    (match) => `BFG-${match[1]}`,
  ),
  shinzui = normalized.match(/INVGTS\d+-\d+-\d+/g) ?? [],
  motasa = normalized.match(/MK\d{10}/g) ?? [],
  matches = [...kino, ...godrej, ...shinzui, ...motasa];
```

Ubah helper mapping agar caller lama tetap memakai batas 3, sedangkan MOTASA dapat mencari header fisik baris 5:

```ts
function mappingRows(
  workbook: XLSX.WorkBook,
  sheetName: string,
  required: string[],
  maxRows = 3,
) {
  const sheet = workbook.Sheets[sheetName];
  if (!sheet?.["!ref"])
    throw new Error(`Sheet mapping ${sheetName} tidak ditemukan atau kosong`);
  const rows = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    raw: true,
    defval: null,
    blankrows: false,
  }) as Row[];
  const header = headerIndex(rows, required, maxRows);
  return { rows, columns: header.columns, start: header.rowIndex + 1 };
}
```

- [ ] **Step 4: Implementasikan parser mapping minimum**

Tambahkan dekat interface mapping lain:

```ts
interface MotasaProductMapping {
  unit: string;
  caseSize: number | null;
  mappingStatus: MappingStatus;
}
interface MotasaMappings {
  products: Map<string, MotasaProductMapping>;
}
```

Tambahkan parser sebelum `parseAccurateSales`:

```ts
export function parseMotasaMappings(
  buffer: Buffer | Uint8Array,
): MotasaMappings {
  if (!buffer?.byteLength) throw new Error("File mapping kosong");
  const workbook = XLSX.read(buffer, {
      type: "buffer",
      raw: true,
      cellFormula: false,
    }),
    sheet = mappingRows(
      workbook,
      "Form Fix",
      ["KODE BARANG WIN2", "ISI/CTN", "SATUAN FIX WIN"],
      5,
    ),
    products = new Map<string, MotasaProductMapping>();

  for (let index = sheet.start; index < sheet.rows.length; index++) {
    const row = sheet.rows[index],
      internal = text(value(row, sheet.columns, "KODE BARANG WIN2")),
      smallestUnit = unit(value(row, sheet.columns, "SATUAN FIX WIN")),
      rawCaseSize = value(row, sheet.columns, "ISI/CTN");
    if (!internal && !smallestUnit && !text(rawCaseSize)) continue;
    if (!internal)
      throw new Error(`KODE BARANG WIN2 kosong pada baris ${index + 1}`);

    let caseSize: number | null = null;
    let mappingStatus: MappingStatus = "OK";
    try {
      caseSize = finite(rawCaseSize, "ISI/CTN", index + 1);
      if (caseSize <= 0) mappingStatus = "UNIT_CONVERSION_ERROR";
    } catch {
      mappingStatus = "UNIT_CONVERSION_ERROR";
    }
    if (!smallestUnit || smallestUnit === "0")
      mappingStatus = "UNIT_CONVERSION_ERROR";

    const next = { unit: smallestUnit, caseSize, mappingStatus },
      existing = products.get(internal);
    if (
      existing &&
      (existing.unit !== next.unit || existing.caseSize !== next.caseSize)
    )
      products.set(internal, { ...existing, mappingStatus: "INVALID_DATA" });
    else if (!existing)
      products.set(internal, next);
  }
  return { products };
}
```

- [ ] **Step 5: Jalankan test dan regression parser**

Run:

```powershell
node --experimental-strip-types lib/off-program-control/motasa-sales-validation.test.ts
node --experimental-strip-types lib/off-program-control/sales-reconciliation.test.ts
node --experimental-strip-types lib/off-program-control/godrej-sales-validation.test.ts
node --experimental-strip-types lib/off-program-control/shinzui-sales-validation.test.ts
```

Expected: seluruh command mencetak `OK` dan exit code 0.

- [ ] **Step 6: Commit Task 1**

```powershell
git add lib/off-program-control/sales-reconciliation.ts lib/off-program-control/motasa-sales-validation.test.ts
git commit -m "feat(reconciliation): parse motasa mapping"
```

---

### Task 2: Parser Sales Order, Rumus Nilai, dan Rekonsiliasi Strict

**Files:**
- Modify: `lib/off-program-control/sales-reconciliation.ts:843-1204`
- Modify: `lib/off-program-control/motasa-sales-validation.test.ts`

**Interfaces:**
- Consumes: `MotasaMappings`, `CanonicalSalesLine`, `parseAccurateSales`, `reconcileLines`, `money`, `finite`, `isoDate`, dan `orderNumber`.
- Produces:

```ts
export function parseMotasaSales(
  buffer: Buffer | Uint8Array,
  mappings: MotasaMappings,
): CanonicalSalesLine[];

export function reconcileMotasaSales(
  accurateBuffer: Buffer | Uint8Array,
  motasaBuffer: Buffer | Uint8Array,
  mappingBuffer: Buffer | Uint8Array,
  options: { valueTolerance?: number } = {},
): ReconciliationOutput;
```

- [ ] **Step 1: Perluas self-check dengan fixture principal dan formula yang harus gagal**

Tambahkan ke test setelah blok Task 1:

```ts
const MOTASA_HEADERS = [
  "Tipe", "No.INV", "TGL.INV", "CODE CUST", "CODE SALES", "KODE PRODUK",
  "Kode Gudang", "PRD_QTY", "SATUAN", "Harga", "Disc. 1", "Disc. 2",
  "Disc. 3", "Disc. 4", "Disc. 5", "FIX DISC. VALUE", "TAX_PERC1",
] as const;
type MotasaValues = Record<(typeof MOTASA_HEADERS)[number], unknown>;

function motasaRow(overrides: Partial<MotasaValues> = {}): unknown[] {
  const values: MotasaValues = {
    Tipe: "SD",
    "No.INV": "MK1260714001",
    "TGL.INV": "2026-07-14",
    "CODE CUST": "C-1",
    "CODE SALES": "S-1",
    "KODE PRODUK": "M4030000000010",
    "Kode Gudang": "GD01",
    PRD_QTY: 3,
    SATUAN: "KRT",
    Harga: 414414.414414414,
    "Disc. 1": 0,
    "Disc. 2": 0,
    "Disc. 3": 1,
    "Disc. 4": 0,
    "Disc. 5": 0,
    "FIX DISC. VALUE": 0,
    TAX_PERC1: 0,
    ...overrides,
  };
  return MOTASA_HEADERS.map((header) => values[header]);
}

function principal(...rows: unknown[][]): Buffer {
  return workbook({ Sheet1: [[...MOTASA_HEADERS], ...rows] });
}

const parsedSales = parseMotasaSales(principal(motasaRow()), mappings);
assert.equal(parsedSales[0]?.orderNumber, "MK1260714001");
assert.equal(parsedSales[0]?.quantitySmallest, 1728);
assert.equal(parsedSales[0]?.unitSmallest, "SCH");
assert.equal(parsedSales[0]?.grossAmount, 12_432_432_000);
assert.equal(parsedSales[0]?.discountAmount, 124_324_320);
assert.equal(parsedSales[0]?.dppAmount, 12_308_107_680);
assert.equal(parsedSales[0]?.taxAmount, 1_353_891_845);
assert.equal(parsedSales[0]?.netAmount, 13_661_999_525);

const sachet = parseMotasaSales(
  principal(motasaRow({ PRD_QTY: 72, SATUAN: "SCH", Harga: 719.8198198, "Disc. 3": 0 })),
  mappings,
)[0];
assert.equal(sachet?.quantitySmallest, 72);

const cascading = parseMotasaSales(
  principal(motasaRow({ PRD_QTY: 1, SATUAN: "SCH", Harga: 100, "Disc. 1": 10, "Disc. 2": 10, "Disc. 3": 0, "FIX DISC. VALUE": 5 })),
  mappings,
)[0];
assert.equal(cascading?.grossAmount, 1_000_000);
assert.equal(cascading?.discountAmount, 240_000);
assert.equal(cascading?.dppAmount, 760_000);
assert.equal(cascading?.taxAmount, 83_600);
assert.equal(cascading?.netAmount, 843_600);

for (const [overrides, message] of [
  [{ Tipe: "LAIN" }, /Tipe harus SD pada baris 2/],
  [{ "Disc. 1": 101 }, /DISC\. 1 harus antara 0 dan 100 pada baris 2/],
  [{ "FIX DISC. VALUE": -1 }, /FIX DISC\. VALUE negatif pada baris 2/],
  [{ PRD_QTY: -1 }, /PRD_QTY negatif pada baris 2/],
  [{ PRD_QTY: null }, /PRD_QTY kosong pada baris 2/],
  [{ Harga: null }, /HARGA kosong pada baris 2/],
] as const)
  assert.throws(
    () => parseMotasaSales(principal(motasaRow(overrides)), mappings),
    message,
  );
```

Update import test agar mencakup `parseMotasaSales` dan `reconcileMotasaSales`.

- [ ] **Step 2: Jalankan test dan pastikan RED**

```powershell
node --experimental-strip-types lib/off-program-control/motasa-sales-validation.test.ts
```

Expected: FAIL karena export `parseMotasaSales`/`reconcileMotasaSales` belum tersedia.

- [ ] **Step 3: Implementasikan parser principal dan rumus canonical**

Tambahkan di `sales-reconciliation.ts` sebelum `Aggregate`:

```ts
const MOTASA_DISCOUNT_COLUMNS = [
  "DISC. 1", "DISC. 2", "DISC. 3", "DISC. 4", "DISC. 5",
] as const;

export function parseMotasaSales(
  buffer: Buffer | Uint8Array,
  mappings: MotasaMappings,
): CanonicalSalesLine[] {
  const rows = readRows(buffer, "Sheet1"),
    required = [
      "TIPE", "NO.INV", "TGL.INV", "CODE CUST", "CODE SALES",
      "KODE PRODUK", "PRD_QTY", "SATUAN", "HARGA",
      ...MOTASA_DISCOUNT_COLUMNS, "FIX DISC. VALUE",
    ],
    header = headerIndex(rows, required),
    output: CanonicalSalesLine[] = [];

  for (let index = header.rowIndex + 1; index < rows.length; index++) {
    const row = rows[index], sourceRowNumber = index + 1;
    if (!text(row.find((cell) => text(cell)))) continue;
    const read = (name: string) => value(row, header.columns, name),
      type = requiredText(row, header.columns, "TIPE", sourceRowNumber);
    if (type !== "SD")
      throw new Error(`Tipe harus SD pada baris ${sourceRowNumber}`);

    const quantity = finite(
        requiredText(row, header.columns, "PRD_QTY", sourceRowNumber),
        "PRD_QTY",
        sourceRowNumber,
      ),
      price = finite(
        requiredText(row, header.columns, "HARGA", sourceRowNumber),
        "Harga",
        sourceRowNumber,
      ),
      fixed = finite(
        read("FIX DISC. VALUE"),
        "FIX DISC. VALUE",
        sourceRowNumber,
      );
    if (quantity < 0) throw new Error(`PRD_QTY negatif pada baris ${sourceRowNumber}`);
    if (price < 0) throw new Error(`Harga negatif pada baris ${sourceRowNumber}`);
    if (fixed < 0)
      throw new Error(`FIX DISC. VALUE negatif pada baris ${sourceRowNumber}`);

    const rates = MOTASA_DISCOUNT_COLUMNS.map((name) => {
      const rate = finite(read(name), name, sourceRowNumber);
      if (rate < 0 || rate > 100)
        throw new Error(`${name} harus antara 0 dan 100 pada baris ${sourceRowNumber}`);
      return rate;
    });
    const rawProduct = requiredText(
        row, header.columns, "KODE PRODUK", sourceRowNumber,
      ),
      mapped = mappings.products.get(rawProduct),
      sourceUnit = unit(requiredText(row, header.columns, "SATUAN", sourceRowNumber));

    let mappingStatus: MappingStatus = mapped?.mappingStatus ?? "UNMAPPED_SKU";
    let quantitySmallest = quantity;
    if (mapped?.mappingStatus === "OK") {
      if (sourceUnit === "KRT") quantitySmallest *= mapped.caseSize!;
      else if (sourceUnit !== mapped.unit)
        mappingStatus = "UNIT_CONVERSION_ERROR";
    }

    const roundedPrice = Math.round(price * 10) / 10,
      grossValue = quantity * roundedPrice;
    let dppValue = rates.reduce(
      (balance, rate) => balance * (1 - rate / 100),
      grossValue,
    );
    dppValue -= fixed;
    if (dppValue < 0)
      throw new Error(`DPP MOTASA negatif pada baris ${sourceRowNumber}`);

    const gross = money(grossValue, "Gross MOTASA", sourceRowNumber),
      dpp = money(dppValue, "DPP MOTASA", sourceRowNumber),
      discount = gross - dpp,
      tax = Math.round((dpp * 11) / 100),
      customer = requiredText(row, header.columns, "CODE CUST", sourceRowNumber),
      salesman = requiredText(row, header.columns, "CODE SALES", sourceRowNumber),
      document = requiredText(row, header.columns, "NO.INV", sourceRowNumber);

    output.push({
      source: "PRINCIPAL",
      sourceRowNumber,
      documentNumber: document,
      orderNumber: orderNumber(document, "No.INV", sourceRowNumber),
      transactionDate: isoDate(read("TGL.INV"), "TGL.INV", sourceRowNumber),
      customerCodeRaw: customer,
      customerCodeInternal: customer,
      salesmanCodeRaw: salesman,
      salesmanCodeInternal: salesman,
      productCodeRaw: rawProduct,
      productCodeInternal: rawProduct,
      transactionClass: "NORMAL",
      quantitySmallest,
      unitSmallest: mapped?.unit ?? sourceUnit,
      grossAmount: gross,
      discountAmount: discount,
      dppAmount: dpp,
      taxAmount: tax,
      netAmount: dpp + tax,
      mappingStatus,
    });
  }
  return output;
}
```

- [ ] **Step 4: Tambahkan wrapper reconcile bersama**

Tambahkan dekat wrapper principal lain:

```ts
export function reconcileMotasaSales(
  accurateBuffer: Buffer | Uint8Array,
  motasaBuffer: Buffer | Uint8Array,
  mappingBuffer: Buffer | Uint8Array,
  options: { valueTolerance?: number } = {},
): ReconciliationOutput {
  const accurateLines = parseAccurateSales(accurateBuffer),
    mappings = parseMotasaMappings(mappingBuffer);
  return reconcileLines(
    accurateLines,
    parseMotasaSales(motasaBuffer, mappings),
    options,
  );
}
```

- [ ] **Step 5: Tambahkan acceptance file nyata**

Tambahkan sebelum `console.log` terakhir di test:

```ts
const [accuratePath, principalPath, mappingPath] = process.argv.slice(2);
if (accuratePath && principalPath && mappingPath) {
  const { readFileSync } = await import("node:fs");
  const actual = reconcileMotasaSales(
    readFileSync(accuratePath),
    readFileSync(principalPath),
    readFileSync(mappingPath),
    { valueTolerance: 1 },
  );
  assert.equal(actual.accurateLines.length, 402);
  assert.equal(actual.kinoLines.length, 14);
  assert.equal(actual.results.length, 402);
  assert.equal(actual.summary.MATCH, 14);
  assert.equal(actual.summary.MISSING_PRINCIPAL, 388);
  for (const status of [
    "QTY_MISMATCH", "VALUE_MISMATCH", "QTY_AND_VALUE_MISMATCH",
    "MISSING_INTERNAL", "UNMAPPED_SKU", "UNIT_CONVERSION_ERROR",
    "INVALID_DATA",
  ] as const)
    assert.equal(actual.summary[status], 0);
  for (const row of actual.results.filter((item) => item.status === "MATCH")) {
    assert.equal(row.quantityDifference, 0);
    assert.deepEqual(row.amountDifferences, []);
  }
}
```

- [ ] **Step 6: Jalankan synthetic dan real acceptance**

```powershell
node --experimental-strip-types lib/off-program-control/motasa-sales-validation.test.ts
node --experimental-strip-types lib/off-program-control/motasa-sales-validation.test.ts "C:\Users\Fiqhi Fauzan\Downloads\motasa\rincian_faktur_penjualan_cvsuryaperkasa_260716100112.xlsx" "C:\Users\Fiqhi Fauzan\Downloads\motasa\SalesOrder-2026-07-14 08_37_47.xlsx" "C:\Users\Fiqhi Fauzan\Downloads\motasa\FIX_FORM MASTER BARANG - MOTASA.xlsx"
```

Expected: kedua command exit 0; real acceptance menegaskan 402 hasil, 14 `MATCH`, dan 388 `MISSING_PRINCIPAL`.

- [ ] **Step 7: Commit Task 2**

```powershell
git add lib/off-program-control/sales-reconciliation.ts lib/off-program-control/motasa-sales-validation.test.ts
git commit -m "feat(reconciliation): reconcile motasa sales"
```

---

### Task 3: Pesan Aman, Endpoint, dan Master Mapping Lokal

**Files:**
- Modify: `lib/off-program-control/kino-sales-route.ts:48-101`
- Modify: `lib/off-program-control/kino-sales-route.test.ts:16-18`
- Create: `app/api/reconciliation/motasa/sales/route.ts`
- Create local ignored: `data/reconciliation/MOTASA.xlsx`

**Interfaces:**
- Consumes: `createKinoSalesPostHandler`, `reconcileMotasaSales`, permission `reconciliation.run`.
- Produces: `POST /api/reconciliation/motasa/sales`; pesan master hilang `Master mapping MOTASA tidak tersedia.`

- [ ] **Step 1: Tambahkan assertion RED untuk pesan parser MOTASA**

Tambahkan di `kino-sales-route.test.ts` dekat assertion `safeParserMessage`:

```ts
assert.equal(
  safeParserMessage(new Error("Tipe harus SD pada baris 2")),
  "Tipe harus SD pada baris 2",
);
assert.equal(
  safeParserMessage(
    new Error("DISC. 1 harus antara 0 dan 100 pada baris 2"),
  ),
  "DISC. 1 harus antara 0 dan 100 pada baris 2",
);
assert.equal(
  safeParserMessage(new Error("D:\\secret\\MOTASA.xlsx parser stack")),
  null,
);
```

- [ ] **Step 2: Jalankan handler test dan pastikan RED**

```powershell
node --experimental-strip-types lib/off-program-control/kino-sales-route.test.ts
```

Expected: FAIL karena pesan aman MOTASA belum dikenali.

- [ ] **Step 3: Tambahkan whitelist MOTASA minimum**

Di `safeParserMessage`, tambahkan regex terpisah agar regex lama tidak dirombak:

```ts
const motasaHeaders = [
    "TIPE", "NO.INV", "TGL.INV", "CODE CUST", "CODE SALES",
    "KODE PRODUK", "PRD_QTY", "SATUAN", "HARGA", "DISC. 1",
    "DISC. 2", "DISC. 3", "DISC. 4", "DISC. 5", "FIX DISC. VALUE",
    "KODE BARANG WIN2", "ISI/CTN", "SATUAN FIX WIN",
  ]
    .map((header) => header.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|"),
  motasaMessage = new RegExp(
    `^(?:Header wajib tidak ditemukan: (?:${motasaHeaders})(?:, (?:${motasaHeaders}))*|No\\.INV harus memuat tepat satu nomor order pada baris \\d+|Tipe harus SD pada baris \\d+|(?:DISC\\. [1-5]) (?:tidak valid|terlalu besar|harus antara 0 dan 100) pada baris \\d+|(?:PRD_QTY|Harga|FIX DISC\\. VALUE|Gross MOTASA|DPP MOTASA) (?:negatif|tidak valid|terlalu besar) pada baris \\d+|(?:PRD_QTY|HARGA|NO\\.INV|CODE CUST|CODE SALES|KODE PRODUK|SATUAN) kosong pada baris \\d+|TGL\\.INV tidak valid pada baris \\d+|DPP MOTASA negatif pada baris \\d+|KODE BARANG WIN2 kosong pada baris \\d+)$`,
  );
```

Tambahkan `motasaMessage.test(error.message)` ke kondisi return yang sudah ada.

- [ ] **Step 4: Buat endpoint MOTASA**

Create `app/api/reconciliation/motasa/sales/route.ts`:

```ts
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createKinoSalesPostHandler } from "@/lib/off-program-control/kino-sales-route";
import { reconcileMotasaSales } from "@/lib/off-program-control/sales-reconciliation";
import { requirePermission } from "@/lib/rbac/resolve";

export const runtime = "nodejs";

export const POST = createKinoSalesPostHandler({
  authorize: async (request) =>
    (await requirePermission(request, "reconciliation.run")).response,
  readMapping: () =>
    readFile(path.join(process.cwd(), "data", "reconciliation", "MOTASA.xlsx")),
  reconcile: (accurate, principal, mapping) =>
    reconcileMotasaSales(accurate, principal, mapping, { valueTolerance: 1 }),
  missingMappingMessage: "Master mapping MOTASA tidak tersedia.",
});
```

- [ ] **Step 5: Salin master lokal tanpa staging**

```powershell
Copy-Item -LiteralPath "C:\Users\Fiqhi Fauzan\Downloads\motasa\FIX_FORM MASTER BARANG - MOTASA.xlsx" -Destination "data\reconciliation\MOTASA.xlsx"
Get-FileHash -LiteralPath "C:\Users\Fiqhi Fauzan\Downloads\motasa\FIX_FORM MASTER BARANG - MOTASA.xlsx","data\reconciliation\MOTASA.xlsx" | Select-Object Path,Hash
git check-ignore -v "data/reconciliation/MOTASA.xlsx"
```

Expected: kedua SHA-256 sama dan Git melaporkan file di-ignore. Jangan gunakan `git add -f` untuk master ini.

- [ ] **Step 6: Jalankan handler test, parser real, dan lint terarah**

```powershell
node --experimental-strip-types lib/off-program-control/kino-sales-route.test.ts
node --experimental-strip-types lib/off-program-control/motasa-sales-validation.test.ts "C:\Users\Fiqhi Fauzan\Downloads\motasa\rincian_faktur_penjualan_cvsuryaperkasa_260716100112.xlsx" "C:\Users\Fiqhi Fauzan\Downloads\motasa\SalesOrder-2026-07-14 08_37_47.xlsx" "D:\MAGANG\OFF PROGRAM CONTROL AFTER REVISI\.worktrees\shinzui-reconciliation\data\reconciliation\MOTASA.xlsx"
npx eslint lib/off-program-control/kino-sales-route.ts lib/off-program-control/kino-sales-route.test.ts app/api/reconciliation/motasa/sales/route.ts
```

Expected: tests exit 0 dan ESLint tanpa error.

- [ ] **Step 7: Commit Task 3 tanpa master XLSX**

```powershell
git add lib/off-program-control/kino-sales-route.ts lib/off-program-control/kino-sales-route.test.ts app/api/reconciliation/motasa/sales/route.ts
git status --short
git commit -m "feat(reconciliation): expose local motasa endpoint"
```

Expected: `data/reconciliation/MOTASA.xlsx` tidak berada dalam staged files.

---

### Task 4: Pilihan MOTASA, UI Flow, dan Verifikasi Akhir

**Files:**
- Modify: `app/(dashboard)/reconciliation/page.tsx:22,389-394`
- Modify: `tests/reconciliation-ui.spec.ts:217-252`

**Interfaces:**
- Consumes: endpoint `/api/reconciliation/motasa/sales` dan output `ReconciliationOutput` bersama.
- Produces: pilihan MOTASA, label `Sales Detail MOTASA`, penyebab/baris sumber dinamis, dan ekspor bernama MOTASA.

- [ ] **Step 1: Tambahkan skenario MOTASA yang gagal pada test UI existing**

Di `tests/reconciliation-ui.spec.ts`, setelah blok SHINZUI dan sebelum ekspor, tambahkan:

```ts
await page.reload();
await page.getByLabel("Prinsipal").selectOption("MOTASA");
await expect(
  page.getByText(
    "Bandingkan faktur Accurate dengan data penjualan prinsipal MOTASA.",
  ),
).toBeVisible();
await expect(page.getByLabel("Sales Detail MOTASA")).toBeVisible();
await expect(page.getByLabel("Sales Detail SHINZUI")).toHaveCount(0);
await page.route("**/api/reconciliation/motasa/sales", (route) =>
  route.fulfill({ json: result }),
);
await page
  .getByLabel("Rincian Faktur Penjualan (Accurate)")
  .setInputFiles(xlsx("accurate.xlsx"));
await page
  .getByLabel("Sales Detail MOTASA")
  .setInputFiles(xlsx("motasa.xlsx"));
await page.getByRole("button", { name: "Jalankan rekonsiliasi" }).click();
await expect(
  page.getByText("Accurate: 3 · MOTASA: 6", { exact: true }),
).toBeVisible();
await expect(page.getByLabel("Filter status")).toHaveValue("ISSUES_ONLY");
await expect(
  page.getByText("Jumlah: Accurate 3, MOTASA 6 — Accurate kurang 3", {
    exact: true,
  }),
).toBeVisible();
```

Karena ekspor dilakukan setelah blok ini, ubah assertion filename terakhir menjadi:

```ts
expect(download.suggestedFilename()).toMatch(
  /^hasil-rekonsiliasi-motasa-\d{4}-\d{2}-\d{2}\.xlsx$/,
);
```

- [ ] **Step 2: Jalankan Playwright dan pastikan RED**

Pastikan server worktree lokal tersedia pada URL Playwright, lalu run:

```powershell
npx playwright test tests/reconciliation-ui.spec.ts --project=msedge
```

Expected: FAIL karena option `MOTASA` belum ada.

- [ ] **Step 3: Tambahkan MOTASA ke type dan dropdown saja**

Di `page.tsx`:

```ts
type Principal = "KINO" | "GODREJ" | "SHINZUI" | "MOTASA";
```

Tambahkan option setelah SHINZUI:

```tsx
<option value="MOTASA">MOTASA</option>
```

Jangan ubah fetch, label, status, penyebab, baris sumber, filter, atau ekspor karena semuanya sudah dinamis berdasarkan `principal`.

- [ ] **Step 4: Jalankan UI test dan lint terarah**

```powershell
npx playwright test tests/reconciliation-ui.spec.ts --project=msedge
npx eslint "app/(dashboard)/reconciliation/page.tsx" tests/reconciliation-ui.spec.ts
```

Expected: Playwright PASS dan ESLint tanpa error.

- [ ] **Step 5: Commit Task 4**

```powershell
git add "app/(dashboard)/reconciliation/page.tsx" tests/reconciliation-ui.spec.ts
git commit -m "feat(reconciliation): add motasa to local ui"
```

- [ ] **Step 6: Jalankan seluruh regression yang relevan**

```powershell
node --experimental-strip-types lib/off-program-control/sales-reconciliation.test.ts
node --experimental-strip-types lib/off-program-control/godrej-sales-validation.test.ts
node --experimental-strip-types lib/off-program-control/shinzui-sales-validation.test.ts
node --experimental-strip-types lib/off-program-control/motasa-sales-validation.test.ts
node --experimental-strip-types lib/off-program-control/kino-sales-route.test.ts
node --experimental-strip-types lib/off-program-control/godrej-sales-route.test.ts
node --experimental-strip-types lib/off-program-control/shinzui-sales-route.test.ts
npx eslint lib/off-program-control/sales-reconciliation.ts lib/off-program-control/motasa-sales-validation.test.ts lib/off-program-control/kino-sales-route.ts lib/off-program-control/kino-sales-route.test.ts app/api/reconciliation/motasa/sales/route.ts "app/(dashboard)/reconciliation/page.tsx" tests/reconciliation-ui.spec.ts
npm run build
```

Expected: seluruh self-check mencetak `OK`, ESLint tanpa error, dan build berhasil.

- [ ] **Step 7: Acceptance akhir tiga file nyata**

```powershell
node --experimental-strip-types lib/off-program-control/motasa-sales-validation.test.ts "C:\Users\Fiqhi Fauzan\Downloads\motasa\rincian_faktur_penjualan_cvsuryaperkasa_260716100112.xlsx" "C:\Users\Fiqhi Fauzan\Downloads\motasa\SalesOrder-2026-07-14 08_37_47.xlsx" "D:\MAGANG\OFF PROGRAM CONTROL AFTER REVISI\.worktrees\shinzui-reconciliation\data\reconciliation\MOTASA.xlsx"
```

Expected final contract:

```text
accurateLines = 402
kinoLines = 14
results = 402
MATCH = 14
MISSING_PRINCIPAL = 388
all other statuses = 0
```

Jangan push, deploy, merge, atau mengubah `main` setelah acceptance.
