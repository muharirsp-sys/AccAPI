import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
    claimAuditLog,
    claimWorkflow,
    claimWorkflowItem,
    offBatch,
    offBatchItem,
} from "@/db/schema";
import {
    calculateClaimAmount,
    calculateRemainingAmount,
    claimWorkflowOffRequirements,
    claimWorkflowStatuses,
    requireClaimSession,
} from "@/lib/claim-workflow";
import {
    getOrCreateDefaultSubmission,
    recalcSubmissionTotals,
    recalcWorkflowAggregateFromSubmissions,
} from "@/lib/claim-workflow/submissions";

type Context = { params: Promise<{ offBatchId: string }> };

function clampRate(value: unknown): number {
    const num = Number(value);
    if (!Number.isFinite(num)) return 0;
    if (num < 0) return 0;
    if (num > 100) return 100;
    return num;
}

function normalizeMetadata(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return null;
    }
    return value as Record<string, unknown>;
}

export async function POST(request: NextRequest, context: Context) {
    const actor = await requireClaimSession();
    if (!actor) {
        return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }
    if (actor.role !== "admin" && actor.role !== "claim") {
        return NextResponse.json({ ok: false, error: "Hanya role admin atau claim yang dapat membuat Claim Workflow dari OFF." }, { status: 403 });
    }

    let body: { ppnRate?: unknown; pphRate?: unknown; note?: unknown } = {};
    if (request.headers.get("content-type")?.includes("application/json")) {
        body = await request.json().catch(() => ({}));
    }
    const ppnRate = clampRate(body.ppnRate);
    const pphRate = clampRate(body.pphRate);

    try {
        const { offBatchId } = await context.params;
        const [batch] = await db.select().from(offBatch).where(eq(offBatch.id, offBatchId));
        if (!batch) {
            return NextResponse.json({ ok: false, error: "OFF batch not found" }, { status: 404 });
        }
        // Phase R1: Claim Workflow boleh dibuat setelah OFF OM Approved.
        // Tidak perlu menunggu Finance Paid atau Final Completed lagi.
        // OFF Completed tetap butuh No Claim Claim Workflow + sync ke
        // off_batch_item.no_claim, divalidasi di route final-claim.
        if (batch.omStatus !== claimWorkflowOffRequirements.omStatus) {
            return NextResponse.json({
                ok: false,
                error: "Claim Workflow hanya dapat dibuat setelah OFF OM Approved.",
            }, { status: 409 });
        }

        const [existing] = await db
            .select()
            .from(claimWorkflow)
            .where(eq(claimWorkflow.offBatchId, offBatchId));
        if (existing) {
            return NextResponse.json({
                ok: false,
                code: "CLAIM_WORKFLOW_ALREADY_EXISTS",
                error: "Claim Workflow untuk OFF batch ini sudah ada.",
                workflow: existing,
            }, { status: 409 });
        }

        const offItems = await db
            .select()
            .from(offBatchItem)
            .where(eq(offBatchItem.batchId, offBatchId));
        const now = new Date();
        const workflowId = randomUUID();
        const items = offItems.map((item) => {
            const amount = calculateClaimAmount(Number(item.nominal || 0), ppnRate, pphRate);
            return {
                id: randomUUID(),
                claimWorkflowId: workflowId,
                offBatchItemId: item.id,
                noSurat: item.noSurat,
                jenisPromosi: item.namaProgram,
                periode: item.periode,
                outlet: item.toko,
                ...amount,
                status: claimWorkflowStatuses.draft,
                note: null,
                createdAt: now,
                updatedAt: now,
            };
        });
        const totals = items.reduce(
            (result, item) => ({
                totalDpp: result.totalDpp + item.dpp,
                totalPpn: result.totalPpn + item.ppnAmount,
                totalPph: result.totalPph + item.pphAmount,
                totalClaim: result.totalClaim + item.nilaiKlaim,
            }),
            { totalDpp: 0, totalPpn: 0, totalPph: 0, totalClaim: 0 },
        );
        const claimWorkflowNo = `CLM/${batch.noPengajuan}`;
        const workflow = {
            id: workflowId,
            offBatchId,
            claimWorkflowNo,
            principleCode: batch.principleCode,
            principleName: batch.principleName,
            status: claimWorkflowStatuses.draft,
            ...totals,
            totalPaid: 0,
            remainingAmount: calculateRemainingAmount(totals.totalClaim, 0),
            createdBy: actor.id,
            createdAt: now,
            updatedAt: now,
        };

        const auditMetadata = normalizeMetadata({
            offBatchId,
            noPengajuan: batch.noPengajuan,
            itemCount: items.length,
            dppSource: "off_batch_item.nominal",
            ppnRate,
            pphRate,
        });

        // libsql/drizzle transaction: semua insert atomic. Jika satu gagal,
        // tidak ada workflow header tanpa items / tanpa audit yang tertinggal.
        let defaultSubmissionId: string | null = null;
        await db.transaction(async (tx) => {
            await tx.insert(claimWorkflow).values(workflow);
            if (items.length > 0) {
                await tx.insert(claimWorkflowItem).values(items);
            }
            const [createdWorkflow] = await tx
                .select()
                .from(claimWorkflow)
                .where(eq(claimWorkflow.id, workflowId));
            if (createdWorkflow) {
                const defaultSubmission = await getOrCreateDefaultSubmission(tx, createdWorkflow, now);
                defaultSubmissionId = defaultSubmission.id;
                await recalcSubmissionTotals(tx, defaultSubmission.id, now);
                await recalcWorkflowAggregateFromSubmissions(tx, workflowId, now);
            }
            await tx.insert(claimAuditLog).values({
                id: randomUUID(),
                claimWorkflowId: workflowId,
                actorId: actor.id,
                actorName: actor.name,
                actorRole: actor.role,
                action: "create_from_off",
                fromStatus: null,
                toStatus: claimWorkflowStatuses.draft,
                note: typeof body.note === "string" ? body.note : null,
                metadata: auditMetadata,
                createdAt: now,
            });
        });

        return NextResponse.json({
            ok: true,
            workflow: {
                ...workflow,
                offNoPengajuan: batch.noPengajuan,
                itemCount: items.length,
                defaultSubmissionId,
            },
        }, { status: 201 });
    } catch (error) {
        const message = error instanceof Error ? error.message.toLowerCase() : "";
        if (message.includes("unique") || message.includes("claim_workflow.off_batch_id")) {
            return NextResponse.json({
                ok: false,
                code: "CLAIM_WORKFLOW_ALREADY_EXISTS",
                error: "Claim Workflow untuk OFF batch ini sudah ada.",
            }, { status: 409 });
        }
        console.error("[CLAIM WORKFLOW CREATE FROM OFF ERROR]", error);
        return NextResponse.json({ ok: false, error: "Gagal membuat Claim Workflow dari OFF batch." }, { status: 500 });
    }
}
