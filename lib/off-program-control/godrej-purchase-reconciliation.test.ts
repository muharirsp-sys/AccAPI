import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as XLSX from "xlsx";
import { reconcileGodrejPurchases } from "./purchase-reconciliation.ts";

function workbook(sheetName: string, rows: unknown[][]): Buffer {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), sheetName);
  return XLSX.write(book, { bookType: "xlsx", type: "buffer" });
}

const accurateHeaders = [
  "NO. PEMBELIAN",
  "KODE BARANG",
  "NAMA BARANG",
  "QTY",
  "SATUAN",
  "DPP",
  "REM",
];
const accurate = (...rows: unknown[][]) =>
  workbook("Rincian Faktur Pembelian", [accurateHeaders, ...rows]);

const principalHeaders = [
  "Invoice_Number",
  "Bill_No",
  "Approved",
  "Amount_Uploaded",
  "Quantity_in_Units",
  "Quantity_in_Cases",
  "Quantity_Uploaded",
  "Qty_Approved",
  "Sku_Name",
];
const principal = (...rows: unknown[][]) =>
  Buffer.from(
    XLSX.utils.sheet_to_csv(
      XLSX.utils.aoa_to_sheet([principalHeaders, ...rows]),
    ),
  );

const mapping = (...rows: unknown[][]) =>
  workbook("Form Fix", [
    ["Nama Barang Principle", "Kode BARANG Win2", "ISI/CTN"],
    ...rows,
  ]);

const output = reconcileGodrejPurchases(
  accurate(
    [
      "LPB-1",
      "WIN-A",
      "ALPHA WIN",
      2,
      "KRT",
      100,
      "ICBU 1 DMS Bill 79231125 | Stock Transfer 0",
    ],
    [
      "LPB-1",
      "WIN-A",
      "ALPHA WIN",
      1,
      "KRT",
      50,
      "ICBU 1 DMS Bill 79231125 | Stock Transfer 0",
    ],
    [
      "LPB-2",
      "WIN-B",
      "BETA WIN",
      2,
      "KRT",
      200,
      "DMS Bill 79231126",
    ],
    ["LPB-BAD", "WIN-A", "ALPHA WIN", 1, "KRT", 10, "tanpa DMS Bill"],
  ),
  principal(
    ["79231125", "79231125", "Approved", 111, 24, 2, 24, 24, "Product Alpha. 4002102 (12/6)"],
    ["79231125", "79231125", "Approved", 55.5, 12, 1, 12, 12, "PRODUCT-ALPHA 4002102"],
    ["79231126", "79231126", "Approved", 111, 6, 1, 6, 6, "Product Beta 4002103"],
    ["79231127", "79231127", "Approved", 111, 1, 1, 1, 1, "Unknown Product 4999999"],
    ["NOT-APPROVED", "NOT-APPROVED", "Rejected", 999, 12, 1, 12, 12, "Product Alpha 4002102"],
  ),
  mapping(
    ["PRODUCT ALPHA", "WIN-A", 12],
    ["PRODUCT BETA", "WIN-B", 6],
  ),
);

assert.equal(output.accurateLines.length, 4);
assert.equal(output.principalLines.length, 5);
assert.equal(output.summary.MATCH, 1);
assert.equal(output.summary.QTY_AND_VALUE_MISMATCH, 1);
assert.equal(output.summary.UNMAPPED, 1);
assert.equal(output.summary.INVALID_DATA, 2);
const notApproved = output.results.find((row) => row.invoiceNumber === "NOT-APPROVED");
assert.equal(notApproved?.status, "INVALID_DATA");
assert.match(notApproved?.invalidReason ?? "", /Status GRN harus Approved/);
assert.deepEqual(notApproved?.principalSourceRows, [6]);

const matched = output.results.find(
  (row) => row.invoiceNumber === "79231125",
);
assert.ok(matched);
assert.equal(matched.accurateProductCode, "WIN-A");
assert.equal(matched.accurateQuantity, 36);
assert.equal(matched.principalQuantity, 36);
assert.equal(matched.accurateDpp, 150);
assert.ok(Math.abs(matched.principalDpp - 150) < 1e-9);
assert.deepEqual(matched.accurateSourceRows, [2, 3]);
assert.deepEqual(matched.principalSourceRows, [2, 3]);

const mismatch = output.results.find(
  (row) => row.invoiceNumber === "79231126",
);
assert.ok(mismatch);
assert.equal(mismatch.status, "QTY_AND_VALUE_MISMATCH");
assert.equal(mismatch.accurateQuantity, 12);
assert.equal(mismatch.principalQuantity, 6);
assert.ok(Math.abs(mismatch.principalDpp - 100) < 1e-9);

