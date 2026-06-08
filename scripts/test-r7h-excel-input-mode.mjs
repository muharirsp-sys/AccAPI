// Tujuan: Integration test untuk Phase R7h — Excel BASE Input Mode.
//         Test mencakup pure helper (parseNoClaimComponents, build, calc)
//         dan flow PATCH item + PATCH submission lewat simulator DB
//         (mirror logic route handler, sama pola dengan test R7d/R7g).
// Caller: `node scripts/test-r7h-excel-input-mode.mjs`.
// Side Effects:
//   - INSERT/UPDATE/DELETE demo data dengan prefix `R7H-TEST-*`.
//   - Cleanup di blok finally.
// Aturan:
//   - Refuse non-lokal DATABASE_URL.
//   - Idempotent.

import { createClient } from "@libsql/client";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";

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
        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        if (!(key in process.env)) process.env[key] = value;
    }
}
loadEnv();
const databaseUrl = process.env.DATABASE_URL || "file:sqlite.db";
const filePath = databaseUrl.startsWith("file:") ? databaseUrl.slice("file:".length) : "";
if (!filePath || filePath.startsWith("/app/")) {
    console.error(`[r7h-test] REFUSED: DATABASE_URL bukan SQLite lokal (${databaseUrl}).`);
    process.exit(2);
}
const db = createClient({ url: databaseUrl });

const STATUS = {
    draft: "Draft",
    needRevision: "Need Revision",
};
const SCOPE = {
    perPengajuan: "per_pengajuan",
    perItem: "per_item",
};
const ACTOR = { id: "r7h-test-actor" };
const NOW = new Date();
const TEST_PREFIX = "R7H-TEST";

