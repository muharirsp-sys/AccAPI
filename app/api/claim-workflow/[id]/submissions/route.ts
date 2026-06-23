/*
 * Tujuan: List + Create Claim Submission untuk Phase R7b.
 *         Read access mengikuti `canActorReadClaimWorkflow`. Create
 *         hanya admin/claim, dan hanya saat workflow status
 *         `Draft` / `Need Revision`.
 * Caller: UI claim-workflow detail page (R7b dan ke depan), serta
 *         tooling internal yang ingin mempersiapkan multi-submission
 *         tanpa menunggu UI.
 * Side Effects:
 *   GET  : tidak menulis DB.
 *   POST : insert claim_submission, audit `claim_submission_created`,
 *          opsional sync mirror ke claim_workflow.noClaim bila
 *          submission tunggal di workflow.
 *
 * Phase R7b — Submission grouping + item assignment:
 *   - Dokumen / payment / close TIDAK pindah ke level submission di R7b.
 *     Route ini hanya menambah container No Claim baru.
 *   - Default submission yang dibuat oleh migration R7a tetap valid;
 *     POST baru hanya menambah submission tambahan.
 *   - Item belum di-link ke submission baru saat create. Assignment
 *     dilakukan via `POST /[id]/submissions/[submissionId]/items`.
 */
import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { and, asc, count, eq, ne } from "drizzle-orm";
import { db } from "@/lib/db";
import { claimSubmission, claimWorkflow, claimWorkflowItem } from "@/db/schema";
import {
    claimAuditScopes,
    claimSubmissionScopeList,
    claimSubmissionScopes,
    claimSubmissionStatuses,
    claimWorkflowStatuses,
    isSubmissionEditableWorkflowStatus,
    NO_CLAIM_MAX_LENGTH,
    requireClaimSession,
    SCOPE_LABEL_MAX_LENGTH,
    writeClaimAudit,
} from "@/lib/claim-workflow";
import { requirePermissionH } from "@/lib/rbac/resolve";

type Context = { params: Promise<{ id: string }> };

function isValidScope(value: unknown): value is typeof claimSubmissionScopeList[number] {
    return typeof value === "string"
        && (claimSubmissionScopeList as ReadonlyArray<string>).includes(value);
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
            .select({ id: claimWorkflow.id })
            .from(claimWorkflow)
            .where(eq(claimWorkflow.id, id));
        if (!workflow) {
            return NextResponse.json({ ok: false, error: "Claim Workflow not found" }, { status: 404 });
        }

        const submissions = await db
            .select()
            .from(claimSubmission)
            .where(eq(claimSubmission.claimWorkflowId, id))
            .orderBy(asc(claimSubmission.createdAt));

        // itemCount per submission via single GROUP BY; cheap karena
        // tabel kecil.
        const itemCounts = submissions.length > 0
            ? await db
                .select({
                    claimSubmissionId: claimWorkflowItem.claimSubmissionId,
                    count: count(claimWorkflowItem.id),
                })
                .from(claimWorkflowItem)
                .where(eq(claimWorkflowItem.claimWorkflowId, id))
                .groupBy(claimWorkflowItem.claimSubmissionId)
            : [];
        const itemCountMap = new Map<string, number>();
        for (const row of itemCounts) {
            if (row.claimSubmissionId) {
                itemCountMap.set(row.claimSubmissionId, Number(row.count || 0));
            }
        }

        return NextResponse.json({
            ok: true,
            submissions: submissions.map((s) => ({
                ...s,
                itemCount: itemCountMap.get(s.id) ?? 0,
            })),
            submissionCount: submissions.length,
        });
    } catch (error) {
        console.error("[CLAIM SUBMISSIONS LIST ERROR]", error);
        return NextResponse.json({
            ok: false,
            error: "Gagal mengambil daftar Claim Submission.",
        }, { status: 500 });
    }
}

