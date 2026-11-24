import assert from "node:assert/strict";
import * as XLSX from "xlsx";
import { reconcileHeinzReturns } from "./return-reconciliation.ts";
import { exportSheets, returnCauseLines } from "./reconciliation-ui.ts";

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
  MISSING_PRINCIPAL: 2,
  UNMAPPED: 1,
  INVALID_DATA: 2,
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
      row.status === "MISSING_ACCURATE" && row.invoiceNumber === "CN-3" &&
      row.accurateSourceRows.length === 0,
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
      row.status === "MISSING_PRINCIPAL" &&
      row.invoiceNumber === "CN-7, CN-8",
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


// Customer formats must not abort unrelated valid returns.
for (const [name, code, valid] of [
  ["TOKO {C-A}", "C-A", true],
  ["TOKO", "C-A", true],
  ["TOKO_C-A_B", "C-A", true],
  ["TOKO {C-A}", "MK001", true],
  ["TOKO {C-B}", "C-A", false],
  ["TK. AAN_C-TK 124", "MK1933", false],
  ["TOKO", "MKS-001", false],
] as const) {
  const check = reconcileHeinzReturns(accurate,
    csv([headerColumns,
      ["CN-1", "G1", "S1", code, name, "", "", "", 1, 333, "Approved"],
      ["CN-2", "G2", "S1", "C-A", "TOKO C-A", "", "", "", 1, 111, "Approved"],
    ]),
    csv([detailColumns,
      ["CN-1", 1, "P-1", 3, "PCS", 3, 111, 333, "R"],
      ["CN-2", 1, "P-1", 1, "PCS", 1, 111, 111, "R"],
    ]), mapping());
  assert.equal(check.results.find(r => r.invoiceNumber === "CN-2")?.status, "MATCH");
  assert.equal(check.results.some(r => r.invoiceNumber === "CN-1" && r.status === (valid ? "MATCH" : "INVALID_DATA")), true);
}


// One Accurate return combines two CNs; each source quantity is counted once.
for (const [qty, dpp, expected] of [[3, 300, "MATCH"], [4, 300, "QTY_MISMATCH"], [3, 320, "VALUE_MISMATCH"]] as const) {
  const combined = reconcileHeinzReturns(
    workbook({"Rincian Faktur Penjualan": [
      ["NO_NOTA", "KODE PELANGGAN INDUK", "KODE_BARANG", "QTY_SATUANKECIL", "DPP", "NILAI_PAJAK", "JUMLAH", "REM", "JENIS_TRANSAKSI"],
      ["RET-M", "C-A", "INT-1", qty, dpp, 33, dpp+33, "CN-901, CN-900, CN-900", "Retur Penjualan"],
    ]}),
    csv([headerColumns,
      ["CN-900", "", "", "C-A", "TOKO C-A", "", "", "", 1, 111, "Approved"],
      ["CN-901", "", "", "C-A", "TOKO C-A", "", "", "", 1, 222, "Approved"],
    ]),
    csv([detailColumns,
      ["CN-900", 1, "P-1", 1, "PCS", 1, 111, 111, "R"],
      ["CN-901", 1, "P-1", 2, "PCS", 2, 111, 222, "R"],
    ]), mapping());
  assert.equal(combined.results.length, 1);
  assert.equal(combined.results[0].invoiceNumber, "CN-900, CN-901");
  assert.equal(combined.results[0].principalQuantity, 3);
  assert.equal(combined.results[0].accurateQuantity, qty);
  assert.equal(combined.results[0].status, expected);
}

// Different customers still expose quantity/value differences for a unique product pair.
for (const [qty, gross, expected] of [[3, 333, "MATCH"], [4, 333, "QTY_MISMATCH"], [3, 350, "VALUE_MISMATCH"]] as const) {
  const check = reconcileHeinzReturns(accurate,
    csv([headerColumns, ["CN-1", "", "", "C-B", "TOKO C-B", "", "", "", 1, gross, "Approved"]]),
    csv([detailColumns, ["CN-1", 1, "P-1", qty, "PCS", qty, gross / qty, gross, "R"]]), mapping());
  assert.ok(check.results.some(row => row.invoiceNumber === "CN-1" && row.status === expected));
  assert.equal(check.principalLines.find(row => row.invoiceNumber === "CN-1")?.customerCode, "C-B");
}

