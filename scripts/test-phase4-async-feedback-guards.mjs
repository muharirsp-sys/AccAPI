/*
 * Tujuan: Regression guard ringan untuk loading, error recovery, empty state, dan reduced-motion Fase 4.
 * Caller: Developer/CI melalui `node scripts/test-phase4-async-feedback-guards.mjs`.
 * Dependensi: Node.js standard library (`assert`, `fs`, `path`).
 * Main Functions: `read`, assertion suite top-level.
 * Side Effects: Membaca source file dan keluar non-zero bila guard gagal; tidak menulis file.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (relativePath) => readFileSync(resolve(relativePath), "utf8");

const asyncState = read("components/ui/AsyncState.tsx");
assert.match(asyncState, /export function LoadingState/);
assert.match(asyncState, /export function ErrorState/);
assert.match(asyncState, /export function EmptyState/);
assert.match(asyncState, /role="status" aria-live="polite" aria-busy="true"/);
assert.match(asyncState, /role="alert"/);
assert.match(asyncState, /onClick=\{onAction\}/);
assert.doesNotMatch(asyncState, /Loader|animate-spin/);

const globals = read("app/globals.css");
assert.match(globals, /\.ui-state-panel/);
assert.match(globals, /\.ui-skeleton-stack/);
assert.match(globals, /@media \(prefers-reduced-motion: no-preference\)/);
assert.match(globals, /@keyframes ui-skeleton-shift/);

const formKontrol = read("app/(dashboard)/form-kontrol/page.tsx");
assert.match(formKontrol, /<LoadingState label="Memuat Form Kontrol"/);
assert.match(formKontrol, /<ErrorState/);
assert.doesNotMatch(formKontrol, /animate-spin/);

const incentives = read("app/(dashboard)/insentif-sales/page.tsx");
assert.match(incentives, /<LoadingState label="Memuat data insentif"/);
assert.match(incentives, /<LoadingState label="Memuat status pembayaran"/);
assert.match(incentives, /<ErrorState/);
assert.match(incentives, /<EmptyState/);

const off = read("app/(dashboard)/off-program-control/page.tsx");
assert.match(off, /<LoadingState label="Menyiapkan akses OFF Program Control"/);

const dataTable = read("components/DataTable.tsx");
assert.match(dataTable, /<LoadingState label="Memuat data tabel"/);
assert.match(dataTable, /<EmptyState title=\{emptyMessage\}/);
assert.doesNotMatch(dataTable, /animate-spin/);

console.log("Phase 4 async feedback guards: OK");
