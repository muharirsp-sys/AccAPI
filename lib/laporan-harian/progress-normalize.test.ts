/*
 * Tujuan: Self-check normalisasi progress tanpa kode salesman sebelum bulk insert PostgreSQL.
 * Caller: Developer/CI via node --experimental-strip-types.
 * Dependensi: lib/laporan-harian/progress-normalize.
 * Main Functions: assert-based self-check module.
 * Side Effects: Menulis hasil check ke stdout; tidak mengakses database.
 */
import assert from "node:assert/strict";
import { normalizeDailyProgressRows, type DailyProgressInputRow } from "./progress-normalize.ts";

const base: Omit<DailyProgressInputRow, "salesCode" | "branch" | "achievedValueDpp"> = {
    principle: "PRISKILA PRIMA MAKMUR, PT",
    date: "2026-07-07",
    periodMonth: 7,
    periodYear: 2026,
    achievedEc: 2,
    achievedAo: 2,
    achievedIa: 8,
};

const result = normalizeDailyProgressRows([
    { ...base, salesCode: " M-ZUB ", branch: "SYAMSUL", achievedValueDpp: 100 },
    { ...base, salesCode: null, branch: "DENNY", achievedValueDpp: 190_918.91892 },
    { ...base, salesCode: "<NA>", branch: "Denny", achievedValueDpp: 65_405.4054 },
]);

assert.deepEqual(result.rows.map((row) => row.salesCode), ["M-ZUB", "UNMAPPED:DENNY", "UNMAPPED:DENNY"]);
assert.equal(result.unmapped.rows, 2);
assert.equal(result.unmapped.achievedValueDpp, 256_324.32432);
assert.deepEqual(result.unmapped.branches, ["DENNY"]);
assert.equal(result.rows.reduce((sum, row) => sum + row.achievedValueDpp, 0), 256_424.32432);

console.log("OK — progress tanpa sales code dipertahankan sebagai UNMAPPED:<branch>.");
