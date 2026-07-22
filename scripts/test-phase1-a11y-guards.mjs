/*
 * Tujuan: Regression guard ringan untuk fondasi aksesibilitas dan interaksi UI Fase 1.
 * Caller: Developer/CI melalui `node scripts/test-phase1-a11y-guards.mjs`.
 * Dependensi: Node.js standard library (`assert`, `fs`, `path`).
 * Main Functions: `read`, assertion suite top-level.
 * Side Effects: Membaca source file dan keluar non-zero bila guard gagal; tidak menulis file.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (relativePath) => readFileSync(resolve(relativePath), "utf8");

const globals = read("app/globals.css");
assert.match(globals, /:focus-visible/);
assert.match(globals, /prefers-reduced-motion:\s*reduce/);

const dialog = read("components/ui/Dialog.tsx");
assert.match(dialog, /<dialog/);
assert.match(dialog, /showModal\(\)/);
assert.match(dialog, /onCancel=/);
assert.match(dialog, /aria-labelledby=/);

const camera = read("components/form-kontrol/camera-capture.tsx");
const payments = read("app/(dashboard)/payments/page.tsx");
const wrapper = read("app/(dashboard)/api-wrapper/page.tsx");
const off = read("app/(dashboard)/off-program-control/page.tsx");
for (const source of [camera, payments, wrapper, off]) {
  assert.match(source, /<Dialog/);
}
assert.doesNotMatch(camera, /createPortal/);
assert.doesNotMatch(payments, /createPortal/);
assert.match(off, /off-overview-detail-title/);
assert.match(off, /role="tablist"/);
assert.match(off, /role="tabpanel"/);

const dataTable = read("components/DataTable.tsx");
assert.match(dataTable, /<caption/);
assert.match(dataTable, /aria-busy=/);
assert.match(dataTable, /aria-live="polite"/);
assert.match(dataTable, /emptyMessage/);

for (const page of [
  "app/(dashboard)/form-kontrol/page.tsx",
  "app/(dashboard)/insentif-sales/page.tsx",
]) {
  const source = read(page);
  assert.match(source, /role="tablist"/);
  assert.match(source, /role="tab"/);
  assert.match(source, /role="tabpanel"/);
  assert.match(source, /ArrowRight/);
}

const globalSearch = read("components/off-program-control/OffGlobalSearch.tsx");
assert.match(globalSearch, /key\.toLowerCase\(\) === "k"/);
assert.doesNotMatch(globalSearch, /key === "f"/);
assert.match(globalSearch, /aria-activedescendant=/);
assert.match(globalSearch, /event\.key === "ArrowDown"/);
assert.match(globalSearch, /event\.key === "Enter"/);

console.log("Phase 1 accessibility guards: OK");
