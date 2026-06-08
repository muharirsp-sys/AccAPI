// Integration test untuk R7i Generate Semua Dokumen.
// Fokus:
// - gate generate-all: No Claim wajib, status Draft/Need Revision.
// - output final: path workflow-level, mirror submission, audit.
// - PDF valid: letter/summary gabungan dan receipt A4 landscape 4 per page.
// - Mark Ready gate memakai dokumen workflow-level.

import { createClient } from "@libsql/client";
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
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
        if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        if (!(key in process.env)) process.env[key] = value;
    }
}

loadEnv();
const databaseUrl = process.env.DATABASE_URL || "file:sqlite.db";
const filePath = databaseUrl.startsWith("file:") ? databaseUrl.slice("file:".length) : "";
if (!filePath || filePath.startsWith("/app/")) {
    console.error(`[r7i-test] REFUSED: DATABASE_URL bukan SQLite lokal (${databaseUrl}).`);
    process.exit(2);
}

const db = createClient({ url: databaseUrl });
const TEST_PREFIX = "R7I-TEST";
const NOW = new Date();
const ACTOR = { id: "r7i-actor", name: "R7I Tester", role: "claim" };
const STATUS = {
    draft: "Draft",
    needRevision: "Need Revision",
    readyToSubmit: "Ready to Submit",
    submittedToPrincipal: "Submitted to Principal",
};

let pass = 0;
let fail = 0;
function check(label, cond) {
    if (cond) {
        pass += 1;
        console.log(`  PASS  ${label}`);
    } else {
        fail += 1;
        console.log(`  FAIL  ${label}`);
    }
}

async function insertWorkflow(status = STATUS.draft) {
    const id = `${TEST_PREFIX}-WF-${randomUUID().slice(0, 8)}`;
    const offBatchId = `${TEST_PREFIX}-OFF-${randomUUID().slice(0, 8)}`;
    await db.execute({
        sql: `INSERT INTO off_batch (id, no_pengajuan, gelombang, principle_code, principle_name,
              bulan, tahun, supervisor_name, total_nominal, status, sm_status, claim_status,
              om_status, finance_status, final_status, locked, updated_at, created_at)
              VALUES (?, ?, 'G1', 'FON', 'FONTERRA BRANDS INDONESIA, PT', '06', '2026',
              'SPV', 0, 'Paid', 'Approved by SM', 'Approved', 'Approved', 'Paid',
              'Waiting Claim Final Verification', 1, ?, ?)`,
        args: [offBatchId, `${TEST_PREFIX}-${offBatchId}`, NOW.getTime(), NOW.getTime()],
    });
    await db.execute({
        sql: `INSERT INTO claim_workflow (id, off_batch_id, claim_workflow_no, principle_code,
              principle_name, source_type, status, total_dpp, total_ppn, total_pph, total_claim,
              total_paid, remaining_amount, created_by, created_at, updated_at)
              VALUES (?, ?, ?, 'FON', 'FONTERRA BRANDS INDONESIA, PT', 'off_program', ?,
              0, 0, 0, 0, 0, 0, ?, ?, ?)`,
        args: [id, offBatchId, `${TEST_PREFIX}-CW-${randomUUID().slice(0, 6)}`, status,
            ACTOR.id, NOW.getTime(), NOW.getTime()],
    });
    return { id, offBatchId };
}

async function insertSubmission(workflowId, noClaim, totalClaim) {
    const id = `${TEST_PREFIX}-SUB-${randomUUID().slice(0, 8)}`;
    await db.execute({
        sql: `INSERT INTO claim_submission (id, claim_workflow_id, no_claim, scope, scope_label,
              status, total_dpp, total_ppn, total_pph, total_claim, total_paid, remaining_amount,
              created_at, updated_at)
              VALUES (?, ?, ?, 'per_item', ?, ?, ?, 0, 0, ?, 0, ?, ?, ?)`,
        args: [id, workflowId, noClaim, `Berkas ${noClaim || "kosong"}`, STATUS.draft,
            totalClaim, totalClaim, totalClaim, NOW.getTime(), NOW.getTime()],
    });
    return { id };
}

