/*
 * Tujuan: Endpoint Outstanding submission-level (Phase R7d). Daftar
 *         `claim_submission` yang masih punya `remainingAmount > 0`.
 *         Menggantikan output workflow-level dari R3 sehingga 1 row
 *         outstanding = 1 No Claim, bukan 1 workflow.
 * Caller: UI list Claim Workflow / dashboard outstanding.
 * Side Effects: Tidak ada (read-only).
 *
 * Aturan:
 *   - `remainingAmount = max(totalClaim - totalPaid, 0)` di-recalc
 *     fresh dari claim_payment aktif per submission supaya tidak
 *     pernah trust cache buta.
 *   - Status submission yang ikut: Submitted to Principal, Partially
 *     Paid, Outstanding (kalau status itu nanti dipakai). Draft /
 *     Need Revision / Ready to Submit / Paid / Closed di-skip.
 *   - Status legacy PEKA tidak boleh memperluas dataset.
 */
import { NextResponse } from "next/server";
import { and, asc, desc, eq, inArray, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { claimPayment, claimSubmission, claimWorkflow, offBatch } from "@/db/schema";
import {
    canActorReadClaimWorkflow,
    claimWorkflowStatuses,
    recalcPaymentTotals,
    requireClaimSession,
} from "@/lib/claim-workflow";

const OUTSTANDING_SUBMISSION_STATUSES = [
    claimWorkflowStatuses.submittedToPrincipal,
    claimWorkflowStatuses.partiallyPaid,
    // Status `Outstanding` workflow lama tetap dipertahankan untuk
    // backward compat row submission yang sengaja di-mark Outstanding.
    claimWorkflowStatuses.outstanding,
] as const;

function dayDiff(now: number, ref: Date | null | undefined): number | null {
    if (!ref) return null;
    const refTime = ref instanceof Date ? ref.getTime() : new Date(ref).getTime();
    if (!Number.isFinite(refTime)) return null;
    const diff = now - refTime;
    if (diff < 0) return 0;
    return Math.floor(diff / (1000 * 60 * 60 * 24));
}

function bucketDays(days: number | null): string {
    if (days === null) return "unknown";
    if (days <= 30) return "0-30";
    if (days <= 60) return "31-60";
    if (days <= 90) return "61-90";
    return "90+";
}

export async function GET(request: Request) {
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
        const { searchParams } = new URL(request.url);
        const principleCode = searchParams.get("principleCode");
        const statusFilter = searchParams.get("status");

        const conditions: SQL[] = [];
        if (statusFilter) {
            if ((OUTSTANDING_SUBMISSION_STATUSES as ReadonlyArray<string>).includes(statusFilter)) {
                conditions.push(eq(claimSubmission.status, statusFilter));
            } else {
                // Status legacy / invalid → return empty
                conditions.push(eq(claimSubmission.status, "__retired_or_invalid_status__"));
            }
        } else {
            conditions.push(inArray(claimSubmission.status, OUTSTANDING_SUBMISSION_STATUSES as unknown as string[]));
        }
        if (principleCode) {
            conditions.push(eq(claimWorkflow.principleCode, principleCode));
        }

        const baseQuery = db
            .select({
                submission: claimSubmission,
                workflow: claimWorkflow,
                offNoPengajuan: offBatch.noPengajuan,
            })
            .from(claimSubmission)
            .innerJoin(claimWorkflow, eq(claimSubmission.claimWorkflowId, claimWorkflow.id))
            .leftJoin(offBatch, eq(claimWorkflow.offBatchId, offBatch.id));

        const filtered = conditions.length > 0
            ? baseQuery.where(and(...conditions))
            : baseQuery;
        const rows = await filtered.orderBy(desc(claimSubmission.submittedToPrincipalAt));

        const paymentRows = rows.length > 0
            ? await db
                .select({
                    claimSubmissionId: claimPayment.claimSubmissionId,
                    paymentDate: claimPayment.paymentDate,
                    paymentAmount: claimPayment.paymentAmount,
                    voidedAt: claimPayment.voidedAt,
                })
                .from(claimPayment)
                .where(inArray(
                    claimPayment.claimSubmissionId,
                    rows.map((row) => row.submission.id),
                ))
                .orderBy(asc(claimPayment.paymentDate))
            : [];
        const paymentsBySubmission = new Map<string, typeof paymentRows>();
        for (const payment of paymentRows) {
            if (!payment.claimSubmissionId) continue;
            const list = paymentsBySubmission.get(payment.claimSubmissionId) ?? [];
            list.push(payment);
            paymentsBySubmission.set(payment.claimSubmissionId, list);
        }

        const now = Date.now();
        const items = rows.map((row) => {
            const totalClaim = Number(row.submission.totalClaim || 0);
            const payments = paymentsBySubmission.get(row.submission.id) ?? [];
            const totals = recalcPaymentTotals(totalClaim, payments);
            const activePayments = payments.filter((p) => p.voidedAt === null);
            const latestPaymentDate = activePayments.length > 0
                ? activePayments[activePayments.length - 1].paymentDate
                : null;
            const daysOutstanding = dayDiff(now, row.submission.submittedToPrincipalAt);
            return {
                workflowId: row.workflow.id,
                claimWorkflowNo: row.workflow.claimWorkflowNo,
                offBatchId: row.workflow.offBatchId,
                offNoPengajuan: row.offNoPengajuan,
                sourceType: row.workflow.sourceType,
                principleCode: row.workflow.principleCode,
                principleName: row.workflow.principleName,
                submissionId: row.submission.id,
                noClaim: row.submission.noClaim,
                scope: row.submission.scope,
                scopeLabel: row.submission.scopeLabel,
                status: row.submission.status,
                totalClaim,
                totalPaid: totals.totalPaid,
                remainingAmount: totals.remainingAmount,
                submittedToPrincipalAt: row.submission.submittedToPrincipalAt,
                latestPaymentDate,
                daysOutstanding,
                agingBucket: bucketDays(daysOutstanding),
            };
        });

        // Filter strict: outstanding harus benar-benar punya remainingAmount > 0.
        const outstandingItems = items.filter((row) => row.remainingAmount > 0);

        const summary = outstandingItems.reduce(
            (acc, row) => ({
                submissionCount: acc.submissionCount + 1,
                totalClaim: acc.totalClaim + row.totalClaim,
                totalPaid: acc.totalPaid + row.totalPaid,
                totalOutstanding: acc.totalOutstanding + row.remainingAmount,
            }),
            { submissionCount: 0, totalClaim: 0, totalPaid: 0, totalOutstanding: 0 },
        );

        return NextResponse.json({
            ok: true,
            outstanding: outstandingItems,
            summary,
        });
    } catch (error) {
        console.error("[CLAIM WORKFLOW OUTSTANDING ERROR]", error);
        return NextResponse.json({
            ok: false,
            error: "Gagal mengambil daftar outstanding Claim Workflow.",
        }, { status: 500 });
    }
}