// Missing CN stays missing even with equal product/qty/value; only linked zero-value motoris is exempt.
for (const [remark, approval, dpp, ambiguous, expected] of [
  ["RSJ/2610/00004", "Approved", 300, false, "MISSING_ACCURATE"],
  ["RSJ/2610/00004", "Approved", 0, false, "MATCH"],
  ["RSJ/2610/000040", "Approved", 300, false, "MISSING_ACCURATE"],
  ["RSJ/2610/00004", "Draft", 300, false, "INVALID_DATA"],
  ["RSJ/2610/00004", "Approved", 300, true, "MISSING_ACCURATE"],
] as const) {
  const hdr: (string | number)[][] = [headerColumns, ["CN-900", "", "", "C-B", "TOKO C-B", "", "", remark, 1, 333, approval]];
  if (ambiguous) hdr.push(["CN-901", "", "", "C-B", "TOKO C-B", "", "", remark, 0, 0, "Approved"]);
  const check = reconcileHeinzReturns(workbook({"Rincian Faktur Penjualan": [
    ["NO_NOTA", "KODE PELANGGAN INDUK", "KODE_BARANG", "QTY_SATUANKECIL", "DPP", "NILAI_PAJAK", "JUMLAH", "REM", "JENIS_TRANSAKSI"],
    ["RSJ/2610/00004", "C-A", "INT-1", 3, dpp, 0, dpp, "DO.2026.09.00035", "Retur Penjualan"],
  ]}), csv(hdr), csv([detailColumns, ["CN-900", 1, "P-1", 3, "PCS", 3, 111, 333, "R"]]), mapping());
  assert.ok(check.results.some(row => row.status === expected));
  assert.equal(check.accurateLines[0].dpp, dpp);
}
for (const reference of ["HZ01062", "HZ01063"] as const) {
  const check = reconcileHeinzReturns(accurate,
    csv([headerColumns, ["CN-1", "", "", "C-A", "TOKO C-A", "", "", `INV/2610/${reference}_input21/10/2026_Batal_DOUBLE NOTA DIK SPV PCH`, 1, 333, "Approved"]]),
    csv([detailColumns, ["CN-1", 1, "P-1", 3, "PCS", 3, 111, 333, "R"]]), mapping());
  // A mixed pair with an unrelated Accurate return must not be marked correction.
  assert.equal(check.results.find(row => row.invoiceNumber === "CN-1")?.status, "MATCH");
  const principalOnly = reconcileHeinzReturns(workbook({"Rincian Faktur Penjualan": [
    ["NO_NOTA", "KODE PELANGGAN INDUK", "KODE_BARANG", "QTY_SATUANKECIL", "DPP", "NILAI_PAJAK", "JUMLAH", "REM", "JENIS_TRANSAKSI"],
    ["OTHER", "C-A", "INT-1", 1, 1, 0, 1, "CN-999", "Retur Penjualan"],
  ]}), csv([headerColumns, ["CN-1", "", "", "C-A", "TOKO C-A", "", "", `INV/2610/${reference}_input21/10/2026_Batal_DOUBLE NOTA DIK SPV PCH`, 1, 333, "Approved"]]),
    csv([detailColumns, ["CN-1", 1, "P-1", 3, "PCS", 3, 111, 333, "R"]]), mapping());
  assert.equal(principalOnly.results.find(row => row.invoiceNumber === "CN-1")?.status, "DOUBLE");
}

