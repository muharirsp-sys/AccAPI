/*
 * Tujuan: Endpoint daftar + buat payment principal untuk Claim Workflow.
 * Caller: UI detail Claim Workflow (`/claim-workflow/[id]`) untuk role
 *         admin/claim. Read access untuk role lain yang sudah di-gate
 *         oleh `canActorReadClaimWorkflow`.
 * Dependensi: drizzle-orm, lib/claim-workflow (audit, helpers), schema.
 * Side Effects:
 *   GET  : tidak menulis DB.
 *   POST : insert claim_payment, recalc totalPaid/remainingAmount/status,
 *          tulis audit `payment_created` (+ optional status transition
 *          audit) dalam transaksi yang sama.
 *
 * Phase R3 — Principal Payment + Outstanding:
 *   Payment hanya diizinkan saat workflow `Submitted to Principal` atau
 *   `Partially Paid`. Overpayment ditolak (overpaidAmount belum
 *   dimodelkan). Void payment ditangani di route terpisah supaya audit
 *   trail tetap bersih.
 *
 * Phase R7d — Multi No Claim payment:
 *   Multi-submission workflow (>1 claim_submission) ditolak dengan
 *   `MULTI_SUBMISSION_PAYMENT_ROUTE_DISABLED`. User wajib pakai
 *   endpoint `/[id]/submissions/[submissionId]/payments` per submission.
 *   Single-submission workflow tetap valid; payment baru ter-link ke
 *   default submission, recalc submission + workflow aggregate.
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
    recalcPaymentTotals,
    recalcSubmissionPaymentTotals,
    recalcWorkflowAggregateWithPayments,
    requireClaimSession,
    writeClaimAudit,
} from "@/lib/claim-workflow";
import { requirePermissionH } from "@/lib/rbac/resolve";

type Context = { params: Promise<{ id: string }> };

const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const PAYMENT_TYPE_MAX = 60;
const PAYMENT_NOTE_MAX = 500;

function isPaymentAllowedStatus(status: string): boolean {
    return (
        status === claimWorkflowStatuses.submittedToPrincipal ||
        status === claimWorkflowStatuses.partiallyPaid
    );
}

function isPaymentDerivedStatus(status: string): boolean {
    return (
        status === claimWorkflowStatuses.submittedToPrincipal ||
        status === claimWorkflowStatuses.partiallyPaid ||
        status === claimWorkflowStatuses.paid
    );
}

function buildPaymentSummary(workflow: typeof claimWorkflow.$inferSelect, totals: {
    totalPaid: number;
    remainingAmount: number;
    derivedStatus: string;
}, counts: { activePaymentCount: number; voidedPaymentCount: number }) {
    const paymentStatus = isPaymentDerivedStatus(workflow.status)
        ? totals.derivedStatus
        : workflow.status;
    return {
        totalClaim: Number(workflow.totalClaim || 0),
        totalPaid: totals.totalPaid,
        remainingAmount: totals.remainingAmount,
        paymentStatus,
        persistedStatus: workflow.status,
        paymentDerivedStatus: totals.derivedStatus,
        statusDriftWarning: isPaymentDerivedStatus(workflow.status) && workflow.status !== totals.derivedStatus,
        activePaymentCount: counts.activePaymentCount,
        voidedPaymentCount: counts.voidedPaymentCount,
        paymentCount: counts.activePaymentCount + counts.voidedPaymentCount,
    };
}

export async function GET(_request: Request, context: Context) {
    const actor = await requireClaimSession();
    if (!actor) {
        return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }
    const gate = await requirePermissionH("claim_workflow.view");
    if (gate.response) return gate.response;

    try {
        const { id } = await context.params;
        const [workflow] = await db
            .select()
            .from(claimWorkflow)
            .where(eq(claimWorkflow.id, id));
        if (!workflow) {
            return NextResponse.json({ ok: false, error: "Claim Workflow not found" }, { status: 404 });
        }
        const payments = await db
            .select()
            .from(claimPayment)
            .where(eq(claimPayment.claimWorkflowId, id))
            .orderBy(asc(claimPayment.paymentDate), asc(claimPayment.createdAt));

        const totals = recalcPaymentTotals(Number(workflow.totalClaim || 0), payments);
        const activePayments = payments.filter((p) => p.voidedAt === null);
        const voidedPayments = payments.filter((p) => p.voidedAt !== null);

        return NextResponse.json({
            ok: true,
            payments,
            activePayments,
            voidedPayments,
            summary: buildPaymentSummary(
                workflow,
                totals,
                {
                    activePaymentCount: activePayments.length,
                    voidedPaymentCount: voidedPayments.length,
                },
            ),
        });
    } catch (error) {
        console.error("[CLAIM WORKFLOW PAYMENTS LIST ERROR]", error);
        return NextResponse.json({ ok: false, error: "Gagal mengambil daftar pembayaran." }, { status: 500 });
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
        const { id } = await context.params;

        const result = await db.transaction(async (tx) => {
            const [workflow] = await tx
                .select()
                .from(claimWorkflow)
                .where(eq(claimWorkflow.id, id));
            if (!workflow) {
                return { error: { status: 404, code: "CLAIM_WORKFLOW_NOT_FOUND", message: "Claim Workflow not found" } } as const;
            }

            // Phase R7d — Multi No Claim payment guard:
            // Legacy route hanya boleh dijalankan untuk single-submission
            // workflow. Multi-submission wajib pakai endpoint
            // /[id]/submissions/[submissionId]/payments supaya tiap
            // No Claim punya ledger payment sendiri.
            const submissions = await tx
                .select({
                    id: claimSubmission.id,
                    status: claimSubmission.status,
                    noClaim: claimSubmission.noClaim,
                    totalClaim: claimSubmission.totalClaim,
                    remainingAmount: claimSubmission.remainingAmount,
                })
                .from(claimSubmission)
                .where(eq(claimSubmission.claimWorkflowId, id));
            if (submissions.length > 1) {
                return {
                    error: {
                        status: 409,
                        code: "MULTI_SUBMISSION_PAYMENT_ROUTE_DISABLED",
                        message: "Workflow memiliki beberapa No Claim. Input pembayaran lewat submission.",
                    },
                } as const;
            }
            const targetSubmission = submissions[0] ?? null;

            const totalClaim = Number(workflow.totalClaim || 0);
            if (!(totalClaim > 0)) {
                return {
                    error: {
                        status: 422,
                        code: "CLAIM_PAYMENT_TOTAL_ZERO",
                        message: "Total Claim harus lebih dari 0 sebelum mencatat pembayaran.",
                    },
                } as const;
            }
            if (!String(workflow.noClaim || "").trim()) {
                return {
                    error: {
                        status: 422,
                        code: "CLAIM_PAYMENT_NO_CLAIM_REQUIRED",
                        message: "No Claim wajib ter-assign sebelum mencatat pembayaran.",
                    },
                } as const;
            }

            const existingPayments = await tx
                .select({ paymentAmount: claimPayment.paymentAmount, voidedAt: claimPayment.voidedAt })
                .from(claimPayment)
                .where(eq(claimPayment.claimWorkflowId, id));

            const previousTotals = recalcPaymentTotals(totalClaim, existingPayments);
            const previousTotalPaid = previousTotals.totalPaid;
            const previousRemaining = previousTotals.remainingAmount;
            const previousStatus = workflow.status;
            const effectiveStatus = isPaymentDerivedStatus(previousStatus)
                ? previousTotals.derivedStatus
                : previousStatus;

            // Row lama yang salah tersimpan Paid tetapi masih memiliki saldo
            // diperlakukan sebagai Partially Paid agar dapat diperbaiki lewat
            // payment normal. Closed tetap tidak dapat dibuka kembali.
            if (!isPaymentAllowedStatus(effectiveStatus)) {
                return {
                    error: {
                        status: 409,
                        code: "CLAIM_PAYMENT_INVALID_STATE",
                        message: "Pembayaran hanya dapat dicatat saat status Submitted to Principal atau Partially Paid.",
                    },
                } as const;
            }

            // R7d: bila ada single submission, gate juga ke status submission
            // (mencegah kasus workflow Submitted tapi submission Paid karena
            // mirror lag). Submission Closed selalu reject.
            if (targetSubmission) {
                if (targetSubmission.status === claimWorkflowStatuses.closed) {
                    return {
                        error: {
                            status: 409,
                            code: "CLAIM_PAYMENT_SUBMISSION_CLOSED",
                            message: "Submission sudah Closed; pembayaran tidak dapat dicatat.",
                        },
                    } as const;
                }
                // Gate single-submission ke status payment-allowed (Submitted
                // / Partially Paid). Submission Paid juga ditolak supaya
                // tidak ada overpayment lewat legacy route.
                if (!isSubmissionPaymentAllowedStatus(targetSubmission.status)) {
                    return {
                        error: {
                            status: 409,
                            code: "CLAIM_PAYMENT_INVALID_STATE",
                            message: "Pembayaran hanya dapat dicatat saat submission Submitted to Principal atau Partially Paid.",
                        },
                    } as const;
                }
            }

            // Reject overpayment: paymentAmount tidak boleh melebihi sisa
            // outstanding (remainingAmount). Paid hanya tercapai ketika
            // saldo tepat nol.
            if (paymentAmount > previousRemaining) {
                return {
                    error: {
                        status: 409,
                        code: "CLAIM_PAYMENT_OVERPAYMENT",
                        message: "Pembayaran melebihi sisa outstanding. Overpayment belum didukung.",
                    },
                } as const;
            }

            const newPaymentId = randomUUID();
            const now = new Date();
            await tx.insert(claimPayment).values({
                id: newPaymentId,
                claimWorkflowId: id,
                claimSubmissionId: targetSubmission?.id ?? null,
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

            // Recalc submission + workflow aggregate (R7d). Untuk DB lokal
            // lama yang belum di-backfill submission, fall back ke recalc
            // workflow-level (R3) supaya behavior tetap kompat.
            let nextTotals;
            let newStatus;
            if (targetSubmission) {
                const recalc = await recalcSubmissionPaymentTotals(tx, targetSubmission.id, now);
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
                claimSubmissionId: targetSubmission?.id ?? null,
                auditScope: targetSubmission ? claimAuditScopes.submission : claimAuditScopes.workflow,
                actor,
                action: "payment_created",
                fromStatus: previousStatus,
                toStatus: newStatus,
                note: paymentNote,
                metadata: {
                    paymentId: newPaymentId,
                    paymentDate: body.paymentDate,
                    paymentAmount,
                    paymentType,
                    previousTotalPaid,
                    newTotalPaid: nextTotals.totalPaid,
                    previousRemainingAmount: previousRemaining,
                    newRemainingAmount: nextTotals.remainingAmount,
                    previousStatus,
                    newStatus,
                    submissionId: targetSubmission?.id ?? null,
                    viaLegacyWorkflowRoute: true,
                },
            }, tx);

            if (newStatus !== previousStatus) {
                await writeClaimAudit({
                    claimWorkflowId: id,
                    claimSubmissionId: targetSubmission?.id ?? null,
                    auditScope: targetSubmission ? claimAuditScopes.submission : claimAuditScopes.workflow,
                    actor,
                    action: "payment_status_recalculated",
                    fromStatus: previousStatus,
                    toStatus: newStatus,
                    metadata: {
                        trigger: "payment_created",
                        paymentId: newPaymentId,
                        totalClaim,
                        totalPaid: nextTotals.totalPaid,
                        remainingAmount: nextTotals.remainingAmount,
                        submissionId: targetSubmission?.id ?? null,
                    },
                }, tx);
            }

            return {
                ok: true,
                paymentId: newPaymentId,
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

        // Re-fetch fresh state untuk response — di luar transaksi supaya
        // konsisten dengan format dari endpoint detail.
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
            summary: workflow ? buildPaymentSummary(
                workflow,
                result.totals,
                {
                    activePaymentCount: activePayments.length,
                    voidedPaymentCount: voidedPayments.length,
                },
            ) : null,
        }, { status: 201 });
    } catch (error) {
        console.error("[CLAIM WORKFLOW PAYMENT CREATE ERROR]", error);
        return NextResponse.json({ ok: false, error: "Gagal mencatat pembayaran." }, { status: 500 });
    }
}
