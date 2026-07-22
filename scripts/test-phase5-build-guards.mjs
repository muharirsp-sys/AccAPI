/*
 * Tujuan: Menjaga dashboard tetap dinamis dan mencegah standalone menyalin seluruh project root.
 * Caller: Developer/CI setelah perubahan build atau auth layout.
 * Dependensi: node:assert, node:fs, app/(dashboard)/layout.tsx, next.config.ts.
 * Main Functions: main.
 * Side Effects: Membaca dua file source; tidak menulis file atau memanggil jaringan.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function main() {
  const layout = readFileSync("app/(dashboard)/layout.tsx", "utf8");
  const config = readFileSync("next.config.ts", "utf8");

  assert.match(layout, /export const dynamic = ["']force-dynamic["']/);
  assert.match(config, /["']\/api\/cron\/cleanup-runtime["']\s*:/);
  assert.match(config, /["']\.\/\.env\*["']/);
  assert.match(config, /Data_Penjualan/);
  assert.doesNotMatch(config, /["']\/api\/cron\/cleanup-runtime["']\s*:\s*\[["']\.\/\*\*\/\*["']\]/);
  console.log("Phase 5 build guards passed.");
}

main();
