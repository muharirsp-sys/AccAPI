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
  "Bill No",
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
    "Bill No": "",
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

const correctedProductMapping = mapping([["G1076202000410", "4103927"], ["G1076202001010", "4103927"]]);
for (const [invoice, customer, code, status] of [
  ["RB/BFG-10000006325", "C-AIS022", "G1076202000410", "KOREKSI"],
  ["RB/BFG-10000006247", "C-580001", "G1076202001010", "MATCH"],
  ["RB/BFG-10000006325", "C-OTHER", "G1076202001010", "MATCH"],
]) {
  const output = reconcileGodrejReturns(
    accurate(accurateRow({ REM: invoice, "KODE PELANGGAN INDUK": customer, KODE_BARANG: code })),
    principal(principalRow({ "Sale Return No.": invoice, CUSTOMER: customer, Skunit: "4103927 - HIT 10S" })),
    correctedProductMapping,
  );
  assert.equal(output.results.length, 1);
  assert.equal(output.results[0].status, status);
  assert.equal(output.summary.MISSING_PRINCIPAL, 0);
  assert.equal(output.summary.MISSING_ACCURATE, 0);
}

for (const [name, code] of [
  ["PT. LOTTE MART PANAKUKANG", "C-LO0013"],
  ["CV.MAJU BERSAMA", "C-DU0003"],
  ["Jack Grocers", "C-JAC767"],
  ["CV. MITRA BELANJA SEJAHTERA", "C-KIN009"],
  ["  Minasa   Mart  ", "C-MIN013"],
]) {
  const mappedCustomer = reconcileGodrejReturns(
    accurate(accurateRow({ "KODE PELANGGAN INDUK": code })),
    principal(principalRow({ CUSTOMER: name })), mapping(),
  );
  assert.equal(mappedCustomer.summary.MATCH, 1);
  assert.equal(mappedCustomer.principalLines[0].customerCode, code);
}
const explicitCustomer = reconcileGodrejReturns(
  accurate(accurateRow({ "KODE PELANGGAN INDUK": "C-OTHER" })),
  principal(principalRow({ CUSTOMER: "Minasa Mart {C-OTHER}" })), mapping(),
);
assert.equal(explicitCustomer.summary.MATCH, 1);
for (const customer of ["MINASA MART CABANG 2", "TOKO BARU", "MINASA MART C-ONE C-TWO", "MINASA MART C-ONE-BOGUS"]) {
  assert.throws(() => reconcileGodrejReturns(accurate(accurateRow()),
    principal(principalRow({ CUSTOMER: customer })), mapping()), /CUSTOMER.*tepat satu/);
}

