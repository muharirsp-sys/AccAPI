/*
 * Tujuan: Void payment per Claim Submission. Phase R7d. Soft delete
 *         (set voidedAt/voidedBy/voidReason). Recalc submission totals
 *         + workflow aggregate dalam transaksi yang sama.
 * Caller: UI claim-workflow detail page admin/claim.
 * Side Effects:
 *   POST: UPDATE claim_payment voidedAt/voidedBy/voidReason,
 *         recalc submission totals, recalc workflow aggregate,
 *         audit payment_voided + payment_status_recalculated bila
 *         status berubah, audit_scope = "submission".
 */
import { NextResponse } from "next/server";
import { and, asc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { claimPayment, claimSubmission, claimWorkflow } from "@/db/schema";
import {
    claimAuditScopes,
    claimWorkflowStatuses,
    recalcSubmissionPaymentTotals,
    recalcWorkflowAggregateWithPayments,
    requireClaimSession,
    writeClaimAudit,
} from "@/lib/claim-workflow";

type Context = {
    params: Promise<{ id: string; submissionId: string; paymentId: string }>;
};

const VOID_REASON_MAX = 500;

export async function POST(request: Request, context: Context) {
    const actor = await requireClaimSession();
    if (!actor) {
        return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }
    if (actor.role !== "admin" && actor.role !== "claim") {
        return NextResponse.json({
            ok: false,
            code: "CLAIM_PAYMENT_FORBIDDEN",
            error: "Hanya role admin atau claim yang dapat void pembayaran.",
        }, { status: 403 });
    }

    let body: { reason?: unknown } = {};
    if (request.headers.get("content-type")?.includes("application/json")) {
        body = await request.json().catch(() => ({}));
    }
    if (typeof body.reason !== "string") {
        return NextResponse.json({
            ok: false,
            code: "CLAIM_PAYMENT_VOID_REASON_INVALID",
            error: "Alasan void harus berupa teks.",
        }, { status: 400 });
    }
    const reason = body.reason.trim().slice(0, VOID_REASON_MAX);
    if (!reason) {
        return NextResponse.json({
            ok: false,
            code: "CLAIM_PAYMENT_VOID_REASON_REQUIRED",
            error: "Alasan void wajib diisi.",
        }, { status: 400 });
    }

    try {
        const { id, submissionId, paymentId } = await context.params;

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
            if (submission.status === claimWorkflowStatuses.closed) {
                return {
                    error: {
                        status: 409,
                        code: "CLAIM_PAYMENT_VOID_SUBMISSION_CLOSED",
                        message: "Submission sudah Closed; payment tidak dapat di-void.",
                    },
                } as const;
            }

            const [payment] = await tx
                .select()
                .from(claimPayment)
                .where(and(
                    eq(claimPayment.id, paymentId),
                    eq(claimPayment.claimSubmissionId, submissionId),
                ));
            if (!payment || payment.claimWorkflowId !== id) {
                return {
                    error: {
                        status: 404,
                        code: "CLAIM_PAYMENT_NOT_FOUND",
                        message: "Pembayaran tidak ditemukan untuk submission ini.",
                    },
                } as const;
            }
            if (payment.voidedAt !== null) {
                return {
                    error: {
                        status: 409,
                        code: "CLAIM_PAYMENT_ALREADY_VOIDED",
                        message: "Pembayaran ini sudah pernah di-void.",
                    },
                } as const;
            }
            // Workflow Closed gate (defensif). Submission Closed sudah dicek
            // di atas; kalau workflow Closed tapi submission belum, ini
            // mengindikasikan inconsistent state — tetap reject untuk
            // safety.
            const [workflow] = await tx
                .select({ status: claimWorkflow.status })
                .from(claimWorkflow)
                .where(eq(claimWorkflow.id, id));
            if (workflow?.status === claimWorkflowStatuses.closed) {
                return {
                    error: {
                        status: 409,
                        code: "CLAIM_PAYMENT_VOID_CLOSED",
                        message: "Tidak dapat void pembayaran pada workflow yang sudah Closed.",
                    },
                } as const;
            }

            const now = new Date();
            const voidedAmount = Number(payment.paymentAmount || 0);

            await tx
                .update(claimPayment)
                .set({
                    voidedAt: now,
                    voidedBy: actor.id,
                    voidReason: reason,
                    updatedAt: now,
                })
                .where(eq(claimPayment.id, paymentId));

            const recalc = await recalcSubmissionPaymentTotals(tx, submissionId, now);
            const aggregate = await recalcWorkflowAggregateWithPayments(tx, id, now);

            await writeClaimAudit({
                claimWorkflowId: id,
                claimSubmissionId: submissionId,
                auditScope: claimAuditScopes.submission,
                actor,
                action: "payment_voided",
                fromStatus: recalc.previousStatus,
                toStatus: recalc.nextStatus,
                note: reason,
                metadata: {
                    paymentId,
                    voidReason: reason,
                    voidedAmount,
                    submissionId,
                    submissionTotalPaid: recalc.totalPaid,
                    submissionRemaining: recalc.remainingAmount,
                    previousSubmissionStatus: recalc.previousStatus,
                    newSubmissionStatus: recalc.nextStatus,
                    workflowAggregateStatus: aggregate.aggregateStatus,
                    workflowTotalPaid: aggregate.totalPaid,
                    workflowRemaining: aggregate.remainingAmount,
                },
            }, tx);

            if (recalc.statusChanged || aggregate.workflowStatusChanged) {
                await writeClaimAudit({
                    claimWorkflowId: id,
                    claimSubmissionId: submissionId,
                    auditScope: claimAuditScopes.submission,
                    actor,
                    action: "payment_status_recalculated",
                    fromStatus: recalc.previousStatus,
                    toStatus: recalc.nextStatus,
                    metadata: {
                        trigger: "payment_voided",
                        paymentId,
                        submissionId,
                        submissionTotalClaim: recalc.totalClaim,
                        submissionTotalPaid: recalc.totalPaid,
                        submissionRemaining: recalc.remainingAmount,
                        workflowAggregateStatus: aggregate.aggregateStatus,
                        workflowStatusChanged: aggregate.workflowStatusChanged,
                    },
                }, tx);
            }

            return {
                ok: true,
                paymentId,
                recalc,
                aggregate,
            } as const;
        });

        if (result.error) {
            return NextResponse.json(
                { ok: false, code: result.error.code, error: result.error.message },
                { status: result.error.status },
            );
        }

        const { id: workflowId, submissionId: paramSubmissionId } = await context.params;
        const [submission] = await db
            .select()
            .from(claimSubmission)
            .where(eq(claimSubmission.id, paramSubmissionId));
        const allPayments = await db
            .select()
            .from(claimPayment)
            .where(eq(claimPayment.claimSubmissionId, paramSubmissionId))
            .orderBy(asc(claimPayment.paymentDate), asc(claimPayment.createdAt));
        const activePayments = allPayments.filter((p) => p.voidedAt === null);
        const voidedPayments = allPayments.filter((p) => p.voidedAt !== null);
        const [workflow] = await db
            .select({
                id: claimWorkflow.id,
                status: claimWorkflow.status,
                aggregateStatus: claimWorkflow.aggregateStatus,
                totalClaim: claimWorkflow.totalClaim,
                totalPaid: claimWorkflow.totalPaid,
                remainingAmount: claimWorkflow.remainingAmount,
            })
            .from(claimWorkflow)
            .where(eq(claimWorkflow.id, workflowId));

        return NextResponse.json({
            ok: true,
            success: true,
            paymentId: result.paymentId,
            statusChanged: result.recalc.statusChanged,
            previousStatus: result.recalc.previousStatus,
            submission: submission ? {
                id: submission.id,
                status: submission.status,
                totalClaim: Number(submission.totalClaim || 0),
                totalPaid: Number(submission.totalPaid || 0),
                remainingAmount: Number(submission.remainingAmount || 0),
            } : null,
            workflow: workflow ? {
                id: workflow.id,
                status: workflow.status,
                aggregateStatus: workflow.aggregateStatus,
                totalClaim: Number(workflow.totalClaim || 0),
                totalPaid: Number(workflow.totalPaid || 0),
                remainingAmount: Number(workflow.remainingAmount || 0),
            } : null,
            payments: allPayments,
            activePayments,
            voidedPayments,
            summary: submission ? {
                submissionId: paramSubmissionId,
                totalClaim: Number(submission.totalClaim || 0),
                totalPaid: result.recalc.totalPaid,
                remainingAmount: result.recalc.remainingAmount,
                paymentStatus: result.recalc.nextStatus,
                activePaymentCount: activePayments.length,
                voidedPaymentCount: voidedPayments.length,
                paymentCount: allPayments.length,
            } : null,
        });
    } catch (error) {
        console.error("[CLAIM SUBMISSION PAYMENT VOID ERROR]", error);
        return NextResponse.json({
            ok: false,
            error: "Gagal void pembayaran submission.",
        }, { status: 500 });
    }
}
