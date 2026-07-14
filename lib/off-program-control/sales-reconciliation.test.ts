/*
 * Self-check parser + engine rekonsiliasi KINO dan Godrej.
 * KINO nyata: node --experimental-strip-types lib/off-program-control/sales-reconciliation.test.ts <accurate.xlsx> <sales-detail.xlsx> <kino.xlsx>
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as XLSX from "xlsx";
import { reconcileGodrejSales, reconcileKinoSales } from "./sales-reconciliation.ts";

function workbook(sheets: Record<string, unknown[][]>): Buffer {
  const wb = XLSX.utils.book_new();
  for (const [name, rows] of Object.entries(sheets)) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), name);
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
}

const accurate = workbook({ "Rincian Faktur Penjualan": [
  ["NO_NOTA", "TANGGAL", "KODE PELANGGAN INDUK", "KODE_SALESMAN", "KODE_BARANG", "QTY_SATUANKECIL", "SATUAN_KECIL", "NILAI JUAL", "POTONGAN", "DPP", "NILAI_PAJAK", "JUMLAH", "REM", "JENIS_TRANSAKSI"],
  ["INV-1", 46204, "C-1", "S-1", "ITEM-1", 6, "BTL", 100, 0, 100, 11, 111, "teks 1671-SOP-1 tambahan", "1. Penjualan Bruto"],
  ["INV-2", 46204, "C-1", "S-1", "ITEM-2", 3, "TUBE", 210, 5, 205, 24, 228, "1671-SOP-2", "1. Penjualan Bruto"],
] });
const kino = workbook({ Sheet1: [
  ["REPORT SALES DETAIL"], ["Periode", ": 2026-07-01"], ["Cabang", ": 1201671"],
  ["CUSTCODE1", "ORDER_NO", "INVOICE_NO", "INVOICE_DATE", "PRODUCT_CODE", "SALESMAN_ID", "FLAG_BONUS", "INVOICE_QTY", "INVOICE_GROSS", "INVOICE_TOTALLINEDISC", "INVOICE_PROMO", "INVOICE_CASHDISC", "INVOICE_TAX", "INVOICE_NET", "PRD_UOM1"],
  ["KC-1", "1671-SOP-1", "INV-K1", "2026-07-01", "P-1", "KS-1", "N", 6, 100, 0, 0, 0, 11, 111, "BT"],
  ["KC-1", "1671-SOP-2", "INV-K2", "2026-07-01", "P-2", "KS-1", "N", 4, 200, 0, 0, 0, 22, 222, "TUB"], ["Grand Total"],
] });
const mapping = workbook({ Mapping_Prd: [["KODE ITEM", "Kode Alias", "Satuan", "ISI"], ["ITEM-1", "P-1", "BTL", 36], ["ITEM-2", "P-2", "TUBE", 12]], Mapping_Customer: [["Code Kino", "Code Internal"], ["KC-1", "C-1"]], Mapping_Sls: [["SLSMAN_ID", "Code Internal"], ["KS-1", "S-1"]] });
const synthetic = reconcileKinoSales(accurate, kino, mapping, { valueTolerance: 1 });
assert.equal(synthetic.results.length, 2);
assert.equal(synthetic.summary.MATCH, 1);
assert.equal(synthetic.summary.QTY_AND_VALUE_MISMATCH, 1);
assert.equal(synthetic.summary.QTY_MISMATCH, 0);
assert.equal(synthetic.summary.INVALID_DATA, 0);
assert.equal(synthetic.results.find((row) => row.internalProductCode === "ITEM-1")?.status, "MATCH");
const different = synthetic.results.find((row) => row.internalProductCode === "ITEM-2");
assert.equal(different?.status, "QTY_AND_VALUE_MISMATCH");
assert.equal(different?.quantityDifference, -1);
assert.deepEqual(different?.amountDifferences, [
  { component: "gross", accurate: 210, kino: 200, difference: 10 },
  { component: "discount", accurate: 5, kino: 0, difference: 5 },
  { component: "dpp", accurate: 205, kino: 200, difference: 5 },
  { component: "tax", accurate: 24, kino: 22, difference: 2 },
  { component: "net", accurate: 228, kino: 222, difference: 6 },
]);
assert.deepEqual(synthetic.results.find((row) => row.status === "MATCH")?.amountDifferences, []);
const tolerated = reconcileKinoSales(accurate, kino, mapping, { valueTolerance: 10 }).results.find((row) => row.internalProductCode === "ITEM-2");
assert.equal(tolerated?.status, "QTY_MISMATCH");
assert.deepEqual(tolerated?.amountDifferences, []);

const godrejAccurate = workbook({ "Rincian Faktur Penjualan": [
  ["NO_NOTA", "TANGGAL", "KODE PELANGGAN INDUK", "KODE_SALESMAN", "KODE_BARANG", "QTY_SATUANKECIL", "SATUAN_KECIL", "NILAI JUAL", "POTONGAN", "DPP", "NILAI_PAJAK", "JUMLAH", "REM", "JENIS_TRANSAKSI"],
  ["A-1", 46216, "C-2", "S-2", "ITEM-G", 6, "BTL", 100, 5, 95, 10.45, 105.45, "catatan FK/BFG-10025410 tambahan", "1. Penjualan Bruto"],
] });
const godrej = workbook({ Sheet1: [["IV_NO", "IV_DATE", "CS_NO", "PS_NO", "INV_NO", "IV_TOTPCS", "IV_PRICE", "IV_DISC1", "IV_FRA", "AR_AMT", "IV_DISC2"], ["FK/BFG-10025410", 46216, "FGC-1", "FGM-1", "40043482", 6, 1200, 5, 72, 999999, 0]] });
const godrejMapping = workbook({ "Pvt Map 1": [["Kode Pcpl", "Kode BARANG Win2", "SATUAN Fix Win"], ["40043482", "ITEM-G", "BTL"], ["40043482", "ITEM-LAIN", "BTL"], [null, "(blank)", null], ["(blank)", "", 0]] });
const godrejResult = reconcileGodrejSales(godrejAccurate, godrej, godrejMapping);
assert.equal(godrejResult.summary.MATCH, 1);
assert.equal(godrejResult.results[0]?.orderNumber, "BFG-10025410");
assert.deepEqual(godrejResult.results[0]?.amountDifferences, []);
assert.equal(godrejResult.kinoLines[0]?.grossAmount, 1_000_000);
assert.equal(godrejResult.kinoLines[0]?.discountAmount, 50_000);
assert.equal(godrejResult.kinoLines[0]?.dppAmount, 950_000);
assert.equal(godrejResult.kinoLines[0]?.taxAmount, 104_500);
assert.equal(godrejResult.kinoLines[0]?.netAmount, 1_054_500);
const unsupportedAdjustment = workbook({ Sheet1: [["IV_NO", "IV_DATE", "CS_NO", "PS_NO", "INV_NO", "IV_TOTPCS", "IV_PRICE", "IV_DISC1", "IV_FRA", "IV_DISC2"], ["FK/BFG-10025410", 46216, "FGC-1", "FGM-1", "40043482", 6, 1200, 5, 72, 1]] });
assert.throws(() => reconcileGodrejSales(godrejAccurate, unsupportedAdjustment, godrejMapping), /IV_DISC2 belum memiliki aturan/);

const realPaths = process.argv.slice(2);
if (realPaths.length) {
  assert.equal(realPaths.length, 3, "berikan path Accurate, SALES_DETAIL, dan Kino.xlsx");
  const real = reconcileKinoSales(...realPaths.map((path) => readFileSync(path)) as [Buffer, Buffer, Buffer], { valueTolerance: 1 });
  assert.equal(real.accurateLines.length, 238);
  assert.equal(real.kinoLines.length, 238);
  assert.equal(real.summary.MATCH, 236);
  assert.equal(real.summary.QTY_AND_VALUE_MISMATCH, 2);
  assert.equal(real.summary.MISSING_INTERNAL, 0);
  assert.equal(real.summary.MISSING_PRINCIPAL, 0);
}
console.log("OK — parser KINO, tolerance, file nyata opsional, dan Godrej tervalidasi.");
