/*
 * Tujuan: Generate dan serve Claim Summary PDF (POST/GET) — workflow-level
 *         legacy route. Phase R7c menambahkan multi-submission guard
 *         supaya cache workflow tidak menabrak nilai dari submission.
 *         Submission-level generator ada di
 *         `app/api/claim-workflow/[id]/submissions/[submissionId]/summary/route.ts`.
 * Caller: UI Claim Workflow detail (admin/claim untuk POST, viewer untuk GET).
 * Side Effects:
 *   POST: tulis PDF, update metadata claim_workflow.summary_pdf_path,
 *         optional mirror ke single submission, audit
 *         `claim_summary_generated`.
 *   GET : stream PDF dari path yang sudah di-validate (legacy dir atau
 *         submission tree, keduanya di bawah `runtime/claim-workflow/`).
 */
import path from "node:path";
import { readFile, unlink } from "node:fs/promises";
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { claimSubmission, claimWorkflow, claimWorkflowItem } from "@/db/schema";
import { db } from "@/lib/db";
import {
    canActorReadClaimWorkflow,
    claimAuditScopes,
    claimDocumentTypes,
    claimWorkflowStatuses,
    generateClaimSummaryPdf,
    isPathInsideClaimDocumentRoot,
    isPathInsideLegacyDir,
    requireClaimSession,
    writeClaimAudit,
} from "@/lib/claim-workflow";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

// Phase R2: Summary boleh di-generate di status yang sama dengan Claim
// Letter (Draft, Need Revision, Ready to Submit, Submitted to Principal).
// Tidak menunggu claim_payment.
function generationAllowed(status: string) {
    return status === claimWorkflowStatuses.draft ||
        status === claimWorkflowStatuses.needRevision ||
        status === claimWorkflowStatuses.readyToSubmit ||
        status === claimWorkflowStatuses.submittedToPrincipal;
}

function validateGeneration(
    workflow: typeof claimWorkflow.$inferSelect,
    items: Array<typeof claimWorkflowItem.$inferSelect>,
) {
    if (!generationAllowed(workflow.status)) {
        return "Claim Summary PDF tidak dapat dibuat pada status workflow saat ini.";
    }
    if (items.length === 0) return "Claim Summary PDF tidak dapat dibuat: workflow belum memiliki item.";
    if (!(Number(workflow.totalClaim || 0) > 0)) return "Claim Summary PDF tidak dapat dibuat: Total Claim harus lebih dari 0.";
    if (items.some((item) => !(Number(item.nilaiKlaim || 0) > 0))) {
        return "Claim Summary PDF tidak dapat dibuat: setiap item harus memiliki Nilai Klaim lebih dari 0.";
    }
    return null;
}

