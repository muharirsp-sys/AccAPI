import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as XLSX from "xlsx";
import { reconcileShinzuiReturns } from "./return-reconciliation.ts";

function workbook(sheets: Record<string, unknown[][]>): Buffer {
  const book = XLSX.utils.book_new();
  for (const [name, rows] of Object.entries(sheets))
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), name);
  return XLSX.write(book, { type: "buffer", bookType: "xlsx" });
}

const ACCURATE_HEADERS = [
  "NO_NOTA",
  "KODE PELANGGAN INDUK",
  "KODE_BARANG",
  "QTY_SATUANKECIL",
  "DPP",
  "NILAI_PAJAK",
  "JUMLAH",
  "REM",
  "JENIS_TRANSAKSI",
] as const;
type AccurateValues = Record<(typeof ACCURATE_HEADERS)[number], unknown>;
function accurateRow(overrides: Partial<AccurateValues>): unknown[] {
  const values: AccurateValues = {
    NO_NOTA: "RET-1",
    "KODE PELANGGAN INDUK": "C-1",
    KODE_BARANG: "I-1",
    QTY_SATUANKECIL: -1,
    DPP: -100,
    NILAI_PAJAK: -11,
    JUMLAH: -111,
    REM: "catatan INVGTS1-2607-000001",
    JENIS_TRANSAKSI: "2. (-) Retur Penjualan",
    ...overrides,
  };
  return ACCURATE_HEADERS.map((header) => values[header]);
}
function accurate(...rows: unknown[][]): Buffer {
  return workbook({ "Rincian Faktur Penjualan": [[...ACCURATE_HEADERS], ...rows] });
}

const PRINCIPAL_HEADERS = [
  "INV Num",
  "Id Produk",
  "Id Pelanggan Lama",
  "Tipe Penjualan",
  "Qty Small",
  "DPP Inv",
  "PPN Inv",
  "Total Inv",
] as const;
type PrincipalValues = Record<(typeof PRINCIPAL_HEADERS)[number], unknown>;
function principalRow(overrides: Partial<PrincipalValues>): unknown[] {
  const values: PrincipalValues = {
    "INV Num": "INVGTS1-2607-000001",
    "Id Produk": "P-1",
    "Id Pelanggan Lama": "C-1",
    "Tipe Penjualan": "RETUR",
    "Qty Small": -1,
    "DPP Inv": -100,
    "PPN Inv": -11,
    "Total Inv": -111,
    ...overrides,
  };
  return PRINCIPAL_HEADERS.map((header) => values[header]);
}
function principal(...rows: unknown[][]): Buffer {
  return workbook({
    PenjualanInvoice: [["LAPORAN"], ["PERIODE"], [...PRINCIPAL_HEADERS], ...rows],
  });
}

function mapping(...rows: unknown[][]): Buffer {
  return workbook({
    "Fix Mapping": [
      ["KODE BARANG", "PCPL KODE 1", "PCPL KODE 2", "PCPL KODE 3", "PCPL KODE 4", "PCPL KODE 5"],
      ...rows,
    ],
  });
}

const mappings = mapping(
  ["I-1", "P-1", 0, 0, 0, 0],
  ["I-2", "P-2", 0, 0, 0, 0],
  ["I-3", "P-3", 0, 0, 0, 0],
  ["I-4", "P-4", 0, 0, 0, 0],
  ["I-5", "P-5", 0, 0, 0, 0],
  ["I-7", "OLD-P-7", "P-7", 0, 0, 0],
  ["I-8", "P-8", 0, 0, 0, 0],
);

