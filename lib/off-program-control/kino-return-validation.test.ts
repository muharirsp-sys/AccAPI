import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as XLSX from "xlsx";
import { reconcileKinoReturns } from "./return-reconciliation.ts";

function workbook(
  sheetName: string,
  rows: unknown[][],
  extraSheets: [string, unknown[][]][] = [],
): Buffer {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), sheetName);
  for (const [name, values] of extraSheets)
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(values), name);
  return XLSX.write(book, { bookType: "xlsx", type: "buffer" });
}

const mapping = workbook("Table Pvt 1", [
  ["Kode Barang Win", "Kode Pcpl", "SATUAN Fix Win", "ISI/CTN"],
  ["WIN1", "P1", "PCS", 1],
  ["WIN1", "P1B", "PCS", 1],
  ["WIN2", "P2", "PCS", 1],
  ["WIN3", "P3", "PCS", 1],
  ["WIN4", "P4", "PCS", 1],
  ["WIN5", "P5", "PCS", 1],
]);

const accurateHeader = [
  "NO_NOTA",
  "KODE PELANGGAN INDUK",
  "KODE_BARANG",
  "QTY_SATUANKECIL",
  "DPP",
  "NILAI_PAJAK",
  "JUMLAH",
  "REM",
  "JENIS_TRANSAKSI",
];
const accurate = workbook("Rincian Faktur Penjualan", [
  accurateHeader,
  ["R1", "C1", "WIN1", -1, -30, -3, -33, "x 1671-SRI-1", "2. (-) Retur Penjualan"],
  ["R1", "C1", "WIN1", -2, -60, -6, -66, "x 1671-SRI-1", "2. (-) Retur Penjualan"],
  ["R2", "C2", "WIN2", -1, -51, -5, -56, "1671-SRI-2", "Retur Penjualan"],
  ["R3", "C3", "WIN3", -1, -52, -5, -57, "1671-SRI-3", "Retur Penjualan"],
  ["R5", "C5", "WIN5", -1, -10, -1, -11, "1671-SRI-5", "Retur Penjualan"],
  ["BAD1", "C1", "WIN1", -1, -1, 0, -1, "tanpa invoice", "Retur Penjualan"],
  ["BAD2", "C1", "WIN1", -1, -1, 0, -1, "1671-SRI-8 dan 1671-SRI-9", "Retur Penjualan"],
  ["SALE", "C1", "WIN1", 99, 99, 0, 99, "1671-SRI-1", "Faktur Penjualan"],
]);

const principalHeader = [
  "INVOICE_NO",
  "CUSTCODE2",
  "PRODUCT_CODE",
  "INVOICE_QTY",
  "INVOICE_GROSS",
  "INVOICE_TOTALLINEDISC",
  "INVOICE_PROMO",
  "INVOICE_CASHDISC",
  "INVOICE_TAX",
  "INVOICE_NET",
  "INVOICE_TYPE",
];
const principal = workbook("Sheet1", [
  principalHeader,
  ["1671-SRI-1", "C1", "P1", -1, -40, -5, -3, -2, -3, -33, "RET01"],
  ["1671-SRI-1", "C1", "P1B", -2, -80, -10, -5, -5, -6, -66, "RET01"],
  ["1671-SRI-2", "C2", "P2", -1, -50, 0, 0, 0, -5, -55, "RET01"],
  ["1671-SRI-3", "C3", "P3", -1, -50, 0, 0, 0, -5, -55, "RET01"],
  ["1671-SRI-4", "C4", "P4", -1, -10, 0, 0, 0, -1, -11, "RET01"],
  ["1671-SRI-6", "C6", "UNKNOWN", -1, -10, 0, 0, 0, -1, -11, "RET01"],
  ["Total for invoice", null, null, null, null, null, null, null, null, null, null],
  ["Grand Total", null, null, null, null, null, null, null, null, null, null],
  ["1671-SRI-7", "C7", "P1", -99, -99, 0, 0, 0, 0, -99, "SALE"],
]);

