import path from "node:path";
import { readFile, unlink } from "node:fs/promises";
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { claimSubmission, claimWorkflow, claimWorkflowItem } from "@/db/schema";
import { db } from "@/lib/db";
import {
    claimAuditScopes,
    claimDocumentTypes,
    claimWorkflowStatuses,
    generateClaimLetterPdf,
    isPathInsideClaimDocumentRoot,
    isPathInsideLegacyDir,
    requireClaimSession,
    writeClaimAudit,
} from "@/lib/claim-workflow";
import { requirePermissionH } from "@/lib/rbac/resolve";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

function generationAllowed(status: string) {
    // Phase R1: PDF wajib di-generate sebelum mark_ready, jadi generation
    // harus diizinkan saat Draft / Need Revision juga. Tetap diizinkan saat
    // Ready to Submit / Submitted to Principal untuk regenerate.
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
        return "Claim Letter PDF tidak dapat dibuat pada status workflow saat ini.";
    }
    if (items.length === 0) return "Claim Letter PDF tidak dapat dibuat: workflow belum memiliki item.";
    if (!(Number(workflow.totalClaim || 0) > 0)) return "Claim Letter PDF tidak dapat dibuat: Total Claim harus lebih dari 0.";
    if (items.some((item) => !(Number(item.nilaiKlaim || 0) > 0))) {
        return "Claim Letter PDF tidak dapat dibuat: setiap item harus memiliki Nilai Klaim lebih dari 0.";
    }
    return null;
}

export async function POST(_request: Request, context: Context) {
    const actor = await requireClaimSession();
    if (!actor) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    const gate = await requirePermissionH("claim_workflow.update");
    if (gate.response) return gate.response;

    try {
        const { id } = await context.params;
        const [workflow] = await db.select().from(claimWorkflow).where(eq(claimWorkflow.id, id));
        if (!workflow) return NextResponse.json({ ok: false, error: "Claim Workflow not found" }, { status: 404 });
        const items = await db.select().from(claimWorkflowItem).where(eq(claimWorkflowItem.claimWorkflowId, id));
        const validationError = validateGeneration(workflow, items);
        if (validationError) return NextResponse.json({ ok: false, error: validationError }, { status: 409 });

        const generatedAt = new Date();
        const result = await generateClaimLetterPdf(workflow, items, generatedAt);

        let previousPdfPath: string | null = null;
        let mirroredSubmissionId: string | null = null;
        try {
            await db.transaction(async (tx) => {
                const [current] = await tx.select().from(claimWorkflow).where(eq(claimWorkflow.id, id));
                if (!current || !generationAllowed(current.status)) {
                    throw new Error("Claim Workflow status berubah sebelum Claim Letter PDF tersimpan.");
                }

                // Phase R7c+R8: Combined Claim Letter for multi-submission.
                // Route ini sekarang mendukung:
                // - Single submission: generate + mirror ke submission (legacy)
                // - Multi submission: generate combined letter workflow-level
                //   (berisi semua item dari semua active submissions)
                const submissions = await tx
                    .select({ id: claimSubmission.id })
                    .from(claimSubmission)
                    .where(eq(claimSubmission.claimWorkflowId, id));
                const targetSubmissionId = submissions.length === 1 ? submissions[0]?.id ?? null : null;

                previousPdfPath = current.claimLetterPdfPath ?? null;
                await tx.update(claimWorkflow).set({
                    claimLetterPdfPath: result.filePath,
                    claimLetterGeneratedAt: generatedAt,
                    claimLetterGeneratedBy: actor.id,
                    updatedAt: generatedAt,
                }).where(eq(claimWorkflow.id, id));

                // Mirror ke single submission supaya source-of-truth
                // submission konsisten dengan cache workflow (legacy compat).
                if (targetSubmissionId) {
                    await tx.update(claimSubmission).set({
                        claimLetterPdfPath: result.filePath,
                        claimLetterGeneratedAt: generatedAt,
                        claimLetterGeneratedBy: actor.id,
                        updatedAt: generatedAt,
                    }).where(eq(claimSubmission.id, targetSubmissionId));
                    mirroredSubmissionId = targetSubmissionId;
                }

                const auditAction = submissions.length > 1
                    ? "claim_letter_combined_generated"
                    : "claim_letter_generated";

                await writeClaimAudit({
                    claimWorkflowId: id,
                    claimSubmissionId: targetSubmissionId,
                    auditScope: targetSubmissionId
                        ? claimAuditScopes.submission
                        : claimAuditScopes.workflow,
                    actor,
                    action: auditAction,
                    fromStatus: current.status,
                    toStatus: current.status,
                    metadata: {
                        workflowId: id,
                        submissionId: targetSubmissionId,
                        submissionCount: submissions.length,
                        documentType: claimDocumentTypes.letter,
                        filePath: result.filePath,
                        itemCount: items.length,
                        totalClaim: Number(current.totalClaim || 0),
                        combined: submissions.length > 1,
                        ...(previousPdfPath ? { previousClaimLetterPdfPath: previousPdfPath } : {}),
                    },
                }, tx);
            });
        } catch (transactionError) {
            // Transaction rolled back: hapus PDF yang sudah terlanjur ditulis ke disk
            // supaya tidak meninggalkan orphan file di runtime/claim-workflow/letters.
            await unlink(result.filePath).catch(() => {});
            throw transactionError;
        }

        // Setelah transaksi sukses, hapus PDF lama (kalau ada) untuk
        // mencegah akumulasi file yang sudah tidak direferensikan database.
        if (
            previousPdfPath &&
            previousPdfPath !== result.filePath &&
            (isPathInsideLegacyDir(previousPdfPath, claimDocumentTypes.letter) ||
             isPathInsideClaimDocumentRoot(previousPdfPath))
        ) {
            await unlink(previousPdfPath).catch(() => {});
        }

        return NextResponse.json({
            ok: true,
            success: true,
            pdfPath: result.filePath,
            downloadUrl: `/api/claim-workflow/${id}/claim-letter`,
            claimLetterGeneratedAt: generatedAt,
            mirroredSubmissionId,
        });
    } catch (error) {
        console.error("[CLAIM WORKFLOW CLAIM LETTER PDF ERROR]", error);
        return NextResponse.json({ ok: false, error: "Gagal membuat Claim Letter PDF." }, { status: 500 });
    }
}

