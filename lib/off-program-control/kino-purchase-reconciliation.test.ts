import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as XLSX from "xlsx";
import { reconcileKinoPurchases } from "./purchase-reconciliation.ts";

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
  workbook("Table Pvt 1", [
    ["Kode Barang Win", "Kode Pcpl", "ISI/CTN"],
    ...rows,
  ]);

const principal = (...rows: unknown[][]) =>
  workbook("Sheet1", [
    ["ORDER PEMBELIAN"],
    [],
    [],
    [],
    [],
    [],
    ["No. Order", "No. SJ", "No. Item", "Kirim", "Price", "Total"],
    ...rows,
  ]);

const output = reconcileKinoPurchases(
  accurate(
    ["LPB-1", "WIN-A", 2, "KRT", 200, 20, "No. SJ: 1201 | No. Order: 1671-PRO-1"],
    ["LPB-1", "WIN-A", 1, "KRT", 100, 10, "No. SJ: 1201 | No. Order: 1671-PRO-1"],
    ["LPB-2", "WIN-B", 1, "KRT", 50, 5, "No. SJ: 1202 | No. Order: 1671-PRO-2"],
    ["LPB-BAD", "WIN-A", 1, "KRT", 10, 1, "tanpa dokumen"],
  ),
  principal(
    ["1671-PRO-1", "1201", "PC-1", 36, 9.15734, 329.66424],
    ["1671-PRO-2", "1202", "PC-2", 5, 20, 100],
    ["1671-PRO-3", "1203", "UNKNOWN", 1, 10, 10],
  ),
  mapping(["WIN-A", "PC-1", 12], ["WIN-B", "PC-2", 6]),
);

assert.equal(output.summary.MATCH, 1);
assert.equal(output.summary.QTY_MISMATCH, 1);
assert.equal(output.summary.UNMAPPED, 1);
assert.equal(output.summary.INVALID_DATA, 1);
const matched = output.results.find((row) => row.status === "MATCH");
assert.ok(matched);
assert.equal(matched.invoiceNumber, "1671-PRO-1|1201");
assert.equal(matched.accurateProductCode, "WIN-A");
assert.equal(matched.principalProductCode, "PC-1");
assert.equal(matched.accurateQuantity, 36);
assert.equal(matched.principalQuantity, 36);
assert.equal(matched.accurateDpp, 300);
assert.deepEqual(matched.accurateSourceRows, [2, 3]);
assert.deepEqual(matched.principalSourceRows, [8]);

const realPaths = process.argv.slice(2);
if (realPaths.length) {
  assert.equal(realPaths.length, 3, "Berikan Accurate, PO Report, dan mapping");
  const real = reconcileKinoPurchases(
    readFileSync(realPaths[0]),
    readFileSync(realPaths[1]),
    readFileSync(realPaths[2]),
  );
  const matchedRows = real.results.filter((row) => row.status === "MATCH");
  assert.equal(real.accurateLines.length, 401);
  assert.equal(real.principalLines.length, 1120);
  assert.equal(real.summary.MATCH, 270);
  assert.equal(real.summary.MISSING_PRINCIPAL, 64);
  assert.equal(real.summary.MISSING_ACCURATE, 559);
  assert.equal(real.summary.UNMAPPED, 189);
  assert.equal(real.summary.INVALID_DATA, 169);
  assert.ok(matchedRows.every((row) => row.quantityDifference === 0));
  console.log("real simulation: 401 Accurate lines, 1120 KINO lines, 270 MATCH");
}

console.log("kino purchase reconciliation: ok");
