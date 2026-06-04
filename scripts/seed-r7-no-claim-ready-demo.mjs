// Tujuan: Seed 20 Claim Workflow demo yang siap generate No Claim.
//         OFF batch: omStatus=Approved, status=Paid, financeStatus=Paid,
//         finalStatus=Waiting Claim Final Verification, off_payment fully paid.
//         Claim Workflow: Draft, ada active submission/item, noClaim=NULL,
//         dokumen kosong. Masuk filter "Siap Generate No Claim".
// Caller: `node scripts/seed-r7-no-claim-ready-demo.mjs`
// Side Effects:
//   - Backup sqlite.db ke sqlite.db.bak-seed-nc-ready (sekali, tidak overwrite).
//   - Hapus data demo prefix DEMO-NC-READY-* (idempotent).
//   - INSERT 20 OFF batch + items + payments + Claim Workflow + submissions + items.
// Aturan:
//   - REFUSE jika DATABASE_URL bukan SQLite lokal.
//   - TIDAK menghapus data non-demo.
//   - TIDAK mengubah schema/route/UI.

import { createClient } from "@libsql/client";
import { existsSync, copyFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";

// ============================================================================
// SECTION 1 — env + local guard
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
function isLocalSqlite(url) {
    if (!url.startsWith("file:")) return false;
    const filePath = url.slice("file:".length);
    if (!filePath) return false;
    if (filePath.startsWith("/app/")) return false;
    return true;
}
if (!isLocalSqlite(databaseUrl)) {
    console.error(`[seed-nc-ready] REFUSED: DATABASE_URL bukan SQLite lokal (${databaseUrl}).`);
    process.exit(2);
}

const sqliteFilePath = databaseUrl.slice("file:".length);

// Backup (sekali, tidak overwrite).
const backupPath = `${sqliteFilePath}.bak-seed-nc-ready`;
if (!existsSync(backupPath) && existsSync(sqliteFilePath)) {
    copyFileSync(sqliteFilePath, backupPath);
    console.log(`[seed-nc-ready] Backup: ${backupPath}`);
}

const db = createClient({ url: databaseUrl });

// ============================================================================
// SECTION 2 — constants + helpers
// ============================================================================
const PREFIX = "DEMO-NC-READY";
const NOW_MS = Date.now();
const ACTOR_ID = "demo-seed-nc-ready";
const ACTOR_NAME = "Demo Seed NC Ready";
const ACTOR_ROLE = "admin";

function ms(daysAgo) { return NOW_MS - daysAgo * 24 * 60 * 60 * 1000; }
function isoDate(daysAgo) {
    const d = new Date(ms(daysAgo));
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const PRINCIPLES = [
    { code: "RB", name: "RECKITT BENCKISER, PT" },
    { code: "FKS", name: "FKS FOOD SEJAHTERA, PT" },
    { code: "GDI", name: "GODREJ DISTRIBUSI INDONESIA, PT" },
    { code: "KINO", name: "KINO INDONESIA. TBK, PT" },
    { code: "FON", name: "FONTERRA BRANDS INDONESIA, PT" },
];

// ============================================================================
// SECTION 3 — cleanup
// ============================================================================
async function cleanup() {
    console.log("[seed-nc-ready] Cleanup demo data...");
    // Delete in order respecting FK constraints
    await db.execute(`DELETE FROM claim_audit_log WHERE claim_workflow_id IN (SELECT id FROM claim_workflow WHERE claim_workflow_no LIKE '${PREFIX}%')`);
    await db.execute(`DELETE FROM claim_payment WHERE claim_workflow_id IN (SELECT id FROM claim_workflow WHERE claim_workflow_no LIKE '${PREFIX}%')`);
    await db.execute(`DELETE FROM claim_workflow_item WHERE claim_workflow_id IN (SELECT id FROM claim_workflow WHERE claim_workflow_no LIKE '${PREFIX}%')`);
    await db.execute(`DELETE FROM claim_submission WHERE claim_workflow_id IN (SELECT id FROM claim_workflow WHERE claim_workflow_no LIKE '${PREFIX}%')`);
    await db.execute(`DELETE FROM claim_workflow WHERE claim_workflow_no LIKE '${PREFIX}%'`);
    await db.execute(`DELETE FROM off_audit_log WHERE batch_id IN (SELECT id FROM off_batch WHERE no_pengajuan LIKE '${PREFIX}%')`);
    await db.execute(`DELETE FROM off_payment WHERE batch_id IN (SELECT id FROM off_batch WHERE no_pengajuan LIKE '${PREFIX}%')`);
    await db.execute(`DELETE FROM off_batch_item WHERE batch_id IN (SELECT id FROM off_batch WHERE no_pengajuan LIKE '${PREFIX}%')`);
    await db.execute(`DELETE FROM off_batch WHERE no_pengajuan LIKE '${PREFIX}%'`);
    console.log("[seed-nc-ready] Cleanup done.");
}

// ============================================================================
// SECTION 4 — seed 20 workflows
// ============================================================================
async function seed() {
    console.log("[seed-nc-ready] Seeding 20 workflows...");

    for (let i = 1; i <= 20; i++) {
        const idx = String(i).padStart(2, "0");
        const principle = PRINCIPLES[(i - 1) % PRINCIPLES.length];
        const batchId = randomUUID();
        const noPengajuan = `${PREFIX}-OFF-${idx}`;
        const totalNominal = 1000000 + i * 500000; // 1.5M to 11M
        const createdDaysAgo = 30 + i;
        const createdAt = ms(createdDaysAgo);
        const paidDaysAgo = 10 + i;

        // 1. OFF Batch: fully paid, OM Approved, waiting final claim verification
        await db.execute({
            sql: `INSERT INTO off_batch (
                id, no_pengajuan, gelombang, principle_code, principle_name,
                bulan, tahun, supervisor_name, total_nominal,
                status, sm_status, claim_status, om_status, finance_status, final_status,
                locked, created_by, updated_at, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            args: [
                batchId, noPengajuan, "G1", principle.code, principle.name,
                "05", "2026", "Demo Supervisor", totalNominal,
                "Paid", "Approved", "Approved", "Approved", "Paid", "Waiting Claim Final Verification",
                1, ACTOR_ID, createdAt, createdAt,
            ],
        });

        // 2. OFF Batch Items (3 per batch)
        for (let j = 1; j <= 3; j++) {
            const itemId = randomUUID();
            const itemNominal = Math.round(totalNominal / 3);
            await db.execute({
                sql: `INSERT INTO off_batch_item (
                    id, batch_id, item_no, row_no, no_surat, nama_program,
                    periode, toko, nominal, cara_bayar,
                    kwt, skp, fp, pc, foto, rekap, others,
                    final_kwt, final_skp, final_fp, final_pc, final_foto, final_rekap, final_others,
                    created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                args: [
                    itemId, batchId, j, j, `${PREFIX}-SURAT-${idx}-${j}`, `Program Demo ${idx}-${j}`,
                    "Mei 2026", `Toko Demo ${j}`, itemNominal, "Transfer",
                    1, 1, 1, 0, 0, 0, 0,
                    1, 1, 1, 0, 0, 0, 0,
                    createdAt, createdAt,
                ],
            });
        }

        // 3. OFF Payment: single payment covering full amount
        const paymentId = randomUUID();
        await db.execute({
            sql: `INSERT INTO off_payment (
                id, batch_id, payment_no, payment_date, paid_amount,
                payment_method, created_by, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            args: [
                paymentId, batchId, 1, isoDate(paidDaysAgo), totalNominal,
                "Transfer", ACTOR_ID, ms(paidDaysAgo), ms(paidDaysAgo),
            ],
        });

        // 4. Claim Workflow: Draft, no documents, no noClaim
        const workflowId = randomUUID();
        const claimWorkflowNo = `${PREFIX}-CW-${idx}`;
        await db.execute({
            sql: `INSERT INTO claim_workflow (
                id, off_batch_id, claim_workflow_no, principle_code, principle_name,
                source_type, source_ref_id,
                status, total_dpp, total_ppn, total_pph, total_claim,
                total_paid, remaining_amount,
                created_by, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            args: [
                workflowId, batchId, claimWorkflowNo, principle.code, principle.name,
                "off_program", batchId,
                "Draft", totalNominal, 0, 0, totalNominal,
                0, totalNominal,
                ACTOR_ID, ms(createdDaysAgo - 5), ms(createdDaysAgo - 5),
            ],
        });

        // 5. Claim Submission: 1 default submission, noClaim NULL
        const submissionId = randomUUID();
        await db.execute({
            sql: `INSERT INTO claim_submission (
                id, claim_workflow_id, scope, scope_label, status,
                no_claim, total_dpp, total_ppn, total_pph, total_claim,
                total_paid, remaining_amount,
                created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            args: [
                submissionId, workflowId, "per_pengajuan", claimWorkflowNo, "Draft",
                null, totalNominal, 0, 0, totalNominal,
                0, totalNominal,
                ms(createdDaysAgo - 5), ms(createdDaysAgo - 5),
            ],
        });

        // 6. Claim Workflow Items: 3 per workflow, linked to submission
        for (let j = 1; j <= 3; j++) {
            const claimItemId = randomUUID();
            const dpp = Math.round(totalNominal / 3);
            await db.execute({
                sql: `INSERT INTO claim_workflow_item (
                    id, claim_workflow_id, claim_submission_id,
                    no_surat, jenis_promosi, periode, outlet,
                    dpp, ppn_rate, ppn_amount, pph_rate, pph_amount, nilai_klaim,
                    status, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                args: [
                    claimItemId, workflowId, submissionId,
                    `${PREFIX}-SURAT-${idx}-${j}`, `Program Demo ${idx}-${j}`, "Mei 2026", `Toko Demo ${j}`,
                    dpp, 0, 0, 0, 0, dpp,
                    "Draft", ms(createdDaysAgo - 5), ms(createdDaysAgo - 5),
                ],
            });
        }

        // 7. Audit log: workflow created
        await db.execute({
            sql: `INSERT INTO claim_audit_log (
                id, claim_workflow_id, actor_id, actor_name, actor_role,
                action, from_status, to_status, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            args: [
                randomUUID(), workflowId, ACTOR_ID, ACTOR_NAME, ACTOR_ROLE,
                "claim_workflow_created", null, "Draft", ms(createdDaysAgo - 5),
            ],
        });

        console.log(`  [${idx}] ${claimWorkflowNo} (OFF: ${noPengajuan}, nominal: ${totalNominal})`);
    }

    console.log("[seed-nc-ready] Done. 20 workflows seeded.");
}

// ============================================================================
// SECTION 5 — main
// ============================================================================
async function main() {
    try {
        await cleanup();
        await seed();
        console.log("[seed-nc-ready] SUCCESS.");
        process.exit(0);
    } catch (err) {
        console.error("[seed-nc-ready] FATAL:", err);
        process.exit(1);
    }
}
main();