const aliasCustomer = reconcileGodrejReturns(
  accurate(accurateRow({ "KODE PELANGGAN INDUK": "C-MIT057-GD" })),
  principal(principalRow({ CUSTOMER: "HERO (C-GI0010)" })),
  mapping(),
);
assert.equal(aliasCustomer.summary.MATCH, 1);
assert.equal(aliasCustomer.principalLines[0].customerCodeRaw, "C-GI0010");
for (const originalExists of [false, true]) {
  const customer = reconcileGodrejReturns(
    accurate(accurateRow({ "KODE PELANGGAN INDUK": "C-IN0081-GD" }),
      ...(originalExists ? [accurateRow({ "KODE PELANGGAN INDUK": "C-IN00" })] : [])),
    principal(principalRow({ CUSTOMER: "SUPER INTI PERKAKAS C-IN00" })),
    mapping(),
  );
  assert.equal(customer.summary.MATCH, 1);
  assert.equal(customer.results.find((row) => row.status === "MATCH")?.customerCode,
    originalExists ? "C-IN00" : "C-IN0081");
}
const otherInvoice = reconcileGodrejReturns(
  accurate(accurateRow({ "KODE PELANGGAN INDUK": "C-IN0081", REM: "RB/BFG-2" })),
  principal(principalRow({ CUSTOMER: "SUPER INTI PERKAKAS C-IN00" })),
  mapping(),
);
assert.equal(otherInvoice.summary.MATCH, 0);
assert.equal(otherInvoice.principalLines[0].customerCode, "C-IN00");
for (const [original, target] of [
  ["C-CIT0", "C-CIT002"],
  ["C-SUR09", "C-SUR097"],
  ["C-HE0027", "C-MIT058"],
  ["C-JAS080", "C-JA0011"],
  ["C-KIN009", "C-KIN012"],
  ["C-JAN469", "C-ARM013"],
]) {
  for (const originalExists of [false, true]) {
    const output = reconcileGodrejReturns(
      accurate(accurateRow({ "KODE PELANGGAN INDUK": target }),
        ...(originalExists ? [accurateRow({ "KODE PELANGGAN INDUK": original })] : [])),
      principal(principalRow({ CUSTOMER: `CITRA KOSMETIK & BABY S (${original}` })), mapping(),
    );
    assert.equal(output.summary.MATCH, 1);
    assert.equal(output.results.find((row) => row.status === "MATCH")?.customerCode,
      originalExists ? original : target);
  }
  const output = reconcileGodrejReturns(
    accurate(accurateRow({ "KODE PELANGGAN INDUK": target, REM: "RB/BFG-2" })),
    principal(principalRow({ CUSTOMER: original })), mapping(),
  );
  assert.equal(output.summary.MATCH, 0);
  assert.equal(output.principalLines[0].customerCode, original);
}
const originalCustomer = reconcileGodrejReturns(
  accurate(accurateRow({ "KODE PELANGGAN INDUK": "C-GI0010" }), accurateRow({ "KODE PELANGGAN INDUK": "C-MIT057" })),
  principal(principalRow({ CUSTOMER: "HERO (C-GI0010)" })),
  mapping(),
);
assert.equal(originalCustomer.results.find((row) => row.status === "MATCH")?.customerCode, "C-GI0010");
const unrelatedReturn = reconcileGodrejReturns(
  accurate(accurateRow({ "KODE PELANGGAN INDUK": "C-MIT057", REM: "RB/BFG-2" })),
  principal(principalRow({ CUSTOMER: "HERO (C-GI0010)" })),
  mapping(),
);
assert.equal(unrelatedReturn.summary.MATCH, 0);
assert.equal(unrelatedReturn.principalLines[0].customerCode, "C-GI0010");

for (const [qty, expected] of [[1, "MATCH"], [2, "KOREKSI"]] as const) {
  const corrected = reconcileGodrejReturns(
    accurate(accurateRow()),
    principal(principalRow({ "Bill No": "FK/BFG-10030753", "Quantity(Units)": qty })),
    mapping(),
  );
  assert.equal(corrected.results[0].status, expected);
  assert.equal(corrected.summary[expected], 1);
  assert.equal(corrected.summary.QTY_MISMATCH, 0);
}
for (const sku of ["P-1 - PRODUCT ONE", "UNKNOWN - UNKNOWN"]) {
  const missingCorrection = reconcileGodrejReturns(
    accurate(),
    principal(principalRow({ "Bill No": "FK/BFG-10030753", Skunit: sku })),
    mapping(),
  );
  assert.equal(missingCorrection.summary.KOREKSI, 1);
  assert.equal(missingCorrection.summary.MISSING_ACCURATE, 0);
  assert.equal(missingCorrection.summary.UNMAPPED, 0);
  assert.match(missingCorrection.results[0].warnings.join(" "), /FK\/BFG-10030753/);
}
const mixedCorrection = reconcileGodrejReturns(
  accurate(),
  principal(principalRow({ "Bill No": "FK/BFG-10030753" }), principalRow()),
  mapping(),
);
assert.equal(mixedCorrection.summary.MISSING_ACCURATE, 1);

for (const code of ["CA-TK0209", "CA-TK0209-GD"]) {
  const caCustomer = reconcileGodrejReturns(
    accurate(accurateRow({ "KODE PELANGGAN INDUK": code })),
    principal(principalRow({ CUSTOMER: "TK. BARU CA-TK0209}" })),
    mapping(),
  );
  assert.equal(caCustomer.summary.MATCH, 1);
  assert.equal(caCustomer.results[0].customerCode, "CA-TK0209");
}
const distinctCustomer = reconcileGodrejReturns(
  accurate(accurateRow({ "KODE PELANGGAN INDUK": "C-TK0209" })),
  principal(principalRow({ CUSTOMER: "TK. BARU CA-TK0209}" })),
  mapping(),
);
assert.equal(distinctCustomer.summary.MATCH, 0);
assert.equal(distinctCustomer.summary.MISSING_ACCURATE, 1);
assert.equal(distinctCustomer.summary.MISSING_PRINCIPAL, 1);

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

