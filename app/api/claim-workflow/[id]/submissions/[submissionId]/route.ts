/*
 * Tujuan: GET detail satu Claim Submission + PATCH untuk update scope,
 *         scopeLabel, atau noClaim. Phase R7b — Submission grouping +
 *         item assignment.
 * Caller: UI claim-workflow detail page (R7b dan ke depan).
 * Side Effects:
 *   GET   : tidak menulis DB.
 *   PATCH : update claim_submission, opsional sync ke off_batch_item
 *           untuk item yang ditugaskan ke submission ini, dan mirror
 *           cache `claim_workflow.noClaim` bila workflow hanya punya
 *           satu submission. Audit `claim_submission_updated` dan
 *           opsional `no_claim_assigned` + `no_claim_synced_to_off`.
 */
import { unlink } from "node:fs/promises";
import { NextResponse } from "next/server";
import { and, asc, eq, inArray, ne } from "drizzle-orm";
import { db } from "@/lib/db";
import {
    claimSubmission,
    claimWorkflow,
    claimWorkflowItem,
    offBatchItem,
} from "@/db/schema";
import {
    assertSubmissionBelongsToWorkflow,
    canActorReadClaimWorkflow,
    claimAuditScopes,
    claimSubmissionScopeList,
    claimWorkflowStatuses,
    getOffFinanceGateForNoClaim,
    isSubmissionEditableWorkflowStatus,
    isPathInsideClaimDocumentRoot,
    NO_CLAIM_MAX_LENGTH,
    requireClaimSession,
    SCOPE_LABEL_MAX_LENGTH,
    writeClaimAudit,
} from "@/lib/claim-workflow";

type Context = { params: Promise<{ id: string; submissionId: string }> };

function isValidScope(value: unknown): value is typeof claimSubmissionScopeList[number] {
    return typeof value === "string"
        && (claimSubmissionScopeList as ReadonlyArray<string>).includes(value);
}

export async function GET(_request: Request, context: Context) {
    const actor = await requireClaimSession();
    if (!actor) {
        return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }
    if (!canActorReadClaimWorkflow(actor)) {
        return NextResponse.json({
            ok: false,
            error: "Role Anda tidak memiliki akses Claim Workflow.",
        }, { status: 403 });
    }

    try {
        const { id, submissionId } = await context.params;
        const submission = await assertSubmissionBelongsToWorkflow(submissionId, id).catch((error) => {
            return { __error: error } as { __error: unknown };
        });
        if ("__error" in submission) {
            const err = submission.__error as { code?: string; status?: number; message?: string };
            return NextResponse.json({
                ok: false,
                code: err.code || "CLAIM_SUBMISSION_NOT_FOUND",
                error: err.message || "Claim Submission not found",
            }, { status: err.status || 404 });
        }

        const items = await db
            .select()
            .from(claimWorkflowItem)
            .where(eq(claimWorkflowItem.claimSubmissionId, submissionId))
            .orderBy(asc(claimWorkflowItem.createdAt));

        return NextResponse.json({
            ok: true,
            submission: {
                ...submission,
                itemCount: items.length,
            },
            items,
        });
    } catch (error) {
        console.error("[CLAIM SUBMISSION DETAIL ERROR]", error);
        return NextResponse.json({
            ok: false,
            error: "Gagal mengambil detail Claim Submission.",
        }, { status: 500 });
    }
}

