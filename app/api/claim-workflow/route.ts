import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq, inArray, lt, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { claimSubmission, claimWorkflow, offBatch, offPayment } from "@/db/schema";
import {
    claimWorkflowStatusList,
    claimWorkflowStatuses,
    requireClaimSession,
} from "@/lib/claim-workflow";
import { offFinanceStatuses } from "@/lib/off-program-control/constants";
import { requirePermissionH } from "@/lib/rbac/resolve";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function parseLimit(value: string | null): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LIMIT;
    return Math.min(Math.floor(parsed), MAX_LIMIT);
}

function parseCursor(value: string | null): Date | null {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
}

export async function GET(request: NextRequest) {
    const actor = await requireClaimSession();
    if (!actor) {
        return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }
    const gate = await requirePermissionH("claim_workflow.view");
    if (gate.response) return gate.response;

    try {
        const { searchParams } = new URL(request.url);
        const limit = parseLimit(searchParams.get("limit"));
        const cursor = parseCursor(searchParams.get("cursor"));
        const statusFilter = searchParams.get("status");
        const principleCode = searchParams.get("principleCode");

        const conditions: SQL[] = [];
        if (statusFilter && claimWorkflowStatusList.includes(statusFilter as typeof claimWorkflowStatusList[number])) {
            conditions.push(eq(claimWorkflow.status, statusFilter));
        }
        if (principleCode) {
            conditions.push(eq(claimWorkflow.principleCode, principleCode));
        }
        if (cursor) {
            conditions.push(lt(claimWorkflow.createdAt, cursor));
        }

        const baseQuery = db
            .select({
                workflow: claimWorkflow,
                offNoPengajuan: offBatch.noPengajuan,
                offFinanceStatus: offBatch.financeStatus,
                offStatus: offBatch.status,
                offTotalNominal: offBatch.totalNominal,
            })
            .from(claimWorkflow)
            .leftJoin(offBatch, eq(claimWorkflow.offBatchId, offBatch.id));
        const filtered = conditions.length > 0
            ? baseQuery.where(and(...conditions))
            : baseQuery;
        const rows = await filtered
            .orderBy(desc(claimWorkflow.createdAt))
            .limit(limit + 1);

        const hasMore = rows.length > limit;
        const visibleRows = hasMore ? rows.slice(0, limit) : rows;
        const nextCursor = hasMore
            ? visibleRows[visibleRows.length - 1]?.workflow.createdAt?.toISOString() ?? null
            : null;

        // Batch queries to avoid N+1:
        // 1. Batch load off_payment totals per offBatchId
        // 2. Batch load claim_submission per workflowId
        const offBatchIds = [...new Set(visibleRows.map((r) => r.workflow.offBatchId).filter(Boolean))];
        const workflowIds = visibleRows.map((r) => r.workflow.id);

        // Batch offPayment: sum paidAmount per batchId
        const paymentRows = offBatchIds.length > 0
            ? await db
                .select({
                    batchId: offPayment.batchId,
                    paidAmount: offPayment.paidAmount,
                })
                .from(offPayment)
                .where(inArray(offPayment.batchId, offBatchIds))
            : [];
        const paymentSumByBatch = new Map<string, number>();
        for (const p of paymentRows) {
            paymentSumByBatch.set(
                p.batchId,
                (paymentSumByBatch.get(p.batchId) ?? 0) + Number(p.paidAmount || 0),
            );
        }

        // Batch submissions
        const submissionRows = workflowIds.length > 0
            ? await db
                .select({
                    id: claimSubmission.id,
                    claimWorkflowId: claimSubmission.claimWorkflowId,
                    noClaim: claimSubmission.noClaim,
                    totalClaim: claimSubmission.totalClaim,
                })
                .from(claimSubmission)
                .where(inArray(claimSubmission.claimWorkflowId, workflowIds))
            : [];
        const submissionsByWorkflow = new Map<string, typeof submissionRows>();
        for (const sub of submissionRows) {
            const list = submissionsByWorkflow.get(sub.claimWorkflowId) ?? [];
            list.push(sub);
            submissionsByWorkflow.set(sub.claimWorkflowId, list);
        }

        // Enrich rows using pre-fetched batch data (no N+1)
        const enrichedWorkflows = visibleRows.map((row) => {
            const totalNominal = Number(row.offTotalNominal || 0);
            const totalPaid = paymentSumByBatch.get(row.workflow.offBatchId) ?? 0;
            const financeStatus = row.offFinanceStatus || "Not Started";
            const financeStatusIsPaid = financeStatus === offFinanceStatuses.paid;
            const isFullyPaid = totalPaid === totalNominal && totalNominal > 0;
            const isPaid = financeStatusIsPaid && isFullyPaid;

            const subs = submissionsByWorkflow.get(row.workflow.id) ?? [];
            const activeSubs = subs.filter((s) => Number(s.totalClaim || 0) > 0);
            const activeSubsMissingNoClaim = activeSubs.filter(
                (s) => !s.noClaim || String(s.noClaim).trim() === "",
            );

            const hasLetter = Boolean(row.workflow.claimLetterPdfPath);
            const hasSummary = Boolean(row.workflow.summaryPdfPath);
            const hasReceipt = Boolean(row.workflow.receiptPdfPath);
            const documentStatus = hasLetter && hasSummary && hasReceipt
                ? "complete"
                : (hasLetter || hasSummary || hasReceipt)
                    ? "partial"
                    : "none";

            const isEditableStatus = (
                row.workflow.status === claimWorkflowStatuses.draft ||
                row.workflow.status === claimWorkflowStatuses.needRevision
            );
            const canGenerateNoClaim = isPaid && isEditableStatus && activeSubsMissingNoClaim.length > 0;

            let noClaimGateReason: string | null = null;
            if (!isPaid) {
                noClaimGateReason = `Menunggu validasi keuangan OFF Program. No Claim baru bisa dibuat setelah Finance OFF Paid. Status saat ini: ${financeStatus}.`;
            } else if (!isEditableStatus) {
                noClaimGateReason = `Status workflow ${row.workflow.status} tidak mengizinkan edit No Claim.`;
            } else if (activeSubsMissingNoClaim.length === 0) {
                noClaimGateReason = "Semua submission aktif sudah memiliki No Claim.";
            }

            return {
                ...row.workflow,
                offNoPengajuan: row.offNoPengajuan,
                offFinanceStatus: financeStatus,
                offStatus: row.offStatus || "Unknown",
                offPaymentSummary: {
                    totalNominal,
                    totalPaid,
                    isFullyPaid,
                },
                activeSubmissionCount: activeSubs.length,
                activeSubmissionMissingNoClaimCount: activeSubsMissingNoClaim.length,
                noClaimList: activeSubs
                    .map((s) => s.noClaim)
                    .filter((v): v is string => typeof v === "string" && v.length > 0),
                documentStatus,
                canGenerateNoClaim,
                noClaimGateReason,
            };
        });

        return NextResponse.json({
            ok: true,
            workflows: enrichedWorkflows,
            pagination: {
                limit,
                hasMore,
                nextCursor,
            },
        });
    } catch (error) {
        console.error("[CLAIM WORKFLOW LIST ERROR]", error);
        return NextResponse.json({ ok: false, error: "Gagal mengambil daftar Claim Workflow." }, { status: 500 });
    }
}
