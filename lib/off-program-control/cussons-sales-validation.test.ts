import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as XLSX from "xlsx";
import {
  cussonsOrderNumber,
  parseAccurateSales,
  parseCussonsMappings,
  parseCussonsSales,
  reconcileCussonsSales,
} from "./sales-reconciliation.ts";

function workbook(sheets: Record<string, unknown[][]>): Buffer {
  const book = XLSX.utils.book_new();
  for (const [name, rows] of Object.entries(sheets))
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), name);
  return XLSX.write(book, { type: "buffer", bookType: "xlsx" });
}

function accurateWithRem(rem: string): Buffer {
  return workbook({
    "Rincian Faktur Penjualan": [
      [
        "NO_NOTA", "TANGGAL", "KODE PELANGGAN INDUK", "KODE_SALESMAN",
        "KODE_BARANG", "QTY_SATUANKECIL", "SATUAN_KECIL", "NILAI JUAL",
        "POTONGAN", "DPP", "NILAI_PAJAK", "JUMLAH", "REM",
        "JENIS_TRANSAKSI",
      ],
      [
        "INV-1", 46216, "C-1", "S-1", "C1284002004510", 12, "EA", 100,
        0, 100, 11, 111, rem, "1. Penjualan Bruto",
      ],
    ],
  });
}

const mappingHeader = [
  "Kode Pcpl",
  "ISI/CTN",
  "SATUAN Fix Win",
  "Kode BARANG Win2",
];

function formFixAt(headerRow: number, rows: unknown[][]): Buffer {
  return workbook({
    "Form Fix": [
      ...Array.from({ length: headerRow - 1 }, (_, index) =>
        index === 0 ? ["UPDATE TGL"] : [],
      ),
      mappingHeader,
      ...rows,
    ],
  });
}

function formFixAtRow5(rows: unknown[][]): Buffer {
  return formFixAt(5, rows);
}

function formFixWithEmptyPreamble(rows: unknown[][]): Buffer {
  const book = XLSX.utils.book_new(),
    sheet: XLSX.WorkSheet = {};
  XLSX.utils.sheet_add_aoa(sheet, [mappingHeader, ...rows], { origin: "A5" });
  sheet["!ref"] = `A5:D${5 + rows.length}`;
  assert.equal(sheet["!ref"], `A5:D${5 + rows.length}`);
  XLSX.utils.book_append_sheet(book, sheet, "Form Fix");
  return XLSX.write(book, { type: "buffer", bookType: "xlsx" });
}

const tiOptions = { orderNumber: cussonsOrderNumber };
assert.equal(
  parseAccurateSales(accurateWithRem("TI125970"), tiOptions)[0]?.orderNumber,
  "TI125970",
);
assert.throws(
  () => parseAccurateSales(accurateWithRem("XTI125970Y"), tiOptions),
  /nomor faktur/i,
);
assert.throws(
  () =>
    parseAccurateSales(
      accurateWithRem("TI125970 TI125971"),
      tiOptions,
    ),
  /tepat satu/i,
);
assert.throws(
  () => parseAccurateSales(accurateWithRem("TI125970")),
  /nomor order/i,
);

const mapped = parseCussonsMappings(
  formFixAtRow5([["100113936", 12, "PACK", "C1284002004510"]]),
);
assert.equal(
  mapped.products.get("100113936")?.productCodeInternal,
  "C1284002004510",
);
assert.equal(mapped.products.get("100113936")?.caseSize, 12);
assert.equal(
  mapped.products.get("100113936")?.mappingStatus,
  "OK",
);
const mappedWithoutPreambleCells = parseCussonsMappings(
  formFixWithEmptyPreamble([["100113936", 12, "CS", "C1284002004510"]]),
);
assert.equal(
  mappedWithoutPreambleCells.products.get("100113936")?.productCodeInternal,
  "C1284002004510",
);
for (const [sku, unsupportedUnit] of [
  ["100113939", "BOX"],
  ["100113940", "ARBITRER"],
]) {
  const unsupported = parseCussonsMappings(
    formFixAtRow5([[sku, 12, unsupportedUnit, `INTERNAL-${sku}`]]),
  );
  assert.equal(
    unsupported.products.get(sku)?.mappingStatus,
    "OK",
  );
}

