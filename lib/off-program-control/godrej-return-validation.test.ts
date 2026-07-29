import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as XLSX from "xlsx";
import { reconcileGodrejReturns } from "./return-reconciliation.ts";

function workbook(sheets: Record<string, unknown[][]>): Buffer {
  const book = XLSX.utils.book_new();
  for (const [name, rows] of Object.entries(sheets))
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), name);
  return XLSX.write(book, { bookType: "xlsx", type: "buffer" });
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
function accurateRow(overrides: Partial<AccurateValues> = {}): unknown[] {
  const values: AccurateValues = {
    NO_NOTA: "RET-1",
    "KODE PELANGGAN INDUK": "C-ONE-GD",
    KODE_BARANG: "WIN-1",
    QTY_SATUANKECIL: 1,
    DPP: 10_000,
    NILAI_PAJAK: 1_100,
    JUMLAH: 11_100,
    REM: "catatan RB/BFG-1",
    JENIS_TRANSAKSI: "2. (-) Retur Penjualan",
    ...overrides,
  };
  return ACCURATE_HEADERS.map((header) => values[header]);
}
function accurate(...rows: unknown[][]): Buffer {
  return workbook({
    "Rincian Faktur Penjualan": [[...ACCURATE_HEADERS], ...rows],
  });
}

const PRINCIPAL_HEADERS = [
  "Sale Return No.",
  "CUSTOMER",
  "Skunit",
  "Quantity(Units)",
  "Amount",
  "Sale Return State",
] as const;
type PrincipalValues = Record<(typeof PRINCIPAL_HEADERS)[number], unknown>;
function principalRow(overrides: Partial<PrincipalValues> = {}): unknown[] {
  const values: PrincipalValues = {
    "Sale Return No.": "RB/BFG-1",
    CUSTOMER: "ONE STORE (C-ONE)",
    Skunit: "P-1 - PRODUCT ONE",
    "Quantity(Units)": 1,
    Amount: 11_100,
    "Sale Return State": "approved",
    ...overrides,
  };
  return PRINCIPAL_HEADERS.map((header) => values[header]);
}
function principal(...rows: unknown[][]): Buffer {
  return Buffer.from(
    XLSX.utils.sheet_to_csv(
      XLSX.utils.aoa_to_sheet([[...PRINCIPAL_HEADERS], ...rows]),
    ),
  );
}

function mapping(
  codeRows: unknown[][] = [["WIN-1", "P-1"]],
  nameRows: unknown[][] = [["PRODUCT FALLBACK", "WIN-F"]],
): Buffer {
  return workbook({
    "Pvt Map 1": [["Kode BARANG Win2", "Kode Pcpl"], ...codeRows],
    "Form Fix": [
      ["Nama Barang Principle", "Kode BARANG Win2", "DATABASE PASSWORD"],
      ...nameRows,
    ],
  });
}

const basic = reconcileGodrejReturns(
  accurate(accurateRow()),
  principal(principalRow()),
  mapping(),
  { dppTolerance: 1 },
);
assert.equal(basic.summary.MATCH, 1);
assert.equal(basic.results[0].principalDpp, 11100 / 1.11);
assert.equal(basic.results[0].customerCode, "C-ONE");

assert.equal(
  reconcileGodrejReturns(
    accurate(accurateRow()),
    principal(
      principalRow({ "Sale Return State": "draft" }),
      principalRow(),
    ),
    mapping(),
  ).principalLines.length,
  1,
);

const fallback = reconcileGodrejReturns(
  accurate(
    accurateRow({
      KODE_BARANG: "WIN-F",
      REM: "RB/BFG-2",
      "KODE PELANGGAN INDUK": "C-TWO-GD",
    }),
  ),
  principal(
    principalRow({
      "Sale Return No.": "RB/BFG-2",
      CUSTOMER: "TWO (C-TWO)",
      Skunit: "999 - PRODUCT FALLBACK. 999 (1/12)",
    }),
  ),
  mapping(),
);
assert.equal(fallback.summary.MATCH, 1);
assert.equal(fallback.principalLines[0].accurateProductCode, "WIN-F");

const unmapped = reconcileGodrejReturns(
  accurate(accurateRow({ KODE_BARANG: "WIN-X" })),
  principal(principalRow({ Skunit: "999 - NOT IN MASTER" })),
  mapping(),
);
assert.equal(unmapped.summary.UNMAPPED, 1);
assert.equal(unmapped.summary.MISSING_PRINCIPAL, 1);

