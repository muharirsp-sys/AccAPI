// Tujuan: Integration test untuk Phase R7e — Close per submission +
//         workflow aggregate + reports per submission. Tidak butuh
//         browser session; mensimulasikan business logic close + report
//         langsung di level DB + filesystem.
// Caller: `node scripts/test-r7e-close-reports.mjs`.
// Side Effects:
//   - INSERT/UPDATE/DELETE demo data dengan prefix `R7E-TEST-*`.
//   - Tulis stub PDF ke `runtime/claim-workflow/...` dan cleanup di finally.
// Aturan:
//   - Refuse non-lokal DATABASE_URL.
//   - Idempotent.

import { createClient } from "@libsql/client";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
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
    console.error(`[r7e-test] REFUSED: DATABASE_URL bukan SQLite lokal (${databaseUrl}).`);
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
const ACTOR = { id: "r7e-test-actor", name: "R7e Test", role: "admin" };
const NOW = new Date();
const TEST_PREFIX = "R7E-TEST";
const PDF_STUB = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n", "utf8");

const results = [];
function record(testId, label, passed, detail) {
    results.push({ testId, label, passed, detail: detail || "" });
    const sym = passed ? "  PASS" : "  FAIL";
    console.log(`${sym}  [Test ${testId}] ${label}${detail ? " — " + detail : ""}`);
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

// __INSERT_HELPERS__
async function pickFreeOffBatch() {
    const res = await db.execute(`
        SELECT b.id FROM off_batch b
        LEFT JOIN claim_workflow cw ON cw.off_batch_id = b.id
        WHERE cw.id IS NULL
    `);
    if (res.rows.length === 0) throw new Error("Tidak ada off_batch tanpa claim_workflow.");
    return String(res.rows[0].id);
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
               no_claim, submitted_to_principal_at,
               created_by, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [id, offBatchId, `${TEST_PREFIX}-${suffix}-${Date.now()}`,
               "DEMO", "Demo Principal", "off_program", STATUS.submittedToPrincipal,
               0, 0, 0, 0, 0, 0,
               null, NOW.getTime(),
               ACTOR.id, NOW.getTime(), NOW.getTime()],
    });
    return { id, offBatchId };
}

