import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as XLSX from "xlsx";
import { reconcileKinoReturns } from "./return-reconciliation.ts";
import { exportSheets } from "./reconciliation-ui.ts";

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

// One confirmed customer alias applies across invoices, not across customers.
const customerAlias = reconcileKinoReturns(
  workbook("Rincian Faktur Penjualan", [accurateHeader,
    ["R1", "C-IN0087", "WIN1", -1, -30, -3, -33, "1671-SRI-260002102", "Retur Penjualan"],
    ["R2", "C-IN0087", "WIN1", -1, -30, -3, -33, "1671-SRI-260002999", "Retur Penjualan"],
    ["R3", "C-OTHER", "WIN1", -1, -30, -3, -33, "1671-SRI-260002888", "Retur Penjualan"],
    ["R4", "C-IN0050", "WIN1", -1, -30, -3, -33, "1671-SRI-260002103", "Retur Penjualan"],
    ["R5", "C-IN0050", "WIN1", -1, -30, -3, -33, "1671-SRI-260002129", "Retur Penjualan"],
    ["R6", "C-IN0087", "WIN1", -2, -60, -6, -66, "1671-SRI-260002129", "Retur Penjualan"],
  ]),
  workbook("Sheet1", [principalHeader,
    ["1671-SRI-260002102", " c-in0050 ", "P1", -1, -30, 0, 0, 0, -3, -33, "RET01"],
    ["1671-SRI-260002999", "C-IN0050", "P1", -1, -30, 0, 0, 0, -3, -33, "RET01"],
    ["1671-SRI-260002888", "C-IN0050", "P1", -1, -30, 0, 0, 0, -3, -33, "RET01"],
    ["1671-SRI-260002103", "C-IN0050", "P1", -1, -30, 0, 0, 0, -3, -33, "RET01"],
    ["1671-SRI-260002129", "C-IN0050", "P1", -1, -30, 0, 0, 0, -3, -33, "RET01"],
  ]), mapping,
);
assert.equal(customerAlias.summary.MATCH, 4);
assert.equal(customerAlias.summary.MISSING_ACCURATE, 1);
assert.equal(customerAlias.summary.MISSING_PRINCIPAL, 2);
assert.deepEqual(customerAlias.principalLines.map(line => line.customerCode), ["C-IN0087", "C-IN0087", "C-IN0050", "C-IN0050", "C-IN0050"]);
assert(customerAlias.principalLines.every(line => line.customerCodeRaw === "C-IN0050"));
assert.equal(customerAlias.accurateLines[2].customerCode, "C-OTHER");

const alfamartAlias = reconcileKinoReturns(
  workbook("Rincian Faktur Penjualan", [accurateHeader,
    ["A1", "C-ALF052", "WIN1", -1, -30, -3, -33, "1671-SRI-260002098", "Retur Penjualan"],
    ["A2", "C-ALF052", "WIN1", -1, -30, -3, -33, "1671-SRI-260002099", "Retur Penjualan"],
    ["A3", "C-AL0063", "WIN1", -1, -30, -3, -33, "1671-SRI-260002121", "Retur Penjualan"],
    ["A4", "C-ALF052", "WIN1", -2, -60, -6, -66, "1671-SRI-260002121", "Retur Penjualan"],
    ["A5", "C-OTHER", "WIN1", -1, -30, -3, -33, "1671-SRI-260002777", "Retur Penjualan"],
  ]),
  workbook("Sheet1", [principalHeader,
    ...["260002098", "260002099", "260002121", "260002777"].map(id =>
      [`1671-SRI-${id}`, " c-al0063 ", "P1", -1, -30, 0, 0, 0, -3, -33, "RET01"]),
  ]), mapping,
);
assert.equal(alfamartAlias.summary.MATCH, 3);
assert.equal(alfamartAlias.summary.MISSING_ACCURATE, 1);
assert.equal(alfamartAlias.summary.MISSING_PRINCIPAL, 2);
assert.deepEqual(alfamartAlias.principalLines.map(line => line.customerCode), ["C-ALF052", "C-ALF052", "C-AL0063", "C-AL0063"]);
assert(alfamartAlias.principalLines.every(line => line.customerCodeRaw === "C-AL0063"));

