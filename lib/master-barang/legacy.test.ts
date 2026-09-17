/*
 * Regression guard: kode legacy yang bukan 0-4 digit (kode item 7 digit di kolom
 * golongan RECKITT, kode promo alfanumerik "0B"/"1B" di PRISKILA/HEINZ) dulu bikin
 * adapt_legacy gagal "Format Kamus Kode tidak valid". addCodebook sekarang membuang
 * kode invalid biar engine menomori ulang. Jalankan: npx tsx lib/master-barang/legacy.test.ts
 * Butuh fixture di master_barang_principle/ — skip bila tidak ada (mis. CI tanpa workbook).
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import assert from "node:assert";
import { parseLegacyWorkbook } from "@/lib/master-barang/legacy";

const dir = path.join(process.cwd(), "master_barang_principle");
const fixtures = [
  "FIX FORM MASTER BARANG - RECKITT.xlsx",
  "FIX_FORM MASTER BARANG - PRISKILA.xlsx",
  "FIX_FORM MASTER BARANG - HEINZ.xlsx",
];
let checked = 0;
for (const f of fixtures) {
  const fp = path.join(dir, f);
  if (!existsSync(fp)) continue;
  const parsed = parseLegacyWorkbook(readFileSync(fp), f);
  for (const e of parsed.codebook) {
    assert.match(String(e.code ?? ""), /^\d{0,4}$/, `${f}: kode invalid ${JSON.stringify(e.code)} pada ${e.key}`);
  }
  checked++;
}
console.log(checked ? `OK — ${checked} workbook legacy: semua kode codebook 0-4 digit.` : "SKIP — fixture master_barang_principle/ tidak tersedia.");