// Only differences with explicit cancellation notes become corrections.
for (const [note, dpp, expected] of [
  ["INV/2610/HZ001_input01/10/2026_Batal_SALAH INPUT - CN-1", 250, "KOREKSI"],
  ["INV/2610/HZ001 - CN-1", 250, "VALUE_MISMATCH"],
  ["INV/2610/HZ001_input01/10/2026_Batal_SALAH INPUT - CN-1", 300, "MATCH"],
] as const) {
  const check = reconcileHeinzReturns(workbook({"Rincian Faktur Penjualan": [
    ["NO_NOTA", "KODE PELANGGAN INDUK", "KODE_BARANG", "QTY_SATUANKECIL", "DPP", "NILAI_PAJAK", "JUMLAH", "REM", "JENIS_TRANSAKSI"],
    ["RET-1", "C-A", "INT-1", 3, dpp, 0, dpp, note, "Retur Penjualan"],
  ]}), csv([headerColumns, ["CN-1", "", "", "C-A", "TOKO C-A", "", "", "", 1, 333, "Approved"]]),
    csv([detailColumns, ["CN-1", 1, "P-1", 3, "PCS", 3, 111, 333, "R"]]), mapping());
  assert.equal(check.results[0].status, expected);
  assert.equal(check.results[0].accurateDpp, dpp);
  assert.equal(check.results[0].principalDpp, 300);
}

// Verified customer fallback is restricted to the confirmed CN and retailer.
for (const [cn, retailer, name, expectedCustomer, valid] of [
  ["CN-026194", "MKS-001359", "TK. LINA(Credit)_", "C-LIN024", true],
  ["CN-026216", "MKS-001359", "TK. LINA(Credit)_", "MKS-001359", false],
  ["CN-026194", "OTHER", "TK. LINA(Credit)_", "OTHER", false],
  ["CN-026194", "MKS-001359", "TK. LINA C-OTHER", "C-OTHER", true],
] as const) {
  const check = reconcileHeinzReturns(accurate,
    csv([headerColumns, [cn, "", "", retailer, name, "", "", "", 1, 333, "Approved"]]),
    csv([detailColumns, [cn, 1, "P-1", 3, "PCS", 3, 111, 333, "R"]]), mapping());
  assert.equal(check.principalLines[0].customerCode, expectedCustomer);
  assert.equal(!check.principalLines[0].invalidReason, valid);
}

// Identical values cannot manufacture a CN or reuse another CN's Accurate return.
for (const rem of ["", "CN-901", "CN-9000"]) {
  const check = reconcileHeinzReturns(workbook({ "Rincian Faktur Penjualan": [
    ["NO_NOTA", "KODE PELANGGAN INDUK", "KODE_BARANG", "QTY_SATUANKECIL", "DPP", "NILAI_PAJAK", "JUMLAH", "REM", "JENIS_TRANSAKSI"],
    ["RET-1", "C-A", "INT-1", 3, 300, 33, 333, rem, "Retur Penjualan"],
  ] }), csv([headerColumns, ["CN-900", "", "", "C-A", "TOKO C-A", "", "", "", 1, 333, "Approved"]]),
  csv([detailColumns, ["CN-900", 1, "P-1", 3, "PCS", 3, 111, 333, "R"]]), mapping());
  const row = check.results.find(r => r.invoiceNumber === "CN-900");
  assert.equal(row?.status, "MISSING_ACCURATE", rem);
  assert.deepEqual(row?.accurateSourceRows, []);
  assert.equal(check.summary.MATCH, 0);
}

