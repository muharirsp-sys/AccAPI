import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as XLSX from "xlsx";
import { reconcileReckittPurchases } from "./purchase-reconciliation.ts";

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
  workbook("Pvt Map 1", [
    ["Kode BARANG Win2", "SATUAN Fix Win", "Kode Pcpl", "ISI/CTN"],
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
      .map((row) => row.map((value) => String(value ?? "")).join("|"))
      .join("\n"),
  );
const p = (
  invoice: string,
  product: string,
  quantity: number,
  listPrice: number,
  customerDiscount: number,
  net: number,
  taxPercentage = 11,
  tax = net * taxPercentage / 100,
  received = quantity,
  uom = "CAR",
  defaultUom = "EA",
) => [
  invoice, product, uom, defaultUom, received, quantity, listPrice,
  customerDiscount, 0, 0, 0, net, taxPercentage, tax,
];

const output = reconcileReckittPurchases(
  accurate(
    ["LPB-1", "WIN-A", 2, "KRT", 100, 16.5, "DO 1 2100000001"],
    ["LPB-1", "WIN-A", 1, "KRT", 50, 16.5, "DO 1 2100000001"],
    ["LPB-BAD", "WIN-A", 1, "KRT", 10, 1.1, "tanpa invoice"],
  ),
  principal(
    p("2100000001", "PC-1", 2, 55, 10, 100),
    p("2100000001", "PC-1", 1, 55, 5, 50),
    p("2100000002", "UNKNOWN", 1, 10, 0, 10),
    p("2100000003", "DUP", 1, 10, 0, 10),
    p("2100000004", "PC-1", 1, 10, 2, 10),
    p("2100000005", "PC-1", 1, 10, 0, 10, 11, 1.1, 2),
  ),
  mapping(
    ["WIN-A", "PCS", "PC-1", 12],
    ["WIN-A", "PCS", "DUP", 12],
    ["WIN-B", "PCS", "DUP", 6],
  ),
);

assert.equal(output.summary.MATCH, 1);
assert.equal(output.summary.UNMAPPED, 1);
assert.equal(output.summary.INVALID_DATA, 4);
const matched = output.results.find((row) => row.status === "MATCH");
assert.ok(matched);
assert.equal(matched.invoiceNumber, "2100000001");
assert.equal(matched.accurateProductCode, "WIN-A");
assert.equal(matched.principalProductCode, "PC-1");
assert.equal(matched.accurateQuantity, 3);
assert.equal(matched.principalQuantity, 3);
assert.equal(matched.accurateDpp, 150);
assert.equal(matched.principalDpp, 150);
assert.ok(Math.abs(matched.accurateTax - 16.5) < 1e-9);
assert.ok(Math.abs(matched.principalTax - 16.5) < 1e-9);
assert.deepEqual(matched.accurateSourceRows, [2, 3]);
assert.deepEqual(matched.principalSourceRows, [2, 3]);
assert.match(
  output.results.find((row) => row.invoiceNumber === "2100000003")?.invalidReason ?? "",
  /ambigu/i,
);
assert.match(
  output.results.find((row) => row.invoiceNumber === "2100000004")?.invalidReason ?? "",
  /Net Amount/i,
);
assert.match(
  output.results.find((row) => row.invoiceNumber === "2100000005")?.invalidReason ?? "",
  /Received Product Quantity/i,
);

const tolerance = reconcileReckittPurchases(
  accurate(["LPB-1", "WIN-A", 1, "KRT", 100, 11, "2100000001"]),
  principal(p("2100000001", "PC-1", 1, 101, 0, 101)),
  mapping(["WIN-A", "PCS", "PC-1", 12]),
  { dppTolerance: 1 },
);
assert.equal(tolerance.summary.MATCH, 1);

const receivedQuantityCanonical = reconcileReckittPurchases(
  accurate(),
  principal(p("2100000040", "PC-1", 1, 20, 0, 20, 11, 2.2, 2)),
  mapping(["WIN-A", "PCS", "PC-1", 12]),
);
assert.equal(receivedQuantityCanonical.summary.INVALID_DATA, 1);
assert.equal(receivedQuantityCanonical.principalLines[0].quantity, 2);

const separateAccurateDocuments = reconcileReckittPurchases(
  accurate(
    ["LPB-30", "WIN-A", 1, "KRT", 60, 11, "2100000030"],
    ["LPB-30", "WIN-A", 1, "KRT", 40, 11, "2100000030"],
    ["LPB-31", "WIN-A", 1, "KRT", 30, 5.5, "2100000030"],
    ["LPB-31", "WIN-A", 1, "KRT", 20, 5.5, "2100000030"],
  ),
  principal(
    p("2100000030", "PC-1", 1, 60, 0, 60),
    p("2100000030", "PC-1", 1, 40, 0, 40),
    p("2100000030", "PC-1", 1, 30, 0, 30),
    p("2100000030", "PC-1", 1, 20, 0, 20),
  ),
  mapping(["WIN-A", "PCS", "PC-1", 12]),
);
assert.equal(separateAccurateDocuments.summary.MATCH, 1);
assert.equal(separateAccurateDocuments.results[0].accurateTax, 16.5);

const blankOptionalNumbers = reconcileReckittPurchases(
  accurate(["LPB-20", "WIN-A", 1, "KRT", 10, 0, "2100000020"]),
  principal([
    "2100000020", "PC-1", "CAR", "EA", 1, 1, 10,
    "", "", "", "", 10, "", "",
  ]),
  mapping(["WIN-A", "PCS", "PC-1", 12]),
);
assert.equal(blankOptionalNumbers.summary.MATCH, 1);
assert.equal(blankOptionalNumbers.principalLines[0].tax, 0);

const invalidUom = reconcileReckittPurchases(
  accurate(),
  principal(
    p("2100000010", "PC-1", 1, 10, 0, 10, 11, 1.1, 1, "BOX"),
    p("2100000011", "PC-1", 1, 10, 0, 10, 11, 1.1, 1, "PAC", "KG"),
  ),
  mapping(["WIN-A", "PCS", "PC-1", 12]),
);
assert.equal(invalidUom.summary.INVALID_DATA, 2);
assert.match(
  invalidUom.results.find((row) => row.invoiceNumber === "2100000010")?.invalidReason ?? "",
  /UOM Code/,
);
assert.match(
  invalidUom.results.find((row) => row.invoiceNumber === "2100000011")?.invalidReason ?? "",
  /Default UOM/,
);

const realPaths = process.argv.slice(2);
if (realPaths.length) {
  assert.equal(realPaths.length, 3, "Berikan Accurate, CSV, dan mapping");
  const real = reconcileReckittPurchases(
    readFileSync(realPaths[0]),
    readFileSync(realPaths[1]),
    readFileSync(realPaths[2]),
  );
  const accurateDocuments = new Set(real.accurateLines.map((row) => row.invoiceNumber));
  const principalDocuments = new Set(real.principalLines.map((row) => row.invoiceNumber));
  const overlap = new Set([...accurateDocuments].filter((invoice) => principalDocuments.has(invoice)));
  assert.equal(accurateDocuments.size, 16);
  assert.equal(principalDocuments.size, 58);
  assert.equal(real.accurateLines.filter((row) => overlap.has(row.invoiceNumber)).length, 118);
  assert.equal(real.principalLines.filter((row) => overlap.has(row.invoiceNumber)).length, 118);
  assert.equal(real.summary.MATCH, 118);
  assert.equal(real.summary.MISSING_ACCURATE, 674);
  assert.equal(real.results.length, 792);
  console.log("real acceptance: documents 16/58; overlap rows 118/118; 118 MATCH; 674 MISSING_ACCURATE; 792 results");
}

console.log("reckitt purchase reconciliation: ok");
