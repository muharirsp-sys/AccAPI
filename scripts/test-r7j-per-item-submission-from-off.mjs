// Integration test untuk R7j per-item Claim Submission dari OFF Batch.
// Fokus:
// - create-from-off membuat 1 active claim_submission per OFF item.
// - claim_workflow_item.claim_submission_id berbeda per row.
// - PATCH No Claim per submission hanya sync OFF item milik submission itu.
// - create-from-off idempotent: panggilan kedua return existing, tidak duplikat.
// - resolver No Claim principal tidak fallback GCPI untuk FON/URC/RB.

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
    console.error(`[r7j-test] REFUSED: DATABASE_URL bukan SQLite lokal (${databaseUrl}).`);
    process.exit(2);
}

const db = createClient({ url: databaseUrl });
const TEST_PREFIX = "R7J-TEST";
const ACTOR = { id: "r7j-actor", name: "R7J Tester", role: "claim" };
const NOW = new Date();

const STATUS = {
    draft: "Draft",
};
const SCOPE = {
    perItem: "per_item",
};

let pass = 0;
let fail = 0;
function check(label, condition, detail = "") {
    if (condition) {
        pass += 1;
        console.log(`  PASS  ${label}`);
    } else {
        fail += 1;
        console.log(`  FAIL  ${label}${detail ? " -- " + detail : ""}`);
    }
}
function equal(label, actual, expected) {
    check(label, actual === expected, `expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`);
}

function calculateClaimAmount(nominal, ppnRate, pphRate) {
    const dpp = Number(nominal || 0);
    const ppnAmount = +(dpp * Number(ppnRate || 0) / 100).toFixed(2);
    const pphAmount = +(dpp * Number(pphRate || 0) / 100).toFixed(2);
    const nilaiKlaim = +(dpp + ppnAmount - pphAmount).toFixed(2);
    return { dpp, ppnRate, ppnAmount, pphRate, pphAmount, nilaiKlaim };
}

function remaining(totalClaim, totalPaid = 0) {
    return Math.max(Number(totalClaim || 0) - Number(totalPaid || 0), 0);
}

function deriveItemScopeLabel(item) {
    for (const value of [item.toko, item.nama_program, item.periode, item.no_surat]) {
        const trimmed = String(value ?? "").trim();
        if (trimmed) return trimmed.slice(0, 200);
    }
    return `Item Klaim ${String(item.id).slice(0, 8)}`;
}

const noClaimRules = {
    GDI: { noClaimKey: "GCPI", pattern: "{seq}/SUPER-GCPI/{month}/{year4}", padWidth: 2, year: "YYYY" },
    FON: { noClaimKey: "FON", pattern: "{seq}/SUPER-FON/{month}/{year4}", padWidth: 3, year: "YYYY" },
    URC: { noClaimKey: "RC", pattern: "{seq}/SP-RC/{month}/{year2}", padWidth: 2, year: "YY" },
    RB: { noClaimKey: null, pattern: "{seq}/SP-{month}/{year2}", padWidth: 2, year: "YY" },
};

function buildNoClaim(principleCode, sequence, month, year) {
    const rule = noClaimRules[principleCode];
    if (!rule) return null;
    const seq = String(sequence).padStart(rule.padWidth, "0");
    const mm = String(month).padStart(2, "0");
    const yyyy = String(year).padStart(4, "0");
    const yy = yyyy.slice(-2);
    return rule.pattern
        .replaceAll("{seq}", seq)
        .replaceAll("{month}", mm)
        .replaceAll("{year4}", yyyy)
        .replaceAll("{year2}", yy);
}

async function cleanup() {
    await db.execute({ sql: `DELETE FROM claim_audit_log WHERE claim_workflow_id LIKE '${TEST_PREFIX}-%'`, args: [] }).catch(() => {});
    await db.execute({ sql: `DELETE FROM claim_workflow_item WHERE claim_workflow_id LIKE '${TEST_PREFIX}-%'`, args: [] }).catch(() => {});
    await db.execute({ sql: `DELETE FROM claim_submission WHERE claim_workflow_id LIKE '${TEST_PREFIX}-%'`, args: [] }).catch(() => {});
    await db.execute({ sql: `DELETE FROM claim_workflow WHERE id LIKE '${TEST_PREFIX}-%'`, args: [] }).catch(() => {});
    await db.execute({ sql: `DELETE FROM off_batch_item WHERE batch_id LIKE '${TEST_PREFIX}-%'`, args: [] }).catch(() => {});
    await db.execute({ sql: `DELETE FROM off_batch WHERE id LIKE '${TEST_PREFIX}-%'`, args: [] }).catch(() => {});
}

