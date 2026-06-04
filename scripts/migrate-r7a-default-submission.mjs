// Tujuan: Phase R7a backfill — buat 1 default `claim_submission` per
//         `claim_workflow` existing dan kaitkan child rows
//         (`claim_workflow_item`, `claim_payment`) ke submission tersebut.
// Caller: `node scripts/migrate-r7a-default-submission.mjs` atau (opsional)
//         `npm run migrate:r7a-submissions`.
// Side Effects:
//   - INSERT row baru di `claim_submission`.
//   - UPDATE `claim_workflow_item.claim_submission_id` (hanya yang masih NULL).
//   - UPDATE `claim_payment.claim_submission_id` (hanya yang masih NULL).
//   - UPDATE `claim_workflow.source_type` ke `'off_program'` jika kosong.
//   - UPDATE `claim_workflow.source_ref_id` ke `off_batch_id` jika kosong.
//   - UPDATE `claim_workflow.aggregate_status` ke `status` jika kosong.
//   - TIDAK menyentuh user/session/account.
//   - TIDAK memindahkan file PDF.
//   - TIDAK menghapus row apapun.
//
// Aturan:
//   - Refuse non-lokal DATABASE_URL.
//   - Idempotent: row workflow yang sudah punya minimal 1 submission akan
//     di-skip total. Re-run aman.
//   - Single transaction untuk seluruh dataset. Bila ada row gagal,
//     transaksi rollback dan tidak ada efek partial.
//   - Tidak ada perubahan ke UI/route.

import { createClient } from "@libsql/client";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";

// =============================================================================
// SECTION 1 — env loader + local SQLite guard
// =============================================================================

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
    console.error(`[migrate-r7a] REFUSED: DATABASE_URL terlihat non-lokal (${databaseUrl}).`);
    process.exit(2);
}

const db = createClient({ url: databaseUrl });

// =============================================================================
// SECTION 2 — pre-flight checks
// =============================================================================

async function tableExists(name) {
    const result = await db.execute({
        sql: "SELECT name FROM sqlite_master WHERE type='table' AND name = ?",
        args: [name],
    });
    return result.rows.length > 0;
}

async function ensureRequiredTables() {
    const required = [
        "claim_workflow",
        "claim_submission",
        "claim_workflow_item",
        "claim_payment",
    ];
    const missing = [];
    for (const table of required) {
        if (!(await tableExists(table))) missing.push(table);
    }
    if (missing.length > 0) {
        console.error(
            `[migrate-r7a] FAILED: tabel berikut belum ada di DB: ${missing.join(", ")}`,
        );
        console.error(
            "[migrate-r7a] Jalankan dulu: node scripts/init-db.mjs",
        );
        process.exit(3);
    }
}

// =============================================================================
// SECTION 3 — helpers (mirror lib/claim-workflow/submissions.ts logic)
// =============================================================================
//
// Catatan: helper di bawah sengaja diduplikasi sebagai pure JS supaya
// migration script tetap berjalan tanpa setup TypeScript runtime
// (tsx/ts-node). Logic harus mengikuti `buildDefaultSubmissionFromWorkflow`
// di lib/claim-workflow/submissions.ts. Bila kebutuhan berkembang, satu
// dari kedua tempat ini bisa di-port menjadi modul lain — untuk R7a kita
// terima minor duplication demi kemudahan operate.

const SCOPE_PER_PENGAJUAN = "per_pengajuan";
const SOURCE_OFF_PROGRAM = "off_program";

function defaultScopeLabel(workflow) {
    const trimmed = String(workflow.claim_workflow_no ?? "").trim();
    return trimmed.length > 0 ? trimmed : "Pengajuan utama";
}

function nowMs() {
    return Date.now();
}

// =============================================================================
// SECTION 4 — main
// =============================================================================

