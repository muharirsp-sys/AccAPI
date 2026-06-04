// Tujuan: Phase R7f integration test — verifikasi migration script dapat
//         dijalankan dalam mode dry-run TANPA mengubah DB. Bila DB lokal
//         masih punya `off_batch_id NOT NULL`, test melaporkan SKIP untuk
//         skenario direct create (sesuai instruksi: jangan half-implement).
// Caller: `node scripts/test-r7f-direct-source.mjs`.
// Side Effects:
//   - TIDAK menyentuh DB (dry-run only).
//   - TIDAK menulis file PDF.
// Aturan:
//   - Refuse non-lokal DATABASE_URL.
//   - Idempotent.

import { createClient } from "@libsql/client";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";

function loadEnv() {
    const envPath = resolve(process.cwd(), ".env");
    if (!existsSync(envPath)) return;
    const content = readFileSync(envPath, "utf8");
    for (const rawLine of content.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith("#")) continue;
        const eq = line.indexOf("=");
        if (eq <= 0) continue;
        const key = line.slice(0, eq).trim();
        let value = line.slice(eq + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        if (!(key in process.env)) process.env[key] = value;
    }
}
loadEnv();

const databaseUrl = process.env.DATABASE_URL || "file:sqlite.db";
const filePath = databaseUrl.startsWith("file:") ? databaseUrl.slice("file:".length) : "";
if (!filePath || filePath.startsWith("/app/")) {
    console.error(`[r7f-test] REFUSED: DATABASE_URL bukan SQLite lokal (${databaseUrl}).`);
    process.exit(2);
}
const db = createClient({ url: databaseUrl });

const results = [];
function record(testId, label, passed, detail) {
    results.push({ testId, label, passed, detail: detail || "" });
    const sym = passed ? "  PASS" : "  FAIL";
    console.log(`${sym}  [Test ${testId}] ${label}${detail ? " — " + detail : ""}`);
}
function recordSkip(testId, label, reason) {
    results.push({ testId, label, passed: true, detail: `SKIPPED: ${reason}`, skipped: true });
    console.log(`  SKIP  [Test ${testId}] ${label} — ${reason}`);
}
function assertTrue(testId, label, condition, detail) {
    record(testId, label, Boolean(condition), Boolean(condition) ? "" : detail || "expected truthy");
    return Boolean(condition);
}
function assertEqual(testId, label, actual, expected) {
    const ok = actual === expected;
    record(testId, label, ok, ok ? "" : `expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`);
    return ok;
}

async function inspectOffBatchIdColumn() {
    const cols = await db.execute("PRAGMA table_info('claim_workflow')");
    const offCol = cols.rows.find((r) => String(r.name) === "off_batch_id");
    if (!offCol) return { exists: false, notNull: false };
    return { exists: true, notNull: Number(offCol.notnull) === 1 };
}

async function main() {
    console.log("\n=== R7f Direct Source — Integration Test (HOLD-aware) ===\n");

    // ----- Test 1: Migration script dry-run smoke test -----
    console.log("--- Test 1: Migration script dry-run ---");
    let dryRunOutput = "";
    try {
        dryRunOutput = execFileSync(process.execPath, ["scripts/migrate-r7f-nullable-off-batch.mjs"], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
        });
        record("1", "Dry-run executes without error", true);
    } catch (err) {
        record("1", "Dry-run executes without error", false, err.stderr || err.message);
    }
    if (dryRunOutput) {
        assertTrue("1", "Dry-run output mentions DRY-RUN mode", dryRunOutput.includes("DRY-RUN"));
        assertTrue("1", "Dry-run output mentions backup plan", dryRunOutput.includes("Backup"));
        assertTrue("1", "Dry-run output mentions table rebuild plan", dryRunOutput.includes("claim_workflow_new"));
        assertTrue("1", "Dry-run output mentions foreign_key_check", dryRunOutput.includes("foreign_key_check"));
        assertTrue("1", "Dry-run output mentions row count verification", dryRunOutput.includes("row count"));
        assertTrue("1", "Dry-run does NOT mention 'Migration applied'", !dryRunOutput.includes("Migration applied"));
    }

    // ----- Test 2-10: SKIP dengan pesan jelas bila NOT NULL masih -----
    console.log("\n--- Test 2-10: Direct source create + flow ---");
    const colState = await inspectOffBatchIdColumn();
    if (!colState.exists) {
        recordSkip("2-10", "Direct source flow", "Schema tidak punya off_batch_id, tidak dapat ditest.");
    } else if (colState.notNull) {
        recordSkip("2",
            "Direct workflow create blocked by schema (off_batch_id NOT NULL)",
            "DB lokal saat ini masih punya off_batch_id NOT NULL. " +
            "Migration belum di-apply. Jalankan: `node scripts/migrate-r7f-nullable-off-batch.mjs --apply` " +
            "(akan otomatis backup) supaya direct/manual claim source dapat dibuat. " +
            "Test direct create + payment + reports SKIPPED — bukan failure, ini guard sengaja.",
        );
        recordSkip("3", "Direct workflow has off_batch_id NULL + sourceType direct_kwitansi",
            "Skipped — butuh migration apply.");
        recordSkip("4", "Direct workflow has submission with items assigned",
            "Skipped — butuh migration apply.");
        recordSkip("5", "No OFF sync attempted",
            "Skipped — butuh migration apply.");
        recordSkip("6", "Generate docs per submission works",
            "Skipped — butuh migration apply.");
        recordSkip("7", "Payment per submission works",
            "Skipped — butuh migration apply.");
        recordSkip("8", "Reports include direct workflow",
            "Skipped — butuh migration apply.");
        recordSkip("9", "Close per submission works",
            "Skipped — butuh migration apply.");
        recordSkip("10", "OFF final claim route not involved",
            "Skipped — butuh migration apply.");
        console.log("\nSTATUS: R7f HOLD — migration tersedia tetapi belum di-apply.");
        console.log("Direct/manual claim create route belum di-implementasikan untuk menghindari");
        console.log("half-implementation against NOT NULL DB. Apply migration manual untuk unlock.");
    } else {
        // Schema sudah nullable. Saat ini direct create route belum
        // di-implement karena user explicit warning. Report SKIP dengan
        // alasan berbeda.
        recordSkip("2-10", "Direct source flow",
            "Schema sudah nullable, tetapi route from-direct sengaja belum di-implement di phase ini. " +
            "Roadmap: implement /api/claim-workflow/from-direct setelah confirm bisnis tentang " +
            "principleCode/principleName mapping.");
    }

    // ----- Summary -----
    console.log("\n=== Test Summary ===");
    const passed = results.filter(r => r.passed && !r.skipped).length;
    const skipped = results.filter(r => r.skipped).length;
    const failed = results.filter(r => !r.passed).length;
    console.log(`Total: ${results.length}  PASS: ${passed}  SKIP: ${skipped}  FAIL: ${failed}`);
    if (failed > 0) {
        console.log("\nFailed assertions:");
        for (const r of results.filter(rr => !rr.passed)) {
            console.log(`  - [Test ${r.testId}] ${r.label}: ${r.detail}`);
        }
    }
}

(async () => {
    let exitCode = 0;
    try {
        await main();
        const failed = results.filter(r => !r.passed).length;
        if (failed > 0) exitCode = 1;
    } catch (err) {
        console.error("\n[r7f-test] UNCAUGHT:", err);
        exitCode = 2;
    } finally {
        process.exit(exitCode);
    }
})();
