/*
 * Tujuan: Assign / move items ke Claim Submission. Phase R7b.
 *         Semua item dalam workflow harus berada di tepat satu
 *         submission. Endpoint ini memindahkan satu atau lebih
 *         `claim_workflow_item` ke target `claim_submission`.
 * Caller: UI claim-workflow detail page (R7b dan ke depan).
 * Side Effects:
 *   - Update `claim_workflow_item.claim_submission_id` untuk item
 *     terdaftar.
 *   - Recalc totals untuk submission target dan submission lama
 *     (yang ditinggalkan).
 *   - Recalc cache aggregate `claim_workflow` totals dari sum
 *     submissions.
 *   - Sync `noClaim` submission target ke `off_batch_item.noClaim`
 *     untuk item yang baru pindah, bila submission target sudah
 *     punya noClaim.
 *   - Audit `claim_submission_items_assigned` ditulis dalam transaksi
 *     yang sama.
 */
import { NextResponse } from "next/server";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import {
    claimSubmission,
    claimWorkflow,
    claimWorkflowItem,
    offBatchItem,
} from "@/db/schema";
import {
    claimAuditScopes,
    claimWorkflowStatuses,
    isSubmissionEditableWorkflowStatus,
    recalcSubmissionTotals,
    recalcWorkflowAggregateFromSubmissions,
    requireClaimSession,
    writeClaimAudit,
} from "@/lib/claim-workflow";

type Context = { params: Promise<{ id: string; submissionId: string }> };

const MAX_ITEMS_PER_REQUEST = 200;