for (const headerRow of [4, 6])
  assert.throws(
    () =>
      parseCussonsMappings(
        formFixAt(headerRow, [["100113936", 12, "CS", "C1284002004510"]]),
      ),
    /Header wajib tidak ditemukan/,
  );

const blankPrincipal = parseCussonsMappings(
  formFixAtRow5([
    [null, 12, "CS", "IGNORED"],
    ["100113936", 12, "CS", "C1284002004510"],
  ]),
);
assert.equal(blankPrincipal.products.size, 1);
assert.equal(blankPrincipal.products.has(""), false);

const identicalDuplicate = parseCussonsMappings(
  formFixAtRow5([
    ["100113936", 12, "CS", "C1284002004510"],
    ["100113936", 12, "CS", "C1284002004510"],
  ]),
);
assert.equal(identicalDuplicate.products.size, 1);
assert.equal(
  identicalDuplicate.products.get("100113936")?.mappingStatus,
  "OK",
);

const conflictingTarget = parseCussonsMappings(
  formFixAtRow5([
    ["100113936", 12, "CS", "C1284002004510"],
    ["100113936", 12, "CS", "C1284002009999"],
    ["100113937", null, "EA", "C1284002004511"],
  ]),
);
assert.equal(
  conflictingTarget.products.get("100113936")?.mappingStatus,
  "INVALID_DATA",
);
assert.equal(conflictingTarget.products.get("100113937")?.mappingStatus, "OK");

const eaIgnoresPack = parseCussonsMappings(
  formFixAtRow5([
    ["100113937", "RUSAK", "EA", "C1284002004511"],
    ["100113937", 999, "EA", "C1284002004511"],
  ]),
);
assert.equal(eaIgnoresPack.products.size, 1);
assert.equal(eaIgnoresPack.products.get("100113937")?.caseSize, null);
assert.equal(
  eaIgnoresPack.products.get("100113937")?.mappingStatus,
  "INVALID_DATA",
);

const csZeroPack = parseCussonsMappings(
  formFixAtRow5([["100113938", 0, "CS", "C1284002004512"]]),
);
assert.equal(
  csZeroPack.products.get("100113938")?.mappingStatus,
  "OK",
);

