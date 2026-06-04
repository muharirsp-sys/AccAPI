// Tujuan: Integration test untuk Phase R7c — Documents per submission.
//         Memverifikasi 15 skenario QA manual via DB + filesystem assertion
//         tanpa butuh browser/session cookie. Mensimulasikan business
//         logic route (multi-submission guard, mirror cache workflow,
//         path resolver, return_to_draft invalidation) langsung di JS.
// Caller: `node scripts/test-r7c-documents.mjs`.
// Side Effects:
//   - INSERT/UPDATE/DELETE demo data dengan prefix `R7C-TEST-*`.
//   - Tulis minimal PDF stub ke `runtime/claim-workflow/...`.
//   - Hapus row + file demo di akhir test (idempotent).
// Aturan:
//   - Refuse non-lokal DATABASE_URL.
//   - Tidak menyentuh data non-test.
//   - Cleanup di blok finally jadi tetap bersih bila assertion fail.
//
// Catatan: Test ini fokus ke INVARIANT R7c yang baru (path resolver,
// multi-submission guard, mirror, return invalidation). Format isi PDF
// sudah dicover oleh R2; di sini cukup tulis stub `%PDF-1.4\n%%EOF`
// supaya readable + openable.

import { createClient } from "@libsql/client";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve, join, dirname, sep } from "node:path";
import { randomUUID } from "node:crypto";

// ============================================================================
// SECTION 1 — env + db
// ============================================================================
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
    console.error(`[r7c-test] REFUSED: DATABASE_URL bukan SQLite lokal (${databaseUrl}).`);
    process.exit(2);
}
const db = createClient({ url: databaseUrl });

// ============================================================================
// SECTION 2 — minimal helpers (mirror lib/claim-workflow/document-paths.ts)
// ============================================================================
const CLAIM_DOCUMENT_ROOT_DIR = resolve(process.cwd(), "runtime", "claim-workflow");
const LEGACY_DOCUMENT_DIRS = {
    letter: join(CLAIM_DOCUMENT_ROOT_DIR, "letters"),
    summary: join(CLAIM_DOCUMENT_ROOT_DIR, "summaries"),
    receipt: join(CLAIM_DOCUMENT_ROOT_DIR, "receipts"),
};

function sanitizeIdSegment(value) {
    const cleaned = String(value || "").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
    if (!cleaned) throw new Error("invalid id segment");
    return cleaned;
}
function slugifyNoClaim(value) {
    if (value === null || value === undefined) return null;
    const ascii = String(value).normalize("NFKD").replace(/[^\x20-\x7E]/g, "").trim();
    if (!ascii) return null;
    const slug = ascii.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
    return slug.length > 0 ? slug : null;
}
function getSubmissionDocumentDir(workflowId, submissionId, type) {
    return join(CLAIM_DOCUMENT_ROOT_DIR, sanitizeIdSegment(workflowId), "submissions", sanitizeIdSegment(submissionId), type);
}
function buildSubmissionDocumentFilePath(workflowId, submissionId, type, noClaim, generatedAt) {
    const dir = getSubmissionDocumentDir(workflowId, submissionId, type);
    const slug = slugifyNoClaim(noClaim) ?? sanitizeIdSegment(submissionId);
    const ts = generatedAt.toISOString().replace(/[-:T]/g, "").slice(0, 14);
    return join(dir, `${slug}-${type}-${ts}.pdf`);
}
function isPathInsideClaimDocumentRoot(targetPath) {
    if (!targetPath) return false;
    const resolved = resolve(targetPath);
    return resolved === CLAIM_DOCUMENT_ROOT_DIR || resolved.startsWith(CLAIM_DOCUMENT_ROOT_DIR + sep);
}

// ============================================================================
// SECTION 3 — minimal PDF stub
// ============================================================================
const PDF_STUB_PREFIX = "%PDF-1.4\n1 0 obj<<>>endobj\n";
const PDF_STUB_SUFFIX = "\ntrailer<<>>\n%%EOF\n";

/**
 * Tulis PDF stub yang valid sebagai PDF tetapi juga membawa marker
 * identifikasi item di dalamnya. Ini supaya test bisa baca-balik
 * bytes dan memastikan dokumen submission A benar-benar HANYA
 * berisi item A — bukan sekadar verifikasi path.
 *
 * Marker format (dibungkus PDF comment supaya tidak mengganggu parser):
 *   %ITEMS:noSurat1,noSurat2,...
 */
