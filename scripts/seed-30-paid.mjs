// Tujuan: Hapus SEMUA data seed demo lama, lalu buat 30 data baru.
//         Setiap data: OFF batch sudah fully Paid oleh Finance + Claim Workflow Draft.
//         Siap untuk Generate No Claim dari UI.
// Caller: `node scripts/seed-30-paid.mjs`
// Side Effects:
//   - DELETE semua data demo (prefix DEMO-*)
//   - INSERT 30 OFF batch (status Paid, financeStatus Paid) + items + payment
//   - INSERT 30 Claim Workflow (Draft) + submission + items
//   - INSERT audit logs

import { createClient } from "@libsql/client";
import { existsSync, copyFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";

// ============================================================================
// ENV + GUARD
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
if (!databaseUrl.startsWith("file:") || databaseUrl.slice(5).startsWith("/app/")) {
    console.error(`[seed-30-paid] REFUSED: bukan SQLite lokal (${databaseUrl}).`);
    process.exit(2);
}

const sqliteFile = databaseUrl.slice(5);
const backupPath = `${sqliteFile}.bak-seed-30-paid`;
if (!existsSync(backupPath) && existsSync(sqliteFile)) {
    copyFileSync(sqliteFile, backupPath);
    console.log(`[seed-30-paid] Backup: ${backupPath}`);
}

const db = createClient({ url: databaseUrl });

// ============================================================================
// HELPERS
// ============================================================================
const NOW = Date.now();
const ACTOR_ID = "seed-30-paid";
const ACTOR_NAME = "Seed 30 Paid";

function ms(daysAgo) { return NOW - daysAgo * 86400000; }
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
    { code: "MI", name: "MARKETAMA INDAH, PT" },
    { code: "PAS", name: "PRIMARASA ABADI SEJAHTERA, PT" },
    { code: "SPS", name: "SUN PAPER SOURCE, PT" },
    { code: "HEINZ", name: "HEINZ ABC INDONESIA, PT" },
    { code: "URC", name: "URC INDONESIA, PT" },
];

const PROGRAMS = [
    "Diskon Akhir Bulan", "Promo Buy 2 Get 1", "Cashback Distributor",
    "Program Bundling Q2", "Insentif Volume", "Promosi Launching",
    "Trade Promo Ramadhan", "Diskon Seasonal", "Program Loyalitas Toko",
    "Off Invoice Distributor",
];

const TOKOS = [
    "Toko Makmur Jaya", "Minimarket Berkah", "Swalayan Sejahtera",
    "Warung Barokah", "Toko Abadi", "Mart Sentosa", "Grosir Murah",
    "Sumber Rezeki", "Toko Harapan", "Retail Modern Plus",
];

// ============================================================================
// CLEANUP ALL DEMO DATA
// ============================================================================
async function cleanupAll() {
    console.log("[seed-30-paid] Menghapus semua data seed demo...");

    // Find all demo OFF batches
    const offRows = await db.execute(
        "SELECT id FROM off_batch WHERE no_pengajuan LIKE 'DEMO-%'",
    );
    const offIds = offRows.rows.map(r => String(r.id));

    // Find all demo Claim Workflows
    const cwRows = await db.execute(
        "SELECT id FROM claim_workflow WHERE claim_workflow_no LIKE 'DEMO-%'",
    );
    const cwIds = cwRows.rows.map(r => String(r.id));

    // Delete claim workflow children
    if (cwIds.length > 0) {
        const ph = cwIds.map(() => "?").join(",");
        await db.execute({ sql: `DELETE FROM claim_audit_log WHERE claim_workflow_id IN (${ph})`, args: cwIds });
        await db.execute({ sql: `DELETE FROM claim_payment WHERE claim_workflow_id IN (${ph})`, args: cwIds });
        await db.execute({ sql: `DELETE FROM claim_workflow_item WHERE claim_workflow_id IN (${ph})`, args: cwIds });
        await db.execute({ sql: `DELETE FROM claim_submission WHERE claim_workflow_id IN (${ph})`, args: cwIds });
        await db.execute({ sql: `DELETE FROM claim_workflow WHERE id IN (${ph})`, args: cwIds });
    }

    // Delete OFF children
    if (offIds.length > 0) {
        const ph = offIds.map(() => "?").join(",");
        await db.execute({ sql: `DELETE FROM off_audit_log WHERE batch_id IN (${ph})`, args: offIds });
        await db.execute({ sql: `DELETE FROM off_payment WHERE batch_id IN (${ph})`, args: offIds });
        await db.execute({ sql: `DELETE FROM off_batch_item WHERE batch_id IN (${ph})`, args: offIds });
        await db.execute({ sql: `DELETE FROM off_batch WHERE id IN (${ph})`, args: offIds });
    }

    // Also clean up NC-READY prefix
    const ncRows = await db.execute(
        "SELECT id FROM claim_workflow WHERE claim_workflow_no LIKE 'DEMO-NC-READY-%'",
    );
    const ncIds = ncRows.rows.map(r => String(r.id));
    if (ncIds.length > 0) {
        const ph = ncIds.map(() => "?").join(",");
        await db.execute({ sql: `DELETE FROM claim_audit_log WHERE claim_workflow_id IN (${ph})`, args: ncIds });
        await db.execute({ sql: `DELETE FROM claim_payment WHERE claim_workflow_id IN (${ph})`, args: ncIds });
        await db.execute({ sql: `DELETE FROM claim_workflow_item WHERE claim_workflow_id IN (${ph})`, args: ncIds });
        await db.execute({ sql: `DELETE FROM claim_submission WHERE claim_workflow_id IN (${ph})`, args: ncIds });
        await db.execute({ sql: `DELETE FROM claim_workflow WHERE id IN (${ph})`, args: ncIds });
    }
    const ncOffRows = await db.execute(
        "SELECT id FROM off_batch WHERE no_pengajuan LIKE 'DEMO-NC-READY-%'",
    );
    const ncOffIds = ncOffRows.rows.map(r => String(r.id));
    if (ncOffIds.length > 0) {
        const ph = ncOffIds.map(() => "?").join(",");
        await db.execute({ sql: `DELETE FROM off_audit_log WHERE batch_id IN (${ph})`, args: ncOffIds });
        await db.execute({ sql: `DELETE FROM off_payment WHERE batch_id IN (${ph})`, args: ncOffIds });
        await db.execute({ sql: `DELETE FROM off_batch_item WHERE batch_id IN (${ph})`, args: ncOffIds });
        await db.execute({ sql: `DELETE FROM off_batch WHERE id IN (${ph})`, args: ncOffIds });
    }

    console.log(`  OFF batches deleted: ${offIds.length + ncOffIds.length}`);
    console.log(`  Claim Workflows deleted: ${cwIds.length + ncIds.length}`);
}

