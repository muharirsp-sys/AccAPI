// Temporary script for E2E data flow simulation
import { createClient } from "@libsql/client";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

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
const db = createClient({ url: databaseUrl });

console.log("=".repeat(80));
console.log("E2E DATA FLOW SIMULATION - OFF Program Control to Claim Workflow");
console.log("=".repeat(80));

// PART 1: OVERVIEW
console.log("\n## PART 1: SYSTEM OVERVIEW\n");

const offBatches = await db.execute("SELECT COUNT(*) as total FROM off_batch");
const offBatchFree = await db.execute("SELECT COUNT(*) as total FROM off_batch WHERE id NOT IN (SELECT off_batch_id FROM claim_workflow)");
const claimWorkflows = await db.execute("SELECT COUNT(*) as total FROM claim_workflow");
const singleSub = await db.execute(`
  SELECT COUNT(*) as total 
  FROM claim_workflow cw
  WHERE (SELECT COUNT(*) FROM claim_submission cs WHERE cs.claim_workflow_id = cw.id) = 1
`);
const multiSub = await db.execute(`
  SELECT COUNT(*) as total 
  FROM claim_workflow cw
  WHERE (SELECT COUNT(*) FROM claim_submission cs WHERE cs.claim_workflow_id = cw.id) > 1
`);

console.log(`Total OFF Batch: ${offBatches.rows[0].total}`);
console.log(`  - Free (no Claim): ${offBatchFree.rows[0].total}`);
console.log(`  - Has Claim: ${offBatches.rows[0].total - offBatchFree.rows[0].total}`);
console.log(`Total Claim Workflow: ${claimWorkflows.rows[0].total}`);
console.log(`  - Single Submission: ${singleSub.rows[0].total}`);
console.log(`  - Multi Submission: ${multiSub.rows[0].total}`);

// PART 2: OFF Program Control FLOW
console.log("\n## PART 2: OFF PROGRAM CONTROL FLOW\n");

console.log("### Status Chain:");
const offFlow = await db.execute(`
  SELECT 
    status,
    sm_status,
    claim_status,
    om_status,
    finance_status,
    final_status,
    COUNT(*) as count
  FROM off_batch 
  GROUP BY status, sm_status, claim_status, om_status, finance_status, final_status
  ORDER BY count DESC
  LIMIT 15
`);
console.table(offFlow.rows);

console.log("\n### Sample OFF Batch Flow (BASE-OFF-001-RB):");
const sampOff = await db.execute(`
  SELECT 
    id,
    no_pengajuan,
    status,
    sm_status,
    claim_status,
    om_status,
    finance_status,
    final_status,
    locked,
    principle_name,
    total_nominal
  FROM off_batch 
  WHERE no_pengajuan = 'BASE-OFF-001-RB'
`);
console.table(sampOff.rows);

console.log("\n### OFF Items for Sample Batch:");
const sampItems = await db.execute(`
  SELECT 
    item_no,
    no_surat,
    nama_program,
    nominal,
    no_claim
  FROM off_batch_item 
  WHERE batch_id = (SELECT id FROM off_batch WHERE no_pengajuan = 'BASE-OFF-001-RB')
  ORDER BY item_no
`);
console.table(sampItems.rows);

console.log("\n### OFF Audit Trail (Sample Batch - last 10 actions):");
const offAudit = await db.execute(`
  SELECT 
    actor_role,
    action,
    from_status,
    to_status,
    created_at
  FROM off_audit_log 
  WHERE batch_id = (SELECT id FROM off_batch WHERE no_pengajuan = 'BASE-OFF-001-RB')
  ORDER BY created_at DESC
  LIMIT 10
`);
console.table(offAudit.rows);

// PART 3: CREATE CLAIM WORKFLOW FLOW
console.log("\n## PART 3: CREATE CLAIM WORKFLOW FROM OFF\n");

