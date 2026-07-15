import assert from "node:assert/strict";
import * as XLSX from "xlsx";
import {
  type CanonicalSalesLine,
  parseGodrejMappings,
  parseGodrejSales,
} from "./sales-reconciliation.ts";

function workbook(sheets: Record<string, unknown[][]>): Buffer {
  const value = XLSX.utils.book_new();
  for (const [name, rows] of Object.entries(sheets))
    XLSX.utils.book_append_sheet(value, XLSX.utils.aoa_to_sheet(rows), name);
  return XLSX.write(value, { type: "buffer", bookType: "xlsx" });
}

const mappings = parseGodrejMappings(
  workbook({
    "Pvt Map 1": [
      ["Kode Pcpl", "Kode BARANG Win2", "SATUAN Fix Win"],
      ["40043482", "ITEM-G", "BTL"],
    ],
  }),
);
const accurateLines: CanonicalSalesLine[] = [
  {
    source: "ACCURATE",
    sourceRowNumber: 2,
    documentNumber: "A-1",
    orderNumber: "BFG-10025410",
    transactionDate: "2026-07-13",
    customerCodeRaw: "C-1",
    customerCodeInternal: "C-1",
    salesmanCodeRaw: "S-1",
    salesmanCodeInternal: "S-1",
    productCodeRaw: "ITEM-G",
    productCodeInternal: "ITEM-G",
    transactionClass: "NORMAL",
    quantitySmallest: 1,
    unitSmallest: "BTL",
    grossAmount: 0,
    discountAmount: 0,
    dppAmount: 0,
    taxAmount: 0,
    netAmount: 0,
    mappingStatus: "OK",
  },
];
function principal(discount: number, quantity = 1, price = 1, fraction = 2) {
  return workbook({
    Sheet1: [
      [
        "IV_NO",
        "IV_DATE",
        "CS_NO",
        "PS_NO",
        "INV_NO",
        "IV_TOTPCS",
        "IV_PRICE",
        "IV_DISC1",
        "IV_FRA",
      ],
      [
        "FK/BFG-10025410",
        46216,
        "C-1",
        "S-1",
        "40043482",
        quantity,
        price,
        discount,
        fraction,
      ],
    ],
  });
}

for (const invalidDiscount of [-1, 101])
  assert.throws(
    () => parseGodrejSales(principal(invalidDiscount), mappings, accurateLines),
    /IV_DISC1 harus antara 0 dan 100 pada baris 2/,
  );

const rounded = parseGodrejSales(principal(7), mappings, accurateLines)[0];
assert.equal(rounded?.dppAmount, 4_650);
assert.equal(rounded?.taxAmount, 512);

console.log("OK — validasi diskon dan pembulatan pajak Godrej tervalidasi.");