for (const [invoice, source, target] of [
  ["1671-SRI-260002156", "C-HE0027", "C-MIT058"],
  ["1671-SRI-260002108", "322630771184", "C-CIT780"],
  ["1671-SRI-260002242", "52410325906", "C-SAT307"],
  ["1671-SRI-260002189", "923120291495", "C-CIT040"],
  ["1671-SRI-260002190", "22120007096", "C-PRA004"],
  ["1671-SRI-260002184", "52330222295", "C-BER030"],
  ["1671-SRI-260002185", "322510497184", "C-SYA061"],
  ["1671-SRI-260002233", "52440374771", "C-ABI010"],
  ["1671-SRI-260002208", "52330224298", "C-TK0006"],
  ["1671-SRI-260002267", "52430367095", "C-UKM004"],
  ["1671-SRI-260002311", "322510498179", "C-DIA062"],
]) {
  const principalRows = workbook("Sheet1", [principalHeader,
    [invoice, source, "P1", -1, -30, 0, 0, 0, -3, -33, "RET01"],
  ]);
  const accurateRow = (customer: string) => ["R1", customer, "WIN1", -1, -30, -3, -33, invoice, "Retur Penjualan"];
  const alias = reconcileKinoReturns(workbook("Rincian Faktur Penjualan", [accurateHeader, accurateRow(target)]), principalRows, mapping);
  assert.equal(alias.summary.MATCH, 1);
  assert.equal(alias.principalLines[0].customerCode, target);
  assert.equal(alias.principalLines[0].customerCodeRaw, source);
  const exact = reconcileKinoReturns(workbook("Rincian Faktur Penjualan", [accurateHeader, accurateRow(source), accurateRow(target)]), principalRows, mapping);
  assert.equal(exact.summary.MATCH, 1);
  assert.equal(exact.principalLines[0].customerCode, source);
  const unrelated = reconcileKinoReturns(workbook("Rincian Faktur Penjualan", [accurateHeader, accurateRow("C-OTHER")]), principalRows, mapping);
  assert.equal(unrelated.summary.MATCH, 0);
  assert.equal(unrelated.principalLines[0].customerCode, source);
}

// Exclude only verified Accurate counterparts, never an entire invoice.
const invPrincipal = workbook("Sheet1", [[...principalHeader, "PAJAK_NO"],
  ["1671-SRI-700", "C1", "P1", -1, -30, 0, 0, 0, -3, -33, "RET01", "inv/2610/kn00046"],
]);
const invAccurateRows = [
  ["R1", "C-OTHER", "WIN1", -1, -30, -3, -33, "INV/2610/KN00046_input - 1671-SRI-700", "Retur Penjualan"],
  ["R2", "C1", "WIN2", -1, -30, -3, -33, "INV/2610/KN00046 - 1671-SRI-700", "Retur Penjualan"],
  ["R3", "C1", "WIN1", -1, -30, -3, -33, "INV/2610/KN000460 - 1671-SRI-700", "Retur Penjualan"],
  ["R4", "C1", "WIN1", -1, -30, -3, -33, "INV/2610/KN00046 - 1671-SRI-701", "Retur Penjualan"],
  ["R5", "C1", "WIN1", -1, -30, -3, -33, "INV/2610/KN00046", "Retur Penjualan"],
];
const invPairs = reconcileKinoReturns(workbook("Rincian Faktur Penjualan", [accurateHeader, ...invAccurateRows]), invPrincipal, mapping);
assert.deepEqual(invPairs.results.find(r => r.status === "MATCH")?.accurateSourceRows, [2]);
assert.equal(invPairs.accurateLines.length, 4);
assert.equal(invPairs.summary.MISSING_PRINCIPAL, 3);
assert.equal(invPairs.summary.INVALID_DATA, 1);
assert.equal(invPairs.summary.MATCH, 1);
assert.deepEqual(invPairs.results.find(r => r.status === "MATCH")?.warnings, []);
for (const [qty, dpp, expected] of [[-1, -31, "MATCH"], [-1, -31.01, "KOREKSI"], [-2, -30, "KOREKSI"]] as const) {
  const row = [...invAccurateRows[0]];
  row[3] = qty;
  row[4] = dpp;
  const checked = reconcileKinoReturns(workbook("Rincian Faktur Penjualan", [accurateHeader, row]), invPrincipal, mapping);
  assert.equal(checked.results[0].status, expected);
  assert.equal(checked.summary.QTY_MISMATCH + checked.summary.VALUE_MISMATCH, 0);
  if (expected === "KOREKSI") assert.match(checked.results[0].warnings[1], /belum cocok/);
}
assert.equal(exportSheets("RETURN", "KINO", invPairs.summary, invPairs.results).detail.find(r => r.Status === "MATCH")?.["Penyebab selisih"], "Tidak ada selisih.");
const mixedInv = reconcileKinoReturns(workbook("Rincian Faktur Penjualan", [accurateHeader, invAccurateRows[0]]),
  workbook("Sheet1", [[...principalHeader, "PAJAK_NO"],
    ["1671-SRI-700", "C1", "P1", -1, -30, 0, 0, 0, -3, -33, "RET01", "INV/2610/KN00046"],
    ["1671-SRI-700", "C-OTHER", "P1", -1, -30, 0, 0, 0, -3, -33, "RET01", "DR-1"],
  ]), mapping);