console.log("### Sample Claim Workflow (BASE-CLAIM-037-RB - Multi-Submission):");
const sampCw = await db.execute(`
  SELECT 
    id,
    claim_workflow_no,
    off_batch_id,
    principle_name,
    status,
    aggregate_status,
    total_dpp, total_ppn, total_pph, total_claim,
    total_paid, remaining_amount,
    source_type, source_ref_id
  FROM claim_workflow 
  WHERE claim_workflow_no = 'BASE-CLAIM-037-RB'
`);
console.table(sampCw.rows);

console.log("\n### Claim Submissions for BASE-CLAIM-037-RB:");
const sampSubs = await db.execute(`
  SELECT 
    id,
    no_claim,
    scope,
    scope_label,
    status,
    total_dpp, total_ppn, total_pph, total_claim,
    total_paid, remaining_amount,
    claim_letter_pdf_path,
    summary_pdf_path,
    receipt_pdf_path,
    created_at
  FROM claim_submission 
  WHERE claim_workflow_id = (SELECT id FROM claim_workflow WHERE claim_workflow_no = 'BASE-CLAIM-037-RB')
  ORDER BY created_at
`);
console.table(sampSubs.rows);

console.log("\n### Claim Items Distribution per Submission (BASE-CLAIM-037-RB):");
const sampItemDist = await db.execute(`
  SELECT 
    cs.scope, cs.scope_label, cs.no_claim,
    COUNT(cwi.id) as item_count,
    SUM(cwi.dpp) as total_dpp,
    SUM(cwi.nilai_klaim) as total_claim
  FROM claim_submission cs
  LEFT JOIN claim_workflow_item cwi ON cwi.claim_submission_id = cs.id
  WHERE cs.claim_workflow_id = (SELECT id FROM claim_workflow WHERE claim_workflow_no = 'BASE-CLAIM-037-RB')
  GROUP BY cs.id
`);
console.table(sampItemDist.rows);

console.log("\n### Sample Claim Items Detail (BASE-CLAIM-037-RB - first submission):");
const firstSubId = sampSubs.rows[0].id;
const sampItems2 = await db.execute(`
  SELECT 
    cwi.no_surat,
    cwi.jenis_promosi,
    cwi.periode,
    cwi.outlet,
    cwi.dpp,
    cwi.ppn_rate, cwi.ppn_amount,
    cwi.pph_rate, cwi.pph_amount,
    cwi.nilai_klaim,
    cwi.status
  FROM claim_workflow_item cwi
  WHERE cwi.claim_submission_id = ?
  ORDER BY cwi.no_surat
`, [firstSubId]);
console.table(sampItems2.rows);

// PART 4: DOCUMENTS FLOW
console.log("\n## PART 4: DOCUMENT GENERATION FLOW\n");

const docStats = await db.execute(`
  SELECT 
    SUM(CASE WHEN claim_letter_pdf_path IS NOT NULL THEN 1 ELSE 0 END) as submission_with_letter,
    SUM(CASE WHEN summary_pdf_path IS NOT NULL THEN 1 ELSE 0 END) as submission_with_summary,
    SUM(CASE WHEN receipt_pdf_path IS NOT NULL THEN 1 ELSE 0 END) as submission_with_receipt,
    COUNT(*) as total_submissions
  FROM claim_submission
  WHERE (total_claim > 0 OR (SELECT COUNT(*) FROM claim_workflow_item cwi WHERE cwi.claim_submission_id = claim_submission.id) > 0)
`);
console.log("Active Submissions Dokumentasi:");
console.table(docStats.rows);

console.log("\n### Sample Document Paths (BASE-CLAIM-037-RB):");
const sampDocs = await db.execute(`
  SELECT 
    scope_label,
    no_claim,
    claim_letter_pdf_path,
    summary_pdf_path,
    receipt_pdf_path,
    CASE 
      WHEN claim_letter_pdf_path IS NOT NULL THEN '✓' ELSE '✗'
    END as letter,
    CASE 
      WHEN summary_pdf_path IS NOT NULL THEN '✓' ELSE '✗'
    END as summary,
    CASE 
      WHEN receipt_pdf_path IS NOT NULL THEN '✓' ELSE '✗'
    END as receipt,
    CASE 
      WHEN claim_letter_pdf_path IS NOT NULL 
        AND summary_pdf_path IS NOT NULL 
        AND receipt_pdf_path IS NOT NULL THEN 'COMPLETE'
      ELSE 'INCOMPLETE'
    END as status_dokumen
  FROM claim_submission
  WHERE claim_workflow_id = (SELECT id FROM claim_workflow WHERE claim_workflow_no = 'BASE-CLAIM-037-RB')
`);
console.table(sampDocs.rows);

