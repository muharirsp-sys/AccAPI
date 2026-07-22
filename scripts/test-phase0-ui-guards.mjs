/*
 * Tujuan: Regression guard ringan untuk memastikan risiko trust/persistence Fase 0 dan isolasi fixture development tidak kembali ke source UI.
 * Caller: Developer/CI melalui `node scripts/test-phase0-ui-guards.mjs`.
 * Dependensi: Node.js standard library (`assert`, `fs`, `path`).
 * Main Functions: `read`, `count`, assertion suite top-level.
 * Side Effects: Membaca source file dan keluar non-zero bila guard gagal; tidak menulis file.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (relativePath) => readFileSync(resolve(relativePath), "utf8");
const count = (source, token) => source.split(token).length - 1;

const off = read("app/(dashboard)/off-program-control/page.tsx");
assert.doesNotMatch(off, /dummyBatches|initialBulkRows|demo-batch-/);
assert.match(off, /useState<SupervisorBulkRow\[\]>\(\[\s*createEmptyBulkRow\(1\),?\s*\]\)/s);
assert.match(off, /getOffDevBatchCount\(searchParams\.get\("mock"\)\)/);
assert.match(off, /if \(devBatchCount > 0\) \{\s*setOverviewBatches\(devBatches\)/s);

const offDevFixtures = read("lib/off-program-control/dev-fixtures.ts");
assert.match(offDevFixtures, /nodeEnv !== "development"/);
assert.match(offDevFixtures, /MAX_DEV_BATCHES = 2_000/);
assert.match(offDevFixtures, /Tidak ada DB\/HTTP\/file I\/O/);

const formKontrol = read("app/(dashboard)/form-kontrol/page.tsx");
assert.doesNotMatch(formKontrol, /setScope\(\{\s*role:\s*["']admin/);
assert.match(formKontrol, /scopeError/);

const visit = read("app/(dashboard)/form-kontrol/visit/[custCode]/page.tsx");
assert.match(visit, /allMerchDone && merchPersisted/);
assert.match(visit, /await onUploaded\(url, coords\)/);
assert.match(visit, /setMerchPersisted\(true\)/);

const camera = read("components/form-kontrol/camera-capture.tsx");
assert.match(camera, /onCapture: \(blob: Blob\) => Promise<void>/);
assert.match(camera, /await onCapture\(blob\)/);

const payments = read("app/(dashboard)/payments/page.tsx");
assert.equal(count(payments, 'document.addEventListener("visibilitychange"'), 1);
assert.match(payments, /const saved = await handleSaveBulk\(\)/);
assert.doesNotMatch(payments, /backendConflictMessage\(res\.data\)\);\s*fetchData/s);

const incentives = read("app/(dashboard)/insentif-sales/page.tsx");
assert.match(incentives, /`\$\{row\.salesCode\}::\$\{row\.principle\}`/);
assert.match(incentives, /Promise\.allSettled/);
assert.match(incentives, /paymentsError/);
assert.match(incentives, /dashboardError/);

const dailyReport = read("app/(dashboard)/laporan-harian/page.tsx");
assert.doesNotMatch(dailyReport, /Proses \(Dry-run\)/);
assert.match(dailyReport, /Proses & Perbarui Dashboard/);

console.log("Phase 0 UI guards: OK");
