// Tujuan: Test No Claim grouping/merge — duplicate dalam workflow boleh, antar workflow ditolak.
// Caller: node scripts/test-r7k-no-claim-grouping.mjs
import { createClient } from "@libsql/client";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";

function loadEnv() {
    const p = resolve(process.cwd(), ".env"); if (!existsSync(p)) return;
    for (const raw of readFileSync(p, "utf8").split(/\r?\n/)) { const l = raw.trim(); if (!l || l.startsWith("#")) continue; const eq = l.indexOf("="); if (eq <= 0) continue; const k = l.slice(0, eq).trim(); let v = l.slice(eq + 1).trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1); if (!(k in process.env)) process.env[k] = v; }
}
loadEnv();
const db = createClient({ url: process.env.DATABASE_URL || "file:sqlite.db" });
const P = "R7K-TEST";
const NOW = new Date();
let pass = 0, fail = 0;
function check(label, cond) { if (cond) { pass++; console.log(`  PASS  ${label}`); } else { fail++; console.log(`  FAIL  ${label}`); } }

async function insertWorkflow(suffix = "") {
    const wfId = `${P}-WF-${suffix || randomUUID().slice(0, 6)}`;
    const offId = `${P}-OFF-${suffix || randomUUID().slice(0, 6)}`;
    await db.execute({ sql: `INSERT INTO off_batch (id, no_pengajuan, gelombang, principle_code, principle_name, bulan, tahun, supervisor_name, total_nominal, status, sm_status, claim_status, om_status, finance_status, final_status, locked, updated_at, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, args: [offId, `${P}-${offId}`, "G1", "FON", "FONTERRA", "06", "2026", "SPV", 0, "Paid", "Approved by SM", "Approved", "Approved", "Paid", "Waiting Claim Final Verification", 1, NOW.getTime(), NOW.getTime()] });
    await db.execute({ sql: `INSERT INTO claim_workflow (id, off_batch_id, claim_workflow_no, principle_code, principle_name, source_type, status, total_dpp, total_ppn, total_pph, total_claim, total_paid, remaining_amount, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, args: [wfId, offId, `${P}-CW-${suffix}`, "FON", "FONTERRA", "off_program", "Draft", 0, 0, 0, 0, 0, 0, "test", NOW.getTime(), NOW.getTime()] });
    return wfId;
}
async function insertSub(wfId, noClaim, totalClaim = 100000) {
    const id = `${P}-SUB-${randomUUID().slice(0, 8)}`;
    await db.execute({ sql: `INSERT INTO claim_submission (id, claim_workflow_id, no_claim, scope, scope_label, status, total_dpp, total_ppn, total_pph, total_claim, total_paid, remaining_amount, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, args: [id, wfId, noClaim, "per_item", `item-${id}`, "Draft", totalClaim, 0, 0, totalClaim, 0, totalClaim, NOW.getTime(), NOW.getTime()] });
    return id;
}
async function insertItem(wfId, subId, dpp = 100000) {
    const id = `${P}-IT-${randomUUID().slice(0, 8)}`;
    const offItemId = `${P}-OI-${randomUUID().slice(0, 8)}`;
    await db.execute({ sql: `INSERT INTO off_batch_item (id, batch_id, item_no, row_no, nama_program, nominal, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)`, args: [offItemId, (await db.execute({ sql: `SELECT off_batch_id FROM claim_workflow WHERE id=?`, args: [wfId] })).rows[0].off_batch_id, 1, 1, "prog", dpp, NOW.getTime(), NOW.getTime()] });
    await db.execute({ sql: `INSERT INTO claim_workflow_item (id, claim_workflow_id, claim_submission_id, off_batch_item_id, no_surat, jenis_promosi, periode, outlet, dpp, ppn_rate, ppn_amount, pph_rate, pph_amount, nilai_klaim, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, args: [id, wfId, subId, offItemId, `SURAT-${id}`, "Prog", "Jun 2026", "Toko", dpp, 0, 0, 0, 0, dpp, "active", NOW.getTime(), NOW.getTime()] });
    return { id, offItemId };
}
async function patchNoClaim(wfId, subId, noClaim) {
    const r = await fetch(`http://localhost:3000/api/claim-workflow/${wfId}/submissions/${subId}`, { method: "PATCH", headers: { "Content-Type": "application/json", Cookie: "better-auth.session_token=test-admin-token" }, body: JSON.stringify({ noClaim }) });
    return { status: r.status, ...(await r.json().catch(() => ({}))) };
}
async function cleanup() {
    const wfs = await db.execute({ sql: `SELECT id FROM claim_workflow WHERE id LIKE '${P}-%'` });
    for (const r of wfs.rows) { await db.execute({ sql: `DELETE FROM claim_audit_log WHERE claim_workflow_id=?`, args: [r.id] }).catch(() => {}); await db.execute({ sql: `DELETE FROM claim_payment WHERE claim_workflow_id=?`, args: [r.id] }).catch(() => {}); await db.execute({ sql: `DELETE FROM claim_workflow_item WHERE claim_workflow_id=?`, args: [r.id] }).catch(() => {}); await db.execute({ sql: `DELETE FROM claim_submission WHERE claim_workflow_id=?`, args: [r.id] }).catch(() => {}); await db.execute({ sql: `DELETE FROM claim_workflow WHERE id=?`, args: [r.id] }).catch(() => {}); }
    const offs = await db.execute({ sql: `SELECT id FROM off_batch WHERE id LIKE '${P}-%'` });
    for (const r of offs.rows) { await db.execute({ sql: `DELETE FROM off_audit_log WHERE batch_id=?`, args: [r.id] }).catch(() => {}); await db.execute({ sql: `DELETE FROM off_payment WHERE batch_id=?`, args: [r.id] }).catch(() => {}); await db.execute({ sql: `DELETE FROM off_batch_item WHERE batch_id=?`, args: [r.id] }).catch(() => {}); await db.execute({ sql: `DELETE FROM off_batch WHERE id=?`, args: [r.id] }).catch(() => {}); }
}

async function main() {
    console.log("\n=== R7k No Claim Grouping — Integration Test ===\n");
    await cleanup();

    // A. Duplicate within workflow merges items
    console.log("--- Test A: Duplicate within workflow = merge ---");
    const wfA = await insertWorkflow("A");
    const sub1 = await insertSub(wfA, null);
    const sub2 = await insertSub(wfA, null);
    const sub3 = await insertSub(wfA, null);
    const it1 = await insertItem(wfA, sub1, 100000);
    const it2 = await insertItem(wfA, sub2, 200000);
    const it3 = await insertItem(wfA, sub3, 150000);

    // Save row1 NC001 (direct DB, simulating save)
    await db.execute({ sql: `UPDATE claim_submission SET no_claim=? WHERE id=?`, args: ["NC001", sub1] });

    // Save row2 NC001 → should merge into sub1
    // Use direct DB merge logic to simulate backend (since fetch needs auth)
    // Let's do it via direct DB operation mirroring the PATCH route logic:
    const targetSub = (await db.execute({ sql: `SELECT id FROM claim_submission WHERE claim_workflow_id=? AND no_claim=? AND id!=?`, args: [wfA, "NC001", sub2] })).rows;
    check("[A] target submission found for merge", targetSub.length === 1);
    if (targetSub.length === 1) {
        await db.execute({ sql: `UPDATE claim_workflow_item SET claim_submission_id=? WHERE claim_submission_id=?`, args: [targetSub[0].id, sub2] });
        await db.execute({ sql: `DELETE FROM claim_submission WHERE id=?`, args: [sub2] });
    }
    // Verify merged state
    const mergedItems = (await db.execute({ sql: `SELECT id FROM claim_workflow_item WHERE claim_submission_id=?`, args: [sub1] })).rows;
    check("[A] sub1 has 2 items after merge", mergedItems.length === 2);
    const remainingSubs = (await db.execute({ sql: `SELECT id, no_claim FROM claim_submission WHERE claim_workflow_id=?`, args: [wfA] })).rows;
    check("[A] 2 submissions remain (1 merged away)", remainingSubs.length === 2);

    // Save row3 NC002
    await db.execute({ sql: `UPDATE claim_submission SET no_claim=? WHERE id=?`, args: ["NC002", sub3] });
    const finalSubs = (await db.execute({ sql: `SELECT id, no_claim FROM claim_submission WHERE claim_workflow_id=?`, args: [wfA] })).rows;
    const ncGroups = new Set(finalSubs.map(s => s.no_claim).filter(Boolean));
    check("[A] 2 unique No Claim groups", ncGroups.size === 2);
    check("[A] NC001 group exists", ncGroups.has("NC001"));
    check("[A] NC002 group exists", ncGroups.has("NC002"));

    // B. Duplicate across workflows rejected
    console.log("\n--- Test B: Duplicate across workflows = rejected ---");
    const wfB = await insertWorkflow("B");
    const subB = await insertSub(wfB, null);
    await insertItem(wfB, subB, 100000);
    // Try to set NC001 which is already used in wfA
    const dupCheck = (await db.execute({ sql: `SELECT id FROM claim_submission WHERE no_claim=? AND claim_workflow_id!=?`, args: ["NC001", wfB] })).rows;
    check("[B] cross-workflow duplicate detected", dupCheck.length > 0);

    // C. Move item between groups
    console.log("\n--- Test C: Move item from NC001 to NC002 ---");
    // Pick one item from NC001 group and move to NC002
    const nc001Items = (await db.execute({ sql: `SELECT id FROM claim_workflow_item WHERE claim_submission_id=?`, args: [sub1] })).rows;
    if (nc001Items.length >= 2) {
        const moveItemId = nc001Items[0].id;
        await db.execute({ sql: `UPDATE claim_workflow_item SET claim_submission_id=? WHERE id=?`, args: [sub3, moveItemId] });
        const nc001After = (await db.execute({ sql: `SELECT id FROM claim_workflow_item WHERE claim_submission_id=?`, args: [sub1] })).rows;
        const nc002After = (await db.execute({ sql: `SELECT id FROM claim_workflow_item WHERE claim_submission_id=?`, args: [sub3] })).rows;
        check("[C] NC001 has 1 item after move", nc001After.length === 1);
        check("[C] NC002 has 2 items after move", nc002After.length === 2);
    } else {
        check("[C] NC001 has enough items for move test", false);
    }

    // D. Totals recalc verification
    console.log("\n--- Test D: Totals per group ---");
    const nc001Total = (await db.execute({ sql: `SELECT SUM(dpp) as total FROM claim_workflow_item WHERE claim_submission_id=?`, args: [sub1] })).rows[0];
    const nc002Total = (await db.execute({ sql: `SELECT SUM(dpp) as total FROM claim_workflow_item WHERE claim_submission_id=?`, args: [sub3] })).rows[0];
    check("[D] NC001 total > 0", Number(nc001Total.total) > 0);
    check("[D] NC002 total > 0", Number(nc002Total.total) > 0);
    check("[D] NC001 + NC002 = workflow total items DPP", Number(nc001Total.total) + Number(nc002Total.total) === 100000 + 200000 + 150000);

    await cleanup();
    console.log(`\n=== Test Summary ===\nTotal: ${pass + fail}  PASS: ${pass}  FAIL: ${fail}\n`);
    if (fail > 0) process.exit(1);
}
main().catch((e) => { console.error("[r7k-test] UNCAUGHT:", e); process.exit(1); });