// PART 5: PAYMENT FLOW
console.log("\n## PART 5: PAYMENT FLOW\n");

const payStats = await db.execute(`
  SELECT 
    SUM(CASE WHEN cp.voided_at IS NULL THEN 1 ELSE 0 END) as active_payments,
    SUM(CASE WHEN cp.voided_at IS NOT NULL THEN 1 ELSE 0 END) as voided_payments,
    COALESCE(SUM(CASE WHEN cp.voided_at IS NULL THEN cp.payment_amount ELSE 0 END), 0) as total_active_paid,
    COUNT(*) as total_payment_records
  FROM claim_payment cp
  INNER JOIN claim_submission cs ON cs.id = cp.claim_submission_id
  INNER JOIN claim_workflow cw ON cw.id = cs.claim_workflow_id
  WHERE cw.claim_workflow_no = 'BASE-CLAIM-041-RB'
`);
console.log("Payment Stats for BASE-CLAIM-041-RB (Partially Paid):");
console.table(payStats.rows);

console.log("\n### Payment Detail (BASE-CLAIM-041-RB):");
const payDetail = await db.execute(`
  SELECT 
    cs.scope_label,
    cs.no_claim,
    cp.payment_date,
    cp.payment_amount,
    cp.payment_type,
    cp.voided_at,
    cp.payment_note
  FROM claim_payment cp
  INNER JOIN claim_submission cs ON cs.id = cp.claim_submission_id
  INNER JOIN claim_workflow cw ON cw.id = cs.claim_workflow_id
  WHERE cw.claim_workflow_no = 'BASE-CLAIM-041-RB'
  ORDER BY cp.payment_date
`);
console.table(payDetail.rows);

console.log("\n### Payment Recalc Verification:");
const payRecalc = await db.execute(`
  SELECT 
    cs.scope_label,
    cs.no_claim,
    cs.total_claim as submission_total_claim,
    cs.total_paid as submission_cached_paid,
    cs.remaining_amount as submission_cached_remaining,
    COALESCE(SUM(CASE WHEN cp.voided_at IS NULL THEN cp.payment_amount ELSE 0 END), 0) as actual_total_paid,
    cs.total_claim - COALESCE(SUM(CASE WHEN cp.voided_at IS NULL THEN cp.payment_amount ELSE 0 END), 0) as expected_remaining,
    CASE 
      WHEN cs.remaining_amount = cs.total_claim - COALESCE(SUM(CASE WHEN cp.voided_at IS NULL THEN cp.payment_amount ELSE 0 END), 0) THEN '✓' 
      ELSE '✗ MISMATCH'
    END as recalc_status
  FROM claim_submission cs
  LEFT JOIN claim_payment cp ON cp.claim_submission_id = cs.id
  WHERE cs.claim_workflow_id = (SELECT id FROM claim_workflow WHERE claim_workflow_no = 'BASE-CLAIM-041-RB')
  GROUP BY cs.id
`);
console.table(payRecalc.rows);

// PART 6: CLOSE FLOW
console.log("\n## PART 6: CLOSE FLOW\n");

console.log("### Sample CLOSED Claim Workflow:");
const sampClosed = await db.execute(`
  SELECT 
    cw.claim_workflow_no,
    cw.status,
    cw.aggregate_status,
    cw.closed_at,
    cw.closed_by,
    cw.close_note
  FROM claim_workflow cw
  WHERE cw.status = 'Closed'
  LIMIT 3
`);
console.table(sampClosed.rows);