const csvHeaders = [
  "Invoice No", "Distributor Code", "Customer Code", "Route Code",
  "Product Index", "Product Code", "Product Description", "UOM Code",
  "Selling Type", "Default UOM", "Product Quantity", "MRP",
  "Product List Price", "UOM List Price", "Gross Amount", "Product Discount",
  "Promo Discount", "SLS Discount", "Customer Group Discount",
  "Discount Amount", "Amount After SKU Disc", "Customer Discount",
  "Total Tax Amount", "Total Net Amount", "Tax Code", "Tax Percentage 1",
  "Tax Percentage 2", "Tax Percentage 3", "Tax Amount 1", "Tax Amount 2",
  "Tax Amount 3",
] as const;
type CsvRow = Record<(typeof csvHeaders)[number], string | number>;
function eaRow(overrides: Partial<CsvRow> = {}): CsvRow {
  return {
    "Invoice No": "TI125970", "Distributor Code": "3000871",
    "Customer Code": "CUSTOMER, QUOTED", "Route Code": "SP1M-AF",
    "Product Index": 1, "Product Code": "100113936",
    "Product Description": "CUSSONS PRODUCT", "UOM Code": "EA",
    "Selling Type": "S", "Default UOM": "EA", "Product Quantity": 3,
    MRP: 0, "Product List Price": 10, "UOM List Price": 10,
    "Gross Amount": 30, "Product Discount": 0, "Promo Discount": 0,
    "SLS Discount": 0, "Customer Group Discount": 0, "Discount Amount": 2,
    "Amount After SKU Disc": 28, "Customer Discount": 1,
    "Total Tax Amount": 2.97, "Total Net Amount": 29.97,
    "Tax Code": "PPN_Output", "Tax Percentage 1": 11,
    "Tax Percentage 2": 0, "Tax Percentage 3": 0, "Tax Amount 1": 2.97,
    "Tax Amount 2": 0, "Tax Amount 3": 0, ...overrides,
  };
}
function csRow(overrides: Partial<CsvRow> = {}): CsvRow {
  return eaRow({ "Product Code": "100113937", "UOM Code": "CS",
    "Default UOM": "CS", "Product Quantity": 2, "Gross Amount": 20,
    "Discount Amount": 0, "Amount After SKU Disc": 20,
    "Customer Discount": 0, "Total Tax Amount": 2.2,
    "Total Net Amount": 22.2, ...overrides });
}
function csv(...rows: CsvRow[]): Buffer {
  const quote = (value: string | number) => {
    const raw = String(value);
    return /[",\r\n]/.test(raw) ? '"' + raw.replaceAll('"', '""') + '"' : raw;
  };
  return Buffer.from("\uFEFF" + csvHeaders.join(",") + "\r\n" +
    rows.map((row) => csvHeaders.map((header) => quote(row[header])).join(","))
      .join("\r\n") + "\r\n");
}
const salesMappings = parseCussonsMappings(formFixAtRow5([
  ["100113936", null, "EA", "C1284002004510"],
  ["100113937", 12, "CS", "C1284002004511"],
  ["100113938", 0, "CS", "C1284002004512"],
  ["100113939", 12, "EA", "C1284002004513"],
  ["100113939", 12, "EA", "C1284002009999"],
]));
const parsedQuoted = parseCussonsSales(csv(eaRow()), salesMappings)[0];
assert.equal(parsedQuoted?.customerCodeRaw, "CUSTOMER, QUOTED");
assert.equal(parsedQuoted?.quantitySmallest, 3);
assert.equal(parsedQuoted?.discountAmount, 30_000);
assert.equal(parseCussonsSales(csv(csRow()), salesMappings)[0]?.quantitySmallest, 24);
assert.equal(
  parseCussonsSales(
    csv(eaRow({ "Product Code": "100113938" })),
    salesMappings,
  )[0]?.mappingStatus,
  "OK",
);
for (const header of ["Gross Amount", "Product Description"]) {
  const missingHeader = csv(eaRow()).toString().replace(header + ",", "");
  assert.throws(
    () => parseCussonsSales(Buffer.from(missingHeader), salesMappings),
    new RegExp("Header wajib.*" + header, "i"),
  );
}
for (const field of [
  "Product Quantity", "UOM List Price", "Gross Amount", "Discount Amount",
  "Amount After SKU Disc", "Customer Discount", "Total Tax Amount",
  "Total Net Amount", "Tax Percentage 1",
] as const)
  for (const bad of ["", "Infinity", -1])
    assert.throws(
      () => parseCussonsSales(csv(eaRow({ [field]: bad })), salesMappings),
      new RegExp(field, "i"),
    );
assert.equal(
  parseCussonsSales(csv(eaRow({ "Gross Amount": 30.0001 })), salesMappings)[0]
    ?.mappingStatus,
  "OK",
);
assert.equal(
  parseCussonsSales(csv(eaRow({ "Gross Amount": 30.0002 })), salesMappings)[0]
    ?.mappingStatus,
  "INVALID_DATA",
);
for (const overrides of [{ "Gross Amount": 31 }, { "Amount After SKU Disc": 27 }, { "Total Tax Amount": 2.98 }, { "Total Net Amount": 29.98 }, { "Tax Code": "NO_TAX" }, { "Tax Percentage 1": 10 }, { "Selling Type": "R" }] satisfies Partial<CsvRow>[])
  assert.equal(parseCussonsSales(csv(eaRow(overrides)), salesMappings)[0]?.mappingStatus, "INVALID_DATA");
assert.equal(parseCussonsSales(csv(eaRow({ "UOM Code": "BOX" })), salesMappings)[0]?.mappingStatus, "UNIT_CONVERSION_ERROR");
assert.equal(parseCussonsSales(csv(csRow({ "Product Code": "100113938" })), salesMappings)[0]?.mappingStatus, "UNIT_CONVERSION_ERROR");
for (const product of ["999999999", "100113939"])
  assert.equal(parseCussonsSales(csv(eaRow({ "Product Code": product })), salesMappings)[0]?.productCodeInternal, "CUSSONS_INVALID:" + product);
for (const rows of [[eaRow({ "UOM Code": "BOX" }), eaRow({ "Selling Type": "R" })], [eaRow({ "Selling Type": "R" }), eaRow({ "UOM Code": "BOX" })]]) {
  const result = reconcileCussonsSales(accurateWithRem("TI125970"), csv(...rows), formFixAtRow5([["100113936", null, "EA", "C1284002004510"]]));
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0]?.status, "INVALID_DATA");
}
if (process.argv.length === 5) {
  const result = reconcileCussonsSales(readFileSync(process.argv[2]), readFileSync(process.argv[3]), readFileSync(process.argv[4])),
    matched = result.results.filter((row) => row.status === "MATCH"),
    missing = result.results.filter((row) => row.status === "MISSING_PRINCIPAL"),
    total = (
      rows: typeof result.results,
      field: keyof (typeof result.results)[number],
    ) =>
      Math.round(
        rows.reduce((sum, row) => sum + Number(row[field]), 0) * 100,
      ) / 100,
    lineTotal = (
      lines: typeof result.accurateLines,
      field: "quantitySmallest" | "grossAmount" | "discountAmount" |
        "dppAmount" | "taxAmount" | "netAmount",
    ) => {
      const sum = lines.reduce((total, line) => total + line[field], 0);
      return field === "quantitySmallest"
        ? sum
        : Math.round((sum / 10_000) * 100) / 100;
    },
    accurateMatched = result.accurateLines.filter(
      (line) => line.orderNumber !== "TI125941",
    ),
    accurateMissing = result.accurateLines.filter(
      (line) => line.orderNumber === "TI125941",
    );
  assert.equal(result.accurateLines.length, 52);
  assert.equal(result.kinoLines.length, 39);
  assert.equal(result.results.length, 52);
  assert.equal(matched.length, 39);
  assert.equal(missing.length, 13);
  assert.ok(missing.every((row) => row.orderNumber === "TI125941"));
  assert.ok(matched.every((row) => row.quantityDifference === 0));
  assert.ok(matched.every((row) => row.amountDifferences.length === 0));
  for (const [status, count] of Object.entries(result.summary))
    assert.equal(count, status === "MATCH" ? 39 : status === "MISSING_PRINCIPAL" ? 13 : 0);
  assert.equal(total(matched, "accurateQuantity"), 537);
  assert.equal(total(matched, "principalQuantity"), 537);
  assert.equal(total(matched, "accurateNet"), 6_875_550.9);
  assert.equal(total(matched, "principalNet"), 6_875_550.9);
  assert.equal(total(missing, "accurateQuantity"), 57);
  assert.equal(total(missing, "accurateNet"), 933_732);
  for (const lines of [accurateMatched, result.kinoLines]) {
    assert.equal(lineTotal(lines, "quantitySmallest"), 537);
    assert.equal(lineTotal(lines, "grossAmount"), 6_194_190);
    assert.equal(lineTotal(lines, "discountAmount"), 0);
    assert.equal(lineTotal(lines, "dppAmount"), 6_194_190);
    assert.equal(lineTotal(lines, "taxAmount"), 681_360.9);
    assert.equal(lineTotal(lines, "netAmount"), 6_875_550.9);
  }
  assert.equal(lineTotal(accurateMissing, "quantitySmallest"), 57);
  assert.equal(lineTotal(accurateMissing, "grossAmount"), 841_200);
  assert.equal(lineTotal(accurateMissing, "discountAmount"), 0);
  assert.equal(lineTotal(accurateMissing, "dppAmount"), 841_200);
  assert.equal(lineTotal(accurateMissing, "taxAmount"), 92_532);
  assert.equal(lineTotal(accurateMissing, "netAmount"), 933_732);
}
console.log("OK - parser dan rekonsiliasi CUSSONS tervalidasi.");