export async function POST(request: Request, context: Context) {
    const actor = await requireClaimSession();
    if (!actor) {
        return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }
    if (actor.role !== "admin" && actor.role !== "claim") {
        return NextResponse.json({
            ok: false,
            code: "CLAIM_SUBMISSION_FORBIDDEN",
            error: "Hanya role admin atau claim yang dapat memindahkan item antar submission.",
        }, { status: 403 });
    }

    let body: { itemIds?: unknown } = {};
    if (request.headers.get("content-type")?.includes("application/json")) {
        body = await request.json().catch(() => ({}));
    }
    if (!Array.isArray(body.itemIds) || body.itemIds.length === 0) {
        return NextResponse.json({
            ok: false,
            code: "CLAIM_SUBMISSION_ITEMS_REQUIRED",
            error: "itemIds wajib berupa array non-empty.",
        }, { status: 400 });
    }
    const itemIds = body.itemIds
        .filter((value): value is string => typeof value === "string" && value.length > 0)
        .slice(0, MAX_ITEMS_PER_REQUEST);
    if (itemIds.length === 0) {
        return NextResponse.json({
            ok: false,
            code: "CLAIM_SUBMISSION_ITEMS_INVALID",
            error: "itemIds harus berisi string non-empty.",
        }, { status: 400 });
    }
    const uniqueItemIds = Array.from(new Set(itemIds));

    try {
        const { id, submissionId } = await context.params;

        const result = await db.transaction(async (tx) => {
            const [workflow] = await tx
                .select()
                .from(claimWorkflow)
                .where(eq(claimWorkflow.id, id));
            if (!workflow) {
                return { error: { status: 404, code: "CLAIM_WORKFLOW_NOT_FOUND", message: "Claim Workflow not found" } } as const;
            }
            if (workflow.status === claimWorkflowStatuses.closed) {
                return {
                    error: {
                        status: 409,
                        code: "CLAIM_SUBMISSION_WORKFLOW_CLOSED",
                        message: "Claim Workflow sudah Closed; item tidak dapat dipindah.",
                    },
                } as const;
            }
            if (!isSubmissionEditableWorkflowStatus(workflow.status)) {
                return {
                    error: {
                        status: 409,
                        code: "CLAIM_SUBMISSION_WORKFLOW_LOCKED",
                        message: "Item submission hanya dapat diubah saat workflow Draft atau Need Revision.",
                    },
                } as const;
            }

            const [submission] = await tx
                .select()
                .from(claimSubmission)
                .where(eq(claimSubmission.id, submissionId));
            if (!submission || submission.claimWorkflowId !== id) {
                return {
                    error: {
                        status: 404,
                        code: "CLAIM_SUBMISSION_NOT_FOUND",
                        message: "Claim Submission tidak ditemukan untuk workflow ini.",
                    },
                } as const;
            }

            // Pastikan semua item milik workflow ini.
            const items = await tx
                .select({
                    id: claimWorkflowItem.id,
                    claimWorkflowId: claimWorkflowItem.claimWorkflowId,
                    claimSubmissionId: claimWorkflowItem.claimSubmissionId,
                    offBatchItemId: claimWorkflowItem.offBatchItemId,
                })
                .from(claimWorkflowItem)
                .where(inArray(claimWorkflowItem.id, uniqueItemIds));
            if (items.length !== uniqueItemIds.length) {
                return {
                    error: {
                        status: 404,
                        code: "CLAIM_SUBMISSION_ITEM_NOT_FOUND",
                        message: "Satu atau lebih item tidak ditemukan.",
                    },
                } as const;
            }
            const wrongWorkflow = items.find((row) => row.claimWorkflowId !== id);
            if (wrongWorkflow) {
                return {
                    error: {
                        status: 409,
                        code: "CLAIM_SUBMISSION_ITEM_WRONG_WORKFLOW",
                        message: `Item ${wrongWorkflow.id} bukan milik Claim Workflow ini.`,
                    },
                } as const;
            }

            // Tentukan submission lama yang terdampak (untuk recalc totals).
            const previousSubmissionIds = Array.from(
                new Set(
                    items
                        .map((row) => row.claimSubmissionId)
                        .filter((value): value is string => typeof value === "string" && value !== submissionId),
                ),
            );

            const now = new Date();

            // Update assignment.
            await tx
                .update(claimWorkflowItem)
                .set({ claimSubmissionId: submissionId, updatedAt: now })
                .where(
                    and(
                        eq(claimWorkflowItem.claimWorkflowId, id),
                        inArray(claimWorkflowItem.id, uniqueItemIds),
                    ),
                );

            // Recalc target submission terlebih dahulu, lalu submission
            // lama. Submission lama yang kosong akan ber-totalClaim 0
            // tetapi tetap dipertahankan (tidak di-delete otomatis).
            await recalcSubmissionTotals(tx, submissionId, now);
            for (const oldId of previousSubmissionIds) {
                await recalcSubmissionTotals(tx, oldId, now);
            }

            // Recalc workflow cache aggregate dari sum submissions.
            const aggregate = await recalcWorkflowAggregateFromSubmissions(tx, id, now);

            // Sync noClaim submission target ke off_batch_item untuk
            // item yang baru pindah saja. Bila submission target belum
            // punya noClaim, tidak ada sync. Hanya item yang sebelumnya
            // di submission lain (atau NULL) yang ikut sync.
            let syncedItemCount = 0;
            if (submission.noClaim) {
                const movedOffItemIds = items
                    .filter((row) => row.claimSubmissionId !== submissionId)
                    .map((row) => row.offBatchItemId)
                    .filter((value): value is string => typeof value === "string" && value.length > 0);
                if (movedOffItemIds.length > 0) {
                    const updateResult = await tx
                        .update(offBatchItem)
                        .set({ noClaim: submission.noClaim, updatedAt: now })
                        .where(inArray(offBatchItem.id, movedOffItemIds))
                        .returning({ id: offBatchItem.id });
                    syncedItemCount = updateResult.length;
                }
            }

            await writeClaimAudit({
                claimWorkflowId: id,
                claimSubmissionId: submissionId,
                auditScope: claimAuditScopes.submission,
                actor,
                action: "claim_submission_items_assigned",
                fromStatus: submission.status,
                toStatus: submission.status,
                metadata: {
                    submissionId,
                    itemIds: uniqueItemIds,
                    itemCount: uniqueItemIds.length,
                    previousSubmissionIds,
                    syncedItemCount,
                    submissionNoClaim: submission.noClaim,
                    workflowAggregate: aggregate,
                },
            }, tx);

            return {
                ok: true,
                syncedItemCount,
                previousSubmissionIds,
                aggregate,
            } as const;
        });

        if (result.error) {
            return NextResponse.json(
                { ok: false, code: result.error.code, error: result.error.message },
                { status: result.error.status },
            );
        }

        const { id: workflowId, submissionId: submissionParamId } = await context.params;
        const [updatedSubmission] = await db
            .select()
            .from(claimSubmission)
            .where(eq(claimSubmission.id, submissionParamId));
        const [updatedWorkflow] = await db
            .select({
                id: claimWorkflow.id,
                totalDpp: claimWorkflow.totalDpp,
                totalPpn: claimWorkflow.totalPpn,
                totalPph: claimWorkflow.totalPph,
                totalClaim: claimWorkflow.totalClaim,
                totalPaid: claimWorkflow.totalPaid,
                remainingAmount: claimWorkflow.remainingAmount,
                aggregateStatus: claimWorkflow.aggregateStatus,
                status: claimWorkflow.status,
            })
            .from(claimWorkflow)
            .where(eq(claimWorkflow.id, workflowId));

        return NextResponse.json({
            ok: true,
            success: true,
            submission: updatedSubmission,
            workflow: updatedWorkflow,
            sync: {
                syncedItemCount: result.syncedItemCount,
                previousSubmissionIds: result.previousSubmissionIds,
            },
            assignedItemCount: uniqueItemIds.length,
        });
    } catch (error) {
        console.error("[CLAIM SUBMISSION ITEMS ASSIGN ERROR]", error);
        return NextResponse.json({
            ok: false,
            error: "Gagal memindahkan item ke Claim Submission.",
        }, { status: 500 });
    }
}