console.log("\n### Closed Submission Detail:");
const smpClosedCw = await db.execute(`
  SELECT id FROM claim_workflow WHERE status = 'Closed' LIMIT 1
`);
if (smpClosedCw.rows.length > 0) {
  const sampClosedSub = await db.execute(`
    SELECT 
      cs.scope_label,
      cs.no_claim,
      cs.status,
      cs.total_claim,
      cs.total_paid,
      cs.remaining_amount,
      cs.closed_at,
      cs.closed_by,
      cs.close_note
    FROM claim_submission cs
    WHERE cs.claim_workflow_id = ?
  `, [smpClosedCw.rows[0].id]);
  console.table(sampClosedSub.rows);
}

// PART 7: DATA CONSISTENCY CHECKS
console.log("\n## PART 7: DATA CONSISTENCY CHECKS\n");

console.log("### Aggregate Recalc Verification (All Multi-Submission Workflows):");
const aggCheck = await db.execute(`
  SELECT 
    cw.claim_workflow_no,
    cw.status as workflow_status,
    cw.total_claim as workflow_cached_total,
    SUM(cs.total_claim) as submissions_total_claim,
    CASE 
      WHEN cw.total_claim = SUM(cs.total_claim) THEN '✓'
      ELSE '✗ MISMATCH'
    END as total_match,
    SUM(CASE WHEN (cs.total_claim > 0 OR (SELECT COUNT(*) FROM claim_workflow_item cwi WHERE cwi.claim_submission_id = cs.id) > 0) THEN 1 ELSE 0 END) as active_submissions,
    COUNT(cs.id) as total_submissions_in_db
  FROM claim_workflow cw
  INNER JOIN claim_submission cs ON cs.claim_workflow_id = cw.id
  WHERE (SELECT COUNT(*) FROM claim_submission cs2 WHERE cs2.claim_workflow_id = cw.id) > 1
  GROUP BY cw.id
`);
console.table(aggCheck.rows);

console.log("\n### Default Submission Empty Count:");
const defEmpty = await db.execute(`
  SELECT 
    cs.scope, cs.scope_label,
    cs.total_claim,
    (SELECT COUNT(*) FROM claim_workflow_item cwi WHERE cwi.claim_submission_id = cs.id) as item_count,
    cw.claim_workflow_no,
    CASE 
      WHEN cs.total_claim = 0 
        AND (SELECT COUNT(*) FROM claim_workflow_item cwi WHERE cwi.claim_submission_id = cs.id) = 0 THEN 'EMPTY DEFAULT'
      ELSE 'HAS DATA'
    END as type
  FROM claim_submission cs
  INNER JOIN claim_workflow cw ON cw.id = cs.claim_workflow_id
  WHERE cs.scope = 'per_pengajuan'
  AND cs.total_claim = 0
  LIMIT 10
`);
console.table(defEmpty.rows);

console.log("\n### OFF <-> Claim No Claim Sync Verification:");
const noClaimSync = await db.execute(`
  SELECT 
    cw.claim_workflow_no,
    cw.no_claim as workflow_no_claim,
    cs.id as submission_id,
    cs.no_claim as submission_no_claim,
    (SELECT COUNT(*) FROM claim_workflow_item cwi WHERE cwi.claim_submission_id = cs.id) as item_count,
    (SELECT COUNT(*) 
     FROM off_batch_item obi
     INNER JOIN claim_workflow_item cwi ON cwi.off_batch_item_id = obi.id
     WHERE cwi.claim_submission_id = cs.id
       AND obi.no_claim != cs.no_claim
    ) as sync_mismatch_count,
    CASE 
      WHEN (SELECT COUNT(*) 
            FROM off_batch_item obi
            INNER JOIN claim_workflow_item cwi ON cwi.off_batch_item_id = obi.id
            WHERE cwi.claim_submission_id = cs.id
              AND obi.no_claim != cs.no_claim) = 0 THEN '✓'
      WHEN (SELECT COUNT(*) 
            FROM off_batch_item obi
            INNER JOIN claim_workflow_item cwi ON cwi.off_batch_item_id = obi.id
            WHERE cwi.claim_submission_id = cs.id
              AND obi.no_claim IS NULL) > 0 THEN 'OFF not synced'
      ELSE '✗ MISMATCH'
    END as sync_status
  FROM claim_submission cs
  INNER JOIN claim_workflow cw ON cw.id = cs.claim_workflow_id
  WHERE cs.no_claim IS NOT NULL
    AND cs.no_claim != ''
    AND cs.total_claim > 0
  LIMIT 10
`);
console.table(noClaimSync.rows);