const results = [];
function record(testId, label, passed, detail) {
    results.push({ testId, label, passed, detail: detail || "" });
    const symbol = passed ? "  PASS" : "  FAIL";
    console.log(`${symbol}  [Test ${testId}] ${label}${detail ? " — " + detail : ""}`);
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
function assertClose(testId, label, actual, expected, eps = 0.01) {
    const ok = Math.abs(Number(actual) - Number(expected)) <= eps;
    record(testId, label, ok, ok ? "" : `expected≈${expected} actual=${actual}`);
    return ok;
}

// ============================================================================
// Pure helper port — Excel Input Mode (mirror page.tsx)
// ============================================================================

function parseNoClaimComponents(value) {
    const trimmed = String(value ?? "").trim();
    if (!trimmed) return null;
    const match = trimmed.match(
        /^([A-Za-z0-9]+)\/([A-Za-z0-9]+)-([A-Za-z0-9]+)\/(\d{2})\/(\d{4})$/,
    );
    if (!match) return null;
    return {
        sequence: match[1],
        distributorCode: match[2],
        principalCode: match[3],
        month: match[4],
        year: match[5],
    };
}

function formatNoClaimSequence(value) {
    const trimmed = String(value ?? "").trim();
    if (!trimmed) return "";
    if (/^\d+$/.test(trimmed)) {
        const n = Number(trimmed);
        if (Number.isFinite(n) && n >= 1 && n <= 9) {
            return String(n).padStart(2, "0");
        }
        return String(Number(trimmed));
    }
    return trimmed;
}

function buildNoClaim({ sequence, distributorCode, principalCode, month, year }) {
    const seq = formatNoClaimSequence(sequence);
    if (!seq) return "";
    return `${seq}/${String(distributorCode).trim()}-${String(principalCode).trim()}/${String(month).trim()}/${String(year).trim()}`;
}

function calculateClaimPreview(dpp, ppnRate, pphRate) {
    const d = Number(dpp || 0);
    const p = Number(ppnRate || 0);
    const h = Number(pphRate || 0);
    const ppnValue = +(d * p / 100).toFixed(2);
    const pphValue = +(d * h / 100).toFixed(2);
    const nilaiKlaim = +(d + ppnValue - pphValue).toFixed(2);
    return { ppnValue, pphValue, nilaiKlaim };
}

// ============================================================================
// DB helpers + simulator
// ============================================================================

const cleanupActions = [];

async function pickFreeOffBatch() {
    const candidates = await db.execute(`
        SELECT b.id FROM off_batch b
        LEFT JOIN claim_workflow cw ON cw.off_batch_id = b.id
        WHERE cw.id IS NULL
    `);
    if (candidates.rows.length === 0) {
        throw new Error("Tidak ada off_batch tanpa claim_workflow. Reset/seed demo dulu.");
    }
    return String(candidates.rows[0].id);
}

async function insertWorkflow(suffix) {
    const offBatchId = await pickFreeOffBatch();
    const id = `${TEST_PREFIX}-WF-${suffix}-${randomUUID().slice(0, 8)}`;
    await db.execute({
        sql: `INSERT INTO claim_workflow
              (id, off_batch_id, claim_workflow_no, principle_code, principle_name,
               source_type, status,
               total_dpp, total_ppn, total_pph, total_claim,
               total_paid, remaining_amount,
               no_claim, no_claim_assigned_at, no_claim_assigned_by,
               submitted_to_principal_at,
               created_by, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [id, offBatchId, `${TEST_PREFIX}-${suffix}-${Date.now()}`,
               "GCPI", "Godrej Consumer Products Indonesia",
               "off_program", STATUS.draft,
               0, 0, 0, 0, 0, 0,
               null, null, null,
               null,
               ACTOR.id, NOW.getTime(), NOW.getTime()],
    });
    return { id, offBatchId };
}

async function insertSubmission(workflowId, scope, scopeLabel, totalClaim) {
    const id = `${TEST_PREFIX}-SUB-${randomUUID().slice(0, 8)}`;
    await db.execute({
        sql: `INSERT INTO claim_submission
              (id, claim_workflow_id, no_claim, no_claim_assigned_at, no_claim_assigned_by,
               scope, scope_label, status,
               total_dpp, total_ppn, total_pph, total_claim, total_paid, remaining_amount,
               submitted_to_principal_at,
               created_by, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [id, workflowId, null, null, null,
               scope, scopeLabel, STATUS.draft,
               0, 0, 0, totalClaim, 0, totalClaim,
               null,
               ACTOR.id, NOW.getTime(), NOW.getTime()],
    });
    return id;
}

async function insertItem(workflowId, submissionId, label, dpp, ppnRate = 11, pphRate = 0) {
    const id = `${TEST_PREFIX}-IT-${randomUUID().slice(0, 8)}`;
    const ppnAmount = +(dpp * ppnRate / 100).toFixed(2);
    const pphAmount = +(dpp * pphRate / 100).toFixed(2);
    const nilaiKlaim = +(dpp + ppnAmount - pphAmount).toFixed(2);
    await db.execute({
        sql: `INSERT INTO claim_workflow_item
              (id, claim_workflow_id, claim_submission_id,
               no_surat, jenis_promosi, periode, outlet,
               dpp, ppn_rate, ppn_amount, pph_rate, pph_amount, nilai_klaim,
               status, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [id, workflowId, submissionId,
               `NO-SURAT-${label}`, `Program ${label}`, "Mei 2026", `Toko ${label}`,
               dpp, ppnRate, ppnAmount, pphRate, pphAmount, nilaiKlaim,
               "active", NOW.getTime(), NOW.getTime()],
    });
    return id;
}

/**
 * Mirror PATCH /api/claim-workflow/[id]/items/[itemId]:
 *  - Update item.dpp + ppnRate + pphRate.
 *  - Recalc workflow totals dari items (cache lama).
 *  - Recalc submission totals dari items.
 */
async function patchItemTax(workflowId, itemId, { dpp, ppnRate, pphRate }) {
    const wfRow = (await db.execute({
        sql: "SELECT * FROM claim_workflow WHERE id=?", args: [workflowId],
    })).rows[0];
    if (!wfRow) return { ok: false, status: 404, code: "CLAIM_WORKFLOW_NOT_FOUND" };
    if (String(wfRow.status) !== STATUS.draft && String(wfRow.status) !== STATUS.needRevision) {
        return { ok: false, status: 409, code: "CLAIM_WORKFLOW_LOCKED" };
    }
    const itemRow = (await db.execute({
        sql: "SELECT * FROM claim_workflow_item WHERE id=? AND claim_workflow_id=?",
        args: [itemId, workflowId],
    })).rows[0];
    if (!itemRow) return { ok: false, status: 404, code: "CLAIM_ITEM_NOT_FOUND" };
    const newDpp = Number(dpp);
    const newPpn = Number(ppnRate);
    const newPph = Number(pphRate);
    if (!Number.isFinite(newDpp) || newDpp < 0) return { ok: false, status: 400, code: "INVALID_DPP" };
    if (!Number.isFinite(newPpn) || newPpn < 0 || newPpn > 100) return { ok: false, status: 400, code: "INVALID_PPN" };
    if (!Number.isFinite(newPph) || newPph < 0 || newPph > 100) return { ok: false, status: 400, code: "INVALID_PPH" };
    const ppnAmount = +(newDpp * newPpn / 100).toFixed(2);
    const pphAmount = +(newDpp * newPph / 100).toFixed(2);
    const nilaiKlaim = +(newDpp + ppnAmount - pphAmount).toFixed(2);
    await db.execute({
        sql: `UPDATE claim_workflow_item SET
              dpp=?, ppn_rate=?, ppn_amount=?, pph_rate=?, pph_amount=?, nilai_klaim=?, updated_at=?
              WHERE id=?`,
        args: [newDpp, newPpn, ppnAmount, newPph, pphAmount, nilaiKlaim, Date.now(), itemId],
    });
    // Recalc submission totals (item ditugaskan ke satu submission).
    const subId = String(itemRow.claim_submission_id || "");
    if (subId) {
        const subItems = (await db.execute({
            sql: "SELECT dpp, ppn_amount, pph_amount, nilai_klaim FROM claim_workflow_item WHERE claim_submission_id=?",
            args: [subId],
        })).rows;
        const sumDpp = subItems.reduce((a, r) => a + Number(r.dpp || 0), 0);
        const sumPpn = subItems.reduce((a, r) => a + Number(r.ppn_amount || 0), 0);
        const sumPph = subItems.reduce((a, r) => a + Number(r.pph_amount || 0), 0);
        const sumClaim = subItems.reduce((a, r) => a + Number(r.nilai_klaim || 0), 0);
        await db.execute({
            sql: `UPDATE claim_submission SET total_dpp=?, total_ppn=?, total_pph=?, total_claim=?,
                  remaining_amount=?, updated_at=? WHERE id=?`,
            args: [sumDpp, sumPpn, sumPph, sumClaim, Math.max(sumClaim, 0), Date.now(), subId],
        });
    }
    // Recalc workflow cache.
    const allItems = (await db.execute({
        sql: "SELECT dpp, ppn_amount, pph_amount, nilai_klaim FROM claim_workflow_item WHERE claim_workflow_id=?",
        args: [workflowId],
    })).rows;
    const w = allItems.reduce((a, r) => ({
        dpp: a.dpp + Number(r.dpp || 0),
        ppn: a.ppn + Number(r.ppn_amount || 0),
        pph: a.pph + Number(r.pph_amount || 0),
        claim: a.claim + Number(r.nilai_klaim || 0),
    }), { dpp: 0, ppn: 0, pph: 0, claim: 0 });
    await db.execute({
        sql: `UPDATE claim_workflow SET total_dpp=?, total_ppn=?, total_pph=?, total_claim=?,
              remaining_amount=?, updated_at=? WHERE id=?`,
        args: [w.dpp, w.ppn, w.pph, w.claim, Math.max(w.claim, 0), Date.now(), workflowId],
    });
    return {
        ok: true, dpp: newDpp, ppnRate: newPpn, ppnAmount,
        pphRate: newPph, pphAmount, nilaiKlaim,
    };
}

/**
 * Mirror PATCH /api/claim-workflow/[id]/submissions/[submissionId]:
 *  - Update submission.noClaim (non-empty).
 */
async function patchSubmissionNoClaim(workflowId, submissionId, noClaim) {
    const sub = (await db.execute({
        sql: "SELECT id, claim_workflow_id FROM claim_submission WHERE id=?",
        args: [submissionId],
    })).rows[0];
    if (!sub || String(sub.claim_workflow_id) !== workflowId) {
        return { ok: false, status: 404, code: "CLAIM_SUBMISSION_NOT_FOUND" };
    }
    const trimmed = String(noClaim ?? "").trim();
    if (!trimmed) return { ok: false, status: 400, code: "NO_CLAIM_EMPTY" };
    await db.execute({
        sql: `UPDATE claim_submission SET no_claim=?, no_claim_assigned_at=?, no_claim_assigned_by=?, updated_at=?
              WHERE id=?`,
        args: [trimmed, Date.now(), ACTOR.id, Date.now(), submissionId],
    });
    return { ok: true, noClaim: trimmed };
}

// ============================================================================
// Tests
// ============================================================================

async function main() {
    console.log("--- Test 1: parseNoClaimComponents ---");
    const parsed = parseNoClaimComponents("01/SUPER-GCPI/02/2026");
    assertTrue("1", "valid pattern parses to object", parsed !== null);
    if (parsed) {
        assertEqual("1", "sequence 01", parsed.sequence, "01");
        assertEqual("1", "distributor SUPER", parsed.distributorCode, "SUPER");
        assertEqual("1", "principal GCPI", parsed.principalCode, "GCPI");
        assertEqual("1", "month 02", parsed.month, "02");
        assertEqual("1", "year 2026", parsed.year, "2026");
    }
    assertEqual("1", "empty input returns null",
        parseNoClaimComponents(""), null);
    assertEqual("1", "freeform string returns null",
        parseNoClaimComponents("CLM-MANUAL-2026"), null);
    assertEqual("1", "missing year returns null",
        parseNoClaimComponents("01/SUPER-GCPI/02"), null);

    console.log("\n--- Test 2: buildNoClaim ---");
    assertEqual("2", "sequence 1 + month 02 + year 2026",
        buildNoClaim({
            sequence: "1", distributorCode: "SUPER",
            principalCode: "GCPI", month: "02", year: "2026",
        }),
        "01/SUPER-GCPI/02/2026");
    assertEqual("2", "sequence 130 + month 04",
        buildNoClaim({
            sequence: "130", distributorCode: "SUPER",
            principalCode: "GCPI", month: "04", year: "2026",
        }),
        "130/SUPER-GCPI/04/2026");

    console.log("\n--- Test 3: calculate preview ---");
    const calc = calculateClaimPreview(100000, 11, 15);
    assertClose("3", "PPN value 11000", calc.ppnValue, 11000);
    assertClose("3", "PPH value 15000", calc.pphValue, 15000);
    assertClose("3", "Nilai Klaim 96000", calc.nilaiKlaim, 96000);

    console.log("\n--- Test 4: PATCH item tax + submission noClaim ---");
    const wf = await insertWorkflow("ROW");
    cleanupActions.push(() => db.execute({
        sql: "DELETE FROM claim_workflow WHERE id=?", args: [wf.id],
    }));
    const sub = await insertSubmission(wf.id, SCOPE.perItem, "Toko A", 0);
    cleanupActions.push(() => db.execute({
        sql: "DELETE FROM claim_submission WHERE claim_workflow_id=?", args: [wf.id],
    }));
    const itemId = await insertItem(wf.id, sub, "A", 50000, 0, 0);
    cleanupActions.push(() => db.execute({
        sql: "DELETE FROM claim_workflow_item WHERE claim_workflow_id=?", args: [wf.id],
    }));
    cleanupActions.push(() => db.execute({
        sql: "DELETE FROM claim_audit_log WHERE claim_workflow_id=?", args: [wf.id],
    }));

    const taxRes = await patchItemTax(wf.id, itemId, {
        dpp: 100000, ppnRate: 11, pphRate: 15,
    });
    assertTrue("4", "patch tax OK", taxRes.ok, JSON.stringify(taxRes));
    if (taxRes.ok) {
        assertClose("4", "ppnValue 11000", taxRes.ppnAmount, 11000);
        assertClose("4", "pphValue 15000", taxRes.pphAmount, 15000);
        assertClose("4", "nilai klaim 96000", taxRes.nilaiKlaim, 96000);
    }

    const subRow = (await db.execute({
        sql: "SELECT total_claim, total_dpp, total_ppn, total_pph FROM claim_submission WHERE id=?",
        args: [sub],
    })).rows[0];
    assertClose("4", "submission totalClaim 96000", Number(subRow.total_claim), 96000);
    assertClose("4", "submission totalDpp 100000", Number(subRow.total_dpp), 100000);
    assertClose("4", "submission totalPpn 11000", Number(subRow.total_ppn), 11000);
    assertClose("4", "submission totalPph 15000", Number(subRow.total_pph), 15000);

    const wfRow = (await db.execute({
        sql: "SELECT total_claim, total_dpp FROM claim_workflow WHERE id=?",
        args: [wf.id],
    })).rows[0];
    assertClose("4", "workflow cache totalClaim 96000", Number(wfRow.total_claim), 96000);
    assertClose("4", "workflow cache totalDpp 100000", Number(wfRow.total_dpp), 100000);

    const noClaimRes = await patchSubmissionNoClaim(wf.id, sub, "01/SUPER-GCPI/02/2026");
    assertTrue("4", "patch noClaim OK", noClaimRes.ok, JSON.stringify(noClaimRes));
    if (noClaimRes.ok) {
        const after = (await db.execute({
            sql: "SELECT no_claim FROM claim_submission WHERE id=?", args: [sub],
        })).rows[0];
        assertEqual("4", "submission.noClaim persisted",
            String(after.no_claim), "01/SUPER-GCPI/02/2026");
    }
    const empty = await patchSubmissionNoClaim(wf.id, sub, "");
    assertEqual("4", "empty noClaim rejected 400", empty.status, 400);

    console.log("\n--- Test 5: Validation rejects out-of-range tax ---");
    const badPpn = await patchItemTax(wf.id, itemId, {
        dpp: 100000, ppnRate: 150, pphRate: 0,
    });
    assertEqual("5", "ppnRate 150 rejected", badPpn.code, "INVALID_PPN");
    const badDpp = await patchItemTax(wf.id, itemId, {
        dpp: -1, ppnRate: 11, pphRate: 0,
    });
    assertEqual("5", "negative dpp rejected", badDpp.code, "INVALID_DPP");

    console.log("\n=== Test Summary ===");
    const passed = results.filter((r) => r.passed).length;
    const failed = results.filter((r) => !r.passed).length;
    console.log(`Total: ${results.length}  PASS: ${passed}  FAIL: ${failed}`);
    if (failed > 0) {
        console.log("\nFailed assertions:");
        for (const r of results.filter((rr) => !rr.passed)) {
            console.log(`  - [Test ${r.testId}] ${r.label}: ${r.detail}`);
        }
    }
}

(async () => {
    let exitCode = 0;
    try {
        await main();
        const failed = results.filter((r) => !r.passed).length;
        if (failed > 0) exitCode = 1;
    } catch (err) {
        console.error("\n[r7h-test] UNCAUGHT:", err);
        exitCode = 2;
    } finally {
        console.log("\n--- Cleanup ---");
        for (const action of cleanupActions.reverse()) {
            try { await action(); } catch (e) { console.warn("cleanup failed:", e?.message); }
        }
        try {
            await db.execute(
                `DELETE FROM claim_workflow_item WHERE claim_workflow_id IN (SELECT id FROM claim_workflow WHERE claim_workflow_no LIKE '${TEST_PREFIX}-%')`,
            );
            await db.execute(
                `DELETE FROM claim_audit_log WHERE claim_workflow_id IN (SELECT id FROM claim_workflow WHERE claim_workflow_no LIKE '${TEST_PREFIX}-%')`,
            );
            await db.execute(
                `DELETE FROM claim_submission WHERE claim_workflow_id IN (SELECT id FROM claim_workflow WHERE claim_workflow_no LIKE '${TEST_PREFIX}-%')`,
            );
            await db.execute(
                `DELETE FROM claim_workflow WHERE claim_workflow_no LIKE '${TEST_PREFIX}-%'`,
            );
            console.log("Cleanup demo rows OK.");
        } catch (e) {
            console.warn("Defensive cleanup failed:", e?.message);
        }
        process.exit(exitCode);
    }
})();