assert.throws(
  () =>
    reconcileGodrejReturns(
      accurate(accurateRow()),
      principal(principalRow({ Skunit: "999 - DUPLICATE NAME" })),
      mapping([], [
        ["DUPLICATE NAME", "SAFE-INTERNAL-A", "super-secret"],
        ["DUPLICATE NAME", "SAFE-INTERNAL-B", "super-secret"],
      ]),
    ),
  (error: unknown) =>
    error instanceof Error &&
    /SAFE-INTERNAL-A/.test(error.message) &&
    /SAFE-INTERNAL-B/.test(error.message) &&
    !/DATABASE PASSWORD|super-secret/.test(error.message),
);

const invalidRem = reconcileGodrejReturns(
  accurate(
    accurateRow({ NO_NOTA: "BAD-0", REM: "tanpa token" }),
    accurateRow({
      NO_NOTA: "BAD-2",
      REM: "RB/BFG-1 dan RB/BFG-2",
    }),
  ),
  principal(),
  mapping(),
);
assert.equal(invalidRem.summary.INVALID_DATA, 2);
assert.deepEqual(
  invalidRem.results.map((row) => row.invoiceNumber),
  ["BAD-0", "BAD-2"],
);

assert.throws(
  () =>
    reconcileGodrejReturns(
      accurate(accurateRow()),
      principal(principalRow({ CUSTOMER: "C-ONE dan C-TWO" })),
      mapping(),
    ),
  /CUSTOMER.*tepat satu/,
);
for (const [name, value] of [
  ["Quantity(Units)", ""],
  ["Quantity(Units)", "NaN"],
  ["Quantity(Units)", -1],
  ["Amount", ""],
  ["Amount", "NaN"],
  ["Amount", -1],
] as const)
  assert.throws(
    () =>
      reconcileGodrejReturns(
        accurate(accurateRow()),
        principal(principalRow({ [name]: value })),
        mapping(),
      ),
    new RegExp(`${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.*baris 2`),
  );

const aggregated = reconcileGodrejReturns(
  accurate(
    accurateRow({ QTY_SATUANKECIL: 1, DPP: 50 }),
    accurateRow({ QTY_SATUANKECIL: 2, DPP: 50 }),
  ),
  principal(
    principalRow({ "Quantity(Units)": 1, Amount: 55.5 }),
    principalRow({ "Quantity(Units)": 2, Amount: 55.5 }),
  ),
  mapping(),
);
assert.equal(aggregated.summary.MATCH, 1);
assert.equal(aggregated.results[0].principalQuantity, 3);
assert.deepEqual(aggregated.results[0].principalSourceRows, [2, 3]);

assert.equal(
  reconcileGodrejReturns(
    accurate(accurateRow({ DPP: 100 })),
    principal(principalRow({ Amount: 112.11 })),
    mapping(),
    { dppTolerance: 1 },
  ).summary.MATCH,
  1,
);
assert.equal(
  reconcileGodrejReturns(
    accurate(accurateRow({ DPP: 100 })),
    principal(principalRow({ Amount: 112.221 })),
    mapping(),
    { dppTolerance: 1 },
  ).summary.VALUE_MISMATCH,
  1,
);

console.log("GODREJ Return synthetic validation passed.");

if (process.argv.length > 2) {
  assert.equal(
    process.argv.length,
    5,
    "berikan path Accurate, principal, dan mapping",
  );
  const real = reconcileGodrejReturns(
    readFileSync(process.argv[2]),
    readFileSync(process.argv[3]),
    readFileSync(process.argv[4]),
    { dppTolerance: 1 },
  );
  assert.equal(real.accurateLines.length, 33);
  assert.equal(real.principalLines.length, 6);
  assert.deepEqual(real.summary, {
    MATCH: 6,
    QTY_MISMATCH: 0,
    VALUE_MISMATCH: 0,
    QTY_AND_VALUE_MISMATCH: 0,
    MISSING_ACCURATE: 0,
    MISSING_PRINCIPAL: 27,
    UNMAPPED: 0,
    INVALID_DATA: 0,
  });
  const matched = real.results.filter((row) => row.status === "MATCH");
  const sum = (
    field:
      | "accurateQuantity"
      | "accurateDpp"
      | "principalDpp"
      | "principalTax"
      | "principalTotal",
  ) => matched.reduce((total, row) => total + row[field], 0);
  assert.equal(sum("accurateQuantity"), 42);
  assert.ok(Math.abs(sum("accurateDpp") - 483275.67567) < 0.000001);
  assert.ok(Math.abs(sum("principalDpp") - 483275.675676) < 0.000001);
  assert.ok(Math.abs(sum("principalTax") - 53160.324324) < 0.000001);
  assert.equal(sum("principalTotal"), 536436);
  console.log("GODREJ Return real-workbook validation passed.");
}