export async function PATCH(request: Request, context: Context) {
    const actor = await requireClaimSession();
    if (!actor) {
        return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }
    if (actor.role !== "admin" && actor.role !== "claim") {
        return NextResponse.json({
            ok: false,
            code: "CLAIM_SUBMISSION_FORBIDDEN",
            error: "Hanya role admin atau claim yang dapat mengubah Claim Submission.",
        }, { status: 403 });
    }

    let body: { scope?: unknown; scopeLabel?: unknown; noClaim?: unknown } = {};
    if (request.headers.get("content-type")?.includes("application/json")) {
        body = await request.json().catch(() => ({}));
    }

    // Validate inputs (allow undefined → no change).
    if (body.scope !== undefined && !isValidScope(body.scope)) {
        return NextResponse.json({
            ok: false,
            code: "CLAIM_SUBMISSION_INVALID_SCOPE",
            error: `Scope tidak valid. Pilih dari: ${claimSubmissionScopeList.join(", ")}.`,
        }, { status: 400 });
    }
    if (body.scopeLabel !== undefined && body.scopeLabel !== null && typeof body.scopeLabel !== "string") {
        return NextResponse.json({
            ok: false,
            code: "CLAIM_SUBMISSION_INVALID_SCOPE_LABEL",
            error: "scopeLabel harus berupa string atau null.",
        }, { status: 400 });
    }
    if (body.noClaim !== undefined && body.noClaim !== null && typeof body.noClaim !== "string") {
        return NextResponse.json({
            ok: false,
            code: "CLAIM_SUBMISSION_INVALID_NO_CLAIM",
            error: "noClaim harus berupa string atau null.",
        }, { status: 400 });
    }

    let nextNoClaim: string | null | undefined = undefined;
    if (body.noClaim !== undefined) {
        if (body.noClaim === null) {
            nextNoClaim = null;
        } else {
            const trimmed = (body.noClaim as string).trim();
            if (trimmed === "") {
                return NextResponse.json({
                    ok: false,
                    code: "CLAIM_SUBMISSION_NO_CLAIM_EMPTY",
                    error: "noClaim tidak boleh string kosong. Kirim null untuk menghapus.",
                }, { status: 400 });
            }
            if (trimmed.length > NO_CLAIM_MAX_LENGTH) {
                return NextResponse.json({
                    ok: false,
                    code: "CLAIM_SUBMISSION_NO_CLAIM_TOO_LONG",
                    error: `noClaim maksimal ${NO_CLAIM_MAX_LENGTH} karakter.`,
                }, { status: 400 });
            }
            nextNoClaim = trimmed;
        }
    }

    let nextScope: string | undefined;
    if (body.scope !== undefined && isValidScope(body.scope)) {
        nextScope = body.scope;
    }
    let nextScopeLabel: string | null | undefined = undefined;
    if (body.scopeLabel !== undefined) {
        if (body.scopeLabel === null) {
            nextScopeLabel = null;
        } else {
            const trimmed = (body.scopeLabel as string).trim().slice(0, SCOPE_LABEL_MAX_LENGTH);
            nextScopeLabel = trimmed === "" ? null : trimmed;
        }
    }

    if (nextScope === undefined && nextScopeLabel === undefined && nextNoClaim === undefined) {
        return NextResponse.json({
            ok: false,
            code: "CLAIM_SUBMISSION_NO_CHANGES",
            error: "Tidak ada perubahan. Berikan scope, scopeLabel, atau noClaim.",
        }, { status: 400 });
    }

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
                        message: "Claim Workflow sudah Closed; submission tidak dapat diubah.",
                    },
                } as const;
            }
            if (!isSubmissionEditableWorkflowStatus(workflow.status)) {
                return {
                    error: {
                        status: 409,
                        code: "CLAIM_SUBMISSION_WORKFLOW_LOCKED",
                        message: "Submission hanya dapat diubah saat workflow Draft atau Need Revision.",
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

            const previousNoClaim = submission.noClaim;
            const noClaimChanged = nextNoClaim !== undefined && nextNoClaim !== previousNoClaim;
            const invalidatedDocumentPaths: Array<{
                type: "letter" | "summary" | "receipt";
                path: string;
            }> = [];

            // Gate OFF Finance: No Claim hanya boleh di-assign jika OFF
            // Finance sudah Paid. Gate hanya aktif saat noClaim berubah
            // ke nilai non-null (assign baru atau ganti). Clear (null)
            // diizinkan tanpa gate supaya user bisa reset jika salah.
            if (noClaimChanged && nextNoClaim) {
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
            }

            // Cek duplicate global bila noClaim baru non-null.
            if (noClaimChanged && nextNoClaim) {
                const [duplicate] = await tx
                    .select({ id: claimSubmission.id, claimWorkflowId: claimSubmission.claimWorkflowId })
                    .from(claimSubmission)
                    .where(
                        and(
                            eq(claimSubmission.noClaim, nextNoClaim),
                            ne(claimSubmission.id, submissionId),
                        ),
                    );
                if (duplicate) {
                    return {
                        error: {
                            status: 409,
                            code: "CLAIM_SUBMISSION_NO_CLAIM_DUPLICATE",
                            message: `noClaim "${nextNoClaim}" sudah dipakai submission lain (workflow ${duplicate.claimWorkflowId}).`,
                        },
                    } as const;
                }
            }

            const now = new Date();

            const updatePayload: Partial<typeof claimSubmission.$inferInsert> = {
                updatedAt: now,
            };
            if (nextScope !== undefined) updatePayload.scope = nextScope;
            if (nextScopeLabel !== undefined) updatePayload.scopeLabel = nextScopeLabel;
            if (nextNoClaim !== undefined) {
                updatePayload.noClaim = nextNoClaim;
                updatePayload.noClaimAssignedAt = nextNoClaim ? now : null;
                updatePayload.noClaimAssignedBy = nextNoClaim ? actor.id : null;
            }
            if (noClaimChanged) {
                if (submission.claimLetterPdfPath) {
                    invalidatedDocumentPaths.push({ type: "letter", path: submission.claimLetterPdfPath });
                }
                if (submission.summaryPdfPath) {
                    invalidatedDocumentPaths.push({ type: "summary", path: submission.summaryPdfPath });
                }
                if (submission.receiptPdfPath) {
                    invalidatedDocumentPaths.push({ type: "receipt", path: submission.receiptPdfPath });
                }
                if (invalidatedDocumentPaths.length > 0) {
                    updatePayload.claimLetterPdfPath = null;
                    updatePayload.claimLetterGeneratedAt = null;
                    updatePayload.claimLetterGeneratedBy = null;
                    updatePayload.summaryPdfPath = null;
                    updatePayload.summaryGeneratedAt = null;
                    updatePayload.summaryGeneratedBy = null;
                    updatePayload.receiptPdfPath = null;
                    updatePayload.receiptGeneratedAt = null;
                    updatePayload.receiptGeneratedBy = null;
                }
            }

            await tx
                .update(claimSubmission)
                .set(updatePayload)
                .where(eq(claimSubmission.id, submissionId));

            // Sync noClaim ke off_batch_item HANYA untuk item yang
            // ditugaskan ke submission ini. Bila item belum di-link
            // (claim_submission_id NULL), tidak ikut. Bila item ter-link
            // tapi tidak punya offBatchItemId (mis. item manual masa
            // depan), juga tidak ikut.
            let syncedItemCount = 0;
            if (noClaimChanged) {
                const submissionItems = await tx
                    .select({
                        id: claimWorkflowItem.id,
                        offBatchItemId: claimWorkflowItem.offBatchItemId,
                    })
                    .from(claimWorkflowItem)
                    .where(eq(claimWorkflowItem.claimSubmissionId, submissionId));

                const offItemIds = submissionItems
                    .map((row) => row.offBatchItemId)
                    .filter((value): value is string => typeof value === "string" && value.length > 0);

                if (offItemIds.length > 0) {
                    const updateResult = await tx
                        .update(offBatchItem)
                        .set({ noClaim: nextNoClaim, updatedAt: now })
                        .where(inArray(offBatchItem.id, offItemIds))
                        .returning({ id: offBatchItem.id });
                    syncedItemCount = updateResult.length;
                }
            }

            // Mirror cache `claim_workflow.noClaim` SETELAH update bila
            // workflow hanya punya 1 submission. Selama transisi R7b,
            // cache ini tetap dipakai oleh route lama.
            let workflowNoClaimMirrored = false;
            if (noClaimChanged) {
                const allSubmissions = await tx
                    .select({ id: claimSubmission.id, noClaim: claimSubmission.noClaim })
                    .from(claimSubmission)
                    .where(eq(claimSubmission.claimWorkflowId, id));
                if (allSubmissions.length === 1 && allSubmissions[0].id === submissionId) {
                    const workflowUpdatePayload: Partial<typeof claimWorkflow.$inferInsert> = {
                        noClaim: nextNoClaim,
                        noClaimAssignedAt: nextNoClaim ? now : null,
                        noClaimAssignedBy: nextNoClaim ? actor.id : null,
                        updatedAt: now,
                    };
                    if (invalidatedDocumentPaths.length > 0) {
                        workflowUpdatePayload.claimLetterPdfPath = null;
                        workflowUpdatePayload.claimLetterGeneratedAt = null;
                        workflowUpdatePayload.claimLetterGeneratedBy = null;
                        workflowUpdatePayload.summaryPdfPath = null;
                        workflowUpdatePayload.summaryGeneratedAt = null;
                        workflowUpdatePayload.summaryGeneratedBy = null;
                        workflowUpdatePayload.receiptPdfPath = null;
                        workflowUpdatePayload.receiptGeneratedAt = null;
                        workflowUpdatePayload.receiptGeneratedBy = null;
                    }
                    await tx
                        .update(claimWorkflow)
                        .set(workflowUpdatePayload)
                        .where(eq(claimWorkflow.id, id));
                    workflowNoClaimMirrored = true;
                }
            }

            await writeClaimAudit({
                claimWorkflowId: id,
                claimSubmissionId: submissionId,
                auditScope: claimAuditScopes.submission,
                actor,
                action: "claim_submission_updated",
                fromStatus: submission.status,
                toStatus: submission.status,
                metadata: {
                    submissionId,
                    previousScope: submission.scope,
                    nextScope: nextScope ?? submission.scope,
                    previousScopeLabel: submission.scopeLabel,
                    nextScopeLabel: nextScopeLabel === undefined ? submission.scopeLabel : nextScopeLabel,
                    previousNoClaim,
                    nextNoClaim: nextNoClaim === undefined ? previousNoClaim : nextNoClaim,
                    noClaimChanged,
                    syncedItemCount,
                    workflowNoClaimMirrored,
                    invalidatedDocumentPaths,
                },
            }, tx);

            if (noClaimChanged) {
                await writeClaimAudit({
                    claimWorkflowId: id,
                    claimSubmissionId: submissionId,
                    auditScope: claimAuditScopes.submission,
                    actor,
                    action: "no_claim_assigned",
                    fromStatus: submission.status,
                    toStatus: submission.status,
                    metadata: {
                        previousNoClaim,
                        newNoClaim: nextNoClaim,
                        submissionScope: nextScope ?? submission.scope,
                    },
                }, tx);
                if (syncedItemCount > 0) {
                    await writeClaimAudit({
                        claimWorkflowId: id,
                        claimSubmissionId: submissionId,
                        auditScope: claimAuditScopes.submission,
                        actor,
                        action: "no_claim_synced_to_off",
                        fromStatus: submission.status,
                        toStatus: submission.status,
                        metadata: {
                            previousNoClaim,
                            newNoClaim: nextNoClaim,
                            offBatchId: workflow.offBatchId,
                            syncedItemCount,
                        },
                    }, tx);
                }
                if (invalidatedDocumentPaths.length > 0) {
                    await writeClaimAudit({
                        claimWorkflowId: id,
                        claimSubmissionId: submissionId,
                        auditScope: claimAuditScopes.submission,
                        actor,
                        action: "no_claim_changed_invalidated_documents",
                        fromStatus: submission.status,
                        toStatus: submission.status,
                        metadata: {
                            previousNoClaim,
                            newNoClaim: nextNoClaim,
                            invalidatedDocumentPaths,
                        },
                    }, tx);
                }
            }

            return {
                ok: true,
                syncedItemCount,
                workflowNoClaimMirrored,
                invalidatedDocumentPaths,
            } as const;
        });

        if (result.error) {
            return NextResponse.json(
                { ok: false, code: result.error.code, error: result.error.message },
                { status: result.error.status },
            );
        }

        const { submissionId: paramSubmissionId } = await context.params;
        for (const entry of result.invalidatedDocumentPaths) {
            if (!isPathInsideClaimDocumentRoot(entry.path)) continue;
            await unlink(entry.path).catch((error) => {
                console.warn("[CLAIM SUBMISSION NO CLAIM INVALIDATE UNLINK FAILED]", {
                    submissionId: paramSubmissionId,
                    type: entry.type,
                    path: entry.path,
                    error,
                });
            });
        }

        const [updated] = await db
            .select()
            .from(claimSubmission)
            .where(eq(claimSubmission.id, paramSubmissionId));

        return NextResponse.json({
            ok: true,
            success: true,
            submission: updated,
            warning: result.invalidatedDocumentPaths.length > 0
                ? "No Claim berubah, dokumen lama dikosongkan dan perlu dibuat ulang."
                : undefined,
            sync: {
                syncedItemCount: result.syncedItemCount,
                workflowNoClaimMirrored: result.workflowNoClaimMirrored,
                invalidatedDocumentCount: result.invalidatedDocumentPaths.length,
            },
        });
    } catch (error) {
        const message = error instanceof Error ? error.message.toLowerCase() : "";
        if (message.includes("unique") && message.includes("no_claim")) {
            return NextResponse.json({
                ok: false,
                code: "CLAIM_SUBMISSION_NO_CLAIM_DUPLICATE",
                error: "noClaim sudah dipakai submission lain.",
            }, { status: 409 });
        }
        console.error("[CLAIM SUBMISSION UPDATE ERROR]", error);
        return NextResponse.json({
            ok: false,
            error: "Gagal memperbarui Claim Submission.",
        }, { status: 500 });
    }
}
