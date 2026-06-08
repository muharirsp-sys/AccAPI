/*
 * Tujuan: Assign / update No Claim utama untuk Claim Workflow dan otomatis
 *         sync ke semua off_batch_item.no_claim pada OFF batch terkait.
 * Caller: UI detail Claim Workflow (admin/claim) dan tooling internal.
 * Dependensi: drizzle-orm, lib/claim-workflow (audit + session), db schema.
 * Main Functions: PATCH handler.
 * Side Effects:
 *   - Update claim_workflow.no_claim, no_claim_assigned_at, no_claim_assigned_by.
 *   - Update off_batch_item.no_claim untuk semua item pada OFF batch
 *     terkait, semua dalam satu transaksi.
 *   - Insert dua row audit ke claim_audit_log
 *     (`no_claim_assigned`, `no_claim_synced_to_off`).
 *   - Phase R7b: bila default submission tunggal sudah ada, kolom
 *     noClaim di submission tersebut juga ikut di-mirror supaya
 *     source-of-truth submission konsisten dengan cache workflow.
 *
 * Phase R1 — Rewire OFF ↔ Claim No Claim:
 *   No Claim diinput sekali di Claim Workflow, lalu otomatis ditebar ke OFF
 *   item supaya OFF Completed (yang butuh noClaim per item) tidak perlu
 *   diketik manual oleh user. Validasi unik ditangani oleh partial unique
 *   index `idx_claim_workflow_no_claim_unique` + pengecekan eksplisit
 *   sebelum write supaya pesan error lebih jelas ke UI.
 *
 * Phase R7b — Multi No Claim guard:
 *   Bila workflow sudah punya >1 submission, route ini menolak request
 *   dengan code `MULTI_SUBMISSION_NO_CLAIM_ROUTE_DISABLED`. User harus
 *   menggunakan endpoint submission-specific
 *   (`PATCH /[id]/submissions/[submissionId]`) untuk mengubah No Claim.
 *   Hal ini mencegah cache workflow.noClaim tertulis sembarangan saat
 *   ada multiple No Claim.
 */
import { NextResponse } from "next/server";
import { and, eq, ne } from "drizzle-orm";
import { db } from "@/lib/db";
import { claimSubmission, claimWorkflow, offBatchItem } from "@/db/schema";
import {
    canActorReadClaimWorkflow,
    claimAuditScopes,
    claimWorkflowStatuses,
    getOffFinanceGateForNoClaim,
    NO_CLAIM_MAX_LENGTH,
    requireClaimSession,
    writeClaimAudit,
} from "@/lib/claim-workflow";