const output = reconcileShinzuiReturns(
  accurate(
    accurateRow({ QTY_SATUANKECIL: -1, DPP: -50, NILAI_PAJAK: -5.5, JUMLAH: -55.5 }),
    accurateRow({ QTY_SATUANKECIL: 1, DPP: 50, NILAI_PAJAK: 5.5, JUMLAH: 55.5 }),
    accurateRow({ REM: "INVGTS1-2607-000002", "KODE PELANGGAN INDUK": "C-2", KODE_BARANG: "I-2", QTY_SATUANKECIL: 2, DPP: 200 }),
    accurateRow({ REM: "INVGTS1-2607-000003", "KODE PELANGGAN INDUK": "C-3", KODE_BARANG: "I-3", QTY_SATUANKECIL: 2, DPP: 200 }),
    accurateRow({ REM: "INVGTS1-2607-000004", "KODE PELANGGAN INDUK": "C-4", KODE_BARANG: "I-4", QTY_SATUANKECIL: 2, DPP: 200 }),
    accurateRow({ REM: "INVGTS1-2607-000005", "KODE PELANGGAN INDUK": "C-5", KODE_BARANG: "I-5" }),
    accurateRow({ REM: "INVGTS1-2607-000006", "KODE PELANGGAN INDUK": "C-6", KODE_BARANG: "NO-MAP" }),
    accurateRow({ REM: "INVGTS1-2607-000006", "KODE PELANGGAN INDUK": "C-6", KODE_BARANG: "NO-MAP", QTY_SATUANKECIL: 2, DPP: 200 }),
    accurateRow({ REM: "INVGTS1-2607-000007", "KODE PELANGGAN INDUK": "C-7", KODE_BARANG: "I-7" }),
    accurateRow({ REM: "INVGTS1-2607-000007", "KODE PELANGGAN INDUK": "C-8", KODE_BARANG: "I-7", QTY_SATUANKECIL: 2, DPP: 200 }),
    accurateRow({ REM: "INVGTS1-2607-999999", JENIS_TRANSAKSI: "Jual" }),
  ),
  principal(
    principalRow({ "Qty Small": -2 }),
    principalRow({ "INV Num": "INVGTS1-2607-000002", "Id Pelanggan Lama": "C-2", "Id Produk": "P-2", "Qty Small": -3, "DPP Inv": -200 }),
    principalRow({ "INV Num": "INVGTS1-2607-000003", "Id Pelanggan Lama": "C-3", "Id Produk": "P-3", "Qty Small": -2, "DPP Inv": -202 }),
    principalRow({ "INV Num": "INVGTS1-2607-000004", "Id Pelanggan Lama": "C-4", "Id Produk": "P-4", "Qty Small": -3, "DPP Inv": -202 }),
    principalRow({ "INV Num": "INVGTS1-2607-000007", "Id Pelanggan Lama": "C-7", "Id Produk": "P-7" }),
    principalRow({ "INV Num": "INVGTS1-2607-000007", "Id Pelanggan Lama": "C-8", "Id Produk": "OLD-P-7", "Qty Small": -2, "DPP Inv": -200 }),
    principalRow({ "INV Num": "INVGTS1-2607-000008", "Id Pelanggan Lama": "C-9", "Id Produk": "P-8" }),
    principalRow({ "INV Num": "INVGTS1-2607-999999", "Tipe Penjualan": "PROMO" }),
  ),
  mappings,
  { dppTolerance: 1 },
);

assert.deepEqual(output.summary, {
  MATCH: 3,
  QTY_MISMATCH: 1,
  VALUE_MISMATCH: 1,
  QTY_AND_VALUE_MISMATCH: 1,
  MISSING_ACCURATE: 1,
  MISSING_PRINCIPAL: 1,
  UNMAPPED: 1,
  INVALID_DATA: 0,
});
const match = output.results.find((row) => row.invoiceNumber.endsWith("000001"));
assert.equal(match?.accurateQuantity, 2);
assert.equal(match?.accurateDpp, 100);
assert.equal(match?.dppDifference, 0);
assert.equal(output.accurateLines.length, 10);
assert.equal(output.principalLines.length, 7);
assert.equal(
  output.results.find((row) => row.customerCode === "C-8")?.status,
  "MATCH",
);
assert.equal(
  output.results.find((row) => row.customerCode === "C-7")?.principalProductCode,
  "P-7",
);
assert.equal(
  output.results.find((row) => row.customerCode === "C-8")?.principalProductCode,
  "OLD-P-7",
);
assert.equal(
  output.results.find((row) => row.status === "UNMAPPED")?.accurateProductCode,
  "NO-MAP",
);
const unmapped = output.results.find((row) => row.status === "UNMAPPED");
assert.equal(unmapped?.accurateQuantity, 3);
assert.equal(unmapped?.accurateDpp, 300);
assert.deepEqual(unmapped?.accurateSourceRows, [8, 9]);

const deepHeader = workbook({
  "Rincian Faktur Penjualan": [
    ...Array.from({ length: 11 }, () => ["PREAMBLE"]),
    [...ACCURATE_HEADERS],
    accurateRow({}),
  ],
});
assert.equal(
  reconcileShinzuiReturns(deepHeader, principal(principalRow({})), mappings).summary.MATCH,
  1,
);
for (const rem of ["tanpa nomor", "INVGTS1-2607-000001 INVGTS1-2607-000002"])
  assert.throws(
    () => reconcileShinzuiReturns(accurate(accurateRow({ REM: rem })), principal(), mappings),
    /REM harus memuat tepat satu nomor invoice pada baris 2/,
  );

if (process.argv.length > 2) {
  assert.equal(process.argv.length, 5, "berikan path Accurate, principal, dan mapping");
  const real = reconcileShinzuiReturns(
    readFileSync(process.argv[2]),
    readFileSync(process.argv[3]),
    readFileSync(process.argv[4]),
    { dppTolerance: 1 },
  );
  assert.equal(real.results.length, 11);
  assert.equal(real.summary.MATCH, 11);
  assert.equal(real.accurateLines.reduce((sum, row) => sum + row.quantity, 0), 29);
  assert.equal(real.principalLines.reduce((sum, row) => sum + row.quantity, 0), 29);
  assert.ok(Math.abs(real.accurateLines.reduce((sum, row) => sum + row.dpp, 0) - 361351.3503) < 0.0001);
  assert.ok(Math.abs(real.principalLines.reduce((sum, row) => sum + row.dpp, 0) - 361351.3503) < 0.0001);
}

console.log("shinzui return reconciliation: ok");
