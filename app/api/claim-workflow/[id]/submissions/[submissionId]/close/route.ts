/*
 * Tujuan: Close Claim Submission per submission. Phase R7e.
 *         Setiap submission ditutup independen. Workflow `aggregate_status`
 *         dan `status` di-derive dari semua submissions setelah close
 *         (workflow Closed hanya bila SEMUA submission Closed).
 * Caller: UI claim-workflow detail page admin/claim.
 * Side Effects:
 *   POST: UPDATE claim_submission status=Closed + closedAt/By/Note,
 *         recalc workflow aggregate, tulis audit `claim_closed`
 *         dengan claim_submission_id + audit_scope = "submission".
 *
 * Gate (semua harus terpenuhi):
 *   - actor admin/claim
 *   - submission belongs to workflow
 *   - submission status = Paid
 *   - submission noClaim ada
 *   - submission totalClaim > 0
 *   - active payment >= 1 (claim_submission_id = submissionId, voidedAt IS NULL)
 *   - totalPaid (recalc fresh) >= totalClaim
 *   - remainingAmount (recalc) = 0
 *   - 3 PDF submission tersedia (claimLetter / summary / receipt)
 *   - submission belum Closed/Cancelled
 *   - note non-empty
 * Tidak menyentuh OFF status. Tidak butuh PEKA.
 */
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { claimPayment, claimSubmission, claimWorkflow } from "@/db/schema";
import {
    claimAuditScopes,
    claimWorkflowStatuses,
    recalcPaymentTotals,
    recalcWorkflowAggregateWithPayments,
    requireClaimSession,
    writeClaimAudit,
} from "@/lib/claim-workflow";

type Context = { params: Promise<{ id: string; submissionId: string }> };

const CLOSE_NOTE_MAX = 1000;