function writePdfStub(filePath, itemMarkers = []) {
    mkdirSync(dirname(filePath), { recursive: true });
    const marker = itemMarkers.length > 0
        ? `\n%ITEMS:${itemMarkers.join(",")}\n`
        : "";
    const buf = Buffer.from(PDF_STUB_PREFIX + marker + PDF_STUB_SUFFIX, "utf8");
    writeFileSync(filePath, buf);
}

function readPdfMarkers(filePath) {
    if (!existsSync(filePath)) return null;
    const content = readFileSync(filePath, "utf8");
    const match = content.match(/%ITEMS:([^\n]*)/);
    if (!match) return [];
    return match[1].split(",").filter(Boolean);
}

// ============================================================================
// SECTION 4 — assertion helpers + result tracker
// ============================================================================
const results = [];
function record(testId, label, passed, detail) {
    results.push({ testId, label, passed, detail: detail || "" });
    const symbol = passed ? "  PASS" : "  FAIL";
    console.log(`${symbol}  [Test ${testId}] ${label}${detail ? " — " + detail : ""}`);
}
function assertTrue(testId, label, condition, failDetail) {
    record(testId, label, Boolean(condition), Boolean(condition) ? "" : failDetail || "expected truthy");
    return Boolean(condition);
}
function assertEqual(testId, label, actual, expected) {
    const ok = actual === expected;
    record(testId, label, ok, ok ? "" : `expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`);
    return ok;
}

// ============================================================================
// SECTION 5 — domain helpers (mirror route logic)
// ============================================================================
const ACTOR = { id: "r7c-test-actor", name: "R7c Test", role: "admin" };
const NOW = new Date();
const TEST_PREFIX = "R7C-TEST";

