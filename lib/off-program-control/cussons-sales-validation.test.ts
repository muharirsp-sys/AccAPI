import assert from "node:assert/strict";
import * as XLSX from "xlsx";
import {
  cussonsOrderNumber,
  parseAccurateSales,
  parseCussonsMappings,
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
assert.equal(mapped.products.get("100113936")?.mappingStatus, "OK");

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

const eaWithoutPack = parseCussonsMappings(
  formFixAtRow5([["100113937", null, "EA", "C1284002004511"]]),
);
assert.equal(eaWithoutPack.products.get("100113937")?.caseSize, null);
assert.equal(eaWithoutPack.products.get("100113937")?.mappingStatus, "OK");

const csZeroPack = parseCussonsMappings(
  formFixAtRow5([["100113938", 0, "CS", "C1284002004512"]]),
);
assert.equal(
  csZeroPack.products.get("100113938")?.mappingStatus,
  "UNIT_CONVERSION_ERROR",
);

console.log("OK - token TI dan mapping CUSSONS tervalidasi.");