// PART 8: RBAC MATRIX VERIFICATION
console.log("\n## PART 8: ROLE CAPABILITY MATRIX (via seeded data)\n");

const users = await db.execute("SELECT name, email, role, permissions FROM user ORDER BY role");
console.table(users.rows);

console.log("\n### Claim Workflows by Role Access Simulation:");
console.log("- admin: can create, edit tax, generate docs, submit, pay, close");
console.log("- claim: same as admin");
console.log("- staff: can view only, cannot mutate (backend enforces 403)");

// PART 9: FLOW SIMULATION TRACE
console.log("\n## PART 9: END-TO-END FLOW SIMULATION (TRACE ONLY)\n");

console.log(`
SIMULATED FLOW (based on code + seeded data):

1. OFF CREATE
   - Supervisor: POST /api/off-program-control/batches
   - Creates: off_batch + off_batch_item
   - Audit: 'create_batch'
   - Status: Draft

2. OFF SUBMIT
   - Supervisor: POST /api/off-program-control/batches/{id}/submit
   - Updates: off_batch.status = Submitted to SM
   - Audit: 'submit_batch'

3. OFF SM APPROVE
   - Sales Manager: POST /api/off-program-control/batches/{id}/sm-approve
   - Updates: off_batch.status = Approved by SM, locked = true
   - Audit: 'sm_approve'

4. OFF CLAIM REVIEW
   - Claim: POST /api/off-program-control/batches/{id}/claim-review
   - Updates: off_batch.claim_status = Approved
   - Audit: 'claim_review'

5. OFF OM APPROVE (GATE untuk Claim Workflow)
   - OM: POST /api/off-program-control/batches/{id}/om-approve
   - Updates: off_batch.om_status = Approved, finance_status = Waiting Payment
   - Audit: 'om_approve'

6. CREATE CLAIM WORKFLOW FROM OFF
   - Admin/Claim: POST /api/claim-workflow/from-off-batch/{offBatchId}
   - Gate: off_batch.om_status = Approved
   - Creates:
     * claim_workflow (status=Draft, total=0)
     * claim_submission (1 default, scope=per_pengajuan)
     * claim_workflow_item[] (from off_batch_item)
   - Audit: 'create_from_off'

7. SIAPKAN BARIS CLAIM (Excel-Style)
   - Admin/Claim: POST /api/claim-workflow/{id}/submissions/from-items
   - Gate: workflow status Draft/Need Revision, role admin/claim
   - Creates:
     * N claim_submission (scope=per_item)
     * Relocates claim_workflow_item to new submissions
   - Audit: 'claim_submissions_created_per_item'

8. GENERATE NO CLAIM PER ROW
   - Via UI: Excel-style generator {NoUrut}/{Distributor}-{Principal}/{MM}/{YYYY}
   - Admin/Claim: PATCH /api/claim-workflow/{id}/submissions/{submissionId}
   - Sync ke off_batch_item.no_claim dari items di submission ini
   - Audit: 'no_claim_assigned' + 'no_claim_synced_to_off'

9. EDIT DPP/PPN/PPH
   - Admin/Claim: PATCH /api/claim-workflow/{id}/items/{itemId}
   - Gate: workflow Draft/Need Revision
   - Recalc: submission totals, workflow aggregates
   - Audit: 'update_item_tax'

10. GENERATE DOCUMENTS PER SUBMISSION
    - Admin/Claim: POST /api/claim-workflow/{id}/submissions/{submissionId}/{claim-letter|summary|receipt}
    - Gate: submission.no_claim + submission.total_claim > 0
    - Creates: PDF di runtime/claim-workflow/{workflowId}/submissions/{submissionId}/{type}/
    - Updates: claim_submission.{type}PdfPath
    - Audit: 'claim_letter_generated'/'claim_summary_generated'/'claim_receipt_generated'

11. MARK READY (FIX BARU - R7-aware)
    - Admin/Claim: POST /api/claim-workflow/{id}/status {action: 'mark_ready'}
    - Gate:
      * items.length > 0
      * total_claim > 0
      * setiap item DPP > 0, nilai_claim > 0
      * ACTIVE submissions > 0
      * semua ACTIVE submissions punya: no_claim, 3 PDF paths
      * DEFAULT submission KOSONG diabaikan
    - Updates: claim_workflow.status = Ready to Submit
    - Audit: 'mark_ready'

12. SUBMIT TO PRINCIPAL
    - Admin/Claim: POST /api/claim-workflow/{id}/status {action: 'submit_to_principal'}
    - Updates: claim_workflow.status = Submitted to Principal, submittedToPrincipalAt
    - Audit: 'submit_to_principal'

13. PAYMENT PER SUBMISSION
    - Admin/Claim: POST /api/claim-workflow/{id}/submissions/{submissionId}/payments
    - Gate: status Submitted to Principal/Partially Paid, amount <= remainingAmount
    - Creates: claim_payment
    - Auto-derives: submission.status = Submitted/Partially Paid/Paid
    - Recalc: submission totals, workflow aggregates
    - Audit: 'payment_created'

14. CLOSE PER SUBMISSION
    - Admin/Claim: POST /api/claim-workflow/{id}/submissions/{submissionId}/close
    - Gate: submission.status = Paid, documents lengkap, remainingAmount = 0
    - Updates: claim_submission.status = Closed
    - Auto-derives: workflow.aggregate_status (Closed bila semua Closed, else previous)
    - Audit: 'claim_closed'

15. RETURN TO DRAFT (jika perlu revisi)
    - Admin/Claim: POST /api/claim-workflow/{id}/status {action: 'return_to_draft', note: "..."}
    - Gate: status Ready to Submit, note non-empty
    - Updates: workflow.status = Draft
    - Invalidates: workflow PDFs + semua submission PDFs
    - Unlinks: runtime PDF files
    - Audit: 'return_to_draft'
`);