// ============================================================================
// SEED 30 PAID WORKFLOWS
// ============================================================================
async function seed() {
    console.log("[seed-30-paid] Creating 30 fully-paid OFF + Draft Claim Workflows...");

    for (let i = 1; i <= 30; i++) {
        const idx = String(i).padStart(2, "0");
        const principle = PRINCIPLES[(i - 1) % PRINCIPLES.length];
        const program = PROGRAMS[(i - 1) % PROGRAMS.length];
        const toko = TOKOS[(i - 1) % TOKOS.length];
        const batchId = randomUUID();
        const noPengajuan = `DEMO-OFF-PAID-${idx}`;
        const itemCount = 2 + (i % 3); // 2-4 items per batch
        const baseNominal = 2000000 + i * 800000; // 2.8M to 26M varied
        const createdDaysAgo = 45 - i; // staggered creation dates
        const paidDaysAgo = 10 + (i % 5);

        // Build items
        const items = [];
        let totalNominal = 0;
        for (let j = 1; j <= itemCount; j++) {
            const nominal = baseNominal + (j - 1) * 1500000;
            totalNominal += nominal;
            items.push({
                id: randomUUID(),
                itemNo: j,
                rowNo: j,
                noSurat: `${noPengajuan}/SURAT-${String(j).padStart(2, "0")}`,
                namaProgram: `${program} ${principle.code} #${idx}`,
                periode: `${isoDate(60)} - ${isoDate(30)}`,
                toko: `${toko} ${j}`,
                nominal,
                caraBayar: j % 2 === 0 ? "Tunai" : "Transfer",
            });
        }

        // 1. INSERT OFF Batch — Paid status
        await db.execute({
            sql: `INSERT INTO off_batch (
                id, no_pengajuan, gelombang, principle_code, principle_name,
                bulan, tahun, supervisor_name, total_nominal,
                status, sm_status, claim_status, om_status, finance_status, final_status,
                locked, created_by, submitted_by, submitted_at,
                sm_approved_by, sm_approved_at,
                claim_reviewed_by, claim_reviewed_at, claim_submitted_date, claim_deadline, completeness_status,
                om_approved_by, om_approved_at,
                paid_by, paid_at, payment_date, paid_amount, payment_method, payment_sender_bank,
                pdf_status, receipt_pdf_status,
                updated_at, created_at
            ) VALUES (
                ?, ?, ?, ?, ?,
                ?, ?, ?, ?,
                ?, ?, ?, ?, ?, ?,
                ?, ?, ?, ?,
                ?, ?,
                ?, ?, ?, ?, ?,
                ?, ?,
                ?, ?, ?, ?, ?, ?,
                ?, ?,
                ?, ?
            )`,
            args: [
                batchId, noPengajuan, "G1", principle.code, principle.name,
                "05", "2026", "Supervisor Demo", totalNominal,
                "Paid", "Approved by SM", "Approved", "Approved", "Paid", "Waiting Claim Final Verification",
                1, ACTOR_ID, ACTOR_ID, ms(createdDaysAgo - 2),
                ACTOR_ID, ms(createdDaysAgo - 5),
                ACTOR_ID, ms(createdDaysAgo - 8), isoDate(createdDaysAgo - 8), isoDate(createdDaysAgo - 38), "Aman",
                ACTOR_ID, ms(createdDaysAgo - 10),
                ACTOR_ID, ms(paidDaysAgo), isoDate(paidDaysAgo), totalNominal, "Transfer", "BCA",
                "generated", "pending",
                ms(paidDaysAgo), ms(createdDaysAgo),
            ],
        });

        // 2. INSERT OFF Items
        for (const item of items) {
            await db.execute({
                sql: `INSERT INTO off_batch_item (
                    id, batch_id, item_no, row_no, no_surat, nama_program,
                    periode, toko, nominal, cara_bayar, type, deadline,
                    kwt, skp, fp, pc, foto, rekap, others,
                    final_kwt, final_skp, final_fp, final_pc, final_foto, final_rekap, final_others,
                    created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                args: [
                    item.id, batchId, item.itemNo, item.rowNo, item.noSurat, item.namaProgram,
                    item.periode, item.toko, item.nominal, item.caraBayar, "OFF", isoDate(-15),
                    1, 1, 1, 0, 1, 0, 0,
                    0, 0, 0, 0, 0, 0, 0,
                    ms(createdDaysAgo), ms(paidDaysAgo),
                ],
            });
        }

        // 3. INSERT OFF Payment — single full payment
        await db.execute({
            sql: `INSERT INTO off_payment (
                id, batch_id, payment_no, payment_date, paid_amount,
                payment_method, payment_sender_bank, note, created_by, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            args: [
                randomUUID(), batchId, 1, isoDate(paidDaysAgo), totalNominal,
                "Transfer", "BCA", "Full payment demo", ACTOR_ID, ms(paidDaysAgo), ms(paidDaysAgo),
            ],
        });

        // 4. INSERT Claim Workflow — Draft, no noClaim, no documents
        const workflowId = randomUUID();
        const claimWorkflowNo = `DEMO-CW-PAID-${idx}`;
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
                ACTOR_ID, ms(paidDaysAgo - 1), ms(paidDaysAgo - 1),
            ],
        });

        // 5. INSERT Claim Submission — default per_pengajuan, no noClaim
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
                ms(paidDaysAgo - 1), ms(paidDaysAgo - 1),
            ],
        });

        // 6. INSERT Claim Workflow Items (same as OFF items, linked to submission)
        for (const item of items) {
            const dpp = item.nominal;
            await db.execute({
                sql: `INSERT INTO claim_workflow_item (
                    id, claim_workflow_id, claim_submission_id, off_batch_item_id,
                    no_surat, jenis_promosi, periode, outlet,
                    dpp, ppn_rate, ppn_amount, pph_rate, pph_amount, nilai_klaim,
                    status, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                args: [
                    randomUUID(), workflowId, submissionId, item.id,
                    item.noSurat, item.namaProgram, item.periode, item.toko,
                    dpp, 0, 0, 0, 0, dpp,
                    "Draft", ms(paidDaysAgo - 1), ms(paidDaysAgo - 1),
                ],
            });
        }

        // 7. Audit logs
        await db.execute({
            sql: `INSERT INTO off_audit_log (
                id, batch_id, actor_id, actor_name, actor_role, action, to_status, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            args: [randomUUID(), batchId, ACTOR_ID, ACTOR_NAME, "admin", "finance_payment", "Paid", ms(paidDaysAgo)],
        });
        await db.execute({
            sql: `INSERT INTO claim_audit_log (
                id, claim_workflow_id, actor_id, actor_name, actor_role, action, to_status, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            args: [randomUUID(), workflowId, ACTOR_ID, ACTOR_NAME, "admin", "claim_workflow_created", "Draft", ms(paidDaysAgo - 1)],
        });

        console.log(`  [${idx}] ${claimWorkflowNo} | OFF: ${noPengajuan} | ${principle.code} | ${itemCount} items | Rp ${totalNominal.toLocaleString("id-ID")}`);
    }

    console.log("\n[seed-30-paid] Done! 30 workflows created.");
}

// ============================================================================
// MAIN
// ============================================================================
async function main() {
    try {
        await cleanupAll();
        await seed();
        console.log("\n[seed-30-paid] SUCCESS.");
        console.log("  Login: admin@local.test / Password123!");
        console.log("  URL: http://localhost:3000/claim-workflow");
        console.log("  Filter: 'Siap Generate No Claim' → 30 baris muncul.");
        process.exit(0);
    } catch (err) {
        console.error("[seed-30-paid] FATAL:", err);
        process.exit(1);
    }
}
main();