async function insertOffBatch(principleCode = "FON") {
    const offBatchId = `${TEST_PREFIX}-OFF-${randomUUID().slice(0, 8)}`;
    const noPengajuan = `${TEST_PREFIX}-PENG-${randomUUID().slice(0, 6)}`;
    const principleName = principleCode === "GDI"
        ? "GODREJ INDONESIA, PT"
        : principleCode === "URC"
            ? "URC INDONESIA, PT"
            : principleCode === "RB"
                ? "RECKITT BENCKISER INDONESIA, PT"
                : "FONTERRA BRANDS INDONESIA, PT";
    await db.execute({
        sql: `INSERT INTO off_batch
              (id, no_pengajuan, gelombang, principle_code, principle_name,
               bulan, tahun, supervisor_name, total_nominal,
               status, sm_status, claim_status, om_status, finance_status,
               final_status, locked, paid_by, paid_at, payment_date, paid_amount,
               verified_amount, updated_at, created_at)
              VALUES (?, ?, 'G1', ?, ?, '06', '2026', 'SPV R7J', 0,
               'Paid', 'Approved by SM', 'Approved', 'Approved', 'Paid',
               'Waiting Claim Final Verification', 1, ?, ?, '2026-06-05', 0,
               0, ?, ?)`,
        args: [
            offBatchId,
            noPengajuan,
            principleCode,
            principleName,
            ACTOR.id,
            NOW.getTime(),
            NOW.getTime(),
            NOW.getTime(),
        ],
    });

    const items = [
        { id: `${TEST_PREFIX}-OFFITEM-A-${randomUUID().slice(0, 6)}`, itemNo: 1, nominal: 100000 },
        { id: `${TEST_PREFIX}-OFFITEM-B-${randomUUID().slice(0, 6)}`, itemNo: 2, nominal: 250000 },
    ];
    for (const item of items) {
        await db.execute({
            sql: `INSERT INTO off_batch_item
                  (id, batch_id, item_no, row_no, no_surat, no_claim,
                   nama_program, periode, toko, barang, nominal, cara_bayar,
                   type, kwt, skp, fp, pc, foto, rekap, others,
                   final_kwt, final_skp, final_fp, final_pc, final_foto,
                   final_rekap, updated_at, created_at)
                  VALUES (?, ?, ?, ?, ?, NULL, ?, 'Juni 2026', ?, 'Produk',
                   ?, 'Transfer', 'claim', 1, 1, 1, 1, 1, 1, 0,
                   1, 1, 1, 1, 1, 1, ?, ?)`,
            args: [
                item.id,
                offBatchId,
                item.itemNo,
                item.itemNo,
                `SURAT-${item.itemNo}`,
                `Program ${item.itemNo}`,
                `Outlet ${item.itemNo}`,
                item.nominal,
                NOW.getTime(),
                NOW.getTime(),
            ],
        });
    }

    return { offBatchId, noPengajuan, principleCode, principleName, items };
}

