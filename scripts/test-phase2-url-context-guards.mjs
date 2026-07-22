/*
 * Tujuan: Regression guard ringan untuk persistensi konteks URL dan direct-action UX Fase 2.
 * Caller: Developer/CI melalui `node scripts/test-phase2-url-context-guards.mjs`.
 * Dependensi: Node.js standard library (`assert`, `fs`, `path`).
 * Main Functions: `read`, assertion suite top-level.
 * Side Effects: Membaca source file dan keluar non-zero bila guard gagal; tidak menulis file.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (relativePath) => readFileSync(resolve(relativePath), "utf8");

const formKontrol = read("app/(dashboard)/form-kontrol/page.tsx");
assert.match(formKontrol, /useSearchParams/);
assert.match(formKontrol, /params\.set\("tab", tab\)/);
assert.match(formKontrol, /router\.replace/);
assert.doesNotMatch(formKontrol, /useState<TabKey>/);

const incentives = read("app/(dashboard)/insentif-sales/page.tsx");
assert.match(incentives, /searchParams\.get\("view"\)/);
assert.match(incentives, /searchParams\.get\("principle"\)/);
assert.match(incentives, /searchParams\.get\("branch"\)/);
assert.match(incentives, /updateContext\(\{ principle: "ALL", branch: "ALL" \}\)/);
assert.doesNotMatch(incentives, /useState<ViewKey>/);

const off = read("app/(dashboard)/off-program-control/page.tsx");
assert.match(off, /params\.set\("batch", batchId\)/);
assert.match(off, /params\.delete\("batch"\)/);
assert.match(off, /onDetailChange\?\.\(batch\.id\)/);
assert.match(off, /onDetailChange\?\.\(null\)/);
assert.match(off, /onSelectBatch=\{\(batchId\)/);
assert.doesNotMatch(off, /useState<TabKey>/);

const notifications = read("components/off-program-control/OffNotificationBell.tsx");
assert.match(notifications, /onSelectBatch\(problem\.batchId\)/);
assert.match(notifications, /Buka pengajuan/);

console.log("Phase 2 URL context guards: OK");