export async function GET(_request: Request, context: Context) {
    const actor = await requireClaimSession();
    if (!actor) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    const gate = await requirePermissionH("claim_workflow.view");
    if (gate.response) return gate.response;

    const { id } = await context.params;
    const [workflow] = await db.select().from(claimWorkflow).where(eq(claimWorkflow.id, id));
    if (!workflow) return NextResponse.json({ ok: false, error: "Claim Workflow not found" }, { status: 404 });
    if (!workflow.claimLetterPdfPath) {
        return NextResponse.json({ ok: false, error: "Claim Letter PDF belum pernah dibuat." }, { status: 404 });
    }
    // Phase R7c: terima file dari folder legacy ATAU dari submission
    // tree (mirror flow). Kedua-duanya berada di bawah
    // `runtime/claim-workflow/`.
    if (!isPathInsideClaimDocumentRoot(workflow.claimLetterPdfPath)) {
        console.error("[CLAIM WORKFLOW CLAIM LETTER PDF] Refusing to serve PDF outside claim-workflow root", {
            workflowId: id,
            path: workflow.claimLetterPdfPath,
        });
        return NextResponse.json({ ok: false, error: "Path Claim Letter PDF tidak valid." }, { status: 400 });
    }

    try {
        const file = await readFile(workflow.claimLetterPdfPath);
        const fileName = `${workflow.claimWorkflowNo.replace(/[^a-zA-Z0-9]+/g, "-")}-claim-letter.pdf`;
        return new NextResponse(new Uint8Array(file), {
            headers: {
                "Content-Type": "application/pdf",
                "Content-Disposition": `inline; filename="${fileName}"`,
            },
        });
    } catch {
        return NextResponse.json({ ok: false, error: "File Claim Letter PDF tidak ditemukan." }, { status: 404 });
    }
}