const punctuatedNumericCode = reconcileGodrejPurchases(
  accurate([
    "LPB-1",
    "WIN-A",
    "ALPHA",
    1,
    "KRT",
    100,
    "DMS Bill 1",
  ]),
  principal(["1", "1", "Approved", 111, 12, 1, 12, 12, "Product-Alpha-4002102."]),
  mapping(["PRODUCT ALPHA", "WIN-A", 12]),
);
assert.equal(punctuatedNumericCode.summary.MATCH, 1);

const exactTolerance = reconcileGodrejPurchases(
  accurate([
    "LPB-1",
    "WIN-A",
    "ALPHA",
    1,
    "KRT",
    100,
    "DMS Bill 1",
  ]),
  principal(["1", "1", "Approved", 112.11, 1, 1, 1, 1, "PRODUCT ALPHA 1"]),
  mapping(["PRODUCT ALPHA", "WIN-A", 1]),
  { dppTolerance: 1 },
);
assert.equal(exactTolerance.summary.MATCH, 1);

const namelessAlias = reconcileGodrejPurchases(
  accurate([
    "LPB-1",
    "WIN-A",
    "ALPHA",
    1,
    "KRT",
    100,
    "DMS Bill 1",
  ]),
  principal(["1", "1", "Approved", 111, 12, 1, 12, 12, "PRODUCT ALPHA 1"]),
  mapping(
    ["PRODUCT ALPHA", "WIN-A", 12],
    [null, "WIN-A", 12],
  ),
);
assert.equal(namelessAlias.summary.MATCH, 1);

const namedAliasWithKnownCaseSize = reconcileGodrejPurchases(
  accurate([
    "LPB-1",
    "WIN-A",
    "ALPHA",
    1,
    "KRT",
    100,
    "DMS Bill 1",
  ]),
  principal(["1", "1", "Approved", 111, 12, 1, 12, 12, "PRODUCT ALPHA ALT 1"]),
  mapping(
    ["PRODUCT ALPHA", "WIN-A", 12],
    ["PRODUCT ALPHA ALT", "WIN-A", null],
  ),
);
assert.equal(namedAliasWithKnownCaseSize.summary.MATCH, 1);

assert.throws(
  () =>
    reconcileGodrejPurchases(
      accurate([
        "LPB-1",
        "WIN-A",
        "ALPHA",
        1,
        "KRT",
        1,
        "DMS Bill 1",
      ]),
      principal(),
      mapping(["PRODUCT ALPHA", "WIN-A", null]),
    ),
  /Mapping parsial.*baris 2/,
);

assert.throws(
  () =>
    reconcileGodrejPurchases(
      accurate([
        "LPB-1",
        "WIN-A",
        "ALPHA",
        1,
        "KRT",
        1,
        "DMS Bill 1",
      ]),
      principal(),
      workbook("Form Fix", [
        [
          "Nama Barang Principle",
          "Kode BARANG Win2",
          "Kode BARANG Win2",
          "ISI/CTN",
        ],
        ["PRODUCT ALPHA", "WIN-A", "WIN-B", 1],
      ]),
    ),
  /Header duplikat.*Kode BARANG Win2/,
);

const ambiguous = reconcileGodrejPurchases(
  accurate([
    "LPB-1",
    "WIN-A",
    "ALPHA",
    1,
    "KRT",
    1,
    "DMS Bill 1",
  ]),
  principal(["1", "1", "Approved", 1.11, 1, 1, 1, 1, "DUPLICATE 99"]),
  mapping(["DUPLICATE", "WIN-A", 1], ["DUPLICATE", "WIN-B", 1]),
);
assert.equal(ambiguous.summary.INVALID_DATA, 1);
assert.match(
  ambiguous.results.find((row) => row.status === "INVALID_DATA")!
    .invalidReason!,
  /Mapping nama ambigu.*WIN-A.*WIN-B/,
);

assert.throws(
  () =>
    reconcileGodrejPurchases(
      accurate([
        "LPB-1",
        "WIN-A",
        "ALPHA",
        -1,
        "KRT",
        1,
        "DMS Bill 1",
      ]),
      principal(),
      mapping(["ALPHA", "WIN-A", 1]),
    ),
  /QTY.*non-negatif.*baris 2/,
);

