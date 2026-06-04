/*
 * Tujuan: Endpoint void pembayaran principal. Soft-delete saja — row
 *         tetap dipertahankan untuk audit trail, hanya kolom voided_*
 *         yang diisi dan baris dikeluarkan dari perhitungan totalPaid.
 * Caller: UI detail Claim Workflow (admin/claim).
 * Dependensi: drizzle-orm, lib/claim-workflow (audit + helpers), schema.
 * Side Effects: Update claim_payment dengan voided_at/voided_by/void_reason,
 *               recalc totals + status workflow, tulis audit
 *               `payment_voided` (+ optional status transition audit)
 *               dalam transaksi yang sama.
 *
 * Phase R7d — Multi No Claim void:
 *   Multi-submission workflow ditolak `MULTI_SUBMISSION_PAYMENT_ROUTE_DISABLED`.
 *   Single-submission tetap valid; recalc submission + workflow aggregate.
 */
import { NextResponse } from "next/server";
import { and, asc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { claimPayment, claimSubmission, claimWorkflow } from "@/db/schema";
import {
    claimAuditScopes,
    claimWorkflowStatuses,
    recalcPaymentTotals,
    recalcSubmissionPaymentTotals,
    recalcWorkflowAggregateWithPayments,
    requireClaimSession,
    writeClaimAudit,
} from "@/lib/claim-workflow";

type Context = { params: Promise<{ id: string; paymentId: string }> };

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
        const { id, paymentId } = await context.params;

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
                        code: "CLAIM_PAYMENT_VOID_CLOSED",
                        message: "Tidak dapat void pembayaran pada workflow yang sudah Closed.",
                    },
                } as const;
            }

            // Phase R7d — Multi No Claim void guard:
            const submissions = await tx
                .select({ id: claimSubmission.id })
                .from(claimSubmission)
                .where(eq(claimSubmission.claimWorkflowId, id));
            if (submissions.length > 1) {
                return {
                    error: {
                        status: 409,
                        code: "MULTI_SUBMISSION_PAYMENT_ROUTE_DISABLED",
                        message: "Workflow memiliki beberapa No Claim. Void pembayaran lewat submission.",
                    },
                } as const;
            }
            const targetSubmissionId = submissions[0]?.id ?? null;

            const [payment] = await tx
                .select()
                .from(claimPayment)
                .where(and(
                    eq(claimPayment.id, paymentId),
                    eq(claimPayment.claimWorkflowId, id),
                ));
            if (!payment) {
                return { error: { status: 404, code: "CLAIM_PAYMENT_NOT_FOUND", message: "Pembayaran tidak ditemukan." } } as const;
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

            const totalClaim = Number(workflow.totalClaim || 0);
            const previousPayments = await tx
                .select({ paymentAmount: claimPayment.paymentAmount, voidedAt: claimPayment.voidedAt })
                .from(claimPayment)
                .where(eq(claimPayment.claimWorkflowId, id));
            const previousTotals = recalcPaymentTotals(totalClaim, previousPayments);
            const previousStatus = workflow.status;
            const voidedAmount = Number(payment.paymentAmount || 0);

            const now = new Date();
            await tx
                .update(claimPayment)
                .set({
                    voidedAt: now,
                    voidedBy: actor.id,
                    voidReason: reason,
                    updatedAt: now,
                })
                .where(eq(claimPayment.id, paymentId));

            // Recalc submission + workflow aggregate (R7d) bila ada submission;
            // fall back ke recalc workflow-level (R3) untuk DB lokal lama.
            let nextTotals;
            let newStatus;
            if (targetSubmissionId) {
                const recalc = await recalcSubmissionPaymentTotals(tx, targetSubmissionId, now);
                const aggregate = await recalcWorkflowAggregateWithPayments(tx, id, now);
                nextTotals = {
                    totalPaid: recalc.totalPaid,
                    remainingAmount: recalc.remainingAmount,
                    derivedStatus: recalc.nextStatus,
                };
                newStatus = aggregate.workflowStatus;
            } else {
                const refreshedPayments = await tx
                    .select({ paymentAmount: claimPayment.paymentAmount, voidedAt: claimPayment.voidedAt })
                    .from(claimPayment)
                    .where(eq(claimPayment.claimWorkflowId, id));
                nextTotals = recalcPaymentTotals(totalClaim, refreshedPayments);
                newStatus = nextTotals.derivedStatus;
                await tx
                    .update(claimWorkflow)
                    .set({
                        totalPaid: nextTotals.totalPaid,
                        remainingAmount: nextTotals.remainingAmount,
                        status: newStatus,
                        updatedAt: now,
                    })
                    .where(eq(claimWorkflow.id, id));
            }

            await writeClaimAudit({
                claimWorkflowId: id,
                claimSubmissionId: targetSubmissionId,
                auditScope: targetSubmissionId ? claimAuditScopes.submission : claimAuditScopes.workflow,
                actor,
                action: "payment_voided",
                fromStatus: previousStatus,
                toStatus: newStatus,
                note: reason,
                metadata: {
                    paymentId,
                    voidReason: reason,
                    voidedAmount,
                    previousTotalPaid: previousTotals.totalPaid,
                    newTotalPaid: nextTotals.totalPaid,
                    previousRemainingAmount: previousTotals.remainingAmount,
                    newRemainingAmount: nextTotals.remainingAmount,
                    previousStatus,
                    newStatus,
                    submissionId: targetSubmissionId,
                    viaLegacyWorkflowRoute: true,
                },
            }, tx);

            if (newStatus !== previousStatus) {
                await writeClaimAudit({
                    claimWorkflowId: id,
                    claimSubmissionId: targetSubmissionId,
                    auditScope: targetSubmissionId ? claimAuditScopes.submission : claimAuditScopes.workflow,
                    actor,
                    action: "payment_status_recalculated",
                    fromStatus: previousStatus,
                    toStatus: newStatus,
                    metadata: {
                        trigger: "payment_voided",
                        paymentId,
                        totalClaim,
                        totalPaid: nextTotals.totalPaid,
                        remainingAmount: nextTotals.remainingAmount,
                        submissionId: targetSubmissionId,
                    },
                }, tx);
            }

            return {
                ok: true,
                paymentId,
                previousStatus,
                newStatus,
                totals: nextTotals,
            } as const;
        });

        if (result.error) {
            return NextResponse.json(
                { ok: false, code: result.error.code, error: result.error.message },
                { status: result.error.status },
            );
        }

        const [workflow] = await db
            .select()
            .from(claimWorkflow)
            .where(eq(claimWorkflow.id, id));
        const allPayments = await db
            .select()
            .from(claimPayment)
            .where(eq(claimPayment.claimWorkflowId, id))
            .orderBy(asc(claimPayment.paymentDate), asc(claimPayment.createdAt));
        const activePayments = allPayments.filter((p) => p.voidedAt === null);
        const voidedPayments = allPayments.filter((p) => p.voidedAt !== null);

        return NextResponse.json({
            ok: true,
            success: true,
            paymentId: result.paymentId,
            statusChanged: result.previousStatus !== result.newStatus,
            previousStatus: result.previousStatus,
            workflow: workflow
                ? {
                    id: workflow.id,
                    status: workflow.status,
                    totalClaim: Number(workflow.totalClaim || 0),
                    totalPaid: Number(workflow.totalPaid || 0),
                    remainingAmount: Number(workflow.remainingAmount || 0),
                }
                : null,
            payments: allPayments,
            activePayments,
            voidedPayments,
            summary: workflow ? {
                totalClaim: Number(workflow.totalClaim || 0),
                totalPaid: result.totals.totalPaid,
                remainingAmount: result.totals.remainingAmount,
                paymentStatus: workflow.status,
                activePaymentCount: activePayments.length,
                voidedPaymentCount: voidedPayments.length,
                paymentCount: allPayments.length,
            } : null,
        });
    } catch (error) {
        console.error("[CLAIM WORKFLOW PAYMENT VOID ERROR]", error);
        return NextResponse.json({ ok: false, error: "Gagal void pembayaran." }, { status: 500 });
    }
}