async function insertSubmission(workflowId, scope, scopeLabel, noClaim, totalClaim, status = STATUS.submittedToPrincipal, withDocs = false) {
    const id = `${TEST_PREFIX}-SUB-${randomUUID().slice(0, 8)}`;
    const docs = withDocs ? {
        letter: join(process.cwd(), "runtime", "claim-workflow", id, "submissions", id, "letter", `stub-letter.pdf`),
        summary: join(process.cwd(), "runtime", "claim-workflow", id, "submissions", id, "summary", `stub-summary.pdf`),
        receipt: join(process.cwd(), "runtime", "claim-workflow", id, "submissions", id, "receipt", `stub-receipt.pdf`),
    } : { letter: null, summary: null, receipt: null };
    if (withDocs) {
        for (const p of [docs.letter, docs.summary, docs.receipt]) {
            mkdirSync(dirname(p), { recursive: true });
            writeFileSync(p, PDF_STUB);
        }
    }
    await db.execute({
        sql: `INSERT INTO claim_submission
              (id, claim_workflow_id, no_claim, no_claim_assigned_at, no_claim_assigned_by,
               scope, scope_label, status,
               total_dpp, total_ppn, total_pph, total_claim, total_paid, remaining_amount,
               submitted_to_principal_at,
               claim_letter_pdf_path, summary_pdf_path, receipt_pdf_path,
               created_by, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [id, workflowId, noClaim, NOW.getTime(), ACTOR.id,
               scope, scopeLabel, status,
               0, 0, 0, totalClaim, 0, totalClaim,
               NOW.getTime(),
               docs.letter, docs.summary, docs.receipt,
               ACTOR.id, NOW.getTime(), NOW.getTime()],
    });
    return { id, docs };
}

async function insertItem(workflowId, submissionId, label, dpp) {
    const id = `${TEST_PREFIX}-IT-${randomUUID().slice(0, 8)}`;
    await db.execute({
        sql: `INSERT INTO claim_workflow_item
              (id, claim_workflow_id, claim_submission_id,
               no_surat, jenis_promosi, periode, outlet,
               dpp, ppn_rate, ppn_amount, pph_rate, pph_amount, nilai_klaim,
               status, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, ?, 'active', ?, ?)`,
        args: [id, workflowId, submissionId,
               `NO-SURAT-${label}`, `Program ${label}`, "Mei 2026", `Toko ${label}`,
               dpp, dpp, NOW.getTime(), NOW.getTime()],
    });
    return id;
}

async function insertPayment(workflowId, submissionId, amount) {
    const id = randomUUID();
    await db.execute({
        sql: `INSERT INTO claim_payment
              (id, claim_workflow_id, claim_submission_id, payment_date, payment_amount,
               payment_type, payment_note, proof_path, created_by, voided_at, voided_by, void_reason,
               created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [id, workflowId, submissionId, "2026-05-28", amount,
               null, null, null, ACTOR.id, null, null, null,
               Date.now(), Date.now()],
    });
    return id;
}

// __INSERT_RECALC__
async function recalcSubmission(submissionId) {
    const sub = (await db.execute({ sql: "SELECT * FROM claim_submission WHERE id=?", args: [submissionId] })).rows[0];
    const totalClaim = Number(sub.total_claim || 0);
    const pays = (await db.execute({
        sql: "SELECT payment_amount, voided_at FROM claim_payment WHERE claim_submission_id=?",
        args: [submissionId],
    })).rows;
    const totalPaid = pays.filter((p) => p.voided_at === null).reduce((a, p) => a + Number(p.payment_amount || 0), 0);
    const remainingAmount = Math.max(totalClaim - totalPaid, 0);
    const previousStatus = String(sub.status);
    let nextStatus = previousStatus;
    const inDerived = previousStatus === STATUS.submittedToPrincipal
        || previousStatus === STATUS.partiallyPaid
        || previousStatus === STATUS.paid;
    if (inDerived) {
        if (totalPaid <= 0) nextStatus = STATUS.submittedToPrincipal;
        else if (remainingAmount === 0) nextStatus = STATUS.paid;
        else nextStatus = STATUS.partiallyPaid;
    }
    await db.execute({
        sql: "UPDATE claim_submission SET total_paid=?, remaining_amount=?, status=?, updated_at=? WHERE id=?",
        args: [totalPaid, remainingAmount, nextStatus, Date.now(), submissionId],
    });
    return { totalClaim, totalPaid, remainingAmount, previousStatus, nextStatus };
}

async function recalcWorkflowAggregate(workflowId) {
    const subs = (await db.execute({
        sql: "SELECT status, total_dpp, total_ppn, total_pph, total_claim, total_paid FROM claim_submission WHERE claim_workflow_id=?",
        args: [workflowId],
    })).rows;
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
    const wf = (await db.execute({ sql: "SELECT status FROM claim_workflow WHERE id=?", args: [workflowId] })).rows[0];
    const previousStatus = String(wf.status);
    const inDerived = previousStatus === STATUS.submittedToPrincipal
        || previousStatus === STATUS.partiallyPaid
        || previousStatus === STATUS.paid;
    const nextStatus = inDerived ? aggregateStatus : previousStatus;
    await db.execute({
        sql: "UPDATE claim_workflow SET total_claim=?, total_paid=?, remaining_amount=?, aggregate_status=?, status=?, updated_at=? WHERE id=?",
        args: [totalClaim, totalPaid, remainingAmount, aggregateStatus, nextStatus, Date.now(), workflowId],
    });
    return { totalClaim, totalPaid, remainingAmount, aggregateStatus, workflowStatus: nextStatus };
}

// __INSERT_CLOSE__
async function submissionClose(workflowId, submissionId, note) {
    const sub = (await db.execute({ sql: "SELECT * FROM claim_submission WHERE id=?", args: [submissionId] })).rows[0];
    if (!sub || String(sub.claim_workflow_id) !== workflowId) return { ok: false, status: 404, code: "CLAIM_SUBMISSION_NOT_FOUND" };
    const previousStatus = String(sub.status);
    if (previousStatus === STATUS.closed) return { ok: false, status: 409, code: "CLAIM_CLOSE_ALREADY_CLOSED" };
    if (previousStatus !== STATUS.paid) return { ok: false, status: 409, code: "CLAIM_CLOSE_NOT_PAID" };
    const totalClaim = Number(sub.total_claim || 0);
    if (!(totalClaim > 0)) return { ok: false, status: 422, code: "CLAIM_CLOSE_TOTAL_ZERO" };
    if (!String(sub.no_claim || "").trim()) return { ok: false, status: 422, code: "CLAIM_CLOSE_NO_CLAIM_REQUIRED" };
    if (!sub.claim_letter_pdf_path) return { ok: false, status: 422, code: "CLAIM_CLOSE_CLAIM_LETTER_REQUIRED" };
    if (!sub.summary_pdf_path) return { ok: false, status: 422, code: "CLAIM_CLOSE_SUMMARY_REQUIRED" };
    if (!sub.receipt_pdf_path) return { ok: false, status: 422, code: "CLAIM_CLOSE_RECEIPT_REQUIRED" };
    const pays = (await db.execute({
        sql: "SELECT payment_amount, voided_at FROM claim_payment WHERE claim_submission_id=?",
        args: [submissionId],
    })).rows;
    const activeCount = pays.filter((p) => p.voided_at === null).length;
    if (activeCount === 0) return { ok: false, status: 422, code: "CLAIM_CLOSE_NO_ACTIVE_PAYMENT" };
    const totalPaid = pays.filter((p) => p.voided_at === null).reduce((a, p) => a + Number(p.payment_amount || 0), 0);
    if (totalPaid < totalClaim) return { ok: false, status: 422, code: "CLAIM_CLOSE_TOTAL_PAID_INSUFFICIENT" };
    const remainingAmount = Math.max(totalClaim - totalPaid, 0);
    if (remainingAmount > 0) return { ok: false, status: 422, code: "CLAIM_CLOSE_OUTSTANDING_NOT_ZERO" };

    const now = Date.now();
    await db.execute({
        sql: `UPDATE claim_submission SET status=?, closed_at=?, closed_by=?, close_note=?,
              total_paid=?, remaining_amount=?, updated_at=? WHERE id=?`,
        args: [STATUS.closed, now, ACTOR.id, note, totalPaid, remainingAmount, now, submissionId],
    });
    const aggregate = await recalcWorkflowAggregate(workflowId);
    if (aggregate.aggregateStatus === STATUS.closed) {
        await db.execute({
            sql: "UPDATE claim_workflow SET status=?, closed_at=?, closed_by=?, close_note=?, updated_at=? WHERE id=?",
            args: [STATUS.closed, now, ACTOR.id, note, now, workflowId],
        });
    }
    return { ok: true, previousStatus, aggregate, totalPaid, remainingAmount };
}

async function legacyWorkflowClose(workflowId, note) {
    const subs = (await db.execute({ sql: "SELECT id FROM claim_submission WHERE claim_workflow_id=?", args: [workflowId] })).rows;
    if (subs.length > 1) return { ok: false, status: 409, code: "MULTI_SUBMISSION_CLOSE_ROUTE_DISABLED" };
    if (subs.length === 1) {
        // Proxy to single submission
        return submissionClose(workflowId, String(subs[0].id), note);
    }
    return { ok: false, status: 422, code: "NO_SUBMISSION" };
}

// __INSERT_REPORTS__
async function buildSummaryReport() {
    const rows = (await db.execute(`
        SELECT s.id AS submission_id, s.claim_workflow_id, s.no_claim, s.scope, s.scope_label,
               s.status AS submission_status, s.total_claim, s.total_paid, s.closed_at,
               w.claim_workflow_no, w.source_type, w.aggregate_status
        FROM claim_submission s
        JOIN claim_workflow w ON w.id = s.claim_workflow_id
    `)).rows;
    return rows.map((r) => ({
        submissionId: String(r.submission_id),
        workflowId: String(r.claim_workflow_id),
        claimWorkflowNo: String(r.claim_workflow_no),
        sourceType: String(r.source_type),
        noClaim: r.no_claim,
        scope: r.scope,
        scopeLabel: r.scope_label,
        submissionStatus: String(r.submission_status),
        workflowAggregateStatus: r.aggregate_status,
        totalClaim: Number(r.total_claim || 0),
        totalPaid: Number(r.total_paid || 0),
        closedAt: r.closed_at,
    }));
}

async function buildPaidReport({ includeVoided = false } = {}) {
    const rows = (await db.execute(`
        SELECT p.id AS payment_id, p.claim_workflow_id, p.claim_submission_id,
               p.payment_amount, p.payment_date, p.voided_at,
               s.no_claim, s.scope, s.scope_label,
               w.claim_workflow_no, w.source_type
        FROM claim_payment p
        JOIN claim_submission s ON s.id = p.claim_submission_id
        JOIN claim_workflow w ON w.id = p.claim_workflow_id
    `)).rows;
    return rows
        .filter((r) => includeVoided ? true : r.voided_at === null)
        .map((r) => ({
            paymentId: String(r.payment_id),
            submissionId: String(r.claim_submission_id),
            workflowId: String(r.claim_workflow_id),
            claimWorkflowNo: String(r.claim_workflow_no),
            sourceType: String(r.source_type),
            noClaim: r.no_claim,
            scope: r.scope,
            scopeLabel: r.scope_label,
            paymentAmount: Number(r.payment_amount || 0),
            paymentDate: r.payment_date,
            voidedAt: r.voided_at,
        }));
}

async function buildOutstandingReport() {
    const rows = (await db.execute(`
        SELECT s.id AS submission_id, s.claim_workflow_id, s.no_claim, s.scope, s.scope_label,
               s.status, s.total_claim,
               w.claim_workflow_no, w.source_type
        FROM claim_submission s
        JOIN claim_workflow w ON w.id = s.claim_workflow_id
        WHERE s.status IN ('Submitted to Principal','Partially Paid','Outstanding')
    `)).rows;
    const out = [];
    for (const r of rows) {
        const pays = (await db.execute({
            sql: "SELECT payment_amount, voided_at FROM claim_payment WHERE claim_submission_id=?",
            args: [r.submission_id],
        })).rows;
        const totalPaid = pays.filter((p) => p.voided_at === null).reduce((a, p) => a + Number(p.payment_amount || 0), 0);
        const totalClaim = Number(r.total_claim || 0);
        const remainingAmount = Math.max(totalClaim - totalPaid, 0);
        if (remainingAmount > 0) {
            out.push({
                submissionId: String(r.submission_id),
                workflowId: String(r.claim_workflow_id),
                noClaim: r.no_claim,
                scope: r.scope,
                scopeLabel: r.scope_label,
                status: String(r.status),
                totalClaim,
                totalPaid,
                remainingAmount,
            });
        }
    }
    return out;
}

function rowsToCsv(columns, rows) {
    function escape(value) {
        if (value === null || value === undefined) return "";
        const text = String(value);
        const needs = /[",\r\n]/.test(text) || /^\s|\s$/.test(text);
        if (!needs) return text;
        return `"${text.replace(/"/g, '""')}"`;
    }
    const header = columns.map((c) => escape(c.label)).join(",");
    const body = rows.map((row) => columns.map((c) => escape(row[c.key])).join(",")).join("\r\n");
    const csv = body.length > 0 ? `${header}\r\n${body}\r\n` : `${header}\r\n`;
    return `\uFEFF${csv}`;
}

// __INSERT_MAIN__
const cleanupActions = [];
async function main() {
    console.log("\n=== R7e Close per Submission + Reports per Submission — Integration Test ===\n");

    // Setup multi-submission workflow A/B (Test 1).
    console.log("--- Setup: 2-submission workflow A/B ---");
    const wf = await insertWorkflow("MULTI");
    cleanupActions.push(() => db.execute({ sql: "DELETE FROM claim_workflow WHERE id=?", args: [wf.id] }));
    const subA = await insertSubmission(wf.id, "per_program", "Program A", "CLM-R7E-A-001", 500000, STATUS.submittedToPrincipal, true);
    const subB = await insertSubmission(wf.id, "per_program", "Program B", "CLM-R7E-B-002", 700000, STATUS.submittedToPrincipal, true);
    cleanupActions.push(() => db.execute({ sql: "DELETE FROM claim_submission WHERE claim_workflow_id=?", args: [wf.id] }));
    await insertItem(wf.id, subA.id, "A", 500000);
    await insertItem(wf.id, subB.id, "B", 700000);
    cleanupActions.push(() => db.execute({ sql: "DELETE FROM claim_workflow_item WHERE claim_workflow_id=?", args: [wf.id] }));
    cleanupActions.push(() => db.execute({ sql: "DELETE FROM claim_payment WHERE claim_workflow_id=?", args: [wf.id] }));
    cleanupActions.push(() => db.execute({ sql: "DELETE FROM claim_audit_log WHERE claim_workflow_id=?", args: [wf.id] }));
    cleanupActions.push(() => {
        for (const docs of [subA.docs, subB.docs]) {
            for (const p of [docs.letter, docs.summary, docs.receipt]) {
                if (p) try { unlinkSync(p); } catch {}
            }
        }
    });

    // Test 2: Pay A full + close A. B not closed; workflow not Closed.
    console.log("\n--- Test 2: Pay A full + close A ---");
    await insertPayment(wf.id, subA.id, 500000);
    await recalcSubmission(subA.id);
    await recalcWorkflowAggregate(wf.id);
    const closeA = await submissionClose(wf.id, subA.id, "A done");
    assertTrue("2", "Close A OK", closeA.ok, JSON.stringify(closeA));
    if (closeA.ok) {
        const a = (await db.execute({ sql: "SELECT * FROM claim_submission WHERE id=?", args: [subA.id] })).rows[0];
        const b = (await db.execute({ sql: "SELECT * FROM claim_submission WHERE id=?", args: [subB.id] })).rows[0];
        const w = (await db.execute({ sql: "SELECT * FROM claim_workflow WHERE id=?", args: [wf.id] })).rows[0];
        assertEqual("2", "A status Closed", String(a.status), STATUS.closed);
        assertTrue("2", "B status NOT Closed", String(b.status) !== STATUS.closed);
        assertTrue("2", "Workflow aggregate NOT Closed", String(w.aggregate_status) !== STATUS.closed);
        assertTrue("2", "Workflow status NOT Closed", String(w.status) !== STATUS.closed);
    }

    // Test 3: Close B rejected (B not paid yet).
    console.log("\n--- Test 3: Close B rejected (not paid) ---");
    const closeBFail = await submissionClose(wf.id, subB.id, "should fail");
    assertEqual("3", "Close B rejected with status 409", closeBFail.status, 409);
    assertEqual("3", "Close B returns CLAIM_CLOSE_NOT_PAID", closeBFail.code, "CLAIM_CLOSE_NOT_PAID");

    // Test 4: Pay B full + close B → workflow aggregate Closed.
    console.log("\n--- Test 4: Pay B full + close B → workflow aggregate Closed ---");
    await insertPayment(wf.id, subB.id, 700000);
    await recalcSubmission(subB.id);
    await recalcWorkflowAggregate(wf.id);
    const closeB = await submissionClose(wf.id, subB.id, "B done");
    assertTrue("4", "Close B OK", closeB.ok, JSON.stringify(closeB));
    if (closeB.ok) {
        const a = (await db.execute({ sql: "SELECT * FROM claim_submission WHERE id=?", args: [subA.id] })).rows[0];
        const b = (await db.execute({ sql: "SELECT * FROM claim_submission WHERE id=?", args: [subB.id] })).rows[0];
        const w = (await db.execute({ sql: "SELECT * FROM claim_workflow WHERE id=?", args: [wf.id] })).rows[0];
        assertEqual("4", "B status Closed", String(b.status), STATUS.closed);
        assertEqual("4", "A still Closed", String(a.status), STATUS.closed);
        assertEqual("4", "Workflow aggregate Closed", String(w.aggregate_status), STATUS.closed);
        assertEqual("4", "Workflow status Closed", String(w.status), STATUS.closed);
    }

    // Test 5: Legacy close on multi-submission rejected.
    console.log("\n--- Test 5: Legacy close on multi-submission rejected ---");
    // Re-create a fresh multi workflow for this test (current wf is now Closed)
    const wfM2 = await insertWorkflow("MULTI2");
    cleanupActions.push(() => db.execute({ sql: "DELETE FROM claim_workflow WHERE id=?", args: [wfM2.id] }));
    const subM2A = await insertSubmission(wfM2.id, "per_program", "Program M2A", "CLM-R7E-M2A-001", 100000, STATUS.submittedToPrincipal, true);
    const subM2B = await insertSubmission(wfM2.id, "per_program", "Program M2B", "CLM-R7E-M2B-002", 100000, STATUS.submittedToPrincipal, true);
    cleanupActions.push(() => db.execute({ sql: "DELETE FROM claim_submission WHERE claim_workflow_id=?", args: [wfM2.id] }));
    await insertItem(wfM2.id, subM2A.id, "M2A", 100000);
    await insertItem(wfM2.id, subM2B.id, "M2B", 100000);
    cleanupActions.push(() => db.execute({ sql: "DELETE FROM claim_workflow_item WHERE claim_workflow_id=?", args: [wfM2.id] }));
    cleanupActions.push(() => db.execute({ sql: "DELETE FROM claim_payment WHERE claim_workflow_id=?", args: [wfM2.id] }));
    cleanupActions.push(() => {
        for (const docs of [subM2A.docs, subM2B.docs]) {
            for (const p of [docs.letter, docs.summary, docs.receipt]) {
                if (p) try { unlinkSync(p); } catch {}
            }
        }
    });
    const legacyMultiClose = await legacyWorkflowClose(wfM2.id, "should fail");
    assertEqual("5", "Legacy close multi rejected with 409", legacyMultiClose.status, 409);
    assertEqual("5", "Legacy close multi returns MULTI_SUBMISSION_CLOSE_ROUTE_DISABLED",
        legacyMultiClose.code, "MULTI_SUBMISSION_CLOSE_ROUTE_DISABLED");

    // Test 6: Legacy close on single-submission still works + mirrors workflow fields.
    console.log("\n--- Test 6: Legacy close on single-submission ---");
    const wfS = await insertWorkflow("SINGLE");
    cleanupActions.push(() => db.execute({ sql: "DELETE FROM claim_workflow WHERE id=?", args: [wfS.id] }));
    const subS = await insertSubmission(wfS.id, "per_pengajuan", "Pengajuan utama", "CLM-R7E-S-001", 250000, STATUS.submittedToPrincipal, true);
    cleanupActions.push(() => db.execute({ sql: "DELETE FROM claim_submission WHERE claim_workflow_id=?", args: [wfS.id] }));
    await insertItem(wfS.id, subS.id, "S", 250000);
    cleanupActions.push(() => db.execute({ sql: "DELETE FROM claim_workflow_item WHERE claim_workflow_id=?", args: [wfS.id] }));
    cleanupActions.push(() => db.execute({ sql: "DELETE FROM claim_payment WHERE claim_workflow_id=?", args: [wfS.id] }));
    cleanupActions.push(() => db.execute({ sql: "DELETE FROM claim_audit_log WHERE claim_workflow_id=?", args: [wfS.id] }));
    cleanupActions.push(() => {
        for (const p of [subS.docs.letter, subS.docs.summary, subS.docs.receipt]) {
            if (p) try { unlinkSync(p); } catch {}
        }
    });
    await insertPayment(wfS.id, subS.id, 250000);
    await recalcSubmission(subS.id);
    await recalcWorkflowAggregate(wfS.id);
    const legacySingleClose = await legacyWorkflowClose(wfS.id, "single done");
    assertTrue("6", "Legacy close single OK", legacySingleClose.ok, JSON.stringify(legacySingleClose));
    if (legacySingleClose.ok) {
        const sub = (await db.execute({ sql: "SELECT * FROM claim_submission WHERE id=?", args: [subS.id] })).rows[0];
        const w = (await db.execute({ sql: "SELECT * FROM claim_workflow WHERE id=?", args: [wfS.id] })).rows[0];
        assertEqual("6", "Single sub Closed via legacy proxy", String(sub.status), STATUS.closed);
        assertEqual("6", "Workflow Closed via legacy proxy", String(w.aggregate_status), STATUS.closed);
        assertEqual("6", "Workflow status Closed", String(w.status), STATUS.closed);
        assertTrue("6", "Workflow closed_at mirrored", Boolean(w.closed_at));
    }

    // Test 7: Summary report 1 row per submission.
    console.log("\n--- Test 7: Summary report per-submission ---");
    const summary = await buildSummaryReport();
    const summaryRowsForWf = summary.filter((r) => r.workflowId === wf.id);
    assertEqual("7", "Summary returns 2 rows for multi-submission workflow", summaryRowsForWf.length, 2);
    const rowA = summaryRowsForWf.find((r) => r.submissionId === subA.id);
    const rowB = summaryRowsForWf.find((r) => r.submissionId === subB.id);
    assertTrue("7", "Summary contains submission A row", Boolean(rowA));
    assertTrue("7", "Summary contains submission B row", Boolean(rowB));
    if (rowA) assertEqual("7", "Row A noClaim", rowA.noClaim, "CLM-R7E-A-001");
    if (rowB) assertEqual("7", "Row B noClaim", rowB.noClaim, "CLM-R7E-B-002");

    // Test 8: Paid report includes submissionId/noClaim.
    console.log("\n--- Test 8: Paid report includes submission columns ---");
    const paid = await buildPaidReport({ includeVoided: false });
    const paidForWf = paid.filter((p) => p.workflowId === wf.id);
    assertEqual("8", "Paid report has 2 payments for wf (A+B)", paidForWf.length, 2);
    const paidA = paidForWf.find((p) => p.submissionId === subA.id);
    const paidB = paidForWf.find((p) => p.submissionId === subB.id);
    assertTrue("8", "Paid row for A exists", Boolean(paidA));
    assertTrue("8", "Paid row for B exists", Boolean(paidB));
    if (paidA) assertEqual("8", "Paid row A has noClaim", paidA.noClaim, "CLM-R7E-A-001");
    if (paidB) assertEqual("8", "Paid row B has noClaim", paidB.noClaim, "CLM-R7E-B-002");

    // Test 9: Outstanding excludes Closed/Paid; includes only open.
    console.log("\n--- Test 9: Outstanding excludes Closed ---");
    const outstanding = await buildOutstandingReport();
    const outstandingForWf = outstanding.filter((r) => r.workflowId === wf.id || r.workflowId === wfS.id);
    assertEqual("9", "Outstanding excludes all closed submissions", outstandingForWf.length, 0);
    const outstandingForM2 = outstanding.filter((r) => r.workflowId === wfM2.id);
    assertEqual("9", "Outstanding includes open submissions M2A+M2B (2 rows)", outstandingForM2.length, 2);

    // Test 10: CSV export contains submission columns and escapes text.
    console.log("\n--- Test 10: CSV export ---");
    const cols = [
        { key: "submissionId", label: "Submission Id" },
        { key: "noClaim", label: "No Claim" },
        { key: "scope", label: "Scope" },
        { key: "scopeLabel", label: "Scope Label" },
    ];
    const csvRows = [
        { submissionId: "X-1", noClaim: 'with "quote"', scope: "per_program", scopeLabel: "Has, comma" },
        { submissionId: "X-2", noClaim: "line\nbreak", scope: "custom", scopeLabel: null },
    ];
    const csv = rowsToCsv(cols, csvRows);
    assertTrue("10", "CSV starts with UTF-8 BOM", csv.charCodeAt(0) === 0xFEFF);
    assertTrue("10", "CSV header includes submission columns", csv.includes("Submission Id,No Claim,Scope,Scope Label"));
    assertTrue("10", "CSV escapes quote", csv.includes('"with ""quote"""'));
    assertTrue("10", "CSV escapes comma", csv.includes('"Has, comma"'));
    assertTrue("10", "CSV escapes newline", csv.includes('"line\nbreak"'));

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
        console.error("\n[r7e-test] UNCAUGHT:", err);
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
