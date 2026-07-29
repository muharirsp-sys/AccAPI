import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as XLSX from "xlsx";
import { reconcileCussonsReturns } from "./return-reconciliation.ts";

function workbook(sheets: Record<string, unknown[][]>): Uint8Array {
  const book = XLSX.utils.book_new();
  for (const [name, rows] of Object.entries(sheets))
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), name);
  return new Uint8Array(XLSX.write(book, { bookType: "xlsx", type: "buffer" }));
}

function csv(rows: (string | number)[][]): Uint8Array {
  return new TextEncoder().encode(
    rows
      .map((row) =>
        row
          .map((value) => {
            const cell = String(value);
            return /[",\r\n]/.test(cell)
              ? `"${cell.replaceAll('"', '""')}"`
              : cell;
          })
          .join(","),
      )
      .join("\r\n"),
  );
}

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
const principalHeader = [
  "Credit Note No",
  "Customer Code",
  "Route Code",
  "Product Code",
  "Product Description",
  "UOM code",
  "Selling Type",
  "Prd Qty",
  "UOM List Price",
  "Gross Amount",
  "Discount Amount",
  "Total Amount After SKU",
  "Customer Discount Amount",
  "Total Tax Amount",
  "Total Net Amount",
  "Tax Code",
  "Tax Percentage 1",
];

function principalRow(
  cn: string,
  customer: string,
  product: string,
  quantity: number,
  price: number,
  discount = 0,
  customerDiscount = 0,
  unit = "EA",
): (string | number)[] {
  const gross = quantity * price,
    afterSku = gross - discount,
    dpp = afterSku - customerDiscount,
    tax = dpp * 0.11;
  return [
    cn,
    customer,
    "R-1",
    product,
    "PRODUK",
    unit,
    "S",
    quantity,
    price,
    gross,
    discount,
    afterSku,
    customerDiscount,
    tax,
    dpp + tax,
    "PPN_Output",
    11,
  ];
}

function mapping(): Uint8Array {
  return workbook({
    "Form Fix": [
      [],
      [],
      [],
      [],
      ["Kode Pcpl", "ISI/CTN", "SATUAN Fix Win", "Kode BARANG Win2"],
      ["P-1", 12, "PCS", "INT-1"],
      ["P-CS", 12, "PCS", "INT-CS"],
      ["P-NOPACK", "", "PCS", "INT-NOPACK"],
      ["P-BAD", 12, "PCS", "INT-A"],
      ["P-BAD", 24, "PCS", "INT-B"],
    ],
  });
}

const accurate = workbook({
  "Rincian Faktur Penjualan": [
    accurateHeader,
    ["R1", "C-A", "INT-1", 3, 270, 29.7, 299.7, "RET CN100", "Retur Penjualan"],
    ["R2", "C-A", "INT-1", 1, 101, 11, 112, "CN101", "Retur Penjualan"],
    ["R3", "C-A", "INT-1", 1, 101.01, 11, 112.01, "CN102", "Retur Penjualan"],
    ["R4", "C-A", "INT-1", 1, 100, 11, 111, "CN103", "Retur Penjualan"],
    ["R5", "C-A", "INT-CS", 24, 200, 22, 222, "CN108", "Retur Penjualan"],
    ["R6", "C-A", "INT-1", 1, 100, 11, 111, "CN110 dan CN111", "Retur Penjualan"],
    ["R7", "C-A", "INT-1", 1, 100, 11, 111, "CN200", "Retur Penjualan"],
    ["R8", "C-B", "INT-1", 1, 100, 11, 111, "CN200", "Retur Penjualan"],
    ["S1", "C-A", "INT-1", 99, 99, 99, 99, "CN100", "Faktur Penjualan"],
  ],
});

const invalidFormula = principalRow("CN106", "CT-1", "P-1", 1, 100);
invalidFormula[9] = 90;
const invalidUnit = principalRow("CN109", "CT-1", "P-1", 1, 100);
invalidUnit[5] = "BX";
const negativeQuantity = principalRow("CN113", "CT-1", "P-1", 1, 100);
negativeQuantity[7] = -1;

const principal = csv([
  principalHeader,
  principalRow("CN100", "CT-1", "P-1", 1, 100, 10),
  principalRow("CN100", "CT-1", "P-1", 2, 100, 20),
  principalRow("CN101", "CT-1", "P-1", 1, 100),
  principalRow("CN102", "CT-1", "P-1", 1, 100),
  principalRow("CN104", "CT-1", "P-1", 1, 100),
  principalRow("CN105", "CT-1", "P-BAD", 1, 100),
  invalidFormula,
  principalRow("BUKAN-CN", "CT-1", "P-1", 1, 100),
  principalRow("CN108", "CT-1", "P-CS", 2, 100, 0, 0, "CS"),
  invalidUnit,
  principalRow("CN201", "CT-A", "P-1", 1, 100),
  principalRow("CN201", "CT-B", "P-1", 1, 100),
  principalRow("CN112", "CT-1", "P-NOPACK", 1, 100, 0, 0, "CS"),
  negativeQuantity,
]);

const output = reconcileCussonsReturns(accurate, principal, mapping(), {
  dppTolerance: 1,
});

assert.equal(output.summary.MATCH, 3);
assert.equal(output.summary.VALUE_MISMATCH, 1);
assert.equal(output.summary.MISSING_PRINCIPAL, 1);
assert.equal(output.summary.MISSING_ACCURATE, 1);
assert.equal(output.summary.UNMAPPED, 2);
assert.equal(output.summary.INVALID_DATA, 9);

const aggregated = output.results.find(
  (row) => row.invoiceNumber === "CN100" && row.status === "MATCH",
);
assert.ok(aggregated);
assert.equal(aggregated.customerCode, "C-A");
assert.equal(aggregated.principalQuantity, 3);
assert.equal(aggregated.principalDpp, 270);
assert.deepEqual(aggregated.principalSourceRows, [2, 3]);

assert.equal(
  output.results.find((row) => row.invoiceNumber === "CN101")?.status,
  "MATCH",
);
assert.equal(
  output.results.find((row) => row.invoiceNumber === "CN102")?.status,
  "VALUE_MISMATCH",
);
assert.equal(
  output.results.find((row) => row.invoiceNumber === "CN108")?.status,
  "MATCH",
);
assert.ok(
  output.results.some(
    (row) =>
      row.status === "INVALID_DATA" &&
      row.invalidReason?.includes("lebih dari satu customer"),
  ),
);
assert.ok(
  output.results.some(
    (row) => row.status === "UNMAPPED" && row.invoiceNumber === "CN112",
  ),
);
assert.ok(
  output.results.some(
    (row) =>
      row.status === "INVALID_DATA" &&
      row.invalidReason?.includes("Prd Qty tidak valid"),
  ),
);
assert.ok(
  output.results.some(
    (row) =>
      row.status === "INVALID_DATA" &&
      row.invalidReason?.includes("Gross Amount"),
  ),
);
assert.ok(
  output.results.some(
    (row) =>
      row.status === "INVALID_DATA" &&
      row.invalidReason?.includes("tepat satu token"),
  ),
);
assert.ok(
  output.results.some(
    (row) =>
      row.status === "INVALID_DATA" &&
      row.invalidReason?.includes("UOM code"),
  ),
);
assert.ok(
  output.results.every(
    (row) => row.accurateSourceRows.length + row.principalSourceRows.length > 0,
  ),
);

const duplicateAcrossValidity = reconcileCussonsReturns(
  workbook({
    "Rincian Faktur Penjualan": [
      accurateHeader,
      ["R1", "C-A", "INT-1", 1, 100, 11, 111, "CN300", "Retur Penjualan"],
      ["R2", "C-B", "INT-1", -1, 100, 11, 111, "CN300", "Retur Penjualan"],
      ["R3", "C-A", "INT-1", 1, 100, 11, 111, "CN301", "Retur Penjualan"],
    ],
  }),
  (() => {
    const invalid = principalRow("CN301", "CT-B", "P-1", 1, 100);
    invalid[9] = 50;
    return csv([
      principalHeader,
      principalRow("CN300", "CT-A", "P-1", 1, 100),
      principalRow("CN301", "CT-A", "P-1", 1, 100),
      invalid,
    ]);
  })(),
  mapping(),
);
assert.equal(duplicateAcrossValidity.summary.MATCH, 0);
assert.equal(duplicateAcrossValidity.summary.INVALID_DATA, 4);
assert.equal(duplicateAcrossValidity.summary.MISSING_ACCURATE, 1);
assert.equal(duplicateAcrossValidity.summary.MISSING_PRINCIPAL, 1);
for (const cn of ["CN300", "CN301"])
  assert.equal(
    duplicateAcrossValidity.results.filter(
      (row) => row.invoiceNumber === cn && row.status === "INVALID_DATA",
    ).length,
    2,
  );

const committedMaster = readFileSync(
  resolve("data/reconciliation/CUSSONS_RETURN.xlsx"),
);
const committedMasterCheck = reconcileCussonsReturns(
  workbook({
    "Rincian Faktur Penjualan": [
      accurateHeader,
      [
        "R1",
        "C-A",
        "C1011001000410",
        1,
        100,
        11,
        111,
        "CN999",
        "Retur Penjualan",
      ],
    ],
  }),
  csv([
    principalHeader,
    principalRow("CN999", "CT-A", "100000425", 1, 100),
  ]),
  committedMaster,
);
assert.equal(committedMasterCheck.summary.MATCH, 1);

const realPaths = [
  "C:/Users/Fiqhi Fauzan/Downloads/cussons return/rincian_faktur_penjualan_cvsuryaperkasa_260729121643.xlsx",
  "C:/Users/Fiqhi Fauzan/Downloads/cussons return/TXN_NOTEPRD_CPM.csv",
];
if (realPaths.every(existsSync)) {
  const real = reconcileCussonsReturns(
    readFileSync(realPaths[0]),
    readFileSync(realPaths[1]),
    committedMaster,
  );
  assert.equal(real.accurateLines.length, 28);
  assert.equal(real.principalLines.length, 21);
  assert.equal(real.results.length, 28);
  assert.equal(real.summary.MATCH, 21);
  assert.equal(real.summary.MISSING_PRINCIPAL, 7);
  for (const [status, count] of Object.entries(real.summary))
    if (status !== "MATCH" && status !== "MISSING_PRINCIPAL")
      assert.equal(count, 0, `${status} harus 0`);
  assert.ok(
    real.results.every(
      (row) =>
        row.accurateSourceRows.length + row.principalSourceRows.length > 0,
    ),
  );
} else {
  console.log("SKIP - acceptance file eksternal CUSSONS tidak tersedia.");
}

console.log(
  "OK - CUSSONS Return exact CN+produk, diskon, agregasi, toleransi, EA/CS, invalid, missing, dan data nyata.",
);
