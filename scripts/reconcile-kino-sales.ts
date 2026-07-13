/*
 * Jalankan:
 * node --experimental-strip-types scripts/reconcile-kino-sales.ts <accurate.xlsx> <sales-detail.xlsx> <kino.xlsx> [hasil.xlsx]
 */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import * as XLSX from "xlsx";
import { reconcileKinoSales } from "../lib/off-program-control/sales-reconciliation.ts";

const inputs = process.argv.slice(2);
if (inputs.length < 3 || inputs.length > 4) {
  throw new Error("Penggunaan: <accurate.xlsx> <sales-detail.xlsx> <kino.xlsx> [hasil.xlsx]");
}

const [accuratePath, kinoPath, mappingPath] = inputs.slice(0, 3).map((file) => path.resolve(file));
for (const file of [accuratePath, kinoPath, mappingPath]) {
  if (path.extname(file).toLowerCase() !== ".xlsx") throw new Error(`File harus .xlsx: ${file}`);
  if (!existsSync(file)) throw new Error(`File tidak ditemukan: ${file}`);
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outputPath = path.resolve(inputs[3] ?? `hasil-rekonsiliasi-kino-${stamp}.xlsx`);
if (path.extname(outputPath).toLowerCase() !== ".xlsx") throw new Error("File hasil harus berekstensi .xlsx");
if (existsSync(outputPath)) throw new Error(`File hasil sudah ada: ${outputPath}`);

const output = reconcileKinoSales(
  readFileSync(accuratePath),
  readFileSync(kinoPath),
  readFileSync(mappingPath),
  { valueTolerance: 1 },
);

const workbook = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(
  Object.entries(output.summary).map(([status, jumlah]) => ({ Status: status, Jumlah: jumlah })),
), "Ringkasan");
XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(output.results.map((result) => ({
  Status: result.status,
  Peringatan: result.warnings.join(", "),
  Order: result.orderNumber,
  "Kode Barang Internal": result.internalProductCode,
  "Jenis Transaksi": result.transactionClass,
  "Qty Accurate": result.accurateQuantity,
  "Qty KINO": result.principalQuantity,
  "Selisih Qty": result.quantityDifference,
  "Net Accurate": result.accurateNet,
  "Net KINO": result.principalNet,
  "Selisih Net": result.valueDifference,
  "Baris Accurate": result.accurateSourceRows.join(", "),
  "Baris KINO": result.principalSourceRows.join(", "),
}))), "Detail");

mkdirSync(path.dirname(outputPath), { recursive: true });
const temporaryPath = `${outputPath}.${randomUUID()}.tmp`;
try {
  writeFileSync(temporaryPath, XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }));
  renameSync(temporaryPath, outputPath);
} catch (error) {
  if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
  throw error;
}

console.log(`Selesai: ${outputPath}`);
console.log(`MATCH: ${output.summary.MATCH}; SELISIH: ${output.results.length - output.summary.MATCH}; TOTAL: ${output.results.length}`);
