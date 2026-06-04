// Tujuan: Integration test untuk Phase R7d — Payment + Outstanding per
//         submission. Mensimulasikan business logic route langsung di
//         level DB tanpa butuh browser session, mirror pola test-r7c.
// Caller: `node scripts/test-r7d-submission-payments.mjs`.
// Side Effects:
//   - INSERT/UPDATE/DELETE demo data dengan prefix `R7D-TEST-*`.
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
    console.error(`[r7d-test] REFUSED: DATABASE_URL bukan SQLite lokal (${databaseUrl}).`);
    process.exit(2);
}
const db = createClient({ url: databaseUrl });

const STATUS = {
    draft: "Draft",
    submittedToPrincipal: "Submitted to Principal",
    partiallyPaid: "Partially Paid",
    paid: "Paid",
    closed: "Closed",
};
const ACTOR = { id: "r7d-test-actor", name: "R7d Test", role: "admin" };
const NOW = new Date();
const TEST_PREFIX = "R7D-TEST";

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

// __INSERT_HELPERS_BELOW__
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
               "DEMO", "Demo Principal", "off_program", STATUS.submittedToPrincipal,
               0, 0, 0, 0, 0, 0,
               null, null, null,
               NOW.getTime(),
               ACTOR.id, NOW.getTime(), NOW.getTime()],
    });
    return { id, offBatchId };
}