assert.equal(mixedInv.summary.MATCH, 1);
assert.deepEqual(mixedInv.results.find(r => r.status === "KOREKSI")?.accurateSourceRows, []);

// INV is a correction in Accurate, not a return to compare with KINO.
const correction = ["1671-SRI-99", "C1", "UNKNOWN", -999, -9999, 0, 0, 0, 0, -9999, "RET01"];
const withCorrections = reconcileKinoReturns(accurate, workbook("Sheet1", [
  [...principalHeader, "PAJAK_NO"],
  ["1671-SRI-1", "C1", "P1", -3, -90, 0, 0, 0, -9, -99, "RET01", "RTV-1"],
  [], // Keep physical Excel row numbers in the exclusion audit.
  [...correction, " inv/2610/kn00046 "],
  [...correction, "INV/2610/KN00047"],
  // Same invoice/product as a valid return: only the marked row is ignored.
  ["1671-SRI-1", "C1", "P1", -100, -1000, 0, 0, 0, -100, -1100, "RET01", "INV/1"],
  ["1671-SRI-2", "C2", "P2", -1, -50, 0, 0, 0, -5, -55, "RET01", null],
  ["1671-SRI-3", "C3", "P3", -1, -50, 0, 0, 0, -5, -55, "RET01", "123456"],
  [...correction.slice(0, 10), "SALE", "INV/SALE"],
]), mapping);
assert.equal(withCorrections.summary.KOREKSI, 3);
assert.deepEqual(withCorrections.results.filter(r => r.status === "KOREKSI").flatMap(r => r.principalSourceRows), [4, 5, 6]);
assert.match(withCorrections.results.find(r => r.status === "KOREKSI")!.warnings[0], /INV\/2610\/KN00046/);
assert.equal(withCorrections.principalLines.length, 3);
assert.equal(withCorrections.principalLines.reduce((sum, line) => sum + line.quantity, 0), 5);
assert.equal(withCorrections.principalLines.reduce((sum, line) => sum + line.dpp, 0), 190);
assert.equal(withCorrections.results.some((line) => line.invoiceNumber === "1671-SRI-99" && line.status === "KOREKSI"), true);
assert.equal(withCorrections.results.find((line) => line.invoiceNumber === "1671-SRI-1")?.status, "MATCH");
assert.equal(Object.values(withCorrections.summary).reduce((a, b) => a + b, 0), withCorrections.results.length);
assert.deepEqual(output.ignoredLines, [], "older exports without PAJAK_NO keep existing behavior");
const exported = exportSheets("RETURN", "KINO", withCorrections.summary, withCorrections.results, withCorrections.ignoredLines);
assert.equal(exported.diabaikan.length, 0);
assert.equal(exported.detail.length, withCorrections.results.length);
assert.equal(exported.ringkasan.reduce((sum, row) => sum + row.Jumlah, 0), withCorrections.results.length);
const onlyCorrections = reconcileKinoReturns(workbook("Rincian Faktur Penjualan", [accurateHeader]), workbook("Sheet1", [[...principalHeader, "PAJAK_NO"], [...correction, "INV/1"]]), mapping);
assert.equal(onlyCorrections.results.length, 1);
assert.equal(onlyCorrections.summary.KOREKSI, 1);
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
    .map((row) => [row.invoiceNumber, row.invalidReason]),
  [
    ["BAD1", "REM tidak memuat nomor invoice KINO 1671-SRI."],
    ["BAD2", "REM memuat lebih dari satu nomor invoice KINO 1671-SRI."],
  ],
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
