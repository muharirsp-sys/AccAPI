import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as XLSX from "xlsx";
import { reconcileCussonsPurchases } from "./purchase-reconciliation.ts";

function workbook(sheetName: string, rows: unknown[][]): Buffer {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), sheetName);
  return XLSX.write(book, { bookType: "xlsx", type: "buffer" });
}

const accurate = (...rows: unknown[][]) =>
  workbook("Rincian Faktur Pembelian", [
    ["NO. PEMBELIAN", "KODE BARANG", "QTY", "SATUAN", "DPP", "PPN", "REM"],
    ...rows,
  ]);

const mapping = (...rows: unknown[][]) =>
  workbook("Form Fix", [
    [],
    [],
    [],
    [],
    ["KODE PCPL", "ISI/CTN", "SATUAN FIX WIN", "KODE BARANG WIN2"],
    ...rows,
  ]);

const principalHeaders = [
  "Invoice No",
  "Product Code",
  "UOM Code",
  "Default UOM",
  "Received Product Quantity",
  "Invoice Quantity UOM",
  "Product List Price",
  "Customer Discount Amount",
  "Purchase Discount Amount",
  "No Return Discount Amount",
  "Discount Allowance Amount",
  "Net Amount",
  "Tax Percentage",
  "Total Tax Amount",
];
const principal = (...rows: unknown[][]) =>
  Buffer.from(
    [principalHeaders, ...rows]
      .map((row) =>
        row
          .map((value) => `"${String(value ?? "").replaceAll('"', '""')}"`)
          .join(","),
      )
      .join("\n"),
  );
const p = (
  invoice: string,
  product: string,
  quantity: number,
  listPrice: number,
  net: number,
  taxPercentage: number | "" = 11,
  tax: number | "" =
    taxPercentage === "" ? "" : net * taxPercentage / 100,
  received = quantity,
  uom = "CS",
  defaultUom = "EA",
  discounts: Array<number | ""> = [0, 0, 0, 0],
) => [
  invoice,
  product,
  uom,
  defaultUom,
  received,
  quantity,
  listPrice,
  ...discounts,
  net,
  taxPercentage,
  tax,
];

const mappings = mapping(
  ["PC-A", 12, "PCS", "WIN-A"],
  ["PC-B", 24, "PCS", "WIN-B"],
  ["DUP", 12, "PCS", "WIN-A"],
  ["DUP", 24, "PCS", "WIN-B"],
);

const output = reconcileCussonsPurchases(
  accurate(
    ["LPB-1", "WIN-A", 2, "KRT", 100, 16.5, "DO 100000001"],
    ["LPB-1", "WIN-A", 1, "KRT", 50, 16.5, "DO 100000001"],
    ["LPB-2", "WIN-A", 1, "KRT", 10, 0, "x100000002y"],
    ["LPB-11", "WIN-A", 1, "KRT", 10, 0, "100000011"],
    ["LPB-12", "WIN-A", 1, "KRT", 10, 0, "100000012"],
  ),
  principal(
    p("100000001", "PC-A", 2, 50, 100),
    p("100000001", "PC-A", 1, 50, 50),
    p("100000003", "PC-A", 1, 10, 10),
    p("100000004", "UNKNOWN", 1, 10, 10),
    p("100000005", "DUP", 1, 10, 10),
    p("210000006", "PC-A", 1, 10, 10),
    p("100000007", "PC-A", 1, 10, 10, 11, 1.1, 1, "BOX"),
    p("100000008", "PC-A", 1, 10, 10, 11, 1.1, 1, "CS", "KG"),
    p("100000009", "PC-A", 1, 10, 10, 11, 1.1, 2),
    p("100000010", "PC-A", 1, 10, 12),
    p("100000013", "PC-A", 1, 10, 10, 11, 3),
    p("100000011", "PC-A", 1, 10, 10, "", "", 1, "CS", "EA", ["", "", "", ""]),
    p("100000012", "PC-A", 1, 10, 11, "", ""),
  ),
  mappings,
);