const output = reconcileKinoReturns(accurate, principal, mapping, {
  dppTolerance: 1,
});
assert.deepEqual(output.summary, {
  MATCH: 2,
  QTY_MISMATCH: 0,
  VALUE_MISMATCH: 1,
  QTY_AND_VALUE_MISMATCH: 0,
  MISSING_ACCURATE: 1,
  MISSING_PRINCIPAL: 1,
  UNMAPPED: 1,
  INVALID_DATA: 2,
});
assert.equal(
  output.results.find((row) => row.invoiceNumber === "1671-SRI-1")?.dppDifference,
  0,
);
assert.equal(
  output.results.find((row) => row.invoiceNumber === "1671-SRI-1")
    ?.principalProductCode,
  "P1, P1B",
);
assert.equal(
  output.results.find((row) => row.invoiceNumber === "1671-SRI-2")?.status,
  "MATCH",
);
assert.deepEqual(
  output.results
    .filter((row) => row.status === "INVALID_DATA")
    .map((row) => row.invoiceNumber),
  ["BAD1", "BAD2"],
);

const fixMappingHeader = [
  "KODE BARANG",
  "PCPL KODE 1",
  "PCPL KODE 2",
  "PCPL KODE 3",
  "PCPL KODE 4",
  "PCPL KODE 5",
];
const fallbackMapping = workbook(
  "Table Pvt 1",
  [["Kode Barang Win", "Kode Pcpl"]],
  [
    [
      "Fix Mapping",
      [
        fixMappingHeader,
        ["WIN1", "P1", "P1B", 0, 0, 0],
      ],
    ],
  ],
);
assert.equal(
  reconcileKinoReturns(accurate, principal, fallbackMapping).results.find(
    (row) => row.invoiceNumber === "1671-SRI-1",
  )?.status,
  "MATCH",
);
const conflictMapping = workbook(
  "Table Pvt 1",
  [
    ["Kode Barang Win", "Kode Pcpl"],
    ["WIN1", "P1"],
  ],
  [["Fix Mapping", [fixMappingHeader, ["OTHER", "P1", 0, 0, 0, 0]]]],
);
assert.throws(
  () => reconcileKinoReturns(accurate, principal, conflictMapping),
  /Mapping produk KINO konflik untuk P1/,
);
const validPrincipalRow = [
  "1671-SRI-1",
  "C1",
  "P1",
  -1,
  -30,
  0,
  0,
  0,
  -3,
  -33,
  "RET01",
];
for (const name of [
  "INVOICE_QTY",
  "INVOICE_GROSS",
  "INVOICE_TAX",
  "INVOICE_NET",
]) {
  const row = [...validPrincipalRow];
  row[principalHeader.indexOf(name)] = null;
  assert.throws(
    () =>
      reconcileKinoReturns(
        accurate,
        workbook("Sheet1", [principalHeader, row]),
        mapping,
      ),
    new RegExp(`${name} kosong`),
  );
}
for (const name of ["QTY_SATUANKECIL", "DPP", "NILAI_PAJAK", "JUMLAH"]) {
  const validAccurateRow = [
    "R1",
    "C1",
    "WIN1",
    -1,
    -30,
    -3,
    -33,
    "1671-SRI-1",
    "Retur Penjualan",
  ];
  validAccurateRow[accurateHeader.indexOf(name)] = null;
  assert.throws(
    () =>
      reconcileKinoReturns(
        workbook("Rincian Faktur Penjualan", [
          accurateHeader,
          validAccurateRow,
        ]),
        principal,
        mapping,
      ),
    new RegExp(`${name} kosong`),
  );
}
console.log("KINO Return synthetic validation passed.");

if (process.argv.length === 5) {
  const real = reconcileKinoReturns(
    readFileSync(process.argv[2]),
    readFileSync(process.argv[3]),
    readFileSync(process.argv[4]),
  );
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
  assert.equal(real.accurateLines.length, 42);
  assert.equal(real.principalLines.length, 10);
  assert.equal(
    real.principalLines.filter((row) => row.accurateProductCode !== null)
      .length,
    10,
  );
  const matched = real.results.filter((row) => row.status === "MATCH");
  const sum = (field: "accurateQuantity" | "accurateDpp" | "principalTax" | "principalTotal") =>
    matched.reduce((total, row) => total + row[field], 0);
  assert.equal(sum("accurateQuantity"), 17);
  assert.ok(Math.abs(sum("accurateDpp") - 293828.8287) < 0.0001);
  assert.ok(Math.abs(sum("principalTax") - 18655.4053) < 0.0001);
  assert.ok(Math.abs(sum("principalTotal") - 312484.234) < 0.0001);
  console.log("KINO Return real-workbook validation passed.");
}
