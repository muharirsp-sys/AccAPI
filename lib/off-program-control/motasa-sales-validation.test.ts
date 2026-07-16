import assert from "node:assert/strict";
import * as XLSX from "xlsx";
import {
  parseAccurateSales,
  parseMotasaMappings,
} from "./sales-reconciliation.ts";

function workbook(sheets: Record<string, unknown[][]>): Buffer {
  const book = XLSX.utils.book_new();
  for (const [name, rows] of Object.entries(sheets))
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), name);
  return XLSX.write(book, { type: "buffer", bookType: "xlsx" });
}

const motasaHeader = ["Kode BARANG Win2", "ISI/CTN", "SATUAN Fix Win"];

function formFixAt(headerRow: number, ...rows: unknown[][]): Buffer {
  return workbook({
    "Form Fix": [
      ...Array.from({ length: headerRow - 1 }, (_, index) =>
        index === 0 ? ["UPDATE TGL"] : [],
      ),
      motasaHeader,
      ...rows,
    ],
  });
}

function formFix(...rows: unknown[][]): Buffer {
  return formFixAt(5, ...rows);
}

const mappings = parseMotasaMappings(
  formFix(
    ["M4030000000010", 576, "SCH"],
    ["M4011003000010", 192, "SCH"],
  ),
);
assert.deepEqual(mappings.products.get("M4030000000010"), {
  unit: "SCH",
  caseSize: 576,
  mappingStatus: "OK",
});
assert.throws(
  () => parseMotasaMappings(formFixAt(4, ["EARLY", 12, "KRT"])),
  /Header wajib tidak ditemukan/,
);
assert.throws(
  () => parseMotasaMappings(formFixAt(6, ["LATE", 12, "KRT"])),
  /Header wajib tidak ditemukan/,
);

const schCaseSize = parseMotasaMappings(
  formFix(
    ["SCH-ZERO", 0, "SCH"],
    ["SCH-EMPTY", null, "SCH"],
    ["SCH-BAD", "RUSAK", "SCH"],
  ),
);
assert.equal(schCaseSize.products.get("SCH-ZERO")?.mappingStatus, "OK");
assert.equal(schCaseSize.products.get("SCH-EMPTY")?.mappingStatus, "OK");
assert.equal(schCaseSize.products.get("SCH-BAD")?.mappingStatus, "OK");

const schDuplicate = parseMotasaMappings(
  formFix(["DUP-SCH", 0, "SCH"], ["DUP-SCH", "RUSAK", "SCH"]),
);
assert.equal(schDuplicate.products.get("DUP-SCH")?.mappingStatus, "OK");

const badSize = parseMotasaMappings(formFix(["BAD-SIZE", 0, "KRT"]));
assert.equal(
  badSize.products.get("BAD-SIZE")?.mappingStatus,
  "UNIT_CONVERSION_ERROR",
);

const badUnit = parseMotasaMappings(formFix(["BAD-UNIT", 12, "PCS"]));
assert.equal(
  badUnit.products.get("BAD-UNIT")?.mappingStatus,
  "UNIT_CONVERSION_ERROR",
);

const badUnitConflict = parseMotasaMappings(
  formFix(["DUP-BAD", 12, "PCS"], ["DUP-BAD", 120, "PCS"]),
);
assert.equal(
  badUnitConflict.products.get("DUP-BAD")?.mappingStatus,
  "INVALID_DATA",
);

const conflict = parseMotasaMappings(
  formFix(["DUP", 12, "KRT"], ["DUP", 120, "KRT"]),
);
assert.equal(conflict.products.get("DUP")?.mappingStatus, "INVALID_DATA");

function accurate(rem: string): Buffer {
  return workbook({
    "Rincian Faktur Penjualan": [
      [
        "NO_NOTA", "TANGGAL", "KODE PELANGGAN INDUK", "KODE_SALESMAN",
        "KODE_BARANG", "QTY_SATUANKECIL", "SATUAN_KECIL", "NILAI JUAL",
        "POTONGAN", "DPP", "NILAI_PAJAK", "JUMLAH", "REM",
        "JENIS_TRANSAKSI",
      ],
      [
        "INV-1", 46216, "C-1", "S-1", "M4030000000010", 576, "SCH",
        100, 0, 100, 11, 111, rem, "1. Penjualan Bruto",
      ],
    ],
  });
}

assert.equal(
  parseAccurateSales(accurate("MK2260714005<PF>"))[0]?.orderNumber,
  "MK2260714005",
);
for (const rem of [
  "XMK2260714005",
  "MK2260714005Y",
  "1MK2260714005",
  "MK22607140050",
  "MK2260714005 MK2260714006",
])
  assert.throws(
    () => parseAccurateSales(accurate(rem)),
    /harus memuat tepat satu nomor order/,
  );

console.log("OK - token dan mapping MOTASA tervalidasi.");