async function insertItem(workflowId, submissionId, label, dpp) {
    const id = `${TEST_PREFIX}-IT-${randomUUID().slice(0, 8)}`;
    await db.execute({
        sql: `INSERT INTO claim_workflow_item (id, claim_workflow_id, claim_submission_id,
              no_surat, jenis_promosi, periode, outlet, dpp, ppn_rate, ppn_amount, pph_rate,
              pph_amount, nilai_klaim, status, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, 'Juni 2026', ?, ?, 0, 0, 0, 0, ?, 'active', ?, ?)`,
        args: [id, workflowId, submissionId, `NO-SURAT-${label}`, `Program ${label}`,
            `Toko ${label}`, dpp, dpp, NOW.getTime(), NOW.getTime()],
    });
    return id;
}

async function getActiveSubmissions(workflowId) {
    const res = await db.execute({
        sql: `SELECT s.*, (SELECT COUNT(*) FROM claim_workflow_item i
              WHERE i.claim_submission_id = s.id) AS item_count
              FROM claim_submission s
              WHERE s.claim_workflow_id = ?
              ORDER BY s.created_at ASC`,
        args: [workflowId],
    });
    return res.rows
        .map((row) => ({ ...row, item_count: Number(row.item_count || 0) }))
        .filter((row) => Number(row.total_claim || 0) > 0 || row.item_count > 0);
}

async function generateAllGate(workflowId) {
    const wfRes = await db.execute({ sql: `SELECT * FROM claim_workflow WHERE id = ?`, args: [workflowId] });
    const wf = wfRes.rows[0];
    if (!wf) return { ok: false, code: "NOT_FOUND" };
    if (wf.status !== STATUS.draft && wf.status !== STATUS.needRevision) {
        return { ok: false, code: "CLAIM_DOCS_INVALID_STATE" };
    }
    const active = await getActiveSubmissions(workflowId);
    if (active.length === 0) return { ok: false, code: "CLAIM_DOCS_NO_ACTIVE_SUBMISSION" };
    for (const submission of active) {
        if (!String(submission.no_claim || "").trim()) {
            return { ok: false, code: "CLAIM_DOCS_NO_CLAIM_REQUIRED", error: "No Claim belum lengkap." };
        }
        if (!(Number(submission.total_claim || 0) > 0)) {
            return { ok: false, code: "CLAIM_DOCS_TOTAL_ZERO" };
        }
        const items = await db.execute({
            sql: `SELECT dpp, nilai_klaim FROM claim_workflow_item WHERE claim_submission_id = ?`,
            args: [submission.id],
        });
        if (items.rows.length === 0) return { ok: false, code: "CLAIM_DOCS_EMPTY_ITEMS" };
        if (items.rows.some((item) => !(Number(item.dpp || 0) > 0) || !(Number(item.nilai_klaim || 0) > 0))) {
            return { ok: false, code: "CLAIM_DOCS_ITEM_INVALID" };
        }
    }
    return { ok: true, active };
}

async function writePdf(filePath, pageSpecs) {
    const { PDFDocument, StandardFonts } = await import("pdf-lib");
    const pdfDoc = await PDFDocument.create();
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    for (const spec of pageSpecs) {
        const page = pdfDoc.addPage(spec.size);
        for (const [idx, line] of spec.lines.entries()) {
            page.drawText(line, { x: 36, y: spec.size[1] - 48 - idx * 18, size: 10, font });
        }
    }
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, Buffer.from(await pdfDoc.save()));
}

