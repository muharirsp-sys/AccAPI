import assert from "node:assert/strict";
import * as XLSX from "xlsx";
import { reconcileHeinzReturns } from "./return-reconciliation.ts";

function workbook(sheets: Record<string, unknown[][]>): Uint8Array {
  const book = XLSX.utils.book_new();
  for (const [name, rows] of Object.entries(sheets))
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), name);
  return new Uint8Array(XLSX.write(book, { bookType: "xlsx", type: "buffer" }));
}

function csv(rows: (string | number)[][]): Uint8Array {
  const escaped = rows.map((row) =>
    row
      .map((value) => {
        const text = String(value);
        return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
      })
      .join(","),
  );
  return new TextEncoder().encode(escaped.join("\r\n"));
}

const accurate = workbook({
  "Rincian Faktur Penjualan": [
    [
      "NO_NOTA",
      "KODE PELANGGAN INDUK",
      "KODE_BARANG",
      "QTY_SATUANKECIL",
      "DPP",
      "NILAI_PAJAK",
      "JUMLAH",
      "REM",
      "JENIS_TRANSAKSI",
    ],
    ["RET-1", "C-A", "INT-1", 3, 300, 33, 333, "CN-1", "Retur Penjualan"],
    [
      "RET-2",
      "C-A",
      "INT-1",
      1,
      100,
      11,
      111,
      "CN-2",
      "Retur Penjualan",
    ],
    [
      "RET-BAD",
      "C-A",
      "INT-1",
      1,
      100,
      11,
      111,
      "CN-7 dan CN-8",
      "Retur Penjualan",
    ],
    ["SALE-1", "C-A", "INT-1", 99, 99, 99, 99, "CN-1", "Faktur Penjualan"],
  ],
});

const headerColumns = [
  "credit_note_number",
  "goods_return_note_number",
  "sales_representative_code",
  "retailer_code",
  "retailer_name",
  "credit_note_date",
  "invoice_number",
  "remarks",
  "line_count",
  "net_value",
  "status",
];
const headers = csv([
  headerColumns,
  ["CN-1", "GRN-1", "S1", "OLD-1", "TOKO A C-A", "2026-07-22", "I1", "", 2, 333, "Approved"],
  ["CN-3", "GRN-3", "S1", "OLD-3", "TOKO P C-P", "2026-07-22", "I3", "", 1, 111, "Approved"],
  ["CN-4", "GRN-4", "S1", "OLD-4", "TOKO U C-U", "2026-07-22", "I4", "", 1, 111, "Approved"],
  ["CN-5", "GRN-5", "S1", "OLD-5", "TOKO L C-L", "2026-07-22", "I5", "", 2, 111, "Approved"],
  ["CN-6", "GRN-6", "S1", "OLD-6", "TOKO R C-R", "2026-07-22", "I6", "", 0, 0, "Rejected"],
]);

const detailColumns = [
  "credit_note_number",
  "line_number",
  "distributor_stock_keeping_unit",
  "unit_quantity",
  "unit",
  "eaches_quantity",
  "unit_price",
  "gross_value",
  "return_code",
];
const details = csv([
  detailColumns,
  ["CN-1", 1, "P-1", 1, "PCS", 1, 111, 111, "R1"],
  ["CN-1", 2, "P-1", 2, "PCS", 2, 111, 222, "R1"],
  ["CN-3", 1, "P-1", 1, "PCS", 1, 111, 111, "R1"],
  ["CN-4", 1, "UNMAPPED", 1, "PCS", 1, 111, 111, "R1"],
  ["CN-5", 1, "P-1", 1, "PCS", 1, 111, 111, "R1"],
  ["CN-999", 1, "P-1", 1, "PCS", 1, 111, 111, "R1"],
]);

function mapping(secondInternal = ""): Uint8Array {
  return workbook({
    "Fix Mapping": [
      [
        "KODE BARANG",
        "PCPL KODE 1",
        "PCPL KODE 2",
        "PCPL KODE 3",
        "PCPL KODE 4",
        "PCPL KODE 5",
      ],
      ["INT-1", "P-1", 0, "", "", ""],
      ...(secondInternal
        ? [[secondInternal, "P-1", "", "", "", ""]]
        : []),
    ],
  });
}

const output = reconcileHeinzReturns(
  accurate,
  headers,
  details,
  mapping(),
  { dppTolerance: 1 },
);

assert.deepEqual(output.summary, {
  MATCH: 1,
  QTY_MISMATCH: 0,
  VALUE_MISMATCH: 0,
  QTY_AND_VALUE_MISMATCH: 0,
  MISSING_ACCURATE: 1,
  MISSING_PRINCIPAL: 1,
  UNMAPPED: 1,
  INVALID_DATA: 3,
});

const match = output.results.find((row) => row.status === "MATCH");
assert.ok(match);
assert.equal(match.invoiceNumber, "CN-1");
assert.equal(match.customerCode, "C-A");
assert.equal(match.accurateProductCode, "INT-1");
assert.equal(match.principalProductCode, "P-1");
assert.equal(match.principalQuantity, 3);
assert.ok(Math.abs(match.principalDpp - 300) < 1e-9);
assert.ok(Math.abs(match.principalTax - 33) < 1e-9);
assert.equal(match.principalTotal, 333);
assert.deepEqual(match.principalSourceRows, [2, 3]);

