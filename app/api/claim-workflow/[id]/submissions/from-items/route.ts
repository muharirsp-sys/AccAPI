/*
 * Tujuan: Buat banyak Claim Submission dengan scope `per_item` sekaligus,
 *         mengikuti pola sheet BASE Excel Godrej (R7g). Satu item =
 *         satu Paket No Claim. No Claim TIDAK di-generate otomatis;
 *         user mengisi belakangan via UI submission editor.
 * Caller: UI claim-workflow detail page section "Paket No Claim" R7g.
 * Side Effects:
 *   - Insert claim_submission rows (scope = per_item) per item target.
 *   - Update claim_workflow_item.claim_submission_id menyusul submission
 *     baru.
 *   - Recalc totals submission target + submission lama yang ditinggalkan.
 *   - Recalc cache aggregate claim_workflow.
 *   - Audit `claim_submissions_created_per_item`.
 *
 * Aturan idempoten:
 *   - Mode `all_unassigned` (default): skip item yang sudah berada di
 *     submission ber-scope `per_item`. Aman dijalankan berkali-kali.
 *   - Mode `all_items`: paksa setiap item memiliki paket per_item baru;
 *     item yang sudah berada di per_item lama tetap di-skip (idempoten).
 *
 * Catatan transisi R7:
 *   - Tidak menyentuh dokumen / payment / close behavior.
 *   - Tidak meng-set `noClaim`. Source-of-truth tetap
 *     claim_submission.noClaim, diisi user via PATCH submission existing.
 *   - Submission lama (mis. default per_pengajuan) tetap dipertahankan
 *     supaya audit/history tidak hilang. Bila kosong, tidak otomatis
 *     dihapus.
 */
import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
    claimSubmission,
    claimWorkflow,
    claimWorkflowItem,
} from "@/db/schema";
import {
    claimAuditScopes,
    claimSubmissionScopes,
    claimSubmissionStatuses,
    claimWorkflowStatuses,
    isSubmissionEditableWorkflowStatus,
    recalcSubmissionTotals,
    recalcWorkflowAggregateFromSubmissions,
    requireClaimSession,
    SCOPE_LABEL_MAX_LENGTH,
    writeClaimAudit,
} from "@/lib/claim-workflow";
import { requirePermissionH } from "@/lib/rbac/resolve";

type Context = { params: Promise<{ id: string }> };

type FromItemsMode = "all_unassigned" | "all_items";

const VALID_MODES: ReadonlyArray<FromItemsMode> = [
    "all_unassigned",
    "all_items",
];

function isValidMode(value: unknown): value is FromItemsMode {
    return typeof value === "string"
        && (VALID_MODES as ReadonlyArray<string>).includes(value);
}

/**
 * Bentuk scope label dari field item yang paling deskriptif.
 * Prioritas: outlet → jenisPromosi → periode → noSurat → fallback ke
 * "Item Klaim {short id}".
 */
function deriveItemScopeLabel(
    item: {
        id: string;
        outlet?: string | null;
        jenisPromosi?: string | null;
        periode?: string | null;
        noSurat?: string | null;
    },
): string {
    const candidates = [
        item.outlet,
        item.jenisPromosi,
        item.periode,
        item.noSurat,
    ];
    for (const candidate of candidates) {
        if (typeof candidate === "string") {
            const trimmed = candidate.trim();
            if (trimmed) return trimmed.slice(0, SCOPE_LABEL_MAX_LENGTH);
        }
    }
    const shortId = item.id.slice(0, 8);
    return `Item Klaim ${shortId}`;
}