async function simulateGenerateAll(workflowId) {
    const gate = await generateAllGate(workflowId);
    if (!gate.ok) return gate;
    const wfRes = await db.execute({ sql: `SELECT * FROM claim_workflow WHERE id = ?`, args: [workflowId] });
    const workflow = wfRes.rows[0];
    const active = gate.active;
    const ts = Date.now();
    const letterPath = join(process.cwd(), "runtime", "claim-workflow", "letters", `${workflowId}-claim-letter-combined-${ts}.pdf`);
    const summaryPath = join(process.cwd(), "runtime", "claim-workflow", "summaries", `${workflowId}-summary-combined-${ts}.pdf`);
    const receiptPath = join(process.cwd(), "runtime", "claim-workflow", "receipts", `${workflowId}-receipt-combined-${ts}.pdf`);
    const portrait = [595.28, 841.89];
    const landscape = [841.89, 595.28];

    await writePdf(letterPath, active.map((submission) => ({
        size: portrait,
        lines: ["SURAT CLAIM GABUNGAN", `WORKFLOW ${workflow.claim_workflow_no}`, `NO CLAIM ${submission.no_claim}`],
    })));
    await writePdf(summaryPath, active.map((submission) => ({
        size: portrait,
        lines: ["SUMMARY CLAIM GABUNGAN", `WORKFLOW ${workflow.claim_workflow_no}`, `NO CLAIM ${submission.no_claim}`],
    })));
    const receiptPages = [];
    for (let i = 0; i < active.length; i += 4) {
        receiptPages.push({
            size: landscape,
            lines: ["KWITANSI CLAIM GABUNGAN", ...active.slice(i, i + 4).map((submission) => `NO CLAIM ${submission.no_claim}`)],
        });
    }
    await writePdf(receiptPath, receiptPages);

    await db.execute({
        sql: `UPDATE claim_workflow
              SET claim_letter_pdf_path = ?, summary_pdf_path = ?, receipt_pdf_path = ?,
                  claim_letter_generated_at = ?, summary_generated_at = ?, receipt_generated_at = ?,
                  claim_letter_generated_by = ?, summary_generated_by = ?, receipt_generated_by = ?,
                  updated_at = ?
              WHERE id = ?`,
        args: [letterPath, summaryPath, receiptPath, NOW.getTime(), NOW.getTime(), NOW.getTime(),
            ACTOR.id, ACTOR.id, ACTOR.id, NOW.getTime(), workflowId],
    });
    for (const submission of active) {
        await db.execute({
            sql: `UPDATE claim_submission
                  SET claim_letter_pdf_path = ?, summary_pdf_path = ?, receipt_pdf_path = ?,
                      claim_letter_generated_at = ?, summary_generated_at = ?, receipt_generated_at = ?,
                      claim_letter_generated_by = ?, summary_generated_by = ?, receipt_generated_by = ?,
                      updated_at = ?
                  WHERE id = ?`,
            args: [letterPath, summaryPath, receiptPath, NOW.getTime(), NOW.getTime(), NOW.getTime(),
                ACTOR.id, ACTOR.id, ACTOR.id, NOW.getTime(), submission.id],
        });
    }
    await db.execute({
        sql: `INSERT INTO claim_audit_log (id, claim_workflow_id, audit_scope, actor_id, actor_name,
              actor_role, action, from_status, to_status, metadata, created_at)
              VALUES (?, ?, 'workflow', ?, ?, ?, 'claim_documents_generated_all', ?, ?, ?, ?)`,
        args: [`${TEST_PREFIX}-AUD-${randomUUID().slice(0, 8)}`, workflowId, ACTOR.id, ACTOR.name,
            ACTOR.role, workflow.status, workflow.status, JSON.stringify({
                activeSubmissionCount: active.length,
                claimLetterPdfPath: letterPath,
                summaryPdfPath: summaryPath,
                receiptPdfPath: receiptPath,
            }), NOW.getTime()],
    });
    return {
        ok: true,
        activeSubmissionCount: active.length,
        claimLetterPdfPath: letterPath,
        summaryPdfPath: summaryPath,
        receiptPdfPath: receiptPath,
    };
}

async function assertPdf(label, filePath, expectedPages, expectLandscape = false) {
    const { PDFDocument } = await import("pdf-lib");
    check(`${label} exists`, existsSync(filePath));
    check(`${label} non-empty`, statSync(filePath).size > 0);
    const bytes = readFileSync(filePath);
    check(`${label} header %PDF`, bytes.subarray(0, 4).toString() === "%PDF");
    const doc = await PDFDocument.load(bytes);
    check(`${label} page count`, doc.getPageCount() === expectedPages);
    if (expectLandscape) {
        const page = doc.getPage(0);
        check(`${label} A4 landscape`, page.getWidth() > page.getHeight() && Math.round(page.getWidth()) === 842);
    }
}

async function markReadyGate(workflowId) {
    const wfRes = await db.execute({ sql: `SELECT * FROM claim_workflow WHERE id = ?`, args: [workflowId] });
    const workflow = wfRes.rows[0];
    const active = await getActiveSubmissions(workflowId);
    if (active.length === 0) return { ok: false, code: "CLAIM_WORKFLOW_NO_ACTIVE_SUBMISSION" };
    for (const submission of active) {
        if (!String(submission.no_claim || "").trim()) {
            return { ok: false, code: "CLAIM_SUBMISSION_NO_CLAIM_REQUIRED", error: "No Claim belum lengkap." };
        }
    }
    if (!workflow.claim_letter_pdf_path) return { ok: false, code: "CLAIM_COMBINED_LETTER_REQUIRED", error: "Surat Claim gabungan belum dibuat." };
    if (!workflow.summary_pdf_path) return { ok: false, code: "CLAIM_COMBINED_SUMMARY_REQUIRED", error: "Summary gabungan belum dibuat." };
    if (!workflow.receipt_pdf_path) return { ok: false, code: "CLAIM_COMBINED_RECEIPT_REQUIRED", error: "Kwitansi gabungan belum dibuat." };
    return { ok: true };
}