export async function POST(request: Request, context: Context) {
    const actor = await requireClaimSession();
    if (!actor) {
        return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }
    const gate = await requirePermissionH("claim_workflow.create");
    if (gate.response) return gate.response;

    let body: { scope?: unknown; scopeLabel?: unknown; noClaim?: unknown } = {};
    if (request.headers.get("content-type")?.includes("application/json")) {
        body = await request.json().catch(() => ({}));
    }

    const scope = isValidScope(body.scope) ? body.scope : claimSubmissionScopes.perPengajuan;
    if (body.scope !== undefined && !isValidScope(body.scope)) {
        return NextResponse.json({
            ok: false,
            code: "CLAIM_SUBMISSION_INVALID_SCOPE",
            error: `Scope tidak valid. Pilih dari: ${claimSubmissionScopeList.join(", ")}.`,
        }, { status: 400 });
    }

    let scopeLabel: string | null = null;
    if (body.scopeLabel !== undefined && body.scopeLabel !== null) {
        if (typeof body.scopeLabel !== "string") {
            return NextResponse.json({
                ok: false,
                code: "CLAIM_SUBMISSION_INVALID_SCOPE_LABEL",
                error: "scopeLabel harus berupa string.",
            }, { status: 400 });
        }
        scopeLabel = body.scopeLabel.trim().slice(0, SCOPE_LABEL_MAX_LENGTH);
        if (scopeLabel === "") scopeLabel = null;
    }

    let noClaim: string | null = null;
    if (body.noClaim !== undefined && body.noClaim !== null) {
        if (typeof body.noClaim !== "string") {
            return NextResponse.json({
                ok: false,
                code: "CLAIM_SUBMISSION_INVALID_NO_CLAIM",
                error: "noClaim harus berupa string.",
            }, { status: 400 });
        }
        const trimmed = body.noClaim.trim();
        if (trimmed === "") {
            return NextResponse.json({
                ok: false,
                code: "CLAIM_SUBMISSION_NO_CLAIM_EMPTY",
                error: "noClaim tidak boleh string kosong. Hilangkan field bila tidak ingin assign.",
            }, { status: 400 });
        }
        if (trimmed.length > NO_CLAIM_MAX_LENGTH) {
            return NextResponse.json({
                ok: false,
                code: "CLAIM_SUBMISSION_NO_CLAIM_TOO_LONG",
                error: `noClaim maksimal ${NO_CLAIM_MAX_LENGTH} karakter.`,
            }, { status: 400 });
        }
        noClaim = trimmed;
    }

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
            if (workflow.status === claimWorkflowStatuses.closed) {
                return {
                    error: {
                        status: 409,
                        code: "CLAIM_SUBMISSION_WORKFLOW_CLOSED",
                        message: "Claim Workflow sudah Closed; tidak dapat menambah submission.",
                    },
                } as const;
            }
            if (!isSubmissionEditableWorkflowStatus(workflow.status)) {
                return {
                    error: {
                        status: 409,
                        code: "CLAIM_SUBMISSION_WORKFLOW_LOCKED",
                        message: "Submission baru hanya dapat dibuat saat workflow Draft atau Need Revision.",
                    },
                } as const;
            }

            // Cek duplicate noClaim antar workflow lain (bukan global).
            // Dalam workflow ini sendiri, No Claim boleh sama (merge).
            if (noClaim) {
                const [duplicate] = await tx
                    .select({
                        id: claimSubmission.id,
                        claimWorkflowId: claimSubmission.claimWorkflowId,
                    })
                    .from(claimSubmission)
                    .where(
                        and(
                            eq(claimSubmission.noClaim, noClaim),
                            ne(claimSubmission.claimWorkflowId, id),
                        ),
                    );
                if (duplicate) {
                    return {
                        error: {
                            status: 409,
                            code: "NO_CLAIM_ALREADY_USED_IN_OTHER_WORKFLOW",
                            message: `noClaim "${noClaim}" sudah dipakai di workflow lain (${duplicate.claimWorkflowId}).`,
                        },
                    } as const;
                }
            }

            const now = new Date();
            const submissionId = randomUUID();
            await tx.insert(claimSubmission).values({
                id: submissionId,
                claimWorkflowId: id,
                noClaim,
                noClaimAssignedAt: noClaim ? now : null,
                noClaimAssignedBy: noClaim ? actor.id : null,
                scope,
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

            await writeClaimAudit({
                claimWorkflowId: id,
                claimSubmissionId: submissionId,
                auditScope: claimAuditScopes.submission,
                actor,
                action: "claim_submission_created",
                fromStatus: null,
                toStatus: claimSubmissionStatuses.draft,
                metadata: {
                    submissionId,
                    scope,
                    scopeLabel,
                    noClaim,
                    workflowStatus: workflow.status,
                },
            }, tx);

            return { ok: true, submissionId } as const;
        });

        if (result.error) {
            return NextResponse.json(
                { ok: false, code: result.error.code, error: result.error.message },
                { status: result.error.status },
            );
        }

        const [created] = await db
            .select()
            .from(claimSubmission)
            .where(eq(claimSubmission.id, result.submissionId));

        return NextResponse.json({
            ok: true,
            success: true,
            submission: created,
        }, { status: 201 });
    } catch (error) {
        const message = error instanceof Error ? error.message.toLowerCase() : "";
        if (message.includes("unique") && message.includes("no_claim")) {
            return NextResponse.json({
                ok: false,
                code: "NO_CLAIM_ALREADY_USED_IN_OTHER_WORKFLOW",
                error: "noClaim sudah dipakai di workflow lain.",
            }, { status: 409 });
        }
        console.error("[CLAIM SUBMISSIONS CREATE ERROR]", error);
        return NextResponse.json({
            ok: false,
            error: "Gagal membuat Claim Submission.",
        }, { status: 500 });
    }
}