assert.ok(
  output.results.some(
    (row) =>
      row.status === "MISSING_PRINCIPAL" && row.invoiceNumber === "CN-2",
  ),
);
assert.ok(
  output.results.some(
    (row) =>
      row.status === "MISSING_ACCURATE" && row.invoiceNumber === "CN-3",
  ),
);
assert.ok(
  output.results.some(
    (row) => row.status === "UNMAPPED" && row.invoiceNumber === "CN-4",
  ),
);
assert.ok(
  output.results.some(
    (row) =>
      row.status === "INVALID_DATA" &&
      row.invalidReason?.includes("lebih dari satu nomor return HEINZ"),
  ),
);
assert.ok(
  output.results.some(
    (row) =>
      row.status === "INVALID_DATA" &&
      row.invalidReason?.includes("line_count 2 tidak sama dengan 1 detail"),
  ),
);
assert.ok(
  output.results.some(
    (row) =>
      row.status === "INVALID_DATA" &&
      row.invalidReason?.includes("HEADER Approved tidak ditemukan"),
  ),
);
assert.equal(
  output.principalLines.some((line) => line.invoiceNumber === "CN-6"),
  false,
);

assert.throws(
  () => reconcileHeinzReturns(accurate, headers, details, mapping("INT-2")),
  /Mapping produk HEINZ konflik untuk P-1/,
);

const duplicateHeaders = csv([
  headerColumns,
  ["CN-1", "GRN-1", "S1", "OLD-1", "TOKO A C-A", "2026-07-22", "I1", "", 2, 333, "Approved"],
  ["CN-1", "GRN-2", "S1", "OLD-1", "TOKO A C-A", "2026-07-22", "I1", "", 2, 333, "Approved"],
]);
assert.throws(
  () =>
    reconcileHeinzReturns(
      accurate,
      duplicateHeaders,
      details,
      mapping(),
    ),
  /credit_note_number duplikat CN-1/,
);

const accurateEmpty = workbook({
  "Rincian Faktur Penjualan": [
    [
      "NO_NOTA",
      "KODE PELANGGAN INDUK",
      "KODE_BARANG",
      "QTY_SATUANKECIL",
      "DPP",
      "NILAI_PAJAK",
      "JUMLAH",
      "REM",
      "JENIS_TRANSAKSI",
    ],
  ],
});
const joinOutput = reconcileHeinzReturns(
  accurateEmpty,
  csv([
    headerColumns,
    ["CN-10", "GRN-10", "S1", "OLD-10", "TOKO E C-E", "2026-07-22", "I10", "", 1, 111, "Approved"],
    ["CN-11", "GRN-11", "S1", "OLD-11", "TOKO R C-R", "2026-07-22", "I11", "", 1, 111, "Rejected"],
  ]),
  csv([
    detailColumns,
    ["CN-11", 1, "P-1", 1, "PCS", 1, 111, 111, "R1"],
  ]),
  mapping(),
);
assert.equal(joinOutput.summary.INVALID_DATA, 2);
assert.equal(joinOutput.results.length, 2);
assert.equal(joinOutput.results[0].invoiceNumber, "CN-11");
assert.deepEqual(joinOutput.results[0].principalSourceRows, [2]);
assert.match(
  joinOutput.results[0].invalidReason ?? "",
  /HEADER Approved tidak ditemukan/,
);
assert.equal(joinOutput.results[1].invoiceNumber, "CN-10");
assert.match(
  joinOutput.results[1].invalidReason ?? "",
  /line_count 1 tidak sama dengan 0 detail/,
);

for (const invalidLineCount of [-1, 1.5])
  assert.throws(
    () =>
      reconcileHeinzReturns(
        accurate,
        csv([
          headerColumns,
          ["CN-1", "GRN-1", "S1", "OLD-1", "TOKO A C-A", "2026-07-22", "I1", "", invalidLineCount, 111, "Approved"],
        ]),
        csv([
          detailColumns,
          ["CN-1", 1, "P-1", 1, "PCS", 3, 111, 333, "R1"],
        ]),
        mapping(),
      ),
    /line_count harus bilangan bulat non-negatif pada baris 2/,
  );

function accurateDpp(dpp: number): Uint8Array {
  return workbook({
    "Rincian Faktur Penjualan": [
      [
        "NO_NOTA",
        "KODE PELANGGAN INDUK",
        "KODE_BARANG",
        "QTY_SATUANKECIL",
        "DPP",
        "NILAI_PAJAK",
        "JUMLAH",
        "REM",
        "JENIS_TRANSAKSI",
      ],
      ["RET-1", "C-A", "INT-1", 1, dpp, 11, 111, "CN-1", "Retur Penjualan"],
    ],
  });
}
const oneLineHeaders = csv([
  headerColumns,
  ["CN-1", "GRN-1", "S1", "OLD-1", "TOKO A C-A", "2026-07-22", "I1", "", 1, 111, "Approved"],
]);
const oneLineDetails = csv([
  detailColumns,
  ["CN-1", 1, "P-1", 1, "PCS", 1, 111, 111, "R1"],
]);
assert.equal(
  reconcileHeinzReturns(
    accurateDpp(101),
    oneLineHeaders,
    oneLineDetails,
    mapping(),
    { dppTolerance: 1 },
  ).summary.MATCH,
  1,
);
assert.equal(
  reconcileHeinzReturns(
    accurateDpp(101.01),
    oneLineHeaders,
    oneLineDetails,
    mapping(),
    { dppTolerance: 1 },
  ).summary.VALUE_MISMATCH,
  1,
);

console.log(
  "OK - HEINZ Return exact mapping, Approved, agregasi, nilai, invalid, missing, dan konflik.",
);
