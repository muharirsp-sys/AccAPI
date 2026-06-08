/*
 * Tujuan: Generate dan serve Claim Letter PDF per submission. Phase R7c.
 *         Pola sama dengan route workflow-level, tetapi:
 *           - Items difilter ke `claim_submission_id = submissionId`.
 *           - Header PDF override pakai totals + noClaim submission.
 *           - File ditulis di `runtime/claim-workflow/{workflowId}/
 *             submissions/{submissionId}/letter/...`.
 *           - Update `claim_submission.claimLetterPdfPath/At/By` (BUKAN
 *             kolom workflow). Audit pakai `audit_scope = "submission"`.
 *           - Compat mirror: bila workflow hanya punya 1 submission,
 *             cache `claim_workflow.claimLetterPdfPath` ikut di-update
 *             agar route legacy + Mark Ready / Close (workflow cache)
 *             tetap valid sampai R7d/R7e.
 * Caller: UI claim-workflow detail page (admin/claim untuk POST,
 *         claim_workflow.view untuk GET).
 */
import path from "node:path";
import { readFile, unlink } from "node:fs/promises";
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import {
    claimSubmission,
    claimWorkflow,
    claimWorkflowItem,
} from "@/db/schema";
import { db } from "@/lib/db";
import {
    canActorReadClaimWorkflow,
    claimAuditScopes,
    claimDocumentTypes,
    claimWorkflowStatuses,
    generateClaimLetterPdf,
    isPathInsideClaimDocumentRoot,
    requireClaimSession,
    writeClaimAudit,
} from "@/lib/claim-workflow";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string; submissionId: string }> };

function generationAllowed(status: string): boolean {
    return status === claimWorkflowStatuses.draft ||
        status === claimWorkflowStatuses.needRevision ||
        status === claimWorkflowStatuses.readyToSubmit ||
        status === claimWorkflowStatuses.submittedToPrincipal;
}