async function main() {
    console.log(`Database: ${databaseUrl}`);
    console.log("");
    console.log("Phase R7a backfill — default claim_submission per claim_workflow");
    console.log("");

    await ensureRequiredTables();

    const workflowsResult = await db.execute(
        `SELECT id, claim_workflow_no, off_batch_id, status, no_claim,
                no_claim_assigned_at, no_claim_assigned_by,
                total_dpp, total_ppn, total_pph, total_claim,
                total_paid, remaining_amount,
                submitted_to_principal_at,
                claim_letter_pdf_path, claim_letter_generated_at, claim_letter_generated_by,
                summary_pdf_path, summary_generated_at, summary_generated_by,
                receipt_pdf_path, receipt_generated_at, receipt_generated_by,
                closed_at, closed_by, close_note,
                source_type, source_ref_id, aggregate_status,
                created_by, created_at
         FROM claim_workflow
         ORDER BY created_at ASC`,
    );

    const workflows = workflowsResult.rows;
    if (workflows.length === 0) {
        console.log("Tidak ada claim_workflow untuk dimigrate.");
        return;
    }

    let workflowsScanned = 0;
    let submissionsCreated = 0;
    let itemsLinked = 0;
    let paymentsLinked = 0;
    let workflowsUpdated = 0;
    let skippedExisting = 0;

    // Single transaction. libsql/SQLite transaksi besar tetap aman karena
    // jumlah workflow internal kecil; rollback total bila salah satu row
    // gagal.
    await db.execute("BEGIN IMMEDIATE TRANSACTION");
    try {
        for (const w of workflows) {
            workflowsScanned += 1;
            const workflowId = String(w.id);

            // Skip kalau sudah punya submission. Idempotent.
            const existing = await db.execute({
                sql: "SELECT id FROM claim_submission WHERE claim_workflow_id = ? LIMIT 1",
                args: [workflowId],
            });

            let submissionId;
            if (existing.rows.length > 0) {
                submissionId = String(existing.rows[0].id);
                skippedExisting += 1;
                console.log(`  [skip ] workflow ${workflowId} sudah punya submission ${submissionId}`);
            } else {
                submissionId = randomUUID();
                const submissionNow = nowMs();
                const submissionCreatedAt = w.created_at ?? submissionNow;

                try {
                    await db.execute({
                        sql: `INSERT INTO claim_submission (
                                id, claim_workflow_id, no_claim, no_claim_assigned_at,
                                no_claim_assigned_by, scope, scope_label, status,
                                total_dpp, total_ppn, total_pph, total_claim,
                                total_paid, remaining_amount, submitted_to_principal_at,
                                claim_letter_pdf_path, claim_letter_generated_at, claim_letter_generated_by,
                                summary_pdf_path, summary_generated_at, summary_generated_by,
                                receipt_pdf_path, receipt_generated_at, receipt_generated_by,
                                closed_at, closed_by, close_note,
                                created_by, created_at, updated_at
                              ) VALUES (
                                ?, ?, ?, ?,
                                ?, ?, ?, ?,
                                ?, ?, ?, ?,
                                ?, ?, ?,
                                ?, ?, ?,
                                ?, ?, ?,
                                ?, ?, ?,
                                ?, ?, ?,
                                ?, ?, ?
                              )`,
                        args: [
                            submissionId,
                            workflowId,
                            w.no_claim ?? null,
                            w.no_claim_assigned_at ?? null,
                            w.no_claim_assigned_by ?? null,
                            SCOPE_PER_PENGAJUAN,
                            defaultScopeLabel(w),
                            String(w.status ?? "Draft"),
                            Number(w.total_dpp ?? 0),
                            Number(w.total_ppn ?? 0),
                            Number(w.total_pph ?? 0),
                            Number(w.total_claim ?? 0),
                            Number(w.total_paid ?? 0),
                            Number(w.remaining_amount ?? 0),
                            w.submitted_to_principal_at ?? null,
                            w.claim_letter_pdf_path ?? null,
                            w.claim_letter_generated_at ?? null,
                            w.claim_letter_generated_by ?? null,
                            w.summary_pdf_path ?? null,
                            w.summary_generated_at ?? null,
                            w.summary_generated_by ?? null,
                            w.receipt_pdf_path ?? null,
                            w.receipt_generated_at ?? null,
                            w.receipt_generated_by ?? null,
                            w.closed_at ?? null,
                            w.closed_by ?? null,
                            w.close_note ?? null,
                            w.created_by ?? null,
                            submissionCreatedAt,
                            submissionNow,
                        ],
                    });
                } catch (insertError) {
                    const message = insertError instanceof Error
                        ? insertError.message.toLowerCase()
                        : "";
                    if (message.includes("unique") && message.includes("no_claim")) {
                        console.error(
                            `[migrate-r7a] UNIQUE conflict: workflow ${workflowId} memiliki no_claim "${w.no_claim ?? ""}" yang sudah dipakai submission lain.`,
                        );
                        console.error(
                            "[migrate-r7a] Backfill dihentikan. Periksa duplikasi no_claim sebelum re-run.",
                        );
                    }
                    throw insertError;
                }

                submissionsCreated += 1;
                console.log(`  [build] workflow ${workflowId} -> submission ${submissionId}`);
            }

            // Link items yang masih NULL.
            const itemUpdate = await db.execute({
                sql: `UPDATE claim_workflow_item
                       SET claim_submission_id = ?
                     WHERE claim_workflow_id = ?
                       AND claim_submission_id IS NULL`,
                args: [submissionId, workflowId],
            });
            const itemAffected = Number(itemUpdate.rowsAffected ?? 0);
            itemsLinked += itemAffected;
            if (itemAffected > 0) {
                console.log(`         ${itemAffected} item(s) di-link ke submission`);
            }

            // Link payments yang masih NULL.
            const paymentUpdate = await db.execute({
                sql: `UPDATE claim_payment
                       SET claim_submission_id = ?
                     WHERE claim_workflow_id = ?
                       AND claim_submission_id IS NULL`,
                args: [submissionId, workflowId],
            });
            const paymentAffected = Number(paymentUpdate.rowsAffected ?? 0);
            paymentsLinked += paymentAffected;
            if (paymentAffected > 0) {
                console.log(`         ${paymentAffected} payment(s) di-link ke submission`);
            }

            // Set source/aggregate metadata bila kosong.
            const sourceType = w.source_type ?? null;
            const sourceRefId = w.source_ref_id ?? null;
            const aggregateStatus = w.aggregate_status ?? null;
            const needsSourceUpdate = (
                !sourceType ||
                String(sourceType).trim() === "" ||
                sourceRefId === null ||
                aggregateStatus === null
            );
            if (needsSourceUpdate) {
                await db.execute({
                    sql: `UPDATE claim_workflow
                           SET source_type = COALESCE(NULLIF(source_type, ''), ?),
                               source_ref_id = COALESCE(source_ref_id, ?),
                               aggregate_status = COALESCE(aggregate_status, ?)
                         WHERE id = ?`,
                    args: [
                        SOURCE_OFF_PROGRAM,
                        w.off_batch_id ?? null,
                        String(w.status ?? "Draft"),
                        workflowId,
                    ],
                });
                workflowsUpdated += 1;
            }
        }

        await db.execute("COMMIT");
    } catch (error) {
        await db.execute("ROLLBACK").catch(() => {});
        console.error("[migrate-r7a] FAILED — transaksi rollback:", error);
        process.exit(1);
    }

    console.log("");
    console.log("Selesai. Ringkasan:");
    console.log(`  workflowsScanned   : ${workflowsScanned}`);
    console.log(`  submissionsCreated : ${submissionsCreated}`);
    console.log(`  skippedExisting    : ${skippedExisting}`);
    console.log(`  itemsLinked        : ${itemsLinked}`);
    console.log(`  paymentsLinked     : ${paymentsLinked}`);
    console.log(`  workflowsUpdated   : ${workflowsUpdated}`);
    console.log("");
    console.log("Catatan:");
    console.log("  - Tidak ada row yang dihapus.");
    console.log("  - File PDF tidak dipindah; default submission share path file dengan workflow legacy.");
    console.log("  - claim_workflow.no_claim masih jadi cache display sampai R7e selesai.");
}

main().catch((error) => {
    console.error("[migrate-r7a] UNCAUGHT:", error);
    process.exit(1);
});