const rowLevelInvalid = reconcileGodrejPurchases(
  accurate(
    ["LPB-1", "WIN-A", "ALPHA", 1, "KRT", 100, "DMS Bill 1"],
    ["LPB-2", "WIN-A", "ALPHA", 1, "KRT", 100, "DMS Bill 2"],
  ),
  principal(
    ["1", "1", "Approved", 111, 12, 2, 12, 12, "PRODUCT ALPHA 1"],
    ["2", "2", "Approved", 111, 12, 1, 12, 12, "PRODUCT ALPHA 1"],
  ),
  mapping(["PRODUCT ALPHA", "WIN-A", 12]),
);
assert.equal(rowLevelInvalid.summary.INVALID_DATA, 1);
assert.equal(rowLevelInvalid.summary.MATCH, 1);
const inconsistent = rowLevelInvalid.results.find((row) => row.invoiceNumber === "1");
assert.equal(inconsistent?.status, "INVALID_DATA");
assert.match(inconsistent?.invalidReason ?? "", /Quantity_in_Cases × ISI\/CTN tidak konsisten/);
assert.deepEqual(inconsistent?.principalSourceRows, [2]);

const missingDocuments = reconcileGodrejPurchases(
  accurate(["LPB-ONLY", "WIN-A", "ALPHA", 1, "KRT", 100, "DMS Bill 10"]),
  principal(["20", "20", "Approved", 111, 12, 1, 12, 12, "PRODUCT ALPHA 1"]),
  mapping(["PRODUCT ALPHA", "WIN-A", 12]),
);
assert.equal(missingDocuments.summary.MISSING_PRINCIPAL, 1);
assert.equal(missingDocuments.summary.MISSING_ACCURATE, 1);

const uploadedQuantityInvalid = reconcileGodrejPurchases(
  accurate(["LPB-3", "WIN-A", "ALPHA", 1, "KRT", 100, "DMS Bill 3"]),
  principal(["3", "3", "Approved", 111, 12, 1, 11, 12, "PRODUCT ALPHA 1"]),
  mapping(["PRODUCT ALPHA", "WIN-A", 12]),
);
assert.equal(uploadedQuantityInvalid.summary.INVALID_DATA, 1);
assert.match(uploadedQuantityInvalid.results[0].invalidReason ?? "", /Quantity_in_Units, Quantity_Uploaded, dan Qty_Approved tidak konsisten/);

const realPaths = process.argv.slice(2);
if (realPaths.length) {
  assert.equal(realPaths.length, 3, "Berikan Accurate, GRN, dan mapping");
  const [accuratePath, principalPath, mappingPath] = realPaths;
  const accurateBuffer = readFileSync(accuratePath);
  const principalBuffer = readFileSync(principalPath);
  const real = reconcileGodrejPurchases(
    accurateBuffer,
    principalBuffer,
    readFileSync(mappingPath),
  );
  const rawAccurateRows = XLSX.utils.sheet_to_json<unknown[]>(
    XLSX.read(accurateBuffer, { type: "buffer" }).Sheets[
      "Rincian Faktur Pembelian"
    ],
    { header: 1 },
  );
  const rawPrincipalRows = XLSX.utils.sheet_to_json<unknown[]>(
    XLSX.read(principalBuffer, { type: "buffer" }).Sheets.Sheet1,
    { header: 1 },
  );
  const rawAccurateDocuments = new Set(
    rawAccurateRows
      .slice(1)
      .map((row) => String(row[41] ?? "").match(/\bDMS\s+Bill\s+(\d+)\b/i)?.[1])
      .filter(Boolean),
  );
  const rawPrincipalDocuments = new Set(
    rawPrincipalRows.slice(1).map((row) => String(row[8] ?? "")),
  );
  const accurateDocuments = new Set(
    real.accurateLines.map((line) => line.invoiceNumber),
  );
  const principalDocuments = new Set(
    real.principalLines.map((line) => line.invoiceNumber),
  );
  const overlap = new Set(
    [...accurateDocuments].filter((invoice) =>
      principalDocuments.has(invoice),
    ),
  );
  assert.equal(accurateDocuments.size, 15);
  assert.equal(principalDocuments.size, 15);
  assert.equal(rawAccurateDocuments.size, 15);
  assert.equal(rawPrincipalDocuments.size, 15);
  assert.equal(overlap.size, 7);
  assert.equal(
    real.accurateLines.filter((line) => overlap.has(line.invoiceNumber)).length,
    368,
  );
  assert.equal(
    real.principalLines.filter((line) => overlap.has(line.invoiceNumber))
      .length,
    368,
  );
  console.log(
    `real simulation: documents ${rawAccurateDocuments.size}/${rawPrincipalDocuments.size}; parsed ${accurateDocuments.size}/${principalDocuments.size}; overlap ${overlap.size}; source rows 368/368`,
  );
}

console.log("godrej purchase reconciliation: ok");