const descriptiveParenthetical = reconcileGodrejReturns(
  accurate(accurateRow({ KODE_BARANG: "WIN-SOAP" })),
  principal(principalRow({ Skunit: "999 - SOAP (LEMON)." })),
  mapping([], [["SOAP", "WIN-SOAP"]]),
);
assert.equal(descriptiveParenthetical.summary.UNMAPPED, 1);
assert.equal(descriptiveParenthetical.summary.MISSING_PRINCIPAL, 1);

const punctuatedPackaging = reconcileGodrejReturns(
  accurate(accurateRow({ KODE_BARANG: "WIN-PRODUCT" })),
  principal(principalRow({ Skunit: "999 - PRODUCT (1/12)." })),
  mapping([], [["PRODUCT", "WIN-PRODUCT"]]),
);
assert.equal(punctuatedPackaging.summary.MATCH, 1);

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
    accurateRow({ NO_NOTA: "BAD-PREFIX", REM: "XRB/BFG-1" }),
    accurateRow({ NO_NOTA: "BAD-SUFFIX", REM: "RB/BFG-1A" }),
  ),
  principal(),
  mapping(),
);
assert.equal(invalidRem.summary.INVALID_DATA, 4);
assert.deepEqual(
  invalidRem.results.map((row) => row.invoiceNumber),
  ["BAD-0", "BAD-2", "BAD-PREFIX", "BAD-SUFFIX"],
);

for (const customer of ["C-ONE dan C-TWO", "XC-ONE", "C-ONE-BOGUS", "XCA-TK0209", "CA-TK0209-BOGUS", "CA-TK0209 C-ONE"])
  assert.throws(
    () =>
      reconcileGodrejReturns(
        accurate(accurateRow()),
        principal(principalRow({ CUSTOMER: customer })),
        mapping(),
      ),
    /CUSTOMER.*tepat satu/,
  );
for (const customer of ["XC-ONE", "C-ONE-BOGUS", "C--GD"])
  assert.throws(
    () =>
      reconcileGodrejReturns(
        accurate(
          accurateRow({ "KODE PELANGGAN INDUK": customer }),
        ),
        principal(principalRow()),
        mapping(),
      ),
    /KODE PELANGGAN INDUK.*tepat satu/,
  );
assert.equal(
  reconcileGodrejReturns(
    accurate(accurateRow({ "KODE PELANGGAN INDUK": "C-ONE" })),
    principal(principalRow({ CUSTOMER: "ONE STORE [C-ONE]" })),
    mapping(),
  ).summary.MATCH,
  1,
);
assert.equal(
  reconcileGodrejReturns(
    accurate(
      accurateRow({ "KODE PELANGGAN INDUK": "C-CI0001-GD" }),
    ),
    principal(principalRow({ CUSTOMER: "STORE (C-CI0001)" })),
    mapping(),
  ).results[0].customerCode,
  "C-CI0001",
);
const gdCustomer = reconcileGodrejReturns(
  accurate(accurateRow({ "KODE PELANGGAN INDUK": "C-GD" })),
  principal(principalRow({ CUSTOMER: "STORE (C-GD)" })),
  mapping(),
);
assert.equal(gdCustomer.summary.MATCH, 1);
assert.equal(gdCustomer.results[0].customerCode, "C-GD");
for (const [name, value] of [
  ["Quantity(Units)", ""],
  ["Quantity(Units)", "NaN"],
  ["Amount", ""],
  ["Amount", "NaN"],
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

const signed = reconcileGodrejReturns(
  accurate(accurateRow()),
  principal(principalRow({ "Quantity(Units)": -1, Amount: -11_100 })),
  mapping(),
);
assert.equal(signed.results[0].principalQuantity, 1);
assert.equal(signed.results[0].principalTotal, 11_100);
assert.equal(signed.results[0].principalDpp, 10_000);
assert.ok(Math.abs(signed.results[0].principalTax - 1_100) < 0.000001);

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
