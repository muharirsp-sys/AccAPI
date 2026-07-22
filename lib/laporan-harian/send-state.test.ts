/*
 * Tujuan: Self-check state claim/retry Laporan Harian.
 * Caller: Developer/CI via node --experimental-strip-types lib/laporan-harian/send-state.test.ts.
 * Dependensi: node:assert dan send-state.ts.
 * Main Functions: Assertion claim status, retryable recipient, dan final status.
 * Side Effects: Tulis hasil ke stdout; gagal dengan exit non-zero.
 */
import assert from "node:assert";
import {
    canClaimReportRun,
    finalReportRunStatus,
    RETRYABLE_RECIPIENT_STATUSES,
} from "./send-state.ts";

assert.strictEqual(canClaimReportRun("dry_run"), true);
assert.strictEqual(canClaimReportRun("failed"), true);
assert.strictEqual(canClaimReportRun("sending"), false);
assert.strictEqual(canClaimReportRun("sent"), false);
assert.deepStrictEqual(RETRYABLE_RECIPIENT_STATUSES, ["pending", "failed"]);
assert.strictEqual(finalReportRunStatus(0), "sent");
assert.strictEqual(finalReportRunStatus(1), "failed");

console.log("OK — laporan-harian send/retry state checks passed");