// Explicit not-imported notes classify missing rows without overriding paired or invalid data.
for (const [cn, remarks, approval, expected] of [
  ["CN-900", "IN-204235 TIDAK IMPOR", "Approved", "TIDAK_IMPOR"],
  ["CN-900", "IN-204235 tidak   impor", "Approved", "TIDAK_IMPOR"],
  ["CN-900", "IN-204235", "Approved", "MISSING_ACCURATE"],
  ["CN-900", "IN-204235 TIDAK IMPORT", "Approved", "MISSING_ACCURATE"],
  ["CN-900", "IN-204235 TIDAK IMPOR", "Draft", "INVALID_DATA"],
  ["CN-1", "IN-204235 TIDAK IMPOR", "Approved", "MATCH"],
] as const) {
  const check = reconcileHeinzReturns(accurate,
    csv([headerColumns, [cn, "", "", "C-A", "TOKO C-A", "", "", remarks, 1, 333, approval]]),
    csv([detailColumns, [cn, 1, "P-1", 3, "PCS", 3, 111, 333, "R"]]), mapping());
  const row = check.results.find(r => r.invoiceNumber === cn)!;
  assert.equal(row.status, expected);
  assert.equal(Object.values(check.summary).reduce((a,b) => a+b,0), check.results.length);
  if (expected === "TIDAK_IMPOR") {
    assert.equal(check.summary.TIDAK_IMPOR, 1);
    assert.equal(check.summary.MISSING_ACCURATE, 0);
    assert.equal(row.principalDpp, 300);
    assert.equal(row.dppDifference, -300);
    assert.ok(returnCauseLines(row, "HEINZ")[0].includes(remarks));
    const exported = exportSheets("RETURN", "HEINZ", check.summary, check.results);
    assert.equal(exported.ringkasan.find(r => r.Status === "TIDAK_IMPOR")?.Jumlah, 1);
    const detail = exported.detail.find(r => r.Status === "TIDAK_IMPOR")!;
    assert.equal(detail["Selisih DPP"], null);
    assert.equal(detail["Selisih Qty"], null);
    assert.equal(detail["DPP HEINZ"], 300);
  }
}

// Double requires explicit evidence on each present side, not generic cancellation wording.
for (const [remark, approval, cn, expected] of [
  ["INV/2609/HZ02101_Batal_DOUBLE INPUT ACC SPV", "Approved", "CN-900", "DOUBLE"],
  ["INV/2609/HZ02101_Batal_double_input", "Approved", "CN-900", "DOUBLE"],
  ["INV/2609/HZ02101_Batal_DOUBLE NOTA", "Approved", "CN-900", "DOUBLE"],
  ["INV/2609/HZ02101_Batal_DOUBLE INPUTTING", "Approved", "CN-900", "MISSING_ACCURATE"],
  ["INV/2609/HZ02101_Batal_DOUBLE INPUT", "Draft", "CN-900", "INVALID_DATA"],
  ["INV/2609/HZ02101_Batal_DOUBLE INPUT", "Approved", "CN-1", "MATCH"],
] as const) {
  const check = reconcileHeinzReturns(accurate,
    csv([headerColumns, [cn, "", "", "C-A", "TOKO C-A", "", "", remark, 1, 333, approval]]),
    csv([detailColumns, [cn, 1, "P-1", 3, "PCS", 3, 111, 333, "R"]]), mapping());
  const row = check.results.find(r => r.invoiceNumber === cn)!;
  assert.equal(row.status, expected);
  assert.equal(Object.values(check.summary).reduce((a,b) => a+b,0), check.results.length);
  if (expected === "DOUBLE") {
    assert.equal(check.summary.DOUBLE, 1);
    assert.equal(check.summary.MISSING_ACCURATE, 0);
    assert.ok(returnCauseLines(row, "HEINZ")[0].includes(remark));
    const exported = exportSheets("RETURN", "HEINZ", check.summary, check.results);
    assert.equal(exported.ringkasan.find(r => r.Status === "DOUBLE")?.Jumlah, 1);
    const detail = exported.detail.find(r => r.Status === "DOUBLE")!;
    assert.equal(detail["Selisih DPP"], null);
    assert.equal(detail["DPP HEINZ"], 300);
  }
}

