/*
 * Tujuan: Regression guard ringan untuk semantic visual system dan information density Fase 3.
 * Caller: Developer/CI melalui `node scripts/test-phase3-visual-system-guards.mjs`.
 * Dependensi: Node.js standard library (`assert`, `fs`, `path`).
 * Main Functions: `read`, `visibleSource`, assertion suite top-level.
 * Side Effects: Membaca source file dan keluar non-zero bila guard gagal; tidak menulis file.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (relativePath) => readFileSync(resolve(relativePath), "utf8");
const visibleSource = (source) => source
  .split(/\r?\n/)
  .filter((line) => !line.trim().startsWith("//") && !line.includes("{/*"))
  .join("\n");

const globals = read("app/globals.css");
for (const contract of [
  "--ui-content-standard",
  "--ui-panel-padding",
  ".ui-page-shell",
  ".ui-page-title",
  ".ui-surface-panel",
  ".ui-tab-strip",
  ".ui-tab-button[data-state=\"active\"]",
  ".ui-toolbar",
  ".ui-data-table",
  ".ui-button-primary",
  "@media (max-width: 40rem)",
]) {
  assert.ok(globals.includes(contract), `Kontrak visual hilang: ${contract}`);
}

const formKontrol = read("app/(dashboard)/form-kontrol/page.tsx");
assert.match(formKontrol, /className="ui-page-shell"/);
assert.match(formKontrol, /className="ui-tab-button"/);
assert.match(formKontrol, /data-state=\{effectiveTab/);

const incentives = read("app/(dashboard)/insentif-sales/page.tsx");
assert.match(incentives, /className="ui-page-shell ui-page-shell--wide"/);
assert.ok((incentives.match(/ui-data-table/g) || []).length >= 10);
assert.match(incentives, /className="ui-toolbar"/);

const off = read("app/(dashboard)/off-program-control/page.tsx");
assert.match(off, /className="ui-page-shell ui-page-shell--wide"/);
assert.match(off, /className="ui-table-frame hidden lg:block"/);
assert.match(off, /className="ui-button-primary/);

const dataTable = read("components/DataTable.tsx");
assert.match(dataTable, /className="ui-table-frame"/);
assert.match(dataTable, /className="ui-data-table relative"/);

for (const source of [formKontrol, incentives, off]) {
  assert.doesNotMatch(visibleSource(source), /[—–]/);
  assert.doesNotMatch(source, /h-screen/);
}

console.log("Phase 3 visual system guards: OK");