function safeFileName(value: string): string {
    return String(value || "")
        .normalize("NFKD")
        .replace(/[^\x20-\x7E]/g, "")
        .replace(/[^a-zA-Z0-9._-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        || "claim-workflow";
}

export async function POST(_request: Request, context: Context) {
    const actor = await requireClaimSession();
    if (!actor) {
        return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }
    if (actor.role !== "admin" && actor.role !== "claim") {
        return NextResponse.json({
            ok: false,
            code: "CLAIM_LETTER_FORBIDDEN",
            error: "Hanya role admin atau claim yang dapat membuat Claim Letter PDF.",
        }, { status: 403 });
    }

    try {
        const { id, submissionId } = await context.params;

        const [workflow] = await db
            .select()
            .from(claimWorkflow)
            .where(eq(claimWorkflow.id, id));
        if (!workflow) {
            return NextResponse.json({ ok: false, error: "Claim Workflow not found" }, { status: 404 });
        }
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
        if (!generationAllowed(workflow.status)) {
            return NextResponse.json({
                ok: false,
                code: "CLAIM_LETTER_INVALID_STATE",
                error: "Claim Letter PDF tidak dapat dibuat pada status workflow saat ini.",
            }, { status: 409 });
        }
        if (submission.status === claimWorkflowStatuses.closed) {
            return NextResponse.json({
                ok: false,
                code: "CLAIM_LETTER_SUBMISSION_CLOSED",
                error: "Submission sudah Closed; Claim Letter tidak dapat di-generate.",
            }, { status: 409 });
        }
        const items = await db
            .select()
            .from(claimWorkflowItem)
            .where(eq(claimWorkflowItem.claimSubmissionId, submissionId));
        if (items.length === 0) {
            return NextResponse.json({
                ok: false,
                code: "CLAIM_LETTER_EMPTY_ITEMS",
                error: "Submission belum memiliki item; Claim Letter tidak dapat dibuat.",
            }, { status: 422 });
        }
        const totalClaim = Number(submission.totalClaim || 0);
        if (!(totalClaim > 0)) {
            return NextResponse.json({
                ok: false,
                code: "CLAIM_LETTER_TOTAL_ZERO",
                error: "Total Claim submission harus lebih dari 0 sebelum generate Claim Letter.",
            }, { status: 422 });
        }
        const invalidItem = items.find((item) => !(Number(item.nilaiKlaim || 0) > 0));
        if (invalidItem) {
            return NextResponse.json({
                ok: false,
                code: "CLAIM_LETTER_ITEM_INVALID",
                error: "Setiap item submission harus memiliki Nilai Klaim lebih dari 0.",
                itemId: invalidItem.id,
            }, { status: 422 });
        }

        const generatedAt = new Date();
        const result = await generateClaimLetterPdf(workflow, items, generatedAt, { submission });

        let previousPdfPath: string | null = null;
        let workflowMirror = false;
        try {
            await db.transaction(async (tx) => {
                const [submissionFresh] = await tx
                    .select()
                    .from(claimSubmission)
                    .where(eq(claimSubmission.id, submissionId));
                if (!submissionFresh || submissionFresh.claimWorkflowId !== id) {
                    throw new Error("Claim Submission berubah sebelum Claim Letter PDF tersimpan.");
                }
                if (submissionFresh.status === claimWorkflowStatuses.closed) {
                    throw new Error("Submission sudah Closed sebelum Claim Letter PDF tersimpan.");
                }
                const [workflowFresh] = await tx
                    .select({ status: claimWorkflow.status })
                    .from(claimWorkflow)
                    .where(eq(claimWorkflow.id, id));
                if (!workflowFresh || !generationAllowed(workflowFresh.status)) {
                    throw new Error("Claim Workflow status berubah sebelum Claim Letter PDF tersimpan.");
                }
                previousPdfPath = submissionFresh.claimLetterPdfPath ?? null;
                await tx
                    .update(claimSubmission)
                    .set({
                        claimLetterPdfPath: result.filePath,
                        claimLetterGeneratedAt: generatedAt,
                        claimLetterGeneratedBy: actor.id,
                        updatedAt: generatedAt,
                    })
                    .where(eq(claimSubmission.id, submissionId));

                // Compat mirror ke workflow cache hanya bila workflow
                // hanya punya 1 submission. Multi-submission TIDAK akan
                // menulis cache workflow supaya gate workflow-level
                // (legacy) tetap konsisten dengan single-submission path.
                const allSubmissions = await tx
                    .select({ id: claimSubmission.id })
                    .from(claimSubmission)
                    .where(eq(claimSubmission.claimWorkflowId, id));
                if (allSubmissions.length === 1 && allSubmissions[0].id === submissionId) {
                    await tx
                        .update(claimWorkflow)
                        .set({
                            claimLetterPdfPath: result.filePath,
                            claimLetterGeneratedAt: generatedAt,
                            claimLetterGeneratedBy: actor.id,
                            updatedAt: generatedAt,
                        })
                        .where(eq(claimWorkflow.id, id));
                    workflowMirror = true;
                }

                await writeClaimAudit({
                    claimWorkflowId: id,
                    claimSubmissionId: submissionId,
                    auditScope: claimAuditScopes.submission,
                    actor,
                    action: "claim_letter_generated",
                    fromStatus: submissionFresh.status,
                    toStatus: submissionFresh.status,
                    metadata: {
                        workflowId: id,
                        submissionId,
                        noClaim: submissionFresh.noClaim,
                        itemCount: items.length,
                        totalClaim,
                        documentType: claimDocumentTypes.letter,
                        filePath: result.filePath,
                        workflowMirror,
                        ...(previousPdfPath ? { previousPdfPath } : {}),
                    },
                }, tx);
            });
        } catch (transactionError) {
            await unlink(result.filePath).catch(() => {});
            throw transactionError;
        }

        if (
            previousPdfPath &&
            previousPdfPath !== result.filePath &&
            isPathInsideClaimDocumentRoot(previousPdfPath)
        ) {
            await unlink(previousPdfPath).catch(() => {});
        }

        return NextResponse.json({
            ok: true,
            success: true,
            pdfPath: result.filePath,
            downloadUrl: `/api/claim-workflow/${id}/submissions/${submissionId}/claim-letter`,
            claimLetterGeneratedAt: generatedAt,
            workflowMirror,
        });
    } catch (error) {
        console.error("[CLAIM SUBMISSION LETTER POST ERROR]", error);
        return NextResponse.json({
            ok: false,
            error: error instanceof Error ? error.message : "Gagal membuat Claim Letter PDF.",
        }, { status: 500 });
    }
}

export async function GET(_request: Request, context: Context) {
    const actor = await requireClaimSession();
    if (!actor) {
        return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }
    if (!canActorReadClaimWorkflow(actor)) {
        return NextResponse.json({
            ok: false,
            error: "Role Anda tidak memiliki akses detail Claim Workflow.",
        }, { status: 403 });
    }

    const { id, submissionId } = await context.params;
    const [submission] = await db
        .select()
        .from(claimSubmission)
        .where(eq(claimSubmission.id, submissionId));
    if (!submission || submission.claimWorkflowId !== id) {
        return NextResponse.json({ ok: false, error: "Claim Submission not found" }, { status: 404 });
    }
    if (!submission.claimLetterPdfPath) {
        return NextResponse.json({
            ok: false,
            error: "Claim Letter PDF belum pernah dibuat untuk submission ini.",
        }, { status: 404 });
    }
    if (!isPathInsideClaimDocumentRoot(submission.claimLetterPdfPath)) {
        console.error("[CLAIM SUBMISSION LETTER GET] path outside root", {
            submissionId,
            path: submission.claimLetterPdfPath,
        });
        return NextResponse.json({
            ok: false,
            error: "Path Claim Letter PDF tidak valid.",
        }, { status: 400 });
    }

    try {
        const file = await readFile(submission.claimLetterPdfPath);
        const baseName = path.basename(submission.claimLetterPdfPath);
        const fileName = baseName || `${safeFileName(submission.id)}-letter.pdf`;
        return new NextResponse(new Uint8Array(file), {
            headers: {
                "Content-Type": "application/pdf",
                "Content-Disposition": `inline; filename="${fileName}"`,
            },
        });
    } catch {
        return NextResponse.json({
            ok: false,
            error: "File Claim Letter PDF tidak ditemukan.",
        }, { status: 404 });
    }
}
