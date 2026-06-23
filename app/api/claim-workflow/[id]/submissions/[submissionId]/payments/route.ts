/*
 * Tujuan: GET list + POST create payment per Claim Submission. Phase R7d.
 *         Menggantikan gradual workflow-level payment route untuk
 *         multi-submission. Single-submission tetap dapat pakai route
 *         legacy `/api/claim-workflow/[id]/payments` (akan proxy ke
 *         default submission, lihat route legacy yang di-update).
 * Caller: UI claim-workflow detail page admin/claim untuk POST,
 *         viewer untuk GET.
 * Side Effects:
 *   GET  : tidak menulis DB.
 *   POST : INSERT claim_payment dengan claim_submission_id,
 *          recalc submission totals + workflow aggregate, audit
 *          payment_created (+ optional payment_status_recalculated)
 *          dengan audit_scope = "submission".
 */
import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { asc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { claimPayment, claimSubmission, claimWorkflow } from "@/db/schema";
import {
    claimAuditScopes,
    claimWorkflowStatuses,
    isSubmissionPaymentAllowedStatus,
    recalcSubmissionPaymentTotals,
    recalcWorkflowAggregateWithPayments,
    requireClaimSession,
    writeClaimAudit,
} from "@/lib/claim-workflow";
import { requirePermissionH } from "@/lib/rbac/resolve";

type Context = { params: Promise<{ id: string; submissionId: string }> };

const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const PAYMENT_TYPE_MAX = 60;
const PAYMENT_NOTE_MAX = 500;

export async function GET(_request: Request, context: Context) {
    const actor = await requireClaimSession();
    if (!actor) {
        return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }
    const gate = await requirePermissionH("claim_workflow.view");
    if (gate.response) return gate.response;

    try {
        const { id, submissionId } = await context.params;
        const [submission] = await db
            .select()
            .from(claimSubmission)
            .where(eq(claimSubmission.id, submissionId));
        if (!submission || submission.claimWorkflowId !== id) {
            return NextResponse.json({
                ok: false,
                code: "CLAIM_SUBMISSION_NOT_FOUND",
                error: "Claim Submission tidak ditemukan untuk workflow ini.",
            }, { status: 404 });
        }
        const payments = await db
            .select()
            .from(claimPayment)
            .where(eq(claimPayment.claimSubmissionId, submissionId))
            .orderBy(asc(claimPayment.paymentDate), asc(claimPayment.createdAt));
        const activePayments = payments.filter((p) => p.voidedAt === null);
        const voidedPayments = payments.filter((p) => p.voidedAt !== null);
        const totalClaim = Number(submission.totalClaim || 0);
        const totalPaid = Number(submission.totalPaid || 0);
        const remainingAmount = Number(submission.remainingAmount || 0);
        return NextResponse.json({
            ok: true,
            payments,
            activePayments,
            voidedPayments,
            summary: {
                submissionId,
                totalClaim,
                totalPaid,
                remainingAmount,
                paymentStatus: submission.status,
                activePaymentCount: activePayments.length,
                voidedPaymentCount: voidedPayments.length,
                paymentCount: payments.length,
            },
        });
    } catch (error) {
        console.error("[CLAIM SUBMISSION PAYMENT LIST ERROR]", error);
        return NextResponse.json({
            ok: false,
            error: "Gagal mengambil daftar pembayaran submission.",
        }, { status: 500 });
    }
}

export async function POST(request: Request, context: Context) {
    const actor = await requireClaimSession();
    if (!actor) {
        return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }
    const gate = await requirePermissionH("claim_workflow.submit");
    if (gate.response) return gate.response;

    let body: {
        paymentDate?: unknown;
        paymentAmount?: unknown;
        paymentType?: unknown;
        paymentNote?: unknown;
    } = {};
    if (request.headers.get("content-type")?.includes("application/json")) {
        body = await request.json().catch(() => ({}));
    }
    if (typeof body.paymentDate !== "string" || !ISO_DATE_REGEX.test(body.paymentDate)) {
        return NextResponse.json({
            ok: false,
            code: "PAYMENT_DATE_INVALID",
            error: "paymentDate wajib diisi dengan format YYYY-MM-DD.",
        }, { status: 400 });
    }
    const paymentAmount = Number(body.paymentAmount);
    if (!Number.isFinite(paymentAmount) || paymentAmount <= 0) {
        return NextResponse.json({
            ok: false,
            code: "PAYMENT_AMOUNT_INVALID",
            error: "paymentAmount harus berupa angka lebih besar dari 0.",
        }, { status: 400 });
    }
    if (body.paymentType !== undefined && body.paymentType !== null && typeof body.paymentType !== "string") {
        return NextResponse.json({
            ok: false,
            code: "PAYMENT_TYPE_INVALID",
            error: "paymentType harus berupa teks.",
        }, { status: 400 });
    }
    if (body.paymentNote !== undefined && body.paymentNote !== null && typeof body.paymentNote !== "string") {
        return NextResponse.json({
            ok: false,
            code: "PAYMENT_NOTE_INVALID",
            error: "paymentNote harus berupa teks.",
        }, { status: 400 });
    }
    const paymentType = typeof body.paymentType === "string" && body.paymentType.trim() !== ""
        ? body.paymentType.trim().slice(0, PAYMENT_TYPE_MAX)
        : null;
    const paymentNote = typeof body.paymentNote === "string" && body.paymentNote.trim() !== ""
        ? body.paymentNote.trim().slice(0, PAYMENT_NOTE_MAX)
        : null;

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
            if (submission.status === claimWorkflowStatuses.closed) {
                return {
                    error: {
                        status: 409,
                        code: "CLAIM_PAYMENT_SUBMISSION_CLOSED",
                        message: "Submission sudah Closed; pembayaran tidak dapat dicatat.",
                    },
                } as const;
            }
            const totalClaim = Number(submission.totalClaim || 0);
            if (!(totalClaim > 0)) {
                return {
                    error: {
                        status: 422,
                        code: "CLAIM_PAYMENT_TOTAL_ZERO",
                        message: "Total Claim submission harus lebih dari 0 sebelum mencatat pembayaran.",
                    },
                } as const;
            }
            if (!String(submission.noClaim || "").trim()) {
                return {
                    error: {
                        status: 422,
                        code: "CLAIM_PAYMENT_NO_CLAIM_REQUIRED",
                        message: "No Claim submission wajib ter-assign sebelum mencatat pembayaran.",
                    },
                } as const;
            }
            if (!isSubmissionPaymentAllowedStatus(submission.status)) {
                return {
                    error: {
                        status: 409,
                        code: "CLAIM_PAYMENT_INVALID_STATE",
                        message: "Pembayaran hanya dapat dicatat saat submission Submitted to Principal atau Partially Paid.",
                    },
                } as const;
            }
            const previousRemaining = Number(submission.remainingAmount || 0);
            if (paymentAmount > previousRemaining) {
                return {
                    error: {
                        status: 409,
                        code: "CLAIM_PAYMENT_OVERPAYMENT",
                        message: "Pembayaran melebihi sisa outstanding submission. Overpayment belum didukung.",
                    },
                } as const;
            }

            const newPaymentId = randomUUID();
            const now = new Date();
            await tx.insert(claimPayment).values({
                id: newPaymentId,
                claimWorkflowId: id,
                claimSubmissionId: submissionId,
                paymentDate: body.paymentDate as string,
                paymentAmount,
                paymentType,
                paymentNote,
                proofPath: null,
                createdBy: actor.id,
                voidedAt: null,
                voidedBy: null,
                voidReason: null,
                createdAt: now,
                updatedAt: now,
            });

            const recalc = await recalcSubmissionPaymentTotals(tx, submissionId, now);
            const aggregate = await recalcWorkflowAggregateWithPayments(tx, id, now);

            await writeClaimAudit({
                claimWorkflowId: id,
                claimSubmissionId: submissionId,
                auditScope: claimAuditScopes.submission,
                actor,
                action: "payment_created",
                fromStatus: recalc.previousStatus,
                toStatus: recalc.nextStatus,
                note: paymentNote,
                metadata: {
                    paymentId: newPaymentId,
                    paymentDate: body.paymentDate,
                    paymentAmount,
                    paymentType,
                    submissionId,
                    submissionTotalClaim: recalc.totalClaim,
                    previousRemaining,
                    newSubmissionTotalPaid: recalc.totalPaid,
                    newSubmissionRemaining: recalc.remainingAmount,
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
                        trigger: "payment_created",
                        paymentId: newPaymentId,
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
                paymentId: newPaymentId,
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
        }, { status: 201 });
    } catch (error) {
        console.error("[CLAIM SUBMISSION PAYMENT CREATE ERROR]", error);
        return NextResponse.json({
            ok: false,
            error: "Gagal mencatat pembayaran submission.",
        }, { status: 500 });
    }
}
