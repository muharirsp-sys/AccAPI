/*
 * Tujuan: Self-check allowlist penerima internal dan pilihan file untuk trial Laporan Harian.
 * Caller: Developer/CI via node --experimental-strip-types.
 * Dependensi: node:assert, recipient-selection.
 * Main Functions: Assertion normalisasi, deduplikasi, filter file, dan penolakan alamat luar.
 * Side Effects: Menulis status lulus ke stdout.
 */

import assert from "node:assert/strict";
import {
    internalRecipientAllowlist,
    selectRequestedFiles,
    validateInternalRecipients,
} from "./recipient-selection.ts";

const allowlist = internalRecipientAllowlist(
    "ops@internal.test; Finance@internal.test,ops@internal.test",
    "Uploader@internal.test",
);
assert.deepStrictEqual(allowlist, [
    "finance@internal.test",
    "ops@internal.test",
    "uploader@internal.test",
]);

assert.deepStrictEqual(
    selectRequestedFiles(["A.xlsx", "B.xlsx"], ["B.xlsx", "luar.xlsx", "B.xlsx"]),
    ["B.xlsx"],
);
assert.deepStrictEqual(selectRequestedFiles(["A.xlsx", "B.xlsx"], undefined), ["A.xlsx", "B.xlsx"]);

assert.deepStrictEqual(
    validateInternalRecipients(allowlist, ["OPS@internal.test", "client@example.com"]),
    { recipients: ["ops@internal.test"], rejected: ["client@example.com"] },
);

console.log("recipient-selection: OK");