assert.equal(output.summary.MATCH, 3);
assert.equal(output.summary.MISSING_ACCURATE, 1);
assert.equal(output.summary.UNMAPPED, 1);
assert.equal(output.summary.INVALID_DATA, 8);
const matched = output.results.find(
  (row) => row.invoiceNumber === "100000001",
);
assert.ok(matched);
assert.equal(matched.status, "MATCH");
assert.equal(matched.accurateQuantity, 3);
assert.equal(matched.principalQuantity, 3);
assert.equal(matched.accurateDpp, 150);
assert.equal(matched.principalDpp, 150);
assert.ok(Math.abs(matched.accurateTax - 16.5) < 1e-9);
assert.ok(Math.abs(matched.principalTax - 16.5) < 1e-9);
assert.deepEqual(matched.accurateSourceRows, [2, 3]);
assert.deepEqual(matched.principalSourceRows, [2, 3]);
assert.equal(output.principalLines.find((row) => row.invoiceNumber === "100000009")?.quantity, 2);
assert.match(
  output.results.find((row) => row.invoiceNumber === "100000005")
    ?.invalidReason ?? "",
  /mapping.*(konflik|ambigu)|invalid/i,
);
assert.match(
  output.results.find((row) => row.invoiceNumber === "210000006")
    ?.invalidReason ?? "",
  /Invoice No tidak valid/,
);
assert.match(
  output.results.find((row) => row.invoiceNumber === "100000010")
    ?.invalidReason ?? "",
  /Net Amount/,
);
assert.match(
  output.results.find((row) => row.invoiceNumber === "100000013")
    ?.invalidReason ?? "",
  /pajak/,
);

const statuses = reconcileCussonsPurchases(
  accurate(
    ["LPB-20", "WIN-A", 1, "KRT", 10, 0, "100000020"],
    ["LPB-21", "WIN-A", 1, "KRT", 10, 0, "100000021"],
    ["LPB-22", "WIN-A", 1, "KRT", 10, 0, "100000022"],
    ["LPB-23", "WIN-A", 1, "KRT", 10, 0, "100000023"],
  ),
  principal(
    p("100000020", "PC-A", 2, 5, 10, "", ""),
    p("100000021", "PC-A", 1, 12, 12, "", ""),
    p("100000022", "PC-A", 2, 12, 24, "", ""),
  ),
  mappings,
);
assert.equal(statuses.summary.QTY_MISMATCH, 1);
assert.equal(statuses.summary.VALUE_MISMATCH, 1);
assert.equal(statuses.summary.QTY_AND_VALUE_MISMATCH, 1);
assert.equal(statuses.summary.MISSING_PRINCIPAL, 1);

const invalidAccurateRows = reconcileCussonsPurchases(
  accurate(
    ["LPB-30", "WIN-A", 1, "PCS", 10, 0, "100000030"],
    ["LPB-31", "UNKNOWN", 1, "KRT", 10, 0, "100000031"],
    ["LPB-32", "WIN-A", 1, "KRT", 10, 0, "100000032 100000033"],
  ),
  principal(),
  mappings,
);
assert.equal(invalidAccurateRows.summary.INVALID_DATA, 3);

const realPaths = process.argv.slice(2);
if (realPaths.length) {
  assert.equal(realPaths.length, 3, "Berikan Accurate, CSV, dan mapping");
  const real = reconcileCussonsPurchases(
    readFileSync(realPaths[0]),
    readFileSync(realPaths[1]),
    readFileSync(realPaths[2]),
  );
  assert.equal(real.accurateLines.length, 249);
  assert.equal(real.principalLines.length, 1_070);
  assert.equal(
    new Set(real.accurateLines.map((row) => row.invoiceNumber)).size,
    7,
  );
  assert.equal(
    new Set(real.principalLines.map((row) => row.invoiceNumber)).size,
    54,
  );
  assert.deepEqual(real.summary, {
    MATCH: 246,
    QTY_MISMATCH: 0,
    VALUE_MISMATCH: 0,
    QTY_AND_VALUE_MISMATCH: 0,
    MISSING_ACCURATE: 812,
    MISSING_PRINCIPAL: 3,
    UNMAPPED: 0,
    INVALID_DATA: 12,
  });
  assert.equal(real.results.length, 1_073);
  console.log(
    "real acceptance: 249/1070 rows; 7/54 invoices; 246 MATCH; 812 MISSING_ACCURATE; 3 MISSING_PRINCIPAL; 12 INVALID_DATA; 1073 results",
  );
}

console.log("cussons purchase reconciliation: ok");
