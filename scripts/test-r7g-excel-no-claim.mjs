// Tujuan: Integration test untuk Phase R7g — Excel-style No Claim
//         generator + Per Item Package. Tidak butuh browser session.
//         Helper logic generator (Makassar date, formatting, validation,
//         preview) di-port ke pure JS di sini agar dapat di-uji tanpa
//         menjalankan React. Endpoint from-items disimulasikan di level
//         DB mengikuti pola test R7d.
// Caller: `node scripts/test-r7g-excel-no-claim.mjs`.
// Side Effects:
//   - INSERT/UPDATE/DELETE demo data dengan prefix `R7G-TEST-*`.
//   - Cleanup di blok finally.
// Aturan:
//   - Refuse non-lokal DATABASE_URL.
//   - Idempotent (row prefix R7G-TEST-).

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
    console.error(`[r7g-test] REFUSED: DATABASE_URL bukan SQLite lokal (${databaseUrl}).`);
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
const ACTOR = { id: "r7g-test-actor", name: "R7g Test", role: "admin" };
const NOW = new Date();
const TEST_PREFIX = "R7G-TEST";

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

// ============================================================================
// Pure helper port — Excel-style No Claim generator (mirror page.tsx)
// ============================================================================

function getMakassarDateParts(date = new Date()) {
    try {
        const formatter = new Intl.DateTimeFormat("en-CA", {
            timeZone: "Asia/Makassar",
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
        });
        const parts = formatter.formatToParts(date);
        const get = (type) => parts.find((p) => p.type === type)?.value ?? "";
        const year = get("year").padStart(4, "0");
        const month = get("month").padStart(2, "0");
        const day = get("day").padStart(2, "0");
        if (year && month && day) return { year, month, day };
    } catch {
        // fall through
    }
    const yyyy = String(date.getFullYear()).padStart(4, "0");
    const mm = String(date.getMonth() + 1).padStart(2, "0");
    const dd = String(date.getDate()).padStart(2, "0");
    return { year: yyyy, month: mm, day: dd };
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

function validateNoClaimGenerator(draft) {
    if (!String(draft.sequence ?? "").trim()) return "Nomor urut wajib diisi.";
    if (!String(draft.distributorCode ?? "").trim()) return "Kode distributor wajib diisi.";
    if (!String(draft.principalCode ?? "").trim()) return "Kode principal wajib diisi.";
    const month = String(draft.month ?? "").trim();
    if (!/^\d{2}$/.test(month)) return "Bulan harus 2 digit (01-12).";
    const monthNum = Number(month);
    if (monthNum < 1 || monthNum > 12) return "Bulan harus 01-12.";
    if (!/^\d{4}$/.test(String(draft.year ?? "").trim())) return "Tahun harus 4 digit.";
    return null;
}

function buildNoClaimPreview(draft) {
    const sequence = formatNoClaimSequence(draft.sequence);
    const distributor = String(draft.distributorCode ?? "").trim();
    const principal = String(draft.principalCode ?? "").trim();
    const month = String(draft.month ?? "").trim();
    const year = String(draft.year ?? "").trim();
    if (!sequence || !distributor || !principal || !month || !year) return "";
    return `${sequence}/${distributor}-${principal}/${month}/${year}`;
}

// ============================================================================
// DB helpers + endpoint simulator (from-items mode all_unassigned)
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

async function insertItem(workflowId, submissionId, label, dpp) {
    const id = `${TEST_PREFIX}-IT-${randomUUID().slice(0, 8)}`;
    await db.execute({
        sql: `INSERT INTO claim_workflow_item
              (id, claim_workflow_id, claim_submission_id,
               no_surat, jenis_promosi, periode, outlet,
               dpp, ppn_rate, ppn_amount, pph_rate, pph_amount, nilai_klaim,
               status, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [id, workflowId, submissionId,
               `NO-SURAT-${label}`, `Program ${label}`, "Mei 2026", `Toko ${label}`,
               dpp, 0, 0, 0, 0, dpp,
               "active", NOW.getTime(), NOW.getTime()],
    });
    return id;
}

function deriveItemScopeLabel(item) {
    const candidates = [item.outlet, item.jenis_promosi, item.periode, item.no_surat];
    for (const candidate of candidates) {
        if (typeof candidate === "string") {
            const trimmed = candidate.trim();
            if (trimmed) return trimmed;
        }
    }
    return `Item Klaim ${String(item.id).slice(0, 8)}`;
}

async function recalcSubmissionTotals(submissionId) {
    const itemRes = await db.execute({
        sql: `SELECT dpp, ppn_amount, pph_amount, nilai_klaim
              FROM claim_workflow_item WHERE claim_submission_id=?`,
        args: [submissionId],
    });
    const totalDpp = itemRes.rows.reduce((a, r) => a + Number(r.dpp || 0), 0);
    const totalPpn = itemRes.rows.reduce((a, r) => a + Number(r.ppn_amount || 0), 0);
    const totalPph = itemRes.rows.reduce((a, r) => a + Number(r.pph_amount || 0), 0);
    const totalClaim = itemRes.rows.reduce((a, r) => a + Number(r.nilai_klaim || 0), 0);
    await db.execute({
        sql: `UPDATE claim_submission
              SET total_dpp=?, total_ppn=?, total_pph=?, total_claim=?,
                  remaining_amount=?, updated_at=?
              WHERE id=?`,
        args: [totalDpp, totalPpn, totalPph, totalClaim,
               Math.max(totalClaim - 0, 0), Date.now(), submissionId],
    });
    return { totalDpp, totalPpn, totalPph, totalClaim };
}

async function recalcWorkflowAggregate(workflowId) {
    const subs = (await db.execute({
        sql: `SELECT total_dpp, total_ppn, total_pph, total_claim, total_paid
              FROM claim_submission WHERE claim_workflow_id=?`,
        args: [workflowId],
    })).rows;
    const totalDpp = subs.reduce((a, s) => a + Number(s.total_dpp || 0), 0);
    const totalPpn = subs.reduce((a, s) => a + Number(s.total_ppn || 0), 0);
    const totalPph = subs.reduce((a, s) => a + Number(s.total_pph || 0), 0);
    const totalClaim = subs.reduce((a, s) => a + Number(s.total_claim || 0), 0);
    const totalPaid = subs.reduce((a, s) => a + Number(s.total_paid || 0), 0);
    await db.execute({
        sql: `UPDATE claim_workflow
              SET total_dpp=?, total_ppn=?, total_pph=?, total_claim=?,
                  total_paid=?, remaining_amount=?, updated_at=?
              WHERE id=?`,
        args: [totalDpp, totalPpn, totalPph, totalClaim,
               totalPaid, Math.max(totalClaim - totalPaid, 0),
               Date.now(), workflowId],
    });
    return { totalDpp, totalPpn, totalPph, totalClaim, totalPaid };
}

/**
 * Simulator endpoint POST /[id]/submissions/from-items mode all_unassigned.
 * Mirror logic dengan handler route (skip item yang sudah berada di
 * submission scope per_item; selain itu pindah ke per_item baru).
 */
async function fromItemsAllUnassigned(workflowId) {
    const wfRes = await db.execute({
        sql: "SELECT id, status FROM claim_workflow WHERE id=?",
        args: [workflowId],
    });
    if (wfRes.rows.length === 0) {
        return { ok: false, status: 404, code: "CLAIM_WORKFLOW_NOT_FOUND" };
    }
    const wf = wfRes.rows[0];
    if (String(wf.status) !== STATUS.draft && String(wf.status) !== STATUS.needRevision) {
        return { ok: false, status: 409, code: "CLAIM_SUBMISSION_WORKFLOW_LOCKED" };
    }
    const items = (await db.execute({
        sql: `SELECT id, claim_submission_id AS claimSubmissionId, outlet, jenis_promosi,
                     periode, no_surat
              FROM claim_workflow_item WHERE claim_workflow_id=?`,
        args: [workflowId],
    })).rows;
    if (items.length === 0) {
        return {
            ok: true, createdCount: 0, skippedCount: 0,
            createdSubmissionIds: [], affectedItemIds: [],
        };
    }
    const subIds = Array.from(new Set(items.map((it) => it.claimSubmissionId).filter(Boolean)));
    const scopeMap = new Map();
    if (subIds.length > 0) {
        const sres = await db.execute({
            sql: `SELECT id, scope FROM claim_submission WHERE claim_workflow_id=?`,
            args: [workflowId],
        });
        for (const r of sres.rows) {
            scopeMap.set(String(r.id), String(r.scope));
        }
    }
    const targets = items.filter((it) => {
        const sid = it.claimSubmissionId ? String(it.claimSubmissionId) : null;
        if (!sid) return true;
        return scopeMap.get(sid) !== SCOPE.perItem;
    });
    if (targets.length === 0) {
        return {
            ok: true, createdCount: 0, skippedCount: items.length,
            createdSubmissionIds: [], affectedItemIds: [],
        };
    }
    const previousSubs = new Set();
    const createdSubmissionIds = [];
    const affectedItemIds = [];
    for (const item of targets) {
        const submissionId = `${TEST_PREFIX}-SUB-${randomUUID().slice(0, 8)}`;
        const scopeLabel = deriveItemScopeLabel({
            id: String(item.id),
            outlet: item.outlet,
            jenis_promosi: item.jenis_promosi,
            periode: item.periode,
            no_surat: item.no_surat,
        });
        await db.execute({
            sql: `INSERT INTO claim_submission
                  (id, claim_workflow_id, no_claim, no_claim_assigned_at, no_claim_assigned_by,
                   scope, scope_label, status,
                   total_dpp, total_ppn, total_pph, total_claim, total_paid, remaining_amount,
                   submitted_to_principal_at,
                   created_by, created_at, updated_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            args: [submissionId, workflowId, null, null, null,
                   SCOPE.perItem, scopeLabel, STATUS.draft,
                   0, 0, 0, 0, 0, 0,
                   null,
                   ACTOR.id, NOW.getTime(), NOW.getTime()],
        });
        createdSubmissionIds.push(submissionId);
        affectedItemIds.push(String(item.id));
        if (item.claimSubmissionId) previousSubs.add(String(item.claimSubmissionId));
        await db.execute({
            sql: `UPDATE claim_workflow_item
                  SET claim_submission_id=?, updated_at=? WHERE id=?`,
            args: [submissionId, Date.now(), String(item.id)],
        });
        await recalcSubmissionTotals(submissionId);
    }
    for (const oldId of previousSubs) {
        await recalcSubmissionTotals(oldId);
    }
    await recalcWorkflowAggregate(workflowId);
    return {
        ok: true,
        createdCount: createdSubmissionIds.length,
        skippedCount: items.length - targets.length,
        createdSubmissionIds,
        affectedItemIds,
    };
}

// ============================================================================
// Tests
// ============================================================================

async function main() {
    console.log("--- Test 1: Makassar date parts ---");
    const parts = getMakassarDateParts(new Date());
    assertTrue("1", "year 4 digits", /^\d{4}$/.test(parts.year), `year=${parts.year}`);
    assertTrue("1", "month 2 digits 01-12",
        /^(0[1-9]|1[0-2])$/.test(parts.month), `month=${parts.month}`);
    assertTrue("1", "day 2 digits 01-31",
        /^(0[1-9]|[12]\d|3[01])$/.test(parts.day), `day=${parts.day}`);
    // Specific known instant: 2026-02-15T00:00:00 UTC = 2026-02-15 08:00 WITA.
    const fixed = new Date("2026-02-15T00:00:00Z");
    const fparts = getMakassarDateParts(fixed);
    assertEqual("1", "fixed instant year 2026", fparts.year, "2026");
    assertEqual("1", "fixed instant month 02", fparts.month, "02");
    assertEqual("1", "fixed instant day 15", fparts.day, "15");

    console.log("\n--- Test 2: Generator formatting ---");
    const baseDraft = {
        sequence: "1",
        distributorCode: "SUPER",
        principalCode: "GCPI",
        month: "02",
        year: "2026",
    };
    assertEqual("2", "sequence 1 -> '01/SUPER-GCPI/02/2026'",
        buildNoClaimPreview({ ...baseDraft, sequence: "1" }),
        "01/SUPER-GCPI/02/2026");
    assertEqual("2", "sequence 9 -> '09/SUPER-GCPI/02/2026'",
        buildNoClaimPreview({ ...baseDraft, sequence: "9" }),
        "09/SUPER-GCPI/02/2026");
    assertEqual("2", "sequence 10 -> '10/SUPER-GCPI/02/2026'",
        buildNoClaimPreview({ ...baseDraft, sequence: "10" }),
        "10/SUPER-GCPI/02/2026");
    assertEqual("2", "sequence 130 + month 04 -> '130/SUPER-GCPI/04/2026'",
        buildNoClaimPreview({ ...baseDraft, sequence: "130", month: "04" }),
        "130/SUPER-GCPI/04/2026");

    console.log("\n--- Test 3: Validation rules ---");
    assertEqual("3", "empty sequence rejected",
        validateNoClaimGenerator({ ...baseDraft, sequence: "" }),
        "Nomor urut wajib diisi.");
    assertEqual("3", "month 13 rejected",
        validateNoClaimGenerator({ ...baseDraft, month: "13" }),
        "Bulan harus 01-12.");
    assertEqual("3", "month abc rejected (format)",
        validateNoClaimGenerator({ ...baseDraft, month: "ab" }),
        "Bulan harus 2 digit (01-12).");
    assertEqual("3", "year 26 rejected (must be 4 digit)",
        validateNoClaimGenerator({ ...baseDraft, year: "26" }),
        "Tahun harus 4 digit.");
    assertEqual("3", "missing distributor rejected",
        validateNoClaimGenerator({ ...baseDraft, distributorCode: "" }),
        "Kode distributor wajib diisi.");
    assertEqual("3", "valid draft returns null",
        validateNoClaimGenerator(baseDraft), null);

    console.log("\n--- Test 4: Per-item endpoint creates one submission per item ---");
    const wf = await insertWorkflow("PERITEM");
    cleanupActions.push(() => db.execute({
        sql: "DELETE FROM claim_workflow WHERE id=?", args: [wf.id],
    }));
    const subDefault = await insertSubmission(wf.id, SCOPE.perPengajuan,
        "Pengajuan utama", 0);
    cleanupActions.push(() => db.execute({
        sql: "DELETE FROM claim_submission WHERE claim_workflow_id=?", args: [wf.id],
    }));
    const itemA = await insertItem(wf.id, subDefault, "A", 100000);
    const itemB = await insertItem(wf.id, subDefault, "B", 250000);
    cleanupActions.push(() => db.execute({
        sql: "DELETE FROM claim_workflow_item WHERE claim_workflow_id=?", args: [wf.id],
    }));
    cleanupActions.push(() => db.execute({
        sql: "DELETE FROM claim_audit_log WHERE claim_workflow_id=?", args: [wf.id],
    }));

    const res1 = await fromItemsAllUnassigned(wf.id);
    assertTrue("4", "from-items first call OK", res1.ok, JSON.stringify(res1));
    assertEqual("4", "createdCount = 2", res1.createdCount, 2);
    assertEqual("4", "skippedCount = 0", res1.skippedCount, 0);

    const subs1 = (await db.execute({
        sql: `SELECT id, scope, scope_label, total_claim, no_claim
              FROM claim_submission WHERE claim_workflow_id=?
              ORDER BY created_at ASC`,
        args: [wf.id],
    })).rows;
    const perItemSubs = subs1.filter((s) => String(s.scope) === SCOPE.perItem);
    assertEqual("4", "2 submissions per_item created", perItemSubs.length, 2);
    for (const sub of perItemSubs) {
        assertEqual("4", `submission ${sub.id} noClaim null after create`,
            sub.no_claim, null);
    }
    const items1 = (await db.execute({
        sql: `SELECT id, claim_submission_id, claim_workflow_id
              FROM claim_workflow_item WHERE claim_workflow_id=?`,
        args: [wf.id],
    })).rows;
    const itemSubMap = new Map(items1.map((it) => [
        String(it.id), String(it.claim_submission_id),
    ]));
    const subA = itemSubMap.get(itemA);
    const subB = itemSubMap.get(itemB);
    assertTrue("4", "item A linked to per_item submission",
        Boolean(subA) && perItemSubs.some((s) => String(s.id) === subA),
        `subA=${subA}`);
    assertTrue("4", "item B linked to per_item submission",
        Boolean(subB) && perItemSubs.some((s) => String(s.id) === subB),
        `subB=${subB}`);
    assertTrue("4", "items linked to different submissions", subA !== subB);

    const subAItems = (await db.execute({
        sql: `SELECT id FROM claim_workflow_item WHERE claim_submission_id=?`,
        args: [subA],
    })).rows;
    const subBItems = (await db.execute({
        sql: `SELECT id FROM claim_workflow_item WHERE claim_submission_id=?`,
        args: [subB],
    })).rows;
    assertEqual("4", "submission A has exactly 1 item", subAItems.length, 1);
    assertEqual("4", "submission B has exactly 1 item", subBItems.length, 1);

    const subATotal = perItemSubs.find((s) => String(s.id) === subA);
    const subBTotal = perItemSubs.find((s) => String(s.id) === subB);
    assertEqual("4", "submission A totalClaim 100000",
        Number(subATotal.total_claim), 100000);
    assertEqual("4", "submission B totalClaim 250000",
        Number(subBTotal.total_claim), 250000);

    const wfRow = (await db.execute({
        sql: `SELECT total_dpp, total_ppn, total_pph, total_claim
              FROM claim_workflow WHERE id=?`,
        args: [wf.id],
    })).rows[0];
    assertEqual("4", "workflow totalClaim aggregate 350000",
        Number(wfRow.total_claim), 350000);

    console.log("\n--- Test 5: Idempotent rerun all_unassigned ---");
    const res2 = await fromItemsAllUnassigned(wf.id);
    assertTrue("5", "second call OK", res2.ok, JSON.stringify(res2));
    assertEqual("5", "createdCount = 0 (no duplicates)", res2.createdCount, 0);
    assertEqual("5", "skippedCount = 2 (both items already per_item)",
        res2.skippedCount, 2);
    const subsAfter = (await db.execute({
        sql: `SELECT COUNT(*) AS c FROM claim_submission
              WHERE claim_workflow_id=? AND scope=?`,
        args: [wf.id, SCOPE.perItem],
    })).rows[0];
    assertEqual("5", "still only 2 per_item submissions", Number(subsAfter.c), 2);

    console.log("\n--- Test 6: Empty workflow returns 0 created ---");
    const wfEmpty = await insertWorkflow("EMPTY");
    cleanupActions.push(() => db.execute({
        sql: "DELETE FROM claim_workflow WHERE id=?", args: [wfEmpty.id],
    }));
    cleanupActions.push(() => db.execute({
        sql: "DELETE FROM claim_submission WHERE claim_workflow_id=?", args: [wfEmpty.id],
    }));
    cleanupActions.push(() => db.execute({
        sql: "DELETE FROM claim_audit_log WHERE claim_workflow_id=?", args: [wfEmpty.id],
    }));
    const resEmpty = await fromItemsAllUnassigned(wfEmpty.id);
    assertTrue("6", "empty workflow OK", resEmpty.ok);
    assertEqual("6", "empty createdCount = 0", resEmpty.createdCount, 0);

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
        console.error("\n[r7g-test] UNCAUGHT:", err);
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
