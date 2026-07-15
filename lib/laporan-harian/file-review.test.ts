/*
 * Tujuan: Self-check keamanan nama file dan pemilihan kolom contoh review Laporan Harian.
 * Caller: Developer/CI via node --experimental-strip-types.
 * Dependensi: lib/laporan-harian/file-review.
 * Main Functions: assert-based self-check module.
 * Side Effects: Menulis hasil check ke stdout; tidak membaca file atau database.
 */
import assert from "node:assert/strict";
import { buildReviewSample, isAllowedReviewFile } from "./file-review.ts";

assert.equal(isAllowedReviewFile("2026-07-15_ZUL & ARUL.xlsx", "2026-07-15"), true);
assert.equal(isAllowedReviewFile("2026-07-14_DENNY.xlsx", "2026-07-15"), false);
assert.equal(isAllowedReviewFile("2026-07-15_../secret.xlsx", "2026-07-15"), false);

const sample = buildReviewSample([
    ["NO_NOTA", "CUSTOMER", "IGNORED", "DPP"],
    ["INV-1", "TOKO SATU", "x", 125_000],
    ["INV-2", "TOKO DUA", "y", 75_000],
], 1);
assert.deepEqual(sample.columns, ["NO_NOTA", "CUSTOMER", "DPP"]);
assert.deepEqual(sample.rows, [["INV-1", "TOKO SATU", 125_000]]);

console.log("OK - nama file dan sample review laporan tervalidasi.");