// Motoris acceptance requires linked sources, matching qty and zero values on every Accurate row.
for (const scenario of [
  { qty: 3, dpp: 0, tax: 0, total: 0, nota: "RSJ/2610/00003", rem: "DO.2026.09.00034", expected: "MATCH" },
  { qty: 2, dpp: 0, tax: 0, total: 0, nota: "RSJ/2610/00003", rem: "DO.2026.09.00034", expected: "QTY_AND_VALUE_MISMATCH" },
  { qty: 3, dpp: 10, tax: 0, total: 10, nota: "RSJ/2610/00003", rem: "DO.2026.09.00034", expected: "MISSING_ACCURATE" },
  { qty: 3, dpp: 0, tax: 1, total: 1, nota: "RSJ/2610/00003", rem: "DO.2026.09.00034", expected: "MISSING_ACCURATE" },
  { qty: 3, dpp: 0, tax: 0, total: 0, nota: "RJN/2610/HZ00003", rem: "DO.2026.09.00034", expected: "MISSING_ACCURATE" },
  { qty: 3, dpp: 0, tax: 0, total: 0, nota: "RSJ/2610/00003", rem: "CN-900", expected: "VALUE_MISMATCH" },
] as const) {
  const { qty, dpp, tax, total, nota, rem, expected } = scenario;
  const check = reconcileHeinzReturns(workbook({ "Rincian Faktur Penjualan": [
    ["NO_NOTA", "KODE PELANGGAN INDUK", "KODE_BARANG", "QTY_SATUANKECIL", "DPP", "NILAI_PAJAK", "JUMLAH", "REM", "JENIS_TRANSAKSI"],
    [nota, "C-A", "INT-1", qty, dpp, tax, total, rem, "Retur Penjualan"],
  ] }), csv([headerColumns, ["CN-900", "", "", "C-A", "TOKO C-A", "", "", nota, 1, 333, "Approved"]]),
  csv([detailColumns, ["CN-900", 1, "P-1", 3, "PCS", 3, 111, 333, "R"]]), mapping());
  if (expected === "MISSING_ACCURATE") {
    assert.equal(check.results.find(r => r.invoiceNumber === "CN-900")?.status, "MISSING_ACCURATE");
    assert.equal(check.accurateLines[0].dpp, dpp);
    assert.equal(check.summary.MATCH, 0);
    continue;
  }
  assert.equal(check.results.length, 1);
  const row = check.results[0];
  assert.equal(row.status, expected, JSON.stringify(scenario));
  assert.equal(check.summary[expected], 1);
  assert.equal(row.accurateDpp, dpp);
  assert.equal(row.dppDifference, dpp - 300);
  if (expected === "MATCH") {
    assert.match(returnCauseLines(row, "HEINZ")[0], /motoris/);
    const exported = exportSheets("RETURN", "HEINZ", check.summary, check.results).detail[0];
    assert.equal(exported.Status, "MATCH");
    assert.equal(exported["DPP Accurate"], 0);
    assert.equal(exported["DPP HEINZ"], 300);
    assert.match(String(exported["Penyebab selisih"]), /motoris/);
  }
}

// Combined cancellation approval requires the complete CN set and every value to agree.
for (const [qty, tax, approved] of [[8, 88, true], [9, 88, false], [8, 90, false]] as const) {
  const cns = Array.from({ length: 8 }, (_, i) => `CN-${25884 + i}`.replace("CN-", "CN-0"));
  const check = reconcileHeinzReturns(workbook({ "Rincian Faktur Penjualan": [
    ["NO_NOTA", "KODE PELANGGAN INDUK", "KODE_BARANG", "QTY_SATUANKECIL", "DPP", "NILAI_PAJAK", "JUMLAH", "REM", "JENIS_TRANSAKSI"],
    ["R1", "C-RAD007", "INT-1", qty, 800, tax, 888, "INV/2609/HZ02652 - CN-025884 - CN-025891", "Retur Penjualan"],
  ]}), csv([headerColumns, ...cns.map((cn, i) => [cn, "", "", `C-T${i}`, `TOKO C-T${i}`, "", "", "INV/2609/HZ02652_Batal_TOLAK 1 FAKTUR", 1, 111, "Approved"])]),
    csv([detailColumns, ...cns.map(cn => [cn, 1, "P-1", 1, "PCS", 1, 111, 111, "R"])]), mapping());
  assert.equal(check.results.some(row => row.warnings.some(note => note.startsWith("MATCH gabungan"))), approved);
  if (approved) {
    assert.equal(check.results.length, 1);
    assert.equal(check.results[0].status, "MATCH");
    assert.equal(check.results[0].principalQuantity, 8);
    assert.equal(check.results[0].principalSourceRows.length, 8);
    assert.equal(check.results[0].accurateSourceRows.length, 1);
  } else {
    assert(check.summary.MISSING_ACCURATE > 0);
  }
  assert.equal(Object.values(check.summary).reduce((sum, n) => sum + n, 0), check.results.length);
}
