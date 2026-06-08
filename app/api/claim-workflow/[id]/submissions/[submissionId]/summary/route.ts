/*
 * Tujuan: Generate dan serve Claim Summary PDF per submission. Phase R7c.
 *         Pola sama persis dengan claim-letter route per submission.
 *         Lihat docstring di
 *         `app/api/claim-workflow/[id]/submissions/[submissionId]/claim-letter/route.ts`
 *         untuk detail behavior.
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
    generateClaimSummaryPdf,
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
            code: "CLAIM_SUMMARY_FORBIDDEN",
            error: "Hanya role admin atau claim yang dapat membuat Claim Summary PDF.",
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
                code: "CLAIM_SUMMARY_INVALID_STATE",
                error: "Claim Summary PDF tidak dapat dibuat pada status workflow saat ini.",
            }, { status: 409 });
        }
        if (submission.status === claimWorkflowStatuses.closed) {
            return NextResponse.json({
                ok: false,
                code: "CLAIM_SUMMARY_SUBMISSION_CLOSED",
                error: "Submission sudah Closed; Summary tidak dapat di-generate.",
            }, { status: 409 });
        }
        const items = await db
            .select()
            .from(claimWorkflowItem)
            .where(eq(claimWorkflowItem.claimSubmissionId, submissionId));
        if (items.length === 0) {
            return NextResponse.json({
                ok: false,
                code: "CLAIM_SUMMARY_EMPTY_ITEMS",
                error: "Submission belum memiliki item; Summary tidak dapat dibuat.",
            }, { status: 422 });
        }
        const totalClaim = Number(submission.totalClaim || 0);
        if (!(totalClaim > 0)) {
            return NextResponse.json({
                ok: false,
                code: "CLAIM_SUMMARY_TOTAL_ZERO",
                error: "Total Claim submission harus lebih dari 0 sebelum generate Summary.",
            }, { status: 422 });
        }
        const invalidItem = items.find((item) => !(Number(item.nilaiKlaim || 0) > 0));
        if (invalidItem) {
            return NextResponse.json({
                ok: false,
                code: "CLAIM_SUMMARY_ITEM_INVALID",
                error: "Setiap item submission harus memiliki Nilai Klaim lebih dari 0.",
                itemId: invalidItem.id,
            }, { status: 422 });
        }

        const generatedAt = new Date();
        const result = await generateClaimSummaryPdf(workflow, items, generatedAt, { submission });

        let previousPdfPath: string | null = null;
        let workflowMirror = false;
        try {
            await db.transaction(async (tx) => {
                const [submissionFresh] = await tx
                    .select()
                    .from(claimSubmission)
                    .where(eq(claimSubmission.id, submissionId));
                if (!submissionFresh || submissionFresh.claimWorkflowId !== id) {
                    throw new Error("Claim Submission berubah sebelum Summary PDF tersimpan.");
                }
                if (submissionFresh.status === claimWorkflowStatuses.closed) {
                    throw new Error("Submission sudah Closed sebelum Summary PDF tersimpan.");
                }
                const [workflowFresh] = await tx
                    .select({ status: claimWorkflow.status })
                    .from(claimWorkflow)
                    .where(eq(claimWorkflow.id, id));
                if (!workflowFresh || !generationAllowed(workflowFresh.status)) {
                    throw new Error("Claim Workflow status berubah sebelum Summary PDF tersimpan.");
                }
                previousPdfPath = submissionFresh.summaryPdfPath ?? null;
                await tx
                    .update(claimSubmission)
                    .set({
                        summaryPdfPath: result.filePath,
                        summaryGeneratedAt: generatedAt,
                        summaryGeneratedBy: actor.id,
                        updatedAt: generatedAt,
                    })
                    .where(eq(claimSubmission.id, submissionId));

                const allSubmissions = await tx
                    .select({ id: claimSubmission.id })
                    .from(claimSubmission)
                    .where(eq(claimSubmission.claimWorkflowId, id));
                if (allSubmissions.length === 1 && allSubmissions[0].id === submissionId) {
                    await tx
                        .update(claimWorkflow)
                        .set({
                            summaryPdfPath: result.filePath,
                            summaryGeneratedAt: generatedAt,
                            summaryGeneratedBy: actor.id,
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
                    action: "claim_summary_generated",
                    fromStatus: submissionFresh.status,
                    toStatus: submissionFresh.status,
                    metadata: {
                        workflowId: id,
                        submissionId,
                        noClaim: submissionFresh.noClaim,
                        itemCount: items.length,
                        totalClaim,
                        documentType: claimDocumentTypes.summary,
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
            downloadUrl: `/api/claim-workflow/${id}/submissions/${submissionId}/summary`,
            summaryGeneratedAt: generatedAt,
            workflowMirror,
        });
    } catch (error) {
        console.error("[CLAIM SUBMISSION SUMMARY POST ERROR]", error);
        return NextResponse.json({
            ok: false,
            error: error instanceof Error ? error.message : "Gagal membuat Claim Summary PDF.",
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
    if (!submission.summaryPdfPath) {
        return NextResponse.json({
            ok: false,
            error: "Claim Summary PDF belum pernah dibuat untuk submission ini.",
        }, { status: 404 });
    }
    if (!isPathInsideClaimDocumentRoot(submission.summaryPdfPath)) {
        console.error("[CLAIM SUBMISSION SUMMARY GET] path outside root", {
            submissionId,
            path: submission.summaryPdfPath,
        });
        return NextResponse.json({
            ok: false,
            error: "Path Claim Summary PDF tidak valid.",
        }, { status: 400 });
    }

    try {
        const file = await readFile(submission.summaryPdfPath);
        const baseName = path.basename(submission.summaryPdfPath);
        const fileName = baseName || `${safeFileName(submission.id)}-summary.pdf`;
        return new NextResponse(new Uint8Array(file), {
            headers: {
                "Content-Type": "application/pdf",
                "Content-Disposition": `inline; filename="${fileName}"`,
            },
        });
    } catch {
        return NextResponse.json({
            ok: false,
            error: "File Claim Summary PDF tidak ditemukan.",
        }, { status: 404 });
    }
}