export async function POST(request: Request, context: Context) {
    const actor = await requireClaimSession();
    if (!actor) {
        return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }
    if (actor.role !== "admin" && actor.role !== "claim") {
        return NextResponse.json({
            ok: false,
            code: "CLAIM_CLOSE_FORBIDDEN",
            error: "Hanya role admin atau claim yang dapat menutup Claim Submission.",
        }, { status: 403 });
    }

    let body: { note?: unknown } = {};
    if (request.headers.get("content-type")?.includes("application/json")) {
        body = await request.json().catch(() => ({}));
    }
    if (typeof body.note !== "string") {
        return NextResponse.json({
            ok: false,
            code: "CLAIM_CLOSE_NOTE_INVALID",
            error: "Catatan close harus berupa teks.",
        }, { status: 400 });
    }
    const note = body.note.trim().slice(0, CLOSE_NOTE_MAX);
    if (!note) {
        return NextResponse.json({
            ok: false,
            code: "CLAIM_CLOSE_NOTE_REQUIRED",
            error: "Catatan close wajib diisi.",
        }, { status: 400 });
    }

    try {
        const { id, submissionId } = await context.params;

        const result = await db.transaction(async (tx) => {
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
            const previousStatus = submission.status;
            if (previousStatus === claimWorkflowStatuses.closed) {
                return {
                    error: {
                        status: 409,
                        code: "CLAIM_CLOSE_ALREADY_CLOSED",
                        message: "Claim Submission sudah Closed.",
                    },
                } as const;
            }
            if (previousStatus === claimWorkflowStatuses.cancelled) {
                return {
                    error: {
                        status: 409,
                        code: "CLAIM_CLOSE_CANCELLED",
                        message: "Claim Submission sudah Cancelled, tidak dapat di-Close.",
                    },
                } as const;
            }
            if (previousStatus !== claimWorkflowStatuses.paid) {
                return {
                    error: {
                        status: 409,
                        code: "CLAIM_CLOSE_NOT_PAID",
                        message: "Close hanya tersedia saat submission Paid.",
                    },
                } as const;
            }

            const totalClaim = Number(submission.totalClaim || 0);
            if (!(totalClaim > 0)) {
                return {
                    error: {
                        status: 422,
                        code: "CLAIM_CLOSE_TOTAL_ZERO",
                        message: "Total Claim submission harus lebih dari 0 sebelum Close.",
                    },
                } as const;
            }
            if (!String(submission.noClaim || "").trim()) {
                return {
                    error: {
                        status: 422,
                        code: "CLAIM_CLOSE_NO_CLAIM_REQUIRED",
                        message: "No Claim wajib ter-assign sebelum Close.",
                    },
                } as const;
            }
            if (!submission.claimLetterPdfPath) {
                return {
                    error: {
                        status: 422,
                        code: "CLAIM_CLOSE_CLAIM_LETTER_REQUIRED",
                        message: "Claim Letter PDF submission wajib tersedia sebelum Close.",
                    },
                } as const;
            }
            if (!submission.summaryPdfPath) {
                return {
                    error: {
                        status: 422,
                        code: "CLAIM_CLOSE_SUMMARY_REQUIRED",
                        message: "Claim Summary PDF submission wajib tersedia sebelum Close.",
                    },
                } as const;
            }
            if (!submission.receiptPdfPath) {
                return {
                    error: {
                        status: 422,
                        code: "CLAIM_CLOSE_RECEIPT_REQUIRED",
                        message: "Kwitansi Claim PDF submission wajib tersedia sebelum Close.",
                    },
                } as const;
            }

            // Recalc fresh dari claim_payment per submission. Tidak boleh
            // percaya cache submission.totalPaid tanpa re-verify supaya
            // close gate selalu authoritative.
            const payments = await tx
                .select({
                    paymentAmount: claimPayment.paymentAmount,
                    voidedAt: claimPayment.voidedAt,
                })
                .from(claimPayment)
                .where(eq(claimPayment.claimSubmissionId, submissionId));
            const activePaymentCount = payments.filter((p) => p.voidedAt === null).length;
            if (activePaymentCount === 0) {
                return {
                    error: {
                        status: 422,
                        code: "CLAIM_CLOSE_NO_ACTIVE_PAYMENT",
                        message: "Minimal satu pembayaran aktif diperlukan sebelum Close.",
                    },
                } as const;
            }
            const totals = recalcPaymentTotals(totalClaim, payments);
            if (totals.totalPaid < totalClaim) {
                return {
                    error: {
                        status: 422,
                        code: "CLAIM_CLOSE_TOTAL_PAID_INSUFFICIENT",
                        message: "Total Paid submission belum mencapai Total Claim.",
                    },
                } as const;
            }
            if (totals.remainingAmount > 0) {
                return {
                    error: {
                        status: 422,
                        code: "CLAIM_CLOSE_OUTSTANDING_NOT_ZERO",
                        message: "Outstanding submission belum 0.",
                    },
                } as const;
            }

            const now = new Date();
            await tx
                .update(claimSubmission)
                .set({
                    status: claimWorkflowStatuses.closed,
                    closedAt: now,
                    closedBy: actor.id,
                    closeNote: note,
                    totalPaid: totals.totalPaid,
                    remainingAmount: totals.remainingAmount,
                    updatedAt: now,
                })
                .where(eq(claimSubmission.id, submissionId));

            // Recalc workflow aggregate. Workflow Closed hanya kalau semua
            // submissions Closed. recalcWorkflowAggregateWithPayments akan
            // derive workflow.aggregate_status; status workflow hanya akan
            // pindah ke Closed bila SEMUA submissions Closed.
            const aggregate = await recalcWorkflowAggregateWithPayments(tx, id, now);

            // Mirror workflow.closed_* hanya kalau workflow aggregate Closed.
            if (aggregate.aggregateStatus === claimWorkflowStatuses.closed) {
                await tx
                    .update(claimWorkflow)
                    .set({
                        status: claimWorkflowStatuses.closed,
                        closedAt: now,
                        closedBy: actor.id,
                        closeNote: note,
                        updatedAt: now,
                    })
                    .where(eq(claimWorkflow.id, id));
            }

            await writeClaimAudit({
                claimWorkflowId: id,
                claimSubmissionId: submissionId,
                auditScope: claimAuditScopes.submission,
                actor,
                action: "claim_closed",
                fromStatus: previousStatus,
                toStatus: claimWorkflowStatuses.closed,
                note,
                metadata: {
                    submissionId,
                    previousStatus,
                    newStatus: claimWorkflowStatuses.closed,
                    totalClaim,
                    totalPaid: totals.totalPaid,
                    remainingAmount: totals.remainingAmount,
                    noClaim: submission.noClaim,
                    activePaymentCount,
                    summaryPdfPath: submission.summaryPdfPath,
                    claimLetterPdfPath: submission.claimLetterPdfPath,
                    receiptPdfPath: submission.receiptPdfPath,
                    workflowAggregateStatus: aggregate.aggregateStatus,
                    workflowClosed: aggregate.aggregateStatus === claimWorkflowStatuses.closed,
                },
            }, tx);

            return {
                ok: true,
                submissionId,
                previousStatus,
                totals,
                activePaymentCount,
                closedAt: now,
                aggregate,
                snapshot: {
                    id: submissionId,
                    status: claimWorkflowStatuses.closed,
                    totalClaim,
                    totalPaid: totals.totalPaid,
                    remainingAmount: totals.remainingAmount,
                    closedAt: now,
                    closedBy: actor.id,
                    closeNote: note,
                },
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
            submission: result.snapshot,
            previousStatus: result.previousStatus,
            workflow: {
                aggregateStatus: result.aggregate.aggregateStatus,
                status: result.aggregate.workflowStatus,
                closed: result.aggregate.aggregateStatus === claimWorkflowStatuses.closed,
            },
        });
    } catch (error) {
        console.error("[CLAIM SUBMISSION CLOSE ERROR]", error);
        return NextResponse.json({
            ok: false,
            error: "Gagal menutup Claim Submission.",
        }, { status: 500 });
    }
}
