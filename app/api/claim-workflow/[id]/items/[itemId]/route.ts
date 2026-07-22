import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { claimWorkflow, claimWorkflowItem } from "@/db/schema";
import {
    calculateClaimAmount,
    calculateRemainingAmount,
    claimWorkflowStatuses,
    getOrCreateDefaultSubmission,
    recalcSubmissionTotals,
    recalcWorkflowAggregateFromSubmissions,
    requireClaimSession,
    writeClaimAudit,
} from "@/lib/claim-workflow";
import { requirePermissionH } from "@/lib/rbac/resolve";

type Context = { params: Promise<{ id: string; itemId: string }> };

// Optimistic locking: dilempar saat versi item (updatedAt) sudah berubah → ditangkap jadi 409.
class OptimisticLockError extends Error {}

function numericField(
    body: Record<string, unknown>,
    key: "dpp" | "ppnRate" | "pphRate",
    fallback: number,
): number | null {
    if (body[key] === undefined) return fallback;
    const input = body[key];
    if (input === null || (typeof input === "string" && input.trim() === "")) return null;
    const value = Number(input);
    return Number.isFinite(value) ? value : null;
}

export async function PATCH(request: Request, context: Context) {
    const actor = await requireClaimSession();
    if (!actor) {
        return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }
    const gate = await requirePermissionH("claim_workflow.edit");
    if (gate.response) return gate.response;

    try {
        const { id, itemId } = await context.params;
        const body = await request.json().catch(() => ({})) as Record<string, unknown>;
        const [workflow] = await db.select().from(claimWorkflow).where(eq(claimWorkflow.id, id));
        if (!workflow) {
            return NextResponse.json({ ok: false, error: "Claim Workflow not found" }, { status: 404 });
        }
        if (
            workflow.status !== claimWorkflowStatuses.draft &&
            workflow.status !== claimWorkflowStatuses.needRevision
        ) {
            return NextResponse.json({
                ok: false,
                error: "Item pajak hanya dapat diubah saat workflow Draft atau Need Revision.",
            }, { status: 409 });
        }

        const [item] = await db
            .select()
            .from(claimWorkflowItem)
            .where(and(eq(claimWorkflowItem.id, itemId), eq(claimWorkflowItem.claimWorkflowId, id)));
        if (!item) {
            return NextResponse.json({ ok: false, error: "Claim Workflow item not found" }, { status: 404 });
        }

        // Optimistic locking (strict): client WAJIB mengirim versi item yang ia muat (expectedUpdatedAt).
        // Cegah dua editor saling timpa nilai DPP/PPN/PPh tanpa sadar.
        const expectedRaw = body.expectedUpdatedAt ?? body.updatedAt;
        if (expectedRaw === undefined || expectedRaw === null || String(expectedRaw).trim() === "") {
            return NextResponse.json({
                ok: false,
                error: "Versi item (updatedAt) wajib disertakan. Muat ulang halaman lalu coba lagi.",
                code: "VERSION_REQUIRED",
            }, { status: 400 });
        }
        const expectedMs = new Date(String(expectedRaw)).getTime();
        if (!Number.isFinite(expectedMs)) {
            return NextResponse.json({
                ok: false,
                error: "Format versi item (updatedAt) tidak valid.",
                code: "VERSION_INVALID",
            }, { status: 400 });
        }
        if (!item.updatedAt || expectedMs !== item.updatedAt.getTime()) {
            return NextResponse.json({
                ok: false,
                error: "Item ini sudah diubah pengguna lain. Muat ulang halaman untuk melihat versi terbaru sebelum menyimpan.",
                code: "CONFLICT",
                currentUpdatedAt: item.updatedAt ?? null,
            }, { status: 409 });
        }
        const expectedDate = new Date(expectedMs);

        const dpp = numericField(body, "dpp", Number(item.dpp || 0));
        const ppnRate = numericField(body, "ppnRate", Number(item.ppnRate || 0));
        const pphRate = numericField(body, "pphRate", Number(item.pphRate || 0));
        if (dpp === null || dpp < 0) {
            return NextResponse.json({ ok: false, error: "DPP harus berupa angka minimal 0." }, { status: 400 });
        }
        if (ppnRate === null || ppnRate < 0 || ppnRate > 100) {
            return NextResponse.json({ ok: false, error: "PPN Rate harus berupa angka antara 0 dan 100." }, { status: 400 });
        }
        if (pphRate === null || pphRate < 0 || pphRate > 100) {
            return NextResponse.json({ ok: false, error: "PPH Rate harus berupa angka antara 0 dan 100." }, { status: 400 });
        }
        if (body.note !== undefined && body.note !== null && typeof body.note !== "string") {
            return NextResponse.json({ ok: false, error: "Catatan harus berupa teks." }, { status: 400 });
        }

        const amount = calculateClaimAmount(dpp, ppnRate, pphRate);
        const note = body.note === undefined ? item.note : body.note as string | null;
        const now = new Date();
        let totals = {
            totalDpp: Number(workflow.totalDpp || 0),
            totalPpn: Number(workflow.totalPpn || 0),
            totalPph: Number(workflow.totalPph || 0),
            totalClaim: Number(workflow.totalClaim || 0),
        };
        let remainingAmount = Number(workflow.remainingAmount || 0);
        let resolvedSubmissionId: string | null = item.claimSubmissionId ?? null;

        await db.transaction(async (tx) => {
            // UPDATE bersyarat pada updatedAt: bila ada penulis lain menyelip di antara
            // pre-check dan transaksi ini, rowsAffected=0 → batalkan (rollback) jadi 409.
            const updated = await tx
                .update(claimWorkflowItem)
                .set({ ...amount, note, updatedAt: now })
                .where(and(
                    eq(claimWorkflowItem.id, itemId),
                    eq(claimWorkflowItem.claimWorkflowId, id),
                    eq(claimWorkflowItem.updatedAt, expectedDate),
                ));
            // D4: pg driver pakai rowCount (libsql: rowsAffected)
            if (!updated.rowCount) throw new OptimisticLockError();

            // Phase R7b — pastikan item terkait submission. Bila item
            // belum di-link (kasus warisan sebelum migration), fallback ke
            // default submission. Helper getOrCreateDefaultSubmission
            // idempotent: kalau sudah ada submission, tidak buat baru.
            if (!resolvedSubmissionId) {
                const defaultSubmission = await getOrCreateDefaultSubmission(tx, workflow, now);
                resolvedSubmissionId = defaultSubmission.id;
                await tx
                    .update(claimWorkflowItem)
                    .set({ claimSubmissionId: defaultSubmission.id, updatedAt: now })
                    .where(eq(claimWorkflowItem.id, itemId));
            }

            // Recalc workflow totals dari semua item (tetap dipertahankan
            // untuk backward-compat dengan route existing yang membaca
            // cache claim_workflow.totalClaim sebelum R7d).
            const workflowItems = await tx
                .select()
                .from(claimWorkflowItem)
                .where(eq(claimWorkflowItem.claimWorkflowId, id));
            totals = workflowItems.reduce(
                (result, row) => ({
                    totalDpp: result.totalDpp + Number(row.dpp || 0),
                    totalPpn: result.totalPpn + Number(row.ppnAmount || 0),
                    totalPph: result.totalPph + Number(row.pphAmount || 0),
                    totalClaim: result.totalClaim + Number(row.nilaiKlaim || 0),
                }),
                { totalDpp: 0, totalPpn: 0, totalPph: 0, totalClaim: 0 },
            );
            remainingAmount = calculateRemainingAmount(totals.totalClaim, Number(workflow.totalPaid || 0));

            await tx
                .update(claimWorkflow)
                .set({ ...totals, remainingAmount, updatedAt: now })
                .where(eq(claimWorkflow.id, id));

            // Phase R7b — recalc submission totals + aggregate cache.
            // Submission totals dipakai oleh UI dan route submission ke
            // depan; aggregate cache memastikan workflow tetap konsisten.
            if (resolvedSubmissionId) {
                await recalcSubmissionTotals(tx, resolvedSubmissionId, now);
            }
            await recalcWorkflowAggregateFromSubmissions(tx, id, now);
            await writeClaimAudit({
                claimWorkflowId: id,
                claimSubmissionId: resolvedSubmissionId,
                auditScope: resolvedSubmissionId ? "submission" : "workflow",
                actor,
                action: "update_item_tax",
                fromStatus: workflow.status,
                toStatus: workflow.status,
                note,
                metadata: {
                    itemId,
                    submissionId: resolvedSubmissionId,
                    dpp: amount.dpp,
                    ppnRate: amount.ppnRate,
                    pphRate: amount.pphRate,
                    totals,
                    remainingAmount,
                },
            }, tx);
        });

        return NextResponse.json({
            ok: true,
            item: { ...item, ...amount, note, updatedAt: now, claimSubmissionId: resolvedSubmissionId },
            totals: {
                ...totals,
                totalPaid: workflow.totalPaid,
                remainingAmount,
            },
        });
    } catch (error) {
        if (error instanceof OptimisticLockError) {
            return NextResponse.json({
                ok: false,
                error: "Item ini sudah diubah pengguna lain. Muat ulang halaman untuk melihat versi terbaru sebelum menyimpan.",
                code: "CONFLICT",
            }, { status: 409 });
        }
        console.error("[CLAIM WORKFLOW ITEM TAX UPDATE ERROR]", error);
        return NextResponse.json({ ok: false, error: "Gagal memperbarui pajak item Claim Workflow." }, { status: 500 });
    }
}
