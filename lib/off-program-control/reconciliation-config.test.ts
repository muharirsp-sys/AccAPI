import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import * as XLSX from "xlsx";
import {
  getReconciliationConfig,
  reconciliationKeys,
} from "./reconciliation-config";
import { validateReconciliationMapping } from "./reconciliation-mapping-validator";

const expected = [
  "sales:KINO", "sales:GODREJ", "sales:SHINZUI", "sales:MOTASA", "sales:CUSSONS",
  "purchases:GODREJ", "purchases:RECKITT", "purchases:CUSSONS", "purchases:KINO", "purchases:FORISA",
  "returns:SHINZUI", "returns:KINO", "returns:GODREJ", "returns:HEINZ", "returns:CUSSONS",
];

assert.deepEqual(reconciliationKeys().sort(), expected.sort());

for (const key of reconciliationKeys()) {
  const [division, principal] = key.split(":") as ["sales" | "purchases" | "returns", string];
  const config = getReconciliationConfig(division, principal);
  assert.ok(
    existsSync(path.join(process.cwd(), "app", config.endpoint, "route.ts")),
    `Endpoint ${config.endpoint} tidak ditemukan`,
  );
  assert.equal(config.inputs.length, key === "returns:HEINZ" ? 3 : 2, key);
}

for (const principal of ["KINO", "FORISA"])
  assert.equal(getReconciliationConfig("purchases", principal).inputs[1].extension, ".xlsx");

for (const key of [
  "sales:CUSSONS",
  "purchases:GODREJ", "purchases:RECKITT", "purchases:CUSSONS",
  "returns:GODREJ", "returns:HEINZ", "returns:CUSSONS",
]) {
  const [division, principal] = key.split(":") as ["sales" | "purchases" | "returns", string];
  assert.equal(getReconciliationConfig(division, principal).inputs.at(-1)?.extension, ".csv", key);
}

function workbook(sheets: Record<string, unknown[][]>): Uint8Array {
  const book = XLSX.utils.book_new();
  for (const [name, rows] of Object.entries(sheets))
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), name);
  return XLSX.write(book, { bookType: "xlsx", type: "buffer" });
}

const formFixRow5 = (header: string[]) => ({ "Form Fix": [[], [], [], [], header] });
const validMappings: Record<string, Uint8Array> = {
  "sales:KINO": workbook({
    Mapping_Prd: [["KODE ITEM", "KODE ALIAS", "SATUAN"]],
    Mapping_Customer: [["CODE KINO", "CODE INTERNAL"]],
    Mapping_Sls: [["SLSMAN_ID", "CODE INTERNAL"]],
  }),
  "sales:GODREJ": workbook({ "Pvt Map 1": [["KODE PCPL", "KODE BARANG WIN2", "SATUAN FIX WIN"]] }),
  "sales:SHINZUI": workbook({ "Pvt Map 1": [["KODE PCPL", "KODE BARANG WIN2", "SATUAN FIX WIN", "ISI/CTN"]] }),
  "sales:MOTASA": workbook(formFixRow5(["KODE BARANG WIN2", "ISI/CTN", "SATUAN FIX WIN"])),
  "sales:CUSSONS": workbook(formFixRow5(["KODE PCPL", "ISI/CTN", "SATUAN FIX WIN", "KODE BARANG WIN2"])),
  "purchases:GODREJ": workbook({ "Form Fix": [["Nama Barang Principle", "Kode BARANG Win2", "ISI/CTN"]] }),
  "purchases:RECKITT": workbook({ "Pvt Map 1": [["Kode BARANG Win2", "Kode Pcpl", "ISI/CTN"]] }),
  "purchases:KINO": workbook({ "Table Pvt 1": [["Kode Barang Win", "Kode Pcpl", "ISI/CTN"]] }),
  "purchases:FORISA": workbook({ "Upload To Win": [["Kode Pcpl", "Kode BARANG Win2", "Nama Win", "ISI/CTN"]] }),
  "returns:SHINZUI": workbook({ "Fix Mapping": [["KODE BARANG", "PCPL KODE 1", "PCPL KODE 2", "PCPL KODE 3", "PCPL KODE 4", "PCPL KODE 5"]] }),
  "returns:KINO": workbook({ "Table Pvt 1": [["KODE PCPL", "KODE BARANG WIN"]] }),
  "returns:GODREJ": workbook({
    "Pvt Map 1": [["KODE BARANG WIN2", "KODE PCPL"]],
    "Form Fix": [["NAMA BARANG PRINCIPLE", "KODE BARANG WIN2"]],
  }),
  "returns:HEINZ": workbook({ "Fix Mapping": [["KODE BARANG", "PCPL KODE 1", "PCPL KODE 2", "PCPL KODE 3", "PCPL KODE 4", "PCPL KODE 5"]] }),
};
validMappings["purchases:CUSSONS"] = validMappings["sales:CUSSONS"];
validMappings["returns:CUSSONS"] = validMappings["sales:CUSSONS"];

const emptyWorkbook = workbook({ Empty: [[""]] });
for (const key of reconciliationKeys()) {
  const [division, principal] = key.split(":") as ["sales" | "purchases" | "returns", string];
  assert.throws(() => validateReconciliationMapping(division, principal, emptyWorkbook), Error, `${key} harus menolak workbook kosong`);
  assert.doesNotThrow(() => validateReconciliationMapping(division, principal, validMappings[key]), key);
}

console.log("OK - registry dan mapping 15 kontrak rekonsiliasi tervalidasi.");