type Context = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, context: Context) {
    const actor = await requireClaimSession();
    if (!actor) {
        return NextResponse.json(
            { ok: false, error: "Unauthorized" },
            { status: 401 },
        );
    }
    if (!canActorReadClaimWorkflow(actor)) {
        return NextResponse.json(
            { ok: false, error: "Role Anda tidak memiliki akses Claim Workflow." },
            { status: 403 },
        );
    }
    if (actor.role !== "admin" && actor.role !== "claim") {
        return NextResponse.json(
            {
                ok: false,
                code: "CLAIM_WORKFLOW_FORBIDDEN",
                error: "Hanya role admin atau claim yang dapat assign / update No Claim.",
            },
            { status: 403 },
        );
    }

    let body: { noClaim?: unknown } = {};
    if (request.headers.get("content-type")?.includes("application/json")) {
        body = await request.json().catch(() => ({}));
    }
    if (typeof body.noClaim !== "string") {
        return NextResponse.json(
            {
                ok: false,
                code: "NO_CLAIM_INVALID",
                error: "noClaim wajib berupa string.",
            },
            { status: 400 },
        );
    }
    const noClaim = body.noClaim.trim();
    if (!noClaim) {
        return NextResponse.json(
            {
                ok: false,
                code: "NO_CLAIM_EMPTY",
                error: "No Claim tidak boleh kosong.",
            },
            { status: 400 },
        );
    }
    if (noClaim.length > NO_CLAIM_MAX_LENGTH) {
        return NextResponse.json(
            {
                ok: false,
                code: "NO_CLAIM_TOO_LONG",
                error: `No Claim maksimal ${NO_CLAIM_MAX_LENGTH} karakter.`,
            },
            { status: 400 },
        );
    }

    try {
        const { id } = await context.params;

        // Re-read awal di luar transaksi untuk memberi pesan error cepat
        // (404 / Closed / duplicate). Catatan race-condition: pengecekan
        // status `Closed` *wajib* diulang di dalam transaksi karena Close
        // dan Update No Claim bisa berjalan paralel — pengecekan di luar
        // transaksi saja tidak cukup. Lihat blok `db.transaction` di bawah.
        const [preCheck] = await db
            .select()
            .from(claimWorkflow)
            .where(eq(claimWorkflow.id, id));
        if (!preCheck) {
            return NextResponse.json(
                { ok: false, error: "Claim Workflow not found" },
                { status: 404 },
            );
        }
        if (preCheck.status === claimWorkflowStatuses.closed) {
            return NextResponse.json(
                {
                    ok: false,
                    code: "NO_CLAIM_CLOSED_LOCKED",
                    error: "No Claim tidak bisa diubah setelah workflow Closed.",
                },
                { status: 409 },
            );
        }

        // Cek duplicate: noClaim yang sama tidak boleh dipakai oleh Claim
        // Workflow lain. Kalau workflow ini sendiri sudah punya nilai sama,
        // kita izinkan (idempotent re-assign tanpa perubahan).
        const [duplicate] = await db
            .select({ id: claimWorkflow.id, claimWorkflowNo: claimWorkflow.claimWorkflowNo })
            .from(claimWorkflow)
            .where(
                and(
                    eq(claimWorkflow.noClaim, noClaim),
                    ne(claimWorkflow.id, id),
                ),
            );
        if (duplicate) {
            return NextResponse.json(
                {
                    ok: false,
                    code: "NO_CLAIM_DUPLICATE",
                    error: `No Claim "${noClaim}" sudah dipakai Claim Workflow ${duplicate.claimWorkflowNo}.`,
                },
                { status: 409 },
            );
        }

        const now = new Date();

        // Sync ke OFF item dilakukan dalam transaksi yang sama agar
        // claim_workflow.no_claim dan off_batch_item.no_claim tidak pernah
        // berbeda. Kalau salah satu langkah gagal, semuanya rollback.
        const result = await db.transaction(async (tx) => {
            // Re-read di dalam transaksi: race-protection terhadap close
            // konkuren. Bila workflow telah berubah ke Closed setelah
            // pre-check di atas, transaksi rollback dan client menerima
            // error yang sama dengan pre-check.
            const [workflow] = await tx
                .select()
                .from(claimWorkflow)
                .where(eq(claimWorkflow.id, id));
            if (!workflow) {
                return {
                    error: {
                        status: 404,
                        code: "CLAIM_WORKFLOW_NOT_FOUND",
                        message: "Claim Workflow not found",
                    },
                } as const;
            }
            if (workflow.status === claimWorkflowStatuses.closed) {
                return {
                    error: {
                        status: 409,
                        code: "NO_CLAIM_CLOSED_LOCKED",
                        message: "No Claim tidak bisa diubah setelah workflow Closed.",
                    },
                } as const;
            }

            // Gate status: No Claim hanya boleh diubah saat Draft atau Need Revision.
            if (
                workflow.status !== claimWorkflowStatuses.draft &&
                workflow.status !== claimWorkflowStatuses.needRevision
            ) {
                return {
                    error: {
                        status: 409,
                        code: "NO_CLAIM_STATUS_LOCKED",
                        message: `No Claim hanya bisa diubah saat workflow Draft atau Need Revision. Status saat ini: ${workflow.status}.`,
                    },
                } as const;
            }

            // Gate OFF Finance: No Claim hanya boleh di-assign jika OFF
            // Finance sudah Paid (internal payment, bukan claim payment).
            const offFinanceGate = await getOffFinanceGateForNoClaim(tx, workflow.offBatchId);
            if (!offFinanceGate.isPaid) {
                return {
                    error: {
                        status: 409,
                        code: "OFF_FINANCE_NOT_PAID_FOR_NO_CLAIM",
                        message: offFinanceGate.reason || "Menunggu validasi keuangan OFF Program. No Claim baru bisa dibuat setelah Finance OFF Paid.",
                    },
                } as const;
            }

            // Phase R7b — Multi No Claim guard:
            // Route lama hanya boleh menulis cache `claim_workflow.noClaim`
            // jika workflow ini hanya punya satu submission (single-No
            // Claim mode). Bila sudah ada multiple submission, route ini
            // di-disable supaya cache workflow tidak menabrak nilai dari
            // submission manapun. User wajib pakai endpoint
            // `PATCH /[id]/submissions/[submissionId]` untuk update No
            // Claim per submission.
            const submissions = await tx
                .select({ id: claimSubmission.id })
                .from(claimSubmission)
                .where(eq(claimSubmission.claimWorkflowId, id));
            if (submissions.length > 1) {
                return {
                    error: {
                        status: 409,
                        code: "MULTI_SUBMISSION_NO_CLAIM_ROUTE_DISABLED",
                        message: "Workflow memiliki beberapa No Claim. Update No Claim lewat submission.",
                    },
                } as const;
            }
            const targetSubmissionId = submissions[0]?.id ?? null;

            const previousNoClaim = workflow.noClaim ?? null;

            await tx
                .update(claimWorkflow)
                .set({
                    noClaim,
                    noClaimAssignedAt: now,
                    noClaimAssignedBy: actor.id,
                    updatedAt: now,
                })
                .where(eq(claimWorkflow.id, id));

            // Mirror nilai noClaim ke default submission (kalau ada)
            // supaya source-of-truth submission tetap konsisten dengan
            // cache workflow. Kasus tidak ada submission masih mungkin
            // untuk workflow lama yang belum di-backfill — biarkan,
            // route lama tetap menulis cache supaya R1-R6 tetap jalan.
            if (targetSubmissionId) {
                await tx
                    .update(claimSubmission)
                    .set({
                        noClaim,
                        noClaimAssignedAt: now,
                        noClaimAssignedBy: actor.id,
                        updatedAt: now,
                    })
                    .where(eq(claimSubmission.id, targetSubmissionId));
            }

            const updateResult = await tx
                .update(offBatchItem)
                .set({ noClaim, updatedAt: now })
                .where(eq(offBatchItem.batchId, workflow.offBatchId))
                .returning({ id: offBatchItem.id });
            const syncedItemCount = updateResult.length;

            await writeClaimAudit(
                {
                    claimWorkflowId: id,
                    claimSubmissionId: targetSubmissionId,
                    auditScope: targetSubmissionId
                        ? claimAuditScopes.submission
                        : claimAuditScopes.workflow,
                    actor,
                    action: "no_claim_assigned",
                    fromStatus: workflow.status,
                    toStatus: workflow.status,
                    metadata: {
                        previousNoClaim,
                        newNoClaim: noClaim,
                        offBatchId: workflow.offBatchId,
                        assignedBy: actor.id,
                        submissionId: targetSubmissionId,
                        viaLegacyWorkflowRoute: true,
                    },
                },
                tx,
            );
            await writeClaimAudit(
                {
                    claimWorkflowId: id,
                    claimSubmissionId: targetSubmissionId,
                    auditScope: targetSubmissionId
                        ? claimAuditScopes.submission
                        : claimAuditScopes.workflow,
                    actor,
                    action: "no_claim_synced_to_off",
                    fromStatus: workflow.status,
                    toStatus: workflow.status,
                    metadata: {
                        previousNoClaim,
                        newNoClaim: noClaim,
                        offBatchId: workflow.offBatchId,
                        syncedItemCount,
                        assignedBy: actor.id,
                        submissionId: targetSubmissionId,
                        viaLegacyWorkflowRoute: true,
                    },
                },
                tx,
            );

            return {
                ok: true,
                offBatchId: workflow.offBatchId,
                syncedItemCount,
                submissionId: targetSubmissionId,
            } as const;
        });

        if (result.error) {
            return NextResponse.json(
                { ok: false, code: result.error.code, error: result.error.message },
                { status: result.error.status },
            );
        }

        return NextResponse.json({
            ok: true,
            success: true,
            workflow: {
                id,
                noClaim,
                noClaimAssignedAt: now,
                noClaimAssignedBy: actor.id,
            },
            sync: {
                offBatchId: result.offBatchId,
                syncedItemCount: result.syncedItemCount,
                submissionId: result.submissionId,
            },
        });
    } catch (error) {
        // SQLite UNIQUE constraint dari partial unique index. Defensif:
        // walaupun sudah dicek di atas, race condition antar request tetap
        // mungkin meraih constraint sebelum response sampai ke client.
        const message = error instanceof Error ? error.message.toLowerCase() : "";
        if (message.includes("unique") && message.includes("no_claim")) {
            return NextResponse.json(
                {
                    ok: false,
                    code: "NO_CLAIM_DUPLICATE",
                    error: "No Claim sudah dipakai Claim Workflow lain.",
                },
                { status: 409 },
            );
        }
        console.error("[CLAIM WORKFLOW NO CLAIM ASSIGN ERROR]", error);
        return NextResponse.json(
            { ok: false, error: "Gagal assign No Claim Claim Workflow." },
            { status: 500 },
        );
    }
}