async function insertSubmission(workflowId, scope, scopeLabel, noClaim, totalClaim, status = STATUS.submittedToPrincipal) {
    const id = `${TEST_PREFIX}-SUB-${randomUUID().slice(0, 8)}`;
    const submittedAt = (status === STATUS.submittedToPrincipal || status === STATUS.partiallyPaid || status === STATUS.paid)
        ? NOW.getTime() : null;
    await db.execute({
        sql: `INSERT INTO claim_submission
              (id, claim_workflow_id, no_claim, no_claim_assigned_at, no_claim_assigned_by,
               scope, scope_label, status,
               total_dpp, total_ppn, total_pph, total_claim, total_paid, remaining_amount,
               submitted_to_principal_at,
               created_by, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [id, workflowId, noClaim, NOW.getTime(), ACTOR.id,
               scope, scopeLabel, status,
               0, 0, 0, totalClaim, 0, totalClaim,
               submittedAt,
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

// __INSERT_RECALC_BELOW__
async function recalcSubmission(submissionId) {
    const subRes = await db.execute({ sql: "SELECT * FROM claim_submission WHERE id=?", args: [submissionId] });
    const sub = subRes.rows[0];
    const totalClaim = Number(sub.total_claim || 0);
    const payRes = await db.execute({
        sql: "SELECT payment_amount, voided_at FROM claim_payment WHERE claim_submission_id=?",
        args: [submissionId],
    });
    const totalPaid = payRes.rows
        .filter((p) => p.voided_at === null)
        .reduce((acc, p) => acc + Number(p.payment_amount || 0), 0);
    const remainingAmount = Math.max(totalClaim - totalPaid, 0);
    const previousStatus = String(sub.status);
    let nextStatus = previousStatus;
    const inDerivedWindow = previousStatus === STATUS.submittedToPrincipal
        || previousStatus === STATUS.partiallyPaid
        || previousStatus === STATUS.paid;
    if (inDerivedWindow) {
        if (totalPaid <= 0) nextStatus = STATUS.submittedToPrincipal;
        else if (remainingAmount === 0) nextStatus = STATUS.paid;
        else nextStatus = STATUS.partiallyPaid;
    }
    await db.execute({
        sql: `UPDATE claim_submission SET total_paid=?, remaining_amount=?, status=?, updated_at=? WHERE id=?`,
        args: [totalPaid, remainingAmount, nextStatus, Date.now(), submissionId],
    });
    return { totalClaim, totalPaid, remainingAmount, previousStatus, nextStatus };
}

async function recalcWorkflowAggregate(workflowId) {
    const subs = (await db.execute({
        sql: "SELECT status, total_dpp, total_ppn, total_pph, total_claim, total_paid FROM claim_submission WHERE claim_workflow_id=?",
        args: [workflowId],
    })).rows;
    const totalDpp = subs.reduce((a, s) => a + Number(s.total_dpp || 0), 0);
    const totalPpn = subs.reduce((a, s) => a + Number(s.total_ppn || 0), 0);
    const totalPph = subs.reduce((a, s) => a + Number(s.total_pph || 0), 0);
    const totalClaim = subs.reduce((a, s) => a + Number(s.total_claim || 0), 0);
    const totalPaid = subs.reduce((a, s) => a + Number(s.total_paid || 0), 0);
    const remainingAmount = Math.max(totalClaim - totalPaid, 0);
    const statuses = subs.map((s) => String(s.status));
    let aggregateStatus = STATUS.draft;
    if (statuses.length > 0) {
        const allClosed = statuses.every((s) => s === STATUS.closed);
        const allPaidOrClosed = statuses.every((s) => s === STATUS.paid || s === STATUS.closed);
        const hasPaid = statuses.includes(STATUS.paid);
        if (allClosed) aggregateStatus = STATUS.closed;
        else if (allPaidOrClosed && hasPaid) aggregateStatus = STATUS.paid;
        else if (statuses.includes(STATUS.partiallyPaid)) aggregateStatus = STATUS.partiallyPaid;
        else if (statuses.includes(STATUS.submittedToPrincipal) || statuses.includes(STATUS.paid)) aggregateStatus = STATUS.submittedToPrincipal;
        else aggregateStatus = STATUS.draft;
    }
    const wfRes = await db.execute({ sql: "SELECT status FROM claim_workflow WHERE id=?", args: [workflowId] });
    const previousStatus = String(wfRes.rows[0].status);
    const inDerivedWindow = previousStatus === STATUS.submittedToPrincipal
        || previousStatus === STATUS.partiallyPaid
        || previousStatus === STATUS.paid;
    const nextStatus = inDerivedWindow ? aggregateStatus : previousStatus;
    await db.execute({
        sql: `UPDATE claim_workflow SET total_dpp=?, total_ppn=?, total_pph=?, total_claim=?, total_paid=?, remaining_amount=?, aggregate_status=?, status=?, updated_at=? WHERE id=?`,
        args: [totalDpp, totalPpn, totalPph, totalClaim, totalPaid, remainingAmount, aggregateStatus, nextStatus, Date.now(), workflowId],
    });
    return { totalDpp, totalPpn, totalPph, totalClaim, totalPaid, remainingAmount, aggregateStatus, workflowStatus: nextStatus };
}

// __INSERT_ROUTE_SIM_BELOW__
async function submissionCreatePayment(workflowId, submissionId, amount) {
    const subRes = await db.execute({ sql: "SELECT * FROM claim_submission WHERE id=?", args: [submissionId] });
    if (subRes.rows.length === 0 || String(subRes.rows[0].claim_workflow_id) !== workflowId) {
        return { ok: false, status: 404, code: "CLAIM_SUBMISSION_NOT_FOUND" };
    }
    const sub = subRes.rows[0];
    if (sub.status === STATUS.closed) return { ok: false, status: 409, code: "CLAIM_PAYMENT_SUBMISSION_CLOSED" };
    if (!(Number(sub.total_claim || 0) > 0)) return { ok: false, status: 422, code: "CLAIM_PAYMENT_TOTAL_ZERO" };
    if (!String(sub.no_claim || "").trim()) return { ok: false, status: 422, code: "CLAIM_PAYMENT_NO_CLAIM_REQUIRED" };
    const allowed = sub.status === STATUS.submittedToPrincipal || sub.status === STATUS.partiallyPaid;
    if (!allowed) return { ok: false, status: 409, code: "CLAIM_PAYMENT_INVALID_STATE" };
    const previousRemaining = Number(sub.remaining_amount || 0);
    if (amount > previousRemaining) return { ok: false, status: 409, code: "CLAIM_PAYMENT_OVERPAYMENT" };
    const paymentId = randomUUID();
    await db.execute({
        sql: `INSERT INTO claim_payment
              (id, claim_workflow_id, claim_submission_id, payment_date, payment_amount,
               payment_type, payment_note, proof_path, created_by, voided_at, voided_by, void_reason,
               created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [paymentId, workflowId, submissionId, "2026-05-28", amount,
               null, null, null, ACTOR.id, null, null, null,
               Date.now(), Date.now()],
    });
    const recalc = await recalcSubmission(submissionId);
    const aggregate = await recalcWorkflowAggregate(workflowId);
    return { ok: true, paymentId, recalc, aggregate };
}

async function submissionVoidPayment(workflowId, submissionId, paymentId, reason) {
    const subRes = await db.execute({ sql: "SELECT * FROM claim_submission WHERE id=?", args: [submissionId] });
    if (subRes.rows.length === 0 || String(subRes.rows[0].claim_workflow_id) !== workflowId) {
        return { ok: false, status: 404, code: "CLAIM_SUBMISSION_NOT_FOUND" };
    }
    const sub = subRes.rows[0];
    if (sub.status === STATUS.closed) return { ok: false, status: 409, code: "CLAIM_PAYMENT_VOID_SUBMISSION_CLOSED" };
    const payRes = await db.execute({
        sql: "SELECT * FROM claim_payment WHERE id=? AND claim_submission_id=?",
        args: [paymentId, submissionId],
    });
    if (payRes.rows.length === 0) return { ok: false, status: 404, code: "CLAIM_PAYMENT_NOT_FOUND" };
    const pay = payRes.rows[0];
    if (pay.voided_at !== null) return { ok: false, status: 409, code: "CLAIM_PAYMENT_ALREADY_VOIDED" };
    await db.execute({
        sql: `UPDATE claim_payment SET voided_at=?, voided_by=?, void_reason=?, updated_at=? WHERE id=?`,
        args: [Date.now(), ACTOR.id, reason, Date.now(), paymentId],
    });
    const recalc = await recalcSubmission(submissionId);
    const aggregate = await recalcWorkflowAggregate(workflowId);
    return { ok: true, recalc, aggregate };
}

async function legacyCreatePayment(workflowId, amount) {
    const subs = await db.execute({
        sql: "SELECT id FROM claim_submission WHERE claim_workflow_id=?",
        args: [workflowId],
    });
    if (subs.rows.length > 1) {
        return { ok: false, status: 409, code: "MULTI_SUBMISSION_PAYMENT_ROUTE_DISABLED" };
    }
    if (subs.rows.length === 1) {
        return submissionCreatePayment(workflowId, String(subs.rows[0].id), amount);
    }
    return { ok: false, status: 422, code: "NO_SUBMISSION" };
}

// __INSERT_OUTSTANDING_BELOW__
async function getOutstanding() {
    const rows = (await db.execute(`
        SELECT s.id AS submission_id, s.claim_workflow_id, s.no_claim, s.scope, s.scope_label,
               s.status, s.total_claim, s.submitted_to_principal_at,
               w.claim_workflow_no, w.principle_code, w.source_type
        FROM claim_submission s
        JOIN claim_workflow w ON w.id = s.claim_workflow_id
        WHERE s.status IN ('Submitted to Principal','Partially Paid','Outstanding')
    `)).rows;
    const items = [];
    for (const row of rows) {
        const payRes = await db.execute({
            sql: "SELECT payment_amount, voided_at FROM claim_payment WHERE claim_submission_id=?",
            args: [row.submission_id],
        });
        const totalClaim = Number(row.total_claim || 0);
        const totalPaid = payRes.rows
            .filter((p) => p.voided_at === null)
            .reduce((a, p) => a + Number(p.payment_amount || 0), 0);
        const remainingAmount = Math.max(totalClaim - totalPaid, 0);
        if (remainingAmount > 0) {
            items.push({
                submissionId: String(row.submission_id),
                workflowId: String(row.claim_workflow_id),
                claimWorkflowNo: String(row.claim_workflow_no),
                noClaim: row.no_claim,
                scope: row.scope,
                scopeLabel: row.scope_label,
                status: row.status,
                totalClaim,
                totalPaid,
                remainingAmount,
            });
        }
    }
    return items;
}

// __INSERT_MAIN_BELOW__
const cleanupActions = [];
async function main() {
    console.log("\n=== R7d Payment + Outstanding per Submission — Integration Test ===\n");

    const wf = await insertWorkflow("MULTI");
    cleanupActions.push(() => db.execute({ sql: "DELETE FROM claim_workflow WHERE id=?", args: [wf.id] }));

    const subA = await insertSubmission(wf.id, "per_program", "Program A", "CLM-R7D-A-001", 500000, STATUS.submittedToPrincipal);
    const subB = await insertSubmission(wf.id, "per_program", "Program B", "CLM-R7D-B-002", 700000, STATUS.submittedToPrincipal);
    cleanupActions.push(() => db.execute({ sql: "DELETE FROM claim_submission WHERE claim_workflow_id=?", args: [wf.id] }));

    await insertItem(wf.id, subA, "A", 500000);
    await insertItem(wf.id, subB, "B", 700000);
    cleanupActions.push(() => db.execute({ sql: "DELETE FROM claim_workflow_item WHERE claim_workflow_id=?", args: [wf.id] }));
    cleanupActions.push(() => db.execute({ sql: "DELETE FROM claim_payment WHERE claim_workflow_id=?", args: [wf.id] }));
    cleanupActions.push(() => db.execute({ sql: "DELETE FROM claim_audit_log WHERE claim_workflow_id=?", args: [wf.id] }));

    console.log("--- Test 1-2: Multi-submission setup verified ---");
    const initialA = (await db.execute({ sql: "SELECT * FROM claim_submission WHERE id=?", args: [subA] })).rows[0];
    const initialB = (await db.execute({ sql: "SELECT * FROM claim_submission WHERE id=?", args: [subB] })).rows[0];
    assertEqual("1", "Submission A status Submitted to Principal", String(initialA.status), STATUS.submittedToPrincipal);
    assertEqual("2", "Submission B status Submitted to Principal", String(initialB.status), STATUS.submittedToPrincipal);
    assertEqual("1", "Submission A totalClaim 500000", Number(initialA.total_claim), 500000);
    assertEqual("2", "Submission B totalClaim 700000", Number(initialB.total_claim), 700000);

    console.log("\n--- Test 3: Pay A partial 200000 ---");
    const payA1 = await submissionCreatePayment(wf.id, subA, 200000);
    assertTrue("3", "Pay A partial 200000 OK", payA1.ok, JSON.stringify(payA1));
    if (payA1.ok) {
        const a = (await db.execute({ sql: "SELECT * FROM claim_submission WHERE id=?", args: [subA] })).rows[0];
        const b = (await db.execute({ sql: "SELECT * FROM claim_submission WHERE id=?", args: [subB] })).rows[0];
        const w = (await db.execute({ sql: "SELECT * FROM claim_workflow WHERE id=?", args: [wf.id] })).rows[0];
        assertEqual("3", "A totalPaid 200000", Number(a.total_paid), 200000);
        assertEqual("3", "A remaining 300000", Number(a.remaining_amount), 300000);
        assertEqual("3", "A status Partially Paid", String(a.status), STATUS.partiallyPaid);
        assertEqual("3", "B totalPaid still 0", Number(b.total_paid), 0);
        assertEqual("3", "B remaining still 700000", Number(b.remaining_amount), 700000);
        assertEqual("3", "Workflow totalPaid aggregate 200000", Number(w.total_paid), 200000);
        assertEqual("3", "Workflow remaining aggregate 1000000", Number(w.remaining_amount), 1000000);
        assertEqual("3", "Workflow aggregate status Partially Paid", String(w.aggregate_status), STATUS.partiallyPaid);
    }

    console.log("\n--- Test 4: Pay B full 700000 ---");
    const payB1 = await submissionCreatePayment(wf.id, subB, 700000);
    assertTrue("4", "Pay B full 700000 OK", payB1.ok, JSON.stringify(payB1));
    if (payB1.ok) {
        const a = (await db.execute({ sql: "SELECT * FROM claim_submission WHERE id=?", args: [subA] })).rows[0];
        const b = (await db.execute({ sql: "SELECT * FROM claim_submission WHERE id=?", args: [subB] })).rows[0];
        const w = (await db.execute({ sql: "SELECT * FROM claim_workflow WHERE id=?", args: [wf.id] })).rows[0];
        assertEqual("4", "B status Paid", String(b.status), STATUS.paid);
        assertEqual("4", "B remaining 0", Number(b.remaining_amount), 0);
        assertEqual("4", "A still Partially Paid", String(a.status), STATUS.partiallyPaid);
        assertTrue("4", "Workflow aggregate NOT Paid yet (A still partial)",
            String(w.aggregate_status) !== STATUS.paid);
    }

    console.log("\n--- Test 5: Pay A remaining 300000 ---");
    const payA2 = await submissionCreatePayment(wf.id, subA, 300000);
    assertTrue("5", "Pay A remaining 300000 OK", payA2.ok, JSON.stringify(payA2));
    if (payA2.ok) {
        const a = (await db.execute({ sql: "SELECT * FROM claim_submission WHERE id=?", args: [subA] })).rows[0];
        const w = (await db.execute({ sql: "SELECT * FROM claim_workflow WHERE id=?", args: [wf.id] })).rows[0];
        assertEqual("5", "A status Paid", String(a.status), STATUS.paid);
        assertEqual("5", "A remaining 0", Number(a.remaining_amount), 0);
        assertEqual("5", "Workflow aggregate Paid", String(w.aggregate_status), STATUS.paid);
    }

    console.log("\n--- Test 6: Overpay rejected ---");
    const voidedB = await submissionVoidPayment(wf.id, subB, payB1.paymentId, "test reset for overpay");
    assertTrue("6", "Void B succeeded for overpay test", voidedB.ok);
    const overpay = await submissionCreatePayment(wf.id, subB, 700001);
    assertEqual("6", "Overpay B by 1 rejected with status 409", overpay.status, 409);
    assertEqual("6", "Overpay B returns CLAIM_PAYMENT_OVERPAYMENT", overpay.code, "CLAIM_PAYMENT_OVERPAYMENT");

    console.log("\n--- Test 7: Void B payment reverts status ---");
    const b = (await db.execute({ sql: "SELECT * FROM claim_submission WHERE id=?", args: [subB] })).rows[0];
    const w = (await db.execute({ sql: "SELECT * FROM claim_workflow WHERE id=?", args: [wf.id] })).rows[0];
    assertEqual("7", "B reverted to Submitted to Principal after void", String(b.status), STATUS.submittedToPrincipal);
    assertEqual("7", "B totalPaid 0 after void", Number(b.total_paid), 0);
    assertEqual("7", "B remaining 700000 after void", Number(b.remaining_amount), 700000);
    assertTrue("7", "Workflow aggregate not Paid after void",
        String(w.aggregate_status) !== STATUS.paid);

    console.log("\n--- Test 8: Legacy POST on multi-submission rejected ---");
    const legacyMulti = await legacyCreatePayment(wf.id, 100000);
    assertEqual("8", "Legacy on multi rejected with status 409", legacyMulti.status, 409);
    assertEqual("8", "Legacy on multi returns MULTI_SUBMISSION_PAYMENT_ROUTE_DISABLED",
        legacyMulti.code, "MULTI_SUBMISSION_PAYMENT_ROUTE_DISABLED");

    console.log("\n--- Test 9: Legacy POST on single-submission ---");
    const wfSingle = await insertWorkflow("SINGLE");
    cleanupActions.push(() => db.execute({ sql: "DELETE FROM claim_workflow WHERE id=?", args: [wfSingle.id] }));
    const subSingle = await insertSubmission(wfSingle.id, "per_pengajuan", "Pengajuan utama", "CLM-R7D-S-001", 100000, STATUS.submittedToPrincipal);
    cleanupActions.push(() => db.execute({ sql: "DELETE FROM claim_submission WHERE claim_workflow_id=?", args: [wfSingle.id] }));
    await insertItem(wfSingle.id, subSingle, "S", 100000);
    cleanupActions.push(() => db.execute({ sql: "DELETE FROM claim_workflow_item WHERE claim_workflow_id=?", args: [wfSingle.id] }));
    cleanupActions.push(() => db.execute({ sql: "DELETE FROM claim_payment WHERE claim_workflow_id=?", args: [wfSingle.id] }));
    cleanupActions.push(() => db.execute({ sql: "DELETE FROM claim_audit_log WHERE claim_workflow_id=?", args: [wfSingle.id] }));

    const legacySingle = await legacyCreatePayment(wfSingle.id, 100000);
    assertTrue("9", "Legacy on single-submission OK", legacySingle.ok, JSON.stringify(legacySingle));
    if (legacySingle.ok) {
        const sub = (await db.execute({ sql: "SELECT * FROM claim_submission WHERE id=?", args: [subSingle] })).rows[0];
        const wsingle = (await db.execute({ sql: "SELECT * FROM claim_workflow WHERE id=?", args: [wfSingle.id] })).rows[0];
        assertEqual("9", "Single submission Paid via legacy route", String(sub.status), STATUS.paid);
        assertEqual("9", "Workflow Paid via legacy route", String(wsingle.aggregate_status), STATUS.paid);
        const payRow = (await db.execute({ sql: "SELECT * FROM claim_payment WHERE id=?", args: [legacySingle.paymentId] })).rows[0];
        assertEqual("9", "Legacy payment ter-link ke submission", String(payRow.claim_submission_id || ""), subSingle);
    }

    console.log("\n--- Test 10: Outstanding endpoint per-submission ---");
    const outstanding = await getOutstanding();
    const ourOutstanding = outstanding.filter((r) =>
        r.workflowId === wf.id || r.workflowId === wfSingle.id);
    const subAInOutstanding = ourOutstanding.find((r) => r.submissionId === subA);
    const subBInOutstanding = ourOutstanding.find((r) => r.submissionId === subB);
    const subSingleInOutstanding = ourOutstanding.find((r) => r.submissionId === subSingle);
    assertTrue("10", "Outstanding excludes Paid submission A", !subAInOutstanding);
    assertTrue("10", "Outstanding includes submission B with remaining 700000",
        Boolean(subBInOutstanding) && subBInOutstanding.remainingAmount === 700000);
    assertTrue("10", "Outstanding excludes Paid single submission", !subSingleInOutstanding);
    if (subBInOutstanding) {
        assertEqual("10", "Outstanding row has noClaim", subBInOutstanding.noClaim, "CLM-R7D-B-002");
        assertEqual("10", "Outstanding row has scope", subBInOutstanding.scope, "per_program");
        assertEqual("10", "Outstanding row has scopeLabel", subBInOutstanding.scopeLabel, "Program B");
    }

    console.log("\n=== Test Summary ===");
    const passed = results.filter(r => r.passed).length;
    const failed = results.filter(r => !r.passed).length;
    console.log(`Total: ${results.length}  PASS: ${passed}  FAIL: ${failed}`);
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
        console.error("\n[r7d-test] UNCAUGHT:", err);
        exitCode = 2;
    } finally {
        console.log("\n--- Cleanup ---");
        for (const action of cleanupActions.reverse()) {
            try { await action(); } catch (e) { console.warn("cleanup failed:", e?.message); }
        }
        try {
            await db.execute(`DELETE FROM claim_payment WHERE claim_workflow_id IN (SELECT id FROM claim_workflow WHERE claim_workflow_no LIKE '${TEST_PREFIX}-%')`);
            await db.execute(`DELETE FROM claim_workflow_item WHERE claim_workflow_id IN (SELECT id FROM claim_workflow WHERE claim_workflow_no LIKE '${TEST_PREFIX}-%')`);
            await db.execute(`DELETE FROM claim_audit_log WHERE claim_workflow_id IN (SELECT id FROM claim_workflow WHERE claim_workflow_no LIKE '${TEST_PREFIX}-%')`);
            await db.execute(`DELETE FROM claim_submission WHERE claim_workflow_id IN (SELECT id FROM claim_workflow WHERE claim_workflow_no LIKE '${TEST_PREFIX}-%')`);
            await db.execute(`DELETE FROM claim_workflow WHERE claim_workflow_no LIKE '${TEST_PREFIX}-%'`);
            console.log("Cleanup demo rows OK.");
        } catch (e) { console.warn("Defensive cleanup failed:", e?.message); }
        process.exit(exitCode);
    }
})();