async function insertWorkflow(suffix) {
    const id = `${TEST_PREFIX}-WF-${suffix}-${randomUUID().slice(0, 8)}`;
    // We need a real off_batch FK — pick first existing or create dummy.
    const offBatchRes = await db.execute("SELECT id FROM off_batch LIMIT 1");
    if (offBatchRes.rows.length === 0) {
        throw new Error("Tidak ada off_batch di DB. Jalankan `npm run seed:demo` dulu.");
    }
    const offBatchId = String(offBatchRes.rows[0].id);
    // off_batch_id is UNIQUE — kita pakai sentinel-id yang unik per test
    // dengan trick INSERT then DELETE dummy. Untuk simplicity, kita reuse
    // existing off_batch dan hapus claim_workflow-nya kalau ada.
    await db.execute({
        sql: `DELETE FROM claim_workflow_item
              WHERE claim_workflow_id IN (
                  SELECT id FROM claim_workflow WHERE off_batch_id = ? AND claim_workflow_no LIKE ?
              )`,
        args: [offBatchId, `${TEST_PREFIX}-%`],
    });
    await db.execute({
        sql: `DELETE FROM claim_submission
              WHERE claim_workflow_id IN (
                  SELECT id FROM claim_workflow WHERE off_batch_id = ? AND claim_workflow_no LIKE ?
              )`,
        args: [offBatchId, `${TEST_PREFIX}-%`],
    });
    await db.execute({
        sql: `DELETE FROM claim_audit_log
              WHERE claim_workflow_id IN (
                  SELECT id FROM claim_workflow WHERE off_batch_id = ? AND claim_workflow_no LIKE ?
              )`,
        args: [offBatchId, `${TEST_PREFIX}-%`],
    });
    await db.execute({
        sql: "DELETE FROM claim_workflow WHERE off_batch_id = ? AND claim_workflow_no LIKE ?",
        args: [offBatchId, `${TEST_PREFIX}-%`],
    });
    // Find an off_batch that has no claim_workflow yet.
    const candidates = await db.execute(`
        SELECT b.id FROM off_batch b
        LEFT JOIN claim_workflow cw ON cw.off_batch_id = b.id
        WHERE cw.id IS NULL
    `);
    if (candidates.rows.length < 1) {
        throw new Error("Tidak ada off_batch tanpa claim_workflow. Reset data demo dulu.");
    }
    const realOffBatchId = String(candidates.rows[0].id);
    await db.execute({
        sql: `INSERT INTO claim_workflow
              (id, off_batch_id, claim_workflow_no, principle_code, principle_name,
               source_type, status,
               total_dpp, total_ppn, total_pph, total_claim,
               total_paid, remaining_amount,
               created_by, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [id, realOffBatchId, `${TEST_PREFIX}-${suffix}-${Date.now()}`,
               "DEMO", "Demo Principal", "off_program", "Draft",
               0, 0, 0, 0, 0, 0,
               ACTOR.id, NOW.getTime(), NOW.getTime()],
    });
    return { id, offBatchId: realOffBatchId };
}

async function insertSubmission(workflowId, scope, scopeLabel, noClaim, totalClaim) {
    const id = `${TEST_PREFIX}-SUB-${randomUUID().slice(0, 8)}`;
    await db.execute({
        sql: `INSERT INTO claim_submission
              (id, claim_workflow_id, no_claim, scope, scope_label, status,
               total_dpp, total_ppn, total_pph, total_claim, total_paid, remaining_amount,
               created_by, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [id, workflowId, noClaim, scope, scopeLabel, "Draft",
               0, 0, 0, totalClaim, 0, totalClaim,
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
               dpp, 11, Math.round(dpp * 0.11), 2, Math.round(dpp * 0.02),
               dpp + Math.round(dpp * 0.11) - Math.round(dpp * 0.02),
               "active", NOW.getTime(), NOW.getTime()],
    });
    return id;
}

// Simulate POST /[id]/claim-letter (legacy workflow-level route).
async function legacyGenerateDocument(workflowId, type) {
    // Multi-submission guard
    const subs = await db.execute({
        sql: "SELECT id FROM claim_submission WHERE claim_workflow_id = ?",
        args: [workflowId],
    });
    if (subs.rows.length > 1) {
        const codeMap = {
            letter: "MULTI_SUBMISSION_LETTER_ROUTE_DISABLED",
            summary: "MULTI_SUBMISSION_SUMMARY_ROUTE_DISABLED",
            receipt: "MULTI_SUBMISSION_RECEIPT_ROUTE_DISABLED",
        };
        return { ok: false, code: codeMap[type], status: 409 };
    }
    const targetSubmissionId = subs.rows[0]?.id ? String(subs.rows[0].id) : null;
    // Items: workflow-level route loads SEMUA item workflow.
    const itemsRes = await db.execute({
        sql: "SELECT id, no_surat FROM claim_workflow_item WHERE claim_workflow_id = ?",
        args: [workflowId],
    });
    const itemMarkers = itemsRes.rows.map((r) => String(r.no_surat || r.id));
    const generatedAt = new Date();
    const ts = generatedAt.toISOString().replace(/[-:T]/g, "").slice(0, 14);
    const dir = LEGACY_DOCUMENT_DIRS[type];
    mkdirSync(dir, { recursive: true });
    const filePath = join(dir, `${TEST_PREFIX}-${type}-${ts}-${randomUUID().slice(0, 6)}.pdf`);
    writePdfStub(filePath, itemMarkers);
    const colMap = {
        letter: { path: "claim_letter_pdf_path", at: "claim_letter_generated_at", by: "claim_letter_generated_by" },
        summary: { path: "summary_pdf_path", at: "summary_generated_at", by: "summary_generated_by" },
        receipt: { path: "receipt_pdf_path", at: "receipt_generated_at", by: "receipt_generated_by" },
    };
    const cols = colMap[type];
    await db.execute({
        sql: `UPDATE claim_workflow SET ${cols.path}=?, ${cols.at}=?, ${cols.by}=?, updated_at=? WHERE id=?`,
        args: [filePath, generatedAt.getTime(), ACTOR.id, generatedAt.getTime(), workflowId],
    });
    if (targetSubmissionId) {
        await db.execute({
            sql: `UPDATE claim_submission SET ${cols.path}=?, ${cols.at}=?, ${cols.by}=?, updated_at=? WHERE id=?`,
            args: [filePath, generatedAt.getTime(), ACTOR.id, generatedAt.getTime(), targetSubmissionId],
        });
    }
    return { ok: true, filePath, mirroredSubmissionId: targetSubmissionId, itemMarkers };
}

// Simulate POST /[id]/submissions/[submissionId]/{type}.
async function submissionGenerateDocument(workflowId, submissionId, type) {
    const subRes = await db.execute({
        sql: "SELECT * FROM claim_submission WHERE id=?",
        args: [submissionId],
    });
    if (subRes.rows.length === 0 || String(subRes.rows[0].claim_workflow_id) !== workflowId) {
        return { ok: false, code: "CLAIM_SUBMISSION_NOT_FOUND" };
    }
    const submission = subRes.rows[0];
    const itemsRes = await db.execute({
        sql: "SELECT id, no_surat FROM claim_workflow_item WHERE claim_submission_id=?",
        args: [submissionId],
    });
    const items = itemsRes.rows;
    if (items.length === 0) {
        return { ok: false, code: "EMPTY_ITEMS" };
    }
    if (!(Number(submission.total_claim || 0) > 0)) {
        return { ok: false, code: "TOTAL_ZERO" };
    }
    const generatedAt = new Date();
    const filePath = buildSubmissionDocumentFilePath(workflowId, submissionId, type, submission.no_claim, generatedAt);
    const itemMarkers = items.map((r) => String(r.no_surat || r.id));
    writePdfStub(filePath, itemMarkers);
    const colMap = {
        letter: { path: "claim_letter_pdf_path", at: "claim_letter_generated_at", by: "claim_letter_generated_by" },
        summary: { path: "summary_pdf_path", at: "summary_generated_at", by: "summary_generated_by" },
        receipt: { path: "receipt_pdf_path", at: "receipt_generated_at", by: "receipt_generated_by" },
    };
    const cols = colMap[type];
    await db.execute({
        sql: `UPDATE claim_submission SET ${cols.path}=?, ${cols.at}=?, ${cols.by}=?, updated_at=? WHERE id=?`,
        args: [filePath, generatedAt.getTime(), ACTOR.id, generatedAt.getTime(), submissionId],
    });
    // Mirror cache workflow only when single submission
    const allSubs = await db.execute({
        sql: "SELECT id FROM claim_submission WHERE claim_workflow_id=?",
        args: [workflowId],
    });
    let workflowMirror = false;
    if (allSubs.rows.length === 1 && String(allSubs.rows[0].id) === submissionId) {
        await db.execute({
            sql: `UPDATE claim_workflow SET ${cols.path}=?, ${cols.at}=?, ${cols.by}=?, updated_at=? WHERE id=?`,
            args: [filePath, generatedAt.getTime(), ACTOR.id, generatedAt.getTime(), workflowId],
        });
        workflowMirror = true;
    }
    return { ok: true, filePath, items: items.map(i => String(i.id)), itemCount: items.length, workflowMirror, itemMarkers };
}

// Simulate POST /[id]/status action=return_to_draft (R7c invalidate).
async function returnToDraft(workflowId) {
    const wf = (await db.execute({ sql: "SELECT * FROM claim_workflow WHERE id=?", args: [workflowId] })).rows[0];
    const invalidatedWorkflowPaths = [wf.claim_letter_pdf_path, wf.summary_pdf_path, wf.receipt_pdf_path].filter(Boolean);
    const subs = (await db.execute({ sql: "SELECT * FROM claim_submission WHERE claim_workflow_id=?", args: [workflowId] })).rows;
    const invalidatedSubmissionPaths = [];
    for (const s of subs) {
        for (const p of [s.claim_letter_pdf_path, s.summary_pdf_path, s.receipt_pdf_path]) {
            if (p) invalidatedSubmissionPaths.push(String(p));
        }
    }
    await db.execute({
        sql: `UPDATE claim_workflow SET status='Draft',
              claim_letter_pdf_path=NULL, claim_letter_generated_at=NULL, claim_letter_generated_by=NULL,
              summary_pdf_path=NULL, summary_generated_at=NULL, summary_generated_by=NULL,
              receipt_pdf_path=NULL, receipt_generated_at=NULL, receipt_generated_by=NULL,
              updated_at=? WHERE id=?`,
        args: [Date.now(), workflowId],
    });
    await db.execute({
        sql: `UPDATE claim_submission SET
              claim_letter_pdf_path=NULL, claim_letter_generated_at=NULL, claim_letter_generated_by=NULL,
              summary_pdf_path=NULL, summary_generated_at=NULL, summary_generated_by=NULL,
              receipt_pdf_path=NULL, receipt_generated_at=NULL, receipt_generated_by=NULL,
              updated_at=? WHERE claim_workflow_id=?`,
        args: [Date.now(), workflowId],
    });
    for (const p of [...invalidatedWorkflowPaths, ...invalidatedSubmissionPaths]) {
        if (p && isPathInsideClaimDocumentRoot(String(p))) {
            try { unlinkSync(String(p)); } catch {}
        }
    }
    return { invalidatedWorkflowPaths, invalidatedSubmissionPaths };
}

// ============================================================================
// SECTION 6 — main test
// ============================================================================
const cleanupActions = [];
async function main() {
    console.log("\n=== R7c Documents per Submission — Integration Test ===\n");

    // ---------------- Tests 1-4: single-submission legacy generate ----------------
    console.log("\n--- Test 1-4: Single-submission legacy workflow flow ---");
    const wf1 = await insertWorkflow("SINGLE");
    cleanupActions.push(() => db.execute({ sql: "DELETE FROM claim_workflow WHERE id=?", args: [wf1.id] }));
    const sub1 = await insertSubmission(wf1.id, "per_pengajuan", "Pengajuan utama", "CLM-R7C-SINGLE-001", 1000000);
    cleanupActions.push(() => db.execute({ sql: "DELETE FROM claim_submission WHERE id=?", args: [sub1] }));
    await insertItem(wf1.id, sub1, "A", 1000000);
    cleanupActions.push(() => db.execute({ sql: "DELETE FROM claim_workflow_item WHERE claim_workflow_id=?", args: [wf1.id] }));

    // Legacy generate Letter / Summary / Kwitansi
    for (const type of ["letter", "summary", "receipt"]) {
        const result = await legacyGenerateDocument(wf1.id, type);
        assertTrue("1+", `Legacy generate ${type} OK`, result.ok, JSON.stringify(result));
        if (result.ok) {
            cleanupActions.push(() => { try { unlinkSync(result.filePath); } catch {} });
            // Test 3: file exists & openable (size > 0, has %PDF header)
            const exists = existsSync(result.filePath);
            assertTrue("3", `${type} file exists at ${result.filePath.split(sep).slice(-2).join("/")}`, exists);
            if (exists) {
                const buf = readFileSync(result.filePath);
                assertTrue("3", `${type} file has valid PDF header`, buf.slice(0, 4).toString() === "%PDF");
                // Test 3 strong: konten valid, marker item terbaca.
                const markers = readPdfMarkers(result.filePath);
                assertTrue("3", `${type} file readable + contains item marker`,
                    markers !== null && markers.includes("NO-SURAT-A"));
            }
            // Test 4: mirror to submission
            const subRow = (await db.execute({ sql: "SELECT * FROM claim_submission WHERE id=?", args: [sub1] })).rows[0];
            const colMap = { letter: "claim_letter_pdf_path", summary: "summary_pdf_path", receipt: "receipt_pdf_path" };
            assertEqual("4", `${type} mirrored to single submission`, String(subRow[colMap[type]] || ""), result.filePath);
        }
    }

    // ---------------- Tests 5-10: 2-submission flow ----------------
    console.log("\n--- Test 5-10: Multi-submission generate per submission ---");
    const wf2 = await insertWorkflow("MULTI");
    cleanupActions.push(() => db.execute({ sql: "DELETE FROM claim_workflow WHERE id=?", args: [wf2.id] }));
    const subA = await insertSubmission(wf2.id, "per_program", "Program A", "CLM-R7C-A-001", 500000);
    const subB = await insertSubmission(wf2.id, "per_program", "Program B", "CLM-R7C-B-002", 700000);
    cleanupActions.push(() => db.execute({ sql: "DELETE FROM claim_submission WHERE claim_workflow_id=?", args: [wf2.id] }));
    const itemA = await insertItem(wf2.id, subA, "A", 500000);
    const itemB = await insertItem(wf2.id, subB, "B", 700000);
    cleanupActions.push(() => db.execute({ sql: "DELETE FROM claim_workflow_item WHERE claim_workflow_id=?", args: [wf2.id] }));

    // Recalc submission totals from items so totalClaim > 0
    for (const sId of [subA, subB]) {
        const sumRes = await db.execute({
            sql: `SELECT COALESCE(SUM(dpp),0) AS dpp, COALESCE(SUM(ppn_amount),0) AS ppn,
                   COALESCE(SUM(pph_amount),0) AS pph, COALESCE(SUM(nilai_klaim),0) AS nk
                  FROM claim_workflow_item WHERE claim_submission_id=?`,
            args: [sId],
        });
        const r = sumRes.rows[0];
        await db.execute({
            sql: `UPDATE claim_submission SET total_dpp=?, total_ppn=?, total_pph=?, total_claim=?, remaining_amount=?, updated_at=? WHERE id=?`,
            args: [Number(r.dpp), Number(r.ppn), Number(r.pph), Number(r.nk), Number(r.nk), Date.now(), sId],
        });
    }

    const generatedFilesA = {};
    const generatedFilesB = {};
    for (const type of ["letter", "summary", "receipt"]) {
        const ra = await submissionGenerateDocument(wf2.id, subA, type);
        assertTrue("8", `Submission A generate ${type} OK`, ra.ok, JSON.stringify(ra));
        if (ra.ok) {
            generatedFilesA[type] = ra.filePath;
            cleanupActions.push(() => { try { unlinkSync(ra.filePath); } catch {} });
            // Test 6 strong: items returned by submissionGenerate must be only itemA.
            assertEqual("6", `Submission A ${type} contains exactly 1 item`, ra.itemCount, 1);
            assertTrue("6", `Submission A ${type} item is itemA`, ra.items.includes(itemA));
            // Test 6 strong: konten file PDF benar-benar HANYA berisi marker
            // item A (NO-SURAT-A), TIDAK berisi marker item B.
            const markersA = readPdfMarkers(ra.filePath);
            assertTrue("6", `Submission A ${type} file contains NO-SURAT-A`,
                markersA !== null && markersA.includes("NO-SURAT-A"));
            assertTrue("6", `Submission A ${type} file does NOT contain NO-SURAT-B`,
                markersA !== null && !markersA.includes("NO-SURAT-B"));
            // Path must include subA folder
            assertTrue("10", `Submission A ${type} path contains submissions/${subA}`,
                ra.filePath.includes(join("submissions", sanitizeIdSegment(subA), type)));
        }
        const rb = await submissionGenerateDocument(wf2.id, subB, type);
        assertTrue("9", `Submission B generate ${type} OK`, rb.ok, JSON.stringify(rb));
        if (rb.ok) {
            generatedFilesB[type] = rb.filePath;
            cleanupActions.push(() => { try { unlinkSync(rb.filePath); } catch {} });
            assertEqual("7", `Submission B ${type} contains exactly 1 item`, rb.itemCount, 1);
            assertTrue("7", `Submission B ${type} item is itemB`, rb.items.includes(itemB));
            // Test 7 strong: konten file PDF benar-benar HANYA berisi marker
            // item B (NO-SURAT-B), TIDAK berisi marker item A.
            const markersB = readPdfMarkers(rb.filePath);
            assertTrue("7", `Submission B ${type} file contains NO-SURAT-B`,
                markersB !== null && markersB.includes("NO-SURAT-B"));
            assertTrue("7", `Submission B ${type} file does NOT contain NO-SURAT-A`,
                markersB !== null && !markersB.includes("NO-SURAT-A"));
            assertTrue("10", `Submission B ${type} path contains submissions/${subB}`,
                rb.filePath.includes(join("submissions", sanitizeIdSegment(subB), type)));
        }
        // Test 10 strong: paths A and B differ
        assertTrue("10", `${type} path A != path B`, ra.ok && rb.ok && ra.filePath !== rb.filePath);
    }

    // Test multi-submission DOES NOT mirror to workflow cache
    const wf2Row = (await db.execute({ sql: "SELECT * FROM claim_workflow WHERE id=?", args: [wf2.id] })).rows[0];
    assertTrue("10", "Multi-submission generate did not mirror Letter to workflow cache",
        !wf2Row.claim_letter_pdf_path);
    assertTrue("10", "Multi-submission generate did not mirror Summary to workflow cache",
        !wf2Row.summary_pdf_path);
    assertTrue("10", "Multi-submission generate did not mirror Receipt to workflow cache",
        !wf2Row.receipt_pdf_path);

    // ---------------- Tests 11-12: legacy route on multi-submission must reject ----------------
    console.log("\n--- Test 11-12: Legacy route on multi-submission rejected ---");
    for (const type of ["letter", "summary", "receipt"]) {
        const result = await legacyGenerateDocument(wf2.id, type);
        assertEqual("12", `Legacy ${type} on multi rejected with status 409`, result.status, 409);
        const expectedCode = `MULTI_SUBMISSION_${type.toUpperCase()}_ROUTE_DISABLED`;
        assertEqual("12", `Legacy ${type} on multi returns expected code`, result.code, expectedCode);
        // Pastikan tidak diam-diam menulis cache workflow
        const wf2After = (await db.execute({ sql: "SELECT * FROM claim_workflow WHERE id=?", args: [wf2.id] })).rows[0];
        const colMap = { letter: "claim_letter_pdf_path", summary: "summary_pdf_path", receipt: "receipt_pdf_path" };
        assertTrue("12", `Workflow cache ${type} still NULL after rejected legacy call`,
            !wf2After[colMap[type]]);
    }

    // ---------------- Tests 13-15: return_to_draft invalidation ----------------
    console.log("\n--- Test 13-15: return_to_draft invalidates all PDFs ---");
    // Verify files exist before reset
    for (const f of [...Object.values(generatedFilesA), ...Object.values(generatedFilesB)]) {
        assertTrue("13", `Pre-return file exists ${f.split(sep).slice(-3).join("/")}`, existsSync(f));
    }
    const ret = await returnToDraft(wf2.id);
    // After: workflow cache + submission columns NULL
    const wf2After = (await db.execute({ sql: "SELECT * FROM claim_workflow WHERE id=?", args: [wf2.id] })).rows[0];
    assertTrue("14", "Workflow status reset to Draft", wf2After.status === "Draft");
    assertTrue("14", "Workflow Letter path NULL", !wf2After.claim_letter_pdf_path);
    assertTrue("14", "Workflow Summary path NULL", !wf2After.summary_pdf_path);
    assertTrue("14", "Workflow Receipt path NULL", !wf2After.receipt_pdf_path);
    const subsAfter = (await db.execute({ sql: "SELECT * FROM claim_submission WHERE claim_workflow_id=?", args: [wf2.id] })).rows;
    for (const s of subsAfter) {
        assertTrue("14", `Submission ${String(s.id).slice(-8)} Letter NULL`, !s.claim_letter_pdf_path);
        assertTrue("14", `Submission ${String(s.id).slice(-8)} Summary NULL`, !s.summary_pdf_path);
        assertTrue("14", `Submission ${String(s.id).slice(-8)} Receipt NULL`, !s.receipt_pdf_path);
    }
    // Test 15: previous file paths no longer reachable on disk (best-effort unlink already executed)
    for (const p of ret.invalidatedSubmissionPaths) {
        assertTrue("15", `File at ${p.split(sep).slice(-3).join("/")} unlinked`, !existsSync(p));
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
        console.error("\n[r7c-test] UNCAUGHT:", err);
        exitCode = 2;
    } finally {
        // Cleanup in reverse order. Best-effort.
        console.log("\n--- Cleanup ---");
        for (const action of cleanupActions.reverse()) {
            try { await action(); } catch (e) { console.warn("cleanup failed:", e?.message); }
        }
        // Hapus row r7c test demo (defensif).
        try {
            await db.execute(`DELETE FROM claim_workflow_item WHERE claim_workflow_id IN (SELECT id FROM claim_workflow WHERE claim_workflow_no LIKE '${TEST_PREFIX}-%')`);
            await db.execute(`DELETE FROM claim_submission WHERE claim_workflow_id IN (SELECT id FROM claim_workflow WHERE claim_workflow_no LIKE '${TEST_PREFIX}-%')`);
            await db.execute(`DELETE FROM claim_audit_log WHERE claim_workflow_id IN (SELECT id FROM claim_workflow WHERE claim_workflow_no LIKE '${TEST_PREFIX}-%')`);
            await db.execute(`DELETE FROM claim_workflow WHERE claim_workflow_no LIKE '${TEST_PREFIX}-%'`);
            console.log("Cleanup demo rows OK.");
        } catch (e) { console.warn("Defensive cleanup failed:", e?.message); }
        process.exit(exitCode);
    }
})();