async function cleanup() {
    const tables = ["claim_audit_log", "claim_payment", "claim_workflow_item", "claim_submission"];
    for (const table of tables) {
        await db.execute({ sql: `DELETE FROM ${table} WHERE id LIKE '${TEST_PREFIX}-%' OR claim_workflow_id LIKE '${TEST_PREFIX}-%'`, args: [] }).catch(() => {});
    }
    await db.execute({ sql: `DELETE FROM claim_workflow WHERE id LIKE '${TEST_PREFIX}-%'`, args: [] }).catch(() => {});
    await db.execute({ sql: `DELETE FROM off_batch WHERE id LIKE '${TEST_PREFIX}-%'`, args: [] }).catch(() => {});
}

async function main() {
    console.log("\n=== R7i Generate Semua Dokumen Integration Test ===\n");
    await cleanup();

    console.log("--- Test 1: generate-all rejected when No Claim missing ---");
    {
        const wf = await insertWorkflow(STATUS.draft);
        const subA = await insertSubmission(wf.id, `T1A-${randomUUID().slice(0, 6)}`, 100000);
        await insertItem(wf.id, subA.id, "A", 100000);
        const subB = await insertSubmission(wf.id, "", 200000);
        await insertItem(wf.id, subB.id, "B", 200000);
        const res = await generateAllGate(wf.id);
        check("[T1] gate ok=false", res.ok === false);
        check("[T1] code CLAIM_DOCS_NO_CLAIM_REQUIRED", res.code === "CLAIM_DOCS_NO_CLAIM_REQUIRED");
        check("[T1] message No Claim belum lengkap.", res.error === "No Claim belum lengkap.");
    }

    console.log("\n--- Test 2: generate-all rejected when status is not Draft/Need Revision ---");
    {
        const wf = await insertWorkflow(STATUS.submittedToPrincipal);
        const subA = await insertSubmission(wf.id, `T2-${randomUUID().slice(0, 6)}`, 100000);
        await insertItem(wf.id, subA.id, "A", 100000);
        const res = await generateAllGate(wf.id);
        check("[T2] gate ok=false", res.ok === false);
        check("[T2] code CLAIM_DOCS_INVALID_STATE", res.code === "CLAIM_DOCS_INVALID_STATE");
    }

    console.log("\n--- Test 3: generate-all succeeds and writes workflow-level docs ---");
    let okWorkflowId = "";
    {
        const wf = await insertWorkflow(STATUS.draft);
        okWorkflowId = wf.id;
        const subA = await insertSubmission(wf.id, `T3A-${randomUUID().slice(0, 6)}`, 100000);
        const subB = await insertSubmission(wf.id, `T3B-${randomUUID().slice(0, 6)}`, 250000);
        await insertItem(wf.id, subA.id, "A", 100000);
        await insertItem(wf.id, subB.id, "B", 250000);
        const generated = await simulateGenerateAll(wf.id);
        check("[T3] generate-all ok=true", generated.ok === true);
        check("[T3] activeSubmissionCount=2", generated.activeSubmissionCount === 2);
        const wfAfter = await db.execute({ sql: `SELECT * FROM claim_workflow WHERE id = ?`, args: [wf.id] });
        check("[T3] workflow claim_letter_pdf_path set", Boolean(wfAfter.rows[0].claim_letter_pdf_path));
        check("[T3] workflow summary_pdf_path set", Boolean(wfAfter.rows[0].summary_pdf_path));
        check("[T3] workflow receipt_pdf_path set", Boolean(wfAfter.rows[0].receipt_pdf_path));
        await assertPdf("[T3] Letter combined PDF", generated.claimLetterPdfPath, 2);
        await assertPdf("[T3] Summary combined PDF", generated.summaryPdfPath, 2);
        await assertPdf("[T3] Receipt combined PDF", generated.receiptPdfPath, 1, true);
        const mirrored = await db.execute({
            sql: `SELECT COUNT(*) AS c FROM claim_submission
                  WHERE claim_workflow_id = ?
                    AND claim_letter_pdf_path = ?
                    AND summary_pdf_path = ?
                    AND receipt_pdf_path = ?`,
            args: [wf.id, generated.claimLetterPdfPath, generated.summaryPdfPath, generated.receiptPdfPath],
        });
        check("[T3] paths mirrored to submissions", Number(mirrored.rows[0].c || 0) === 2);
        const audit = await db.execute({
            sql: `SELECT COUNT(*) AS c FROM claim_audit_log WHERE claim_workflow_id = ? AND action = 'claim_documents_generated_all'`,
            args: [wf.id],
        });
        check("[T3] audit claim_documents_generated_all", Number(audit.rows[0].c || 0) === 1);
    }

    console.log("\n--- Test 4: receipt combined uses 4 receipts per landscape page ---");
    {
        const wf = await insertWorkflow(STATUS.draft);
        for (let i = 1; i <= 6; i += 1) {
            const sub = await insertSubmission(wf.id, `T4-${String(i).padStart(2, "0")}`, 100000 + i);
            await insertItem(wf.id, sub.id, `T4-${i}`, 100000 + i);
        }
        const generated = await simulateGenerateAll(wf.id);
        await assertPdf("[T4] Receipt 6 No Claim combined PDF", generated.receiptPdfPath, 2, true);
    }

    console.log("\n--- Test 5: mark_ready blocked by missing workflow-level docs ---");
    {
        const wf = await insertWorkflow(STATUS.draft);
        const sub = await insertSubmission(wf.id, `T5-${randomUUID().slice(0, 6)}`, 100000);
        await insertItem(wf.id, sub.id, "A", 100000);
        let res = await markReadyGate(wf.id);
        check("[T5] missing letter blocked", res.ok === false && res.code === "CLAIM_COMBINED_LETTER_REQUIRED");
        check("[T5] missing letter message", res.error === "Surat Claim gabungan belum dibuat.");
        const lp = join(process.cwd(), "runtime", "claim-workflow", "letters", `${wf.id}-letter.pdf`);
        const sp = join(process.cwd(), "runtime", "claim-workflow", "summaries", `${wf.id}-summary.pdf`);
        const rp = join(process.cwd(), "runtime", "claim-workflow", "receipts", `${wf.id}-receipt.pdf`);
        for (const p of [lp, sp, rp]) {
            mkdirSync(dirname(p), { recursive: true });
            writeFileSync(p, "%PDF-1.4\n%%EOF\n");
        }
        await db.execute({ sql: `UPDATE claim_workflow SET claim_letter_pdf_path = ? WHERE id = ?`, args: [lp, wf.id] });
        res = await markReadyGate(wf.id);
        check("[T5] missing summary blocked", res.ok === false && res.code === "CLAIM_COMBINED_SUMMARY_REQUIRED");
        check("[T5] missing summary message", res.error === "Summary gabungan belum dibuat.");
        await db.execute({ sql: `UPDATE claim_workflow SET summary_pdf_path = ? WHERE id = ?`, args: [sp, wf.id] });
        res = await markReadyGate(wf.id);
        check("[T5] missing receipt blocked", res.ok === false && res.code === "CLAIM_COMBINED_RECEIPT_REQUIRED");
        check("[T5] missing receipt message", res.error === "Kwitansi gabungan belum dibuat.");
        await db.execute({ sql: `UPDATE claim_workflow SET receipt_pdf_path = ? WHERE id = ?`, args: [rp, wf.id] });
        res = await markReadyGate(wf.id);
        check("[T5] mark_ready ok=true with all workflow docs", res.ok === true);
    }

    console.log("\n--- Test 6: mark_ready passes after generate-all workflow-level docs ---");
    {
        const res = await markReadyGate(okWorkflowId);
        check("[T6] mark_ready ok=true", res.ok === true);
    }

    await cleanup();

    console.log(`\n=== Test Summary ===\nTotal: ${pass + fail}  PASS: ${pass}  FAIL: ${fail}\n`);
    if (fail > 0) process.exit(1);
    process.exit(0);
}

main().catch((error) => {
    console.error("[r7i-test] UNCAUGHT:", error);
    process.exit(1);
});