export async function POST(_request: Request, context: Context) {
    const actor = await requireClaimSession();
    if (!actor) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    if (actor.role !== "admin" && actor.role !== "claim") {
        return NextResponse.json({ ok: false, error: "Hanya role admin atau claim yang dapat membuat Claim Summary PDF." }, { status: 403 });
    }

    try {
        const { id } = await context.params;
        const [workflow] = await db.select().from(claimWorkflow).where(eq(claimWorkflow.id, id));
        if (!workflow) return NextResponse.json({ ok: false, error: "Claim Workflow not found" }, { status: 404 });
        const items = await db.select().from(claimWorkflowItem).where(eq(claimWorkflowItem.claimWorkflowId, id));
        const validationError = validateGeneration(workflow, items);
        if (validationError) return NextResponse.json({ ok: false, error: validationError }, { status: 409 });

        const generatedAt = new Date();
        const result = await generateClaimSummaryPdf(workflow, items, generatedAt);

        let previousPdfPath: string | null = null;
        let mirroredSubmissionId: string | null = null;
        try {
            await db.transaction(async (tx) => {
                const [current] = await tx.select().from(claimWorkflow).where(eq(claimWorkflow.id, id));
                if (!current || !generationAllowed(current.status)) {
                    throw new Error("Claim Workflow status berubah sebelum Claim Summary PDF tersimpan.");
                }
                // Phase R7c — Multi No Claim guard:
                const submissions = await tx
                    .select({ id: claimSubmission.id })
                    .from(claimSubmission)
                    .where(eq(claimSubmission.claimWorkflowId, id));
                if (submissions.length > 1) {
                    throw Object.assign(
                        new Error("Workflow memiliki beberapa submission. Generate Summary lewat submission."),
                        { code: "MULTI_SUBMISSION_SUMMARY_ROUTE_DISABLED" },
                    );
                }
                const targetSubmissionId = submissions[0]?.id ?? null;

                previousPdfPath = current.summaryPdfPath ?? null;
                await tx.update(claimWorkflow).set({
                    summaryPdfPath: result.filePath,
                    summaryGeneratedAt: generatedAt,
                    summaryGeneratedBy: actor.id,
                    updatedAt: generatedAt,
                }).where(eq(claimWorkflow.id, id));

                if (targetSubmissionId) {
                    await tx.update(claimSubmission).set({
                        summaryPdfPath: result.filePath,
                        summaryGeneratedAt: generatedAt,
                        summaryGeneratedBy: actor.id,
                        updatedAt: generatedAt,
                    }).where(eq(claimSubmission.id, targetSubmissionId));
                    mirroredSubmissionId = targetSubmissionId;
                }

                await writeClaimAudit({
                    claimWorkflowId: id,
                    claimSubmissionId: targetSubmissionId,
                    auditScope: targetSubmissionId
                        ? claimAuditScopes.submission
                        : claimAuditScopes.workflow,
                    actor,
                    action: "claim_summary_generated",
                    fromStatus: current.status,
                    toStatus: current.status,
                    metadata: {
                        workflowId: id,
                        submissionId: targetSubmissionId,
                        documentType: claimDocumentTypes.summary,
                        filePath: result.filePath,
                        itemCount: items.length,
                        totalClaim: Number(current.totalClaim || 0),
                        noClaim: current.noClaim ?? null,
                        generatedBy: actor.id,
                        viaLegacyWorkflowRoute: true,
                        ...(previousPdfPath ? { previousPdfPath } : {}),
                    },
                }, tx);
            });
        } catch (transactionError) {
            // Transaction rolled back: hapus PDF yang sudah terlanjur ditulis ke disk.
            await unlink(result.filePath).catch(() => {});
            const code = transactionError && typeof transactionError === "object"
                && "code" in (transactionError as Record<string, unknown>)
                ? String((transactionError as Record<string, unknown>).code)
                : null;
            if (code === "MULTI_SUBMISSION_SUMMARY_ROUTE_DISABLED") {
                return NextResponse.json({
                    ok: false,
                    code,
                    error: transactionError instanceof Error
                        ? transactionError.message
                        : "Workflow memiliki beberapa submission. Generate Summary lewat submission.",
                }, { status: 409 });
            }
            throw transactionError;
        }

        // Setelah transaksi sukses, hapus PDF lama (kalau ada) untuk
        // mencegah akumulasi file yang sudah tidak direferensikan database.
        if (
            previousPdfPath &&
            previousPdfPath !== result.filePath &&
            (isPathInsideLegacyDir(previousPdfPath, claimDocumentTypes.summary) ||
             isPathInsideClaimDocumentRoot(previousPdfPath))
        ) {
            await unlink(previousPdfPath).catch(() => {});
        }

        return NextResponse.json({
            ok: true,
            success: true,
            pdfPath: result.filePath,
            downloadUrl: `/api/claim-workflow/${id}/summary`,
            summaryGeneratedAt: generatedAt,
            mirroredSubmissionId,
        });
    } catch (error) {
        console.error("[CLAIM WORKFLOW SUMMARY PDF ERROR]", error);
        return NextResponse.json({ ok: false, error: "Gagal membuat Claim Summary PDF." }, { status: 500 });
    }
}

export async function GET(_request: Request, context: Context) {
    const actor = await requireClaimSession();
    if (!actor) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    if (!canActorReadClaimWorkflow(actor)) {
        return NextResponse.json({ ok: false, error: "Role Anda tidak memiliki akses detail Claim Workflow." }, { status: 403 });
    }

    const { id } = await context.params;
    const [workflow] = await db.select().from(claimWorkflow).where(eq(claimWorkflow.id, id));
    if (!workflow) return NextResponse.json({ ok: false, error: "Claim Workflow not found" }, { status: 404 });
    if (!workflow.summaryPdfPath) {
        return NextResponse.json({ ok: false, error: "Claim Summary PDF belum pernah dibuat." }, { status: 404 });
    }
    // Phase R7c: terima legacy dir maupun submission tree.
    if (!isPathInsideClaimDocumentRoot(workflow.summaryPdfPath)) {
        console.error("[CLAIM WORKFLOW SUMMARY PDF] Refusing to serve PDF outside claim-workflow root", {
            workflowId: id,
            path: workflow.summaryPdfPath,
        });
        return NextResponse.json({ ok: false, error: "Path Claim Summary PDF tidak valid." }, { status: 400 });
    }

    try {
        const file = await readFile(workflow.summaryPdfPath);
        const baseName = path.basename(workflow.summaryPdfPath);
        const fileName = baseName || `${workflow.claimWorkflowNo.replace(/[^a-zA-Z0-9]+/g, "-")}-summary.pdf`;
        return new NextResponse(new Uint8Array(file), {
            headers: {
                "Content-Type": "application/pdf",
                "Content-Disposition": `inline; filename="${fileName}"`,
            },
        });
    } catch {
        return NextResponse.json({ ok: false, error: "File Claim Summary PDF tidak ditemukan." }, { status: 404 });
    }
}