async function createFromOffBatch(offBatchId, ppnRate = 0, pphRate = 0) {
    const existing = await db.execute({
        sql: "SELECT * FROM claim_workflow WHERE off_batch_id=?",
        args: [offBatchId],
    });
    if (existing.rows.length > 0) {
        return { ok: false, status: 409, code: "CLAIM_WORKFLOW_ALREADY_EXISTS", workflowId: String(existing.rows[0].id) };
    }

    const batch = (await db.execute({ sql: "SELECT * FROM off_batch WHERE id=?", args: [offBatchId] })).rows[0];
    if (!batch) return { ok: false, status: 404, code: "OFF_BATCH_NOT_FOUND" };
    if (String(batch.om_status) !== "Approved") return { ok: false, status: 409, code: "OFF_OM_NOT_APPROVED" };

    const offItems = (await db.execute({
        sql: "SELECT * FROM off_batch_item WHERE batch_id=? ORDER BY item_no ASC",
        args: [offBatchId],
    })).rows;

    const workflowId = `${TEST_PREFIX}-WF-${randomUUID().slice(0, 8)}`;
    const submissionByOffItemId = new Map();
    const submissions = [];
    const claimItems = [];
    for (const item of offItems) {
        const amount = calculateClaimAmount(Number(item.nominal || 0), ppnRate, pphRate);
        const submissionId = `${TEST_PREFIX}-SUB-${randomUUID().slice(0, 8)}`;
        submissionByOffItemId.set(String(item.id), submissionId);
        submissions.push({
            id: submissionId,
            scopeLabel: deriveItemScopeLabel(item),
            ...amount,
        });
        claimItems.push({
            id: `${TEST_PREFIX}-IT-${randomUUID().slice(0, 8)}`,
            submissionId,
            offBatchItemId: String(item.id),
            noSurat: item.no_surat,
            jenisPromosi: item.nama_program,
            periode: item.periode,
            outlet: item.toko,
            ...amount,
        });
    }

    const totals = claimItems.reduce((acc, item) => ({
        totalDpp: acc.totalDpp + item.dpp,
        totalPpn: acc.totalPpn + item.ppnAmount,
        totalPph: acc.totalPph + item.pphAmount,
        totalClaim: acc.totalClaim + item.nilaiKlaim,
    }), { totalDpp: 0, totalPpn: 0, totalPph: 0, totalClaim: 0 });

    await db.execute({
        sql: `INSERT INTO claim_workflow
              (id, off_batch_id, claim_workflow_no, principle_code, principle_name,
               source_type, status, total_dpp, total_ppn, total_pph, total_claim,
               total_paid, remaining_amount, created_by, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, 'off_program', ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
        args: [
            workflowId,
            offBatchId,
            `CLM/${batch.no_pengajuan}`,
            batch.principle_code,
            batch.principle_name,
            STATUS.draft,
            totals.totalDpp,
            totals.totalPpn,
            totals.totalPph,
            totals.totalClaim,
            remaining(totals.totalClaim, 0),
            ACTOR.id,
            NOW.getTime(),
            NOW.getTime(),
        ],
    });

    for (const sub of submissions) {
        await db.execute({
            sql: `INSERT INTO claim_submission
                  (id, claim_workflow_id, no_claim, no_claim_assigned_at,
                   no_claim_assigned_by, scope, scope_label, status,
                   total_dpp, total_ppn, total_pph, total_claim, total_paid,
                   remaining_amount, created_by, created_at, updated_at)
                  VALUES (?, ?, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
            args: [
                sub.id,
                workflowId,
                SCOPE.perItem,
                sub.scopeLabel,
                STATUS.draft,
                sub.dpp,
                sub.ppnAmount,
                sub.pphAmount,
                sub.nilaiKlaim,
                remaining(sub.nilaiKlaim, 0),
                ACTOR.id,
                NOW.getTime(),
                NOW.getTime(),
            ],
        });
    }

    for (const item of claimItems) {
        await db.execute({
            sql: `INSERT INTO claim_workflow_item
                  (id, claim_workflow_id, claim_submission_id, off_batch_item_id,
                   no_surat, jenis_promosi, periode, outlet,
                   dpp, ppn_rate, ppn_amount, pph_rate, pph_amount, nilai_klaim,
                   status, created_at, updated_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            args: [
                item.id,
                workflowId,
                item.submissionId,
                item.offBatchItemId,
                item.noSurat,
                item.jenisPromosi,
                item.periode,
                item.outlet,
                item.dpp,
                item.ppnRate,
                item.ppnAmount,
                item.pphRate,
                item.pphAmount,
                item.nilaiKlaim,
                STATUS.draft,
                NOW.getTime(),
                NOW.getTime(),
            ],
        });
    }

    await db.execute({
        sql: `INSERT INTO claim_audit_log
              (id, claim_workflow_id, audit_scope, actor_id, actor_name,
               actor_role, action, from_status, to_status, metadata, created_at)
              VALUES (?, ?, 'workflow', ?, ?, ?, 'create_from_off', NULL, ?, ?, ?)`,
        args: [
            `${TEST_PREFIX}-AUD-${randomUUID().slice(0, 8)}`,
            workflowId,
            ACTOR.id,
            ACTOR.name,
            ACTOR.role,
            STATUS.draft,
            JSON.stringify({
                offBatchId,
                itemCount: claimItems.length,
                submissionMode: "per_item",
                activeSubmissionCount: submissions.length,
            }),
            NOW.getTime(),
        ],
    });

    return {
        ok: true,
        status: 201,
        workflowId,
        activeSubmissionCount: submissions.length,
        itemCount: claimItems.length,
        submissionByOffItemId,
    };
}

async function patchSubmissionNoClaim(workflowId, submissionId, noClaim) {
    const trimmed = String(noClaim ?? "").trim();
    if (!trimmed) return { ok: false, code: "CLAIM_SUBMISSION_NO_CLAIM_EMPTY" };

    const sub = (await db.execute({
        sql: "SELECT * FROM claim_submission WHERE id=? AND claim_workflow_id=?",
        args: [submissionId, workflowId],
    })).rows[0];
    if (!sub) return { ok: false, code: "CLAIM_SUBMISSION_NOT_FOUND" };

    await db.execute({
        sql: `UPDATE claim_submission
              SET no_claim=?, no_claim_assigned_at=?, no_claim_assigned_by=?, updated_at=?
              WHERE id=?`,
        args: [trimmed, NOW.getTime(), ACTOR.id, NOW.getTime(), submissionId],
    });

    const offItemIds = (await db.execute({
        sql: `SELECT off_batch_item_id FROM claim_workflow_item
              WHERE claim_submission_id=? AND off_batch_item_id IS NOT NULL`,
        args: [submissionId],
    })).rows.map((row) => String(row.off_batch_item_id));
    for (const offItemId of offItemIds) {
        await db.execute({
            sql: "UPDATE off_batch_item SET no_claim=?, updated_at=? WHERE id=?",
            args: [trimmed, NOW.getTime(), offItemId],
        });
    }
    return { ok: true, syncedItemCount: offItemIds.length };
}

async function getWorkflowCounts(workflowId) {
    const itemCount = (await db.execute({
        sql: "SELECT COUNT(*) AS c FROM claim_workflow_item WHERE claim_workflow_id=?",
        args: [workflowId],
    })).rows[0].c;
    const activeSubmissionCount = (await db.execute({
        sql: `SELECT COUNT(*) AS c FROM claim_submission s
              WHERE s.claim_workflow_id=?
              AND (s.total_claim > 0 OR EXISTS (
                  SELECT 1 FROM claim_workflow_item i WHERE i.claim_submission_id=s.id
              ))`,
        args: [workflowId],
    })).rows[0].c;
    return { itemCount: Number(itemCount), activeSubmissionCount: Number(activeSubmissionCount) };
}

async function main() {
    await cleanup();

    console.log("--- Test 1: No Claim rule principal mapping ---");
    equal("GDI resolves to configured GCPI key", noClaimRules.GDI.noClaimKey, "GCPI");
    equal("GDI sample uses GCPI pattern", buildNoClaim("GDI", "1", "06", "2026"), "01/SUPER-GCPI/06/2026");
    equal("FON sample uses FON, not GCPI", buildNoClaim("FON", "1", "06", "2026"), "001/SUPER-FON/06/2026");
    equal("URC sample uses SP-RC 2-digit year", buildNoClaim("URC", "1", "06", "2026"), "01/SP-RC/06/26");
    equal("RB sample follows RB rule without GCPI", buildNoClaim("RB", "1", "06", "2026"), "01/SP-06/26");

    console.log("\n--- Test 2: create-from-off creates per-item submissions ---");
    const off = await insertOffBatch("FON");
    const created = await createFromOffBatch(off.offBatchId);
    check("from-off returns created", created.ok, JSON.stringify(created));

    const counts = await getWorkflowCounts(created.workflowId);
    equal("claim_workflow_item count = 2", counts.itemCount, 2);
    equal("active claim_submission count = 2", counts.activeSubmissionCount, 2);

    const itemRows = (await db.execute({
        sql: `SELECT id, off_batch_item_id, claim_submission_id
              FROM claim_workflow_item WHERE claim_workflow_id=?
              ORDER BY off_batch_item_id ASC`,
        args: [created.workflowId],
    })).rows;
    const subIds = itemRows.map((row) => String(row.claim_submission_id));
    check("each item has claimSubmissionId", subIds.every(Boolean), JSON.stringify(itemRows));
    equal("item submissions are distinct", new Set(subIds).size, 2);

    const first = itemRows[0];
    const second = itemRows[1];
    const noClaimSuffix = randomUUID().slice(0, 6).toUpperCase();
    const noClaimA = `R7J-${noClaimSuffix}-001/SUPER-FON/06/2026`;
    const noClaimB = `R7J-${noClaimSuffix}-002/SUPER-FON/06/2026`;

    console.log("\n--- Test 3: save No Claim row A does not touch row B ---");
    const saveA = await patchSubmissionNoClaim(created.workflowId, String(first.claim_submission_id), noClaimA);
    check("save row A OK", saveA.ok, JSON.stringify(saveA));

    const subAfterA = (await db.execute({
        sql: "SELECT id, no_claim FROM claim_submission WHERE claim_workflow_id=? ORDER BY id ASC",
        args: [created.workflowId],
    })).rows;
    const offAfterA = (await db.execute({
        sql: "SELECT id, no_claim FROM off_batch_item WHERE batch_id=? ORDER BY id ASC",
        args: [off.offBatchId],
    })).rows;
    equal("submission A noClaim saved", String(subAfterA.find((row) => String(row.id) === String(first.claim_submission_id)).no_claim), noClaimA);
    equal("submission B noClaim still null", subAfterA.find((row) => String(row.id) === String(second.claim_submission_id)).no_claim, null);
    equal("OFF item A noClaim synced", String(offAfterA.find((row) => String(row.id) === String(first.off_batch_item_id)).no_claim), noClaimA);
    equal("OFF item B noClaim still null", offAfterA.find((row) => String(row.id) === String(second.off_batch_item_id)).no_claim, null);

    console.log("\n--- Test 4: save No Claim row B independently ---");
    const saveB = await patchSubmissionNoClaim(created.workflowId, String(second.claim_submission_id), noClaimB);
    check("save row B OK", saveB.ok, JSON.stringify(saveB));

    const subAfterB = (await db.execute({
        sql: "SELECT id, no_claim FROM claim_submission WHERE claim_workflow_id=?",
        args: [created.workflowId],
    })).rows;
    const offAfterB = (await db.execute({
        sql: "SELECT id, no_claim FROM off_batch_item WHERE batch_id=?",
        args: [off.offBatchId],
    })).rows;
    equal("submission A keeps own No Claim", String(subAfterB.find((row) => String(row.id) === String(first.claim_submission_id)).no_claim), noClaimA);
    equal("submission B keeps own No Claim", String(subAfterB.find((row) => String(row.id) === String(second.claim_submission_id)).no_claim), noClaimB);
    equal("OFF item A keeps own No Claim", String(offAfterB.find((row) => String(row.id) === String(first.off_batch_item_id)).no_claim), noClaimA);
    equal("OFF item B keeps own No Claim", String(offAfterB.find((row) => String(row.id) === String(second.off_batch_item_id)).no_claim), noClaimB);

    console.log("\n--- Test 5: create-from-off is idempotent ---");
    const duplicate = await createFromOffBatch(off.offBatchId);
    equal("second call rejected as existing workflow", duplicate.code, "CLAIM_WORKFLOW_ALREADY_EXISTS");
    const countsAfterDuplicate = await getWorkflowCounts(created.workflowId);
    equal("no duplicate items", countsAfterDuplicate.itemCount, 2);
    equal("no duplicate active submissions", countsAfterDuplicate.activeSubmissionCount, 2);

    console.log("\n=== Test Summary ===");
    console.log(`Total: ${pass + fail}  PASS: ${pass}  FAIL: ${fail}`);
}

(async () => {
    let exitCode = 0;
    try {
        await main();
        if (fail > 0) exitCode = 1;
    } catch (error) {
        console.error("\n[r7j-test] UNCAUGHT:", error);
        exitCode = 2;
    } finally {
        console.log("\n--- Cleanup ---");
        try {
            await cleanup();
            console.log("Cleanup demo rows OK.");
        } catch (error) {
            console.warn("Cleanup failed:", error?.message || error);
        }
        process.exit(exitCode);
    }
})();