export async function POST(request: Request, context: Context) {
    const actor = await requireClaimSession();
    if (!actor) {
        return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }
    const gate = await requirePermissionH("claim_workflow.create");
    if (gate.response) return gate.response;

    let body: { mode?: unknown } = {};
    if (request.headers.get("content-type")?.includes("application/json")) {
        body = await request.json().catch(() => ({}));
    }
    const mode: FromItemsMode = isValidMode(body.mode) ? body.mode : "all_unassigned";
    if (body.mode !== undefined && !isValidMode(body.mode)) {
        return NextResponse.json({
            ok: false,
            code: "CLAIM_SUBMISSION_FROM_ITEMS_INVALID_MODE",
            error: `mode tidak valid. Pilih: ${VALID_MODES.join(", ")}.`,
        }, { status: 400 });
    }

    try {
        const { id } = await context.params;

        const result = await db.transaction(async (tx) => {
            const [workflow] = await tx
                .select()
                .from(claimWorkflow)
                .where(eq(claimWorkflow.id, id));
            if (!workflow) {
                return {
                    error: {
                        status: 404,
                        code: "CLAIM_WORKFLOW_NOT_FOUND",
                        message: "Claim Workflow not found",
                    },
                } as const;
            }
            if (workflow.status === claimWorkflowStatuses.closed) {
                return {
                    error: {
                        status: 409,
                        code: "CLAIM_SUBMISSION_WORKFLOW_CLOSED",
                        message: "Claim Workflow sudah Closed; tidak dapat membuat paket per item.",
                    },
                } as const;
            }
            if (!isSubmissionEditableWorkflowStatus(workflow.status)) {
                return {
                    error: {
                        status: 409,
                        code: "CLAIM_SUBMISSION_WORKFLOW_LOCKED",
                        message:
                            "Paket per item hanya dapat dibuat saat workflow Draft atau Need Revision.",
                    },
                } as const;
            }

            // Ambil semua item workflow + scope submission saat ini.
            const items = await tx
                .select({
                    id: claimWorkflowItem.id,
                    claimSubmissionId: claimWorkflowItem.claimSubmissionId,
                    outlet: claimWorkflowItem.outlet,
                    jenisPromosi: claimWorkflowItem.jenisPromosi,
                    periode: claimWorkflowItem.periode,
                    noSurat: claimWorkflowItem.noSurat,
                    dpp: claimWorkflowItem.dpp,
                    ppnAmount: claimWorkflowItem.ppnAmount,
                    pphAmount: claimWorkflowItem.pphAmount,
                    nilaiKlaim: claimWorkflowItem.nilaiKlaim,
                })
                .from(claimWorkflowItem)
                .where(eq(claimWorkflowItem.claimWorkflowId, id));

            if (items.length === 0) {
                return {
                    ok: true,
                    createdCount: 0,
                    skippedCount: 0,
                    createdSubmissionIds: [] as string[],
                    affectedItemIds: [] as string[],
                    previousSubmissionIds: [] as string[],
                } as const;
            }

            // Map submissionId → scope (untuk filter per_item).
            const submissionScopeMap = new Map<string, string>();
            const submissionIds = Array.from(
                new Set(
                    items
                        .map((it) => it.claimSubmissionId)
                        .filter((v): v is string => typeof v === "string" && v.length > 0),
                ),
            );
            if (submissionIds.length > 0) {
                const subsRows = await tx
                    .select({
                        id: claimSubmission.id,
                        scope: claimSubmission.scope,
                    })
                    .from(claimSubmission)
                    .where(eq(claimSubmission.claimWorkflowId, id));
                for (const row of subsRows) {
                    submissionScopeMap.set(row.id, row.scope);
                }
            }

            // Tentukan target item:
            //   all_unassigned: skip item yang sudah berada di per_item.
            //   all_items     : sama (idempotent), karena item yang sudah
            //                   per_item tidak perlu duplikat.
            // Filter sama untuk kedua mode di R7g; perbedaan dipertahankan
            // di kontrak API agar future expansion (mis. force regroup)
            // tetap mungkin tanpa breaking call site.
            void mode; // mode currently behaves the same; reserved for R7h
            const targetItems = items.filter((it) => {
                if (!it.claimSubmissionId) return true;
                const scope = submissionScopeMap.get(it.claimSubmissionId);
                return scope !== claimSubmissionScopes.perItem;
            });

            if (targetItems.length === 0) {
                return {
                    ok: true,
                    createdCount: 0,
                    skippedCount: items.length,
                    createdSubmissionIds: [] as string[],
                    affectedItemIds: [] as string[],
                    previousSubmissionIds: [] as string[],
                } as const;
            }

            const now = new Date();
            const createdSubmissionIds: string[] = [];
            const affectedItemIds: string[] = [];
            const previousSubmissionIds = new Set<string>();

            for (const item of targetItems) {
                const submissionId = randomUUID();
                const scopeLabel = deriveItemScopeLabel(item);
                await tx.insert(claimSubmission).values({
                    id: submissionId,
                    claimWorkflowId: id,
                    noClaim: null,
                    noClaimAssignedAt: null,
                    noClaimAssignedBy: null,
                    scope: claimSubmissionScopes.perItem,
                    scopeLabel,
                    status: claimSubmissionStatuses.draft,
                    totalDpp: 0,
                    totalPpn: 0,
                    totalPph: 0,
                    totalClaim: 0,
                    totalPaid: 0,
                    remainingAmount: 0,
                    submittedToPrincipalAt: null,
                    claimLetterPdfPath: null,
                    claimLetterGeneratedAt: null,
                    claimLetterGeneratedBy: null,
                    summaryPdfPath: null,
                    summaryGeneratedAt: null,
                    summaryGeneratedBy: null,
                    receiptPdfPath: null,
                    receiptGeneratedAt: null,
                    receiptGeneratedBy: null,
                    closedAt: null,
                    closedBy: null,
                    closeNote: null,
                    createdBy: actor.id,
                    createdAt: now,
                    updatedAt: now,
                });
                createdSubmissionIds.push(submissionId);
                affectedItemIds.push(item.id);
                if (item.claimSubmissionId) {
                    previousSubmissionIds.add(item.claimSubmissionId);
                }

                // Pindahkan item ke submission baru.
                await tx
                    .update(claimWorkflowItem)
                    .set({ claimSubmissionId: submissionId, updatedAt: now })
                    .where(eq(claimWorkflowItem.id, item.id));

                // Recalc totals submission baru (1 item).
                await recalcSubmissionTotals(tx, submissionId, now);
            }

            // Recalc submission lama (yang kehilangan item).
            for (const oldId of previousSubmissionIds) {
                await recalcSubmissionTotals(tx, oldId, now);
            }

            // Recalc cache aggregate workflow.
            const aggregate = await recalcWorkflowAggregateFromSubmissions(tx, id, now);

            await writeClaimAudit({
                claimWorkflowId: id,
                claimSubmissionId: null,
                auditScope: claimAuditScopes.workflow,
                actor,
                action: "claim_submissions_created_per_item",
                fromStatus: workflow.status,
                toStatus: workflow.status,
                metadata: {
                    mode,
                    createdCount: createdSubmissionIds.length,
                    createdSubmissionIds,
                    affectedItemIds,
                    previousSubmissionIds: Array.from(previousSubmissionIds),
                    workflowAggregate: aggregate,
                },
            }, tx);

            return {
                ok: true,
                createdCount: createdSubmissionIds.length,
                skippedCount: items.length - targetItems.length,
                createdSubmissionIds,
                affectedItemIds,
                previousSubmissionIds: Array.from(previousSubmissionIds),
            } as const;
        });

        if ("error" in result && result.error) {
            return NextResponse.json(
                { ok: false, code: result.error.code, error: result.error.message },
                { status: result.error.status },
            );
        }

        return NextResponse.json({
            ok: true,
            success: true,
            mode,
            createdCount: result.createdCount,
            skippedCount: result.skippedCount,
            createdSubmissionIds: result.createdSubmissionIds,
            affectedItemIds: result.affectedItemIds,
        }, { status: 201 });
    } catch (error) {
        console.error("[CLAIM SUBMISSIONS FROM-ITEMS ERROR]", error);
        return NextResponse.json({
            ok: false,
            error: "Gagal membuat paket per item.",
        }, { status: 500 });
    }
}
