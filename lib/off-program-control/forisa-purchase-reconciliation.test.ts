import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as XLSX from "xlsx";
import { createKinoSalesPostHandler } from "./kino-sales-route.ts";
import { reconcileForisaPurchases } from "./purchase-reconciliation.ts";

function workbook(sheetName: string, values: unknown[][]): Uint8Array {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(values), sheetName);
  return XLSX.write(book, { bookType: "xlsx", type: "buffer" });
}

async function main() {

const mapping = workbook("Upload To Win", [
  ["Kode Pcpl", "Kode BARANG Win2", "Nama Win", "ISI/CTN"],
  ["P1", "NEW1", "TOP CHOCO 100 GR", 12],
  ["P2", "NEW2", "NUTRIJELL MANGO 15 GR", 24],
]);
const accurate = workbook("Rincian Faktur Pembelian", [
  ["NO. PEMBELIAN", "KODE BARANG", "NAMA BARANG", "QTY", "SATUAN", "DPP", "PPN", "REM"],
  ["FB-1", "44001", "TOP CKLT 100GR FS PI01", 2, "KRT", 100, 22, "Surat jalan /4010368434 (GT)"],
  ["FB-1", "44002", "NUTRIJELL MANGGA 15G X REG", 3, "KRT", 200, 22, "Surat jalan /4010368434 (GT)"],
  ["FB-2", "IGNORED", "TOP CKLT 100GR", 99, "KRT", 999, 110, "Surat jalan /4010999999"],
]);
const principal = workbook("DO", [
  ["Product Code", "Product Name", "Brand Name", "Qty (CB)", "Price", "Amount", "Discount", "Amount After Discount", "PPN", "Total Amount"],
  ["P1", "TOP CHOCOLATE 100 GR", "TOP", 2, 55, 110, 10, 100, 11, 111],
  ["P2", "NUTRIJELL MANGO 15 GR", "NUTRIJELL", 3, 70, 210, 10, 200, 22, 222],
]);
const badPricePrincipal = workbook("DO", [
  ["Product Code", "Product Name", "Brand Name", "Qty (CB)", "Price", "Amount", "Discount", "Amount After Discount", "PPN", "Total Amount"],
  ["P1", "TOP CHOCOLATE 100 GR", "TOP", 2, 999, 110, 10, 100, 11, 111],
  ["P2", "NUTRIJELL MANGO 15 GR", "NUTRIJELL", 3, 70, 210, 10, 200, 22, 222],
]);

const output = reconcileForisaPurchases(
  accurate,
  principal,
  mapping,
  "do 4010368434 (GT).xlsx",
);
assert.equal(output.accurateLines.length, 2, "Accurate DO lain tidak boleh ikut dibandingkan");
assert.equal(output.principalLines.length, 2);
assert.equal(output.summary.MATCH, 2);
assert.equal(output.results.length, 2);
assert.deepEqual(output.results.map((row) => row.accurateProductCode).sort(), ["44001", "44002"]);
assert.deepEqual(output.results.map((row) => row.principalProductCode).sort(), ["P1", "P2"]);
assert.ok(output.results.every((row) => row.quantityDifference === 0 && Math.abs(row.dppDifference) <= 1));
const badPrice = reconcileForisaPurchases(
  accurate,
  badPricePrincipal,
  mapping,
  "do 4010368434 (GT).xlsx",
);
assert.equal(badPrice.summary.MATCH, 1);
assert.ok(
  badPrice.results.some(
    (row) =>
      row.status === "INVALID_DATA" &&
      row.principalProductCode === "P1" &&
      row.invalidReason === "Formula Amount tidak konsisten pada baris 2",
  ),
);
assert.throws(
  () => reconcileForisaPurchases(accurate, principal, mapping, "do tanpa nomor.xlsx"),
  /Nama file principal harus memuat tepat satu nomor DO FORISA \(format 401 \+ 7 digit\)/,
);
assert.throws(
  () => reconcileForisaPurchases(accurate, principal, mapping, "4010368434 4010368435.xlsx"),
  /Nama file principal harus memuat tepat satu nomor DO FORISA \(format 401 \+ 7 digit\)/,
);

let receivedFilename = "";
const handler = createKinoSalesPostHandler({
  authorize: async () => null,
  readMapping: async () => mapping,
  principalUpload: { kind: "xlsx" },
  reconcile: (_accurate, _principal, _mapping, principalFilename) => {
    receivedFilename = principalFilename;
    return { ok: true };
  },
});
const form = new FormData();
form.append("accurateFile", new File([accurate], "accurate.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
form.append("principalFile", new File([principal], "do 4010368434 (GT).xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
assert.equal((await handler(new Request("http://localhost/test", { method: "POST", body: form }))).status, 200);
assert.equal(receivedFilename, "do 4010368434 (GT).xlsx");

if (process.argv.length >= 5) {
  const real = reconcileForisaPurchases(
    await readFile(process.argv[2]),
    await readFile(process.argv[3]),
    await readFile(process.argv[4]),
    process.argv[3].split(/[\\/]/).at(-1) ?? "",
  );
  assert.equal(real.accurateLines.length, 15);
  assert.equal(real.principalLines.length, 15);
  assert.equal(real.summary.MATCH, 15);
  assert.equal(real.results.length, 15);
  console.log(`real simulation: ${real.accurateLines.length} Accurate lines, ${real.principalLines.length} FORISA lines, ${real.summary.MATCH} MATCH`);
}

console.log("forisa purchase reconciliation: ok");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
