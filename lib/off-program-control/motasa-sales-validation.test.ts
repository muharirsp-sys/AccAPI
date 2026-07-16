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

function formFix(...rows: unknown[][]): Buffer {
  return workbook({
    "Form Fix": [
      ["UPDATE TGL"],
      [],
      ["PASTE NAMA DAN CODE PRINCIPLE"],
      ["ISI SESUAIKAN ANTARA DMS vs WIN"],
      ["Kode BARANG Win2", "ISI/CTN", "SATUAN Fix Win"],
      ...rows,
    ],
  });
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

const badSize = parseMotasaMappings(
  formFix(["BAD-SIZE", 0, "SCH"]),
);
assert.equal(
  badSize.products.get("BAD-SIZE")?.mappingStatus,
  "UNIT_CONVERSION_ERROR",
);

const conflict = parseMotasaMappings(
  formFix(["DUP", 12, "SCH"], ["DUP", 120, "SCH"]),
);
assert.equal(conflict.products.get("DUP")?.mappingStatus, "INVALID_DATA");

const accurate = workbook({
  "Rincian Faktur Penjualan": [
    [
      "NO_NOTA", "TANGGAL", "KODE PELANGGAN INDUK", "KODE_SALESMAN",
      "KODE_BARANG", "QTY_SATUANKECIL", "SATUAN_KECIL", "NILAI JUAL",
      "POTONGAN", "DPP", "NILAI_PAJAK", "JUMLAH", "REM",
      "JENIS_TRANSAKSI",
    ],
    [
      "INV-1", 46216, "C-1", "S-1", "M4030000000010", 576, "SCH",
      100, 0, 100, 11, 111, "MK2260714005<PF>", "1. Penjualan Bruto",
    ],
  ],
});
assert.equal(parseAccurateSales(accurate)[0]?.orderNumber, "MK2260714005");

console.log("OK - token dan mapping MOTASA tervalidasi.");