// PART 10: ISSUE / OBSERVATIONS
console.log("## PART 10: POTENTIAL ISSUES DETECTED\n");

// Check if there are multi-submission workflows that could NOT have Mark Ready pass (legacy bug)
const multiSubReadyCheck = await db.execute(`
  SELECT 
    cw.claim_workflow_no,
    cw.status,
    cw.no_claim as workflow_legacy_no_claim,
    cw.claim_letter_pdf_path as workflow_legacy_letter,
    (SELECT COUNT(*) FROM claim_submission cs 
     WHERE cs.claim_workflow_id = cw.id 
       AND (cs.total_claim > 0 OR (SELECT COUNT(*) FROM claim_workflow_item cwi WHERE cwi.claim_submission_id = cs.id) > 0)
    ) as active_submissions,
    (SELECT COUNT(*) FROM claim_submission cs 
     WHERE cs.claim_workflow_id = cw.id 
       AND cs.no_claim IS NOT NULL 
       AND cs.total_claim > 0
       AND cs.claim_letter_pdf_path IS NOT NULL
       AND cs.summary_pdf_path IS NOT NULL
       AND cs.receipt_pdf_path IS NOT NULL
    ) as fully_ready_submissions
  FROM claim_workflow cw
  WHERE (SELECT COUNT(*) FROM claim_submission cs WHERE cs.claim_workflow_id = cw.id) > 1
    AND cw.status = 'Draft'
`);
console.log("### Multi-Submission Workflows in DRAFT (Mark Ready test candidates):");
console.table(multiSubReadyCheck.rows);

console.log("\n### Observation Summary:");
console.log("- Multi-submission workflows in Draft status have workflow-level legacy fields (no_claim, PDF paths) which may be NULL");
console.log("- After fix (commits fecaad6, 68da8cb, 234fe3c, 5851fe6):");
console.log("  ✓ Helper isActiveSubmission() filters empty defaults");
console.log("  ✓ Mark Ready gate now loops per active submission");
console.log("  ✓ GET detail count uses active submissions only");
console.log("  ✓ RBAC UI flag isReadOnly added for staff");
console.log("");
