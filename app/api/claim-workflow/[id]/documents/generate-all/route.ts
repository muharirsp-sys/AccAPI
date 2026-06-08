/*
 * Tujuan: Orchestrator generate SEMUA dokumen klaim dalam 1 PDF gabungan
 *         per jenis (Phase R7 doc rule final). Hasil:
 *           - 1 PDF Surat Claim gabungan (banyak surat di dalam 1 file)
 *             → workflow.claimLetterPdfPath + mirror ke submission.
 *           - 1 PDF Summary gabungan (banyak summary di dalam 1 file)
 *             → workflow.summaryPdfPath + mirror ke submission.
 *           - 1 PDF Kwitansi gabungan (A4 Landscape, 2x2 per halaman)
 *             → workflow.receiptPdfPath + mirror ke submission.
 * Caller: UI claim-workflow detail page — tombol "Generate Semua Dokumen".
 * Guard: admin/claim only. Status workflow harus Draft / Need Revision.
 *        Semua submission aktif wajib punya No Claim tersimpan + item +
 *        total claim valid.
 */
import { unlink } from "node:fs/promises";
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import {
    claimSubmission,
    claimWorkflow,
    claimWorkflowItem,
} from "@/db/schema";
import { db } from "@/lib/db";
import {
    claimAuditScopes,
    claimWorkflowStatuses,
    generateCombinedClaimLetterPdf,
    generateCombinedClaimSummaryPdf,
    generateCombinedClaimReceiptPdf,
    getActiveSubmissions,
    isPathInsideClaimDocumentRoot,
    requireClaimSession,
    writeClaimAudit,
} from "@/lib/claim-workflow";
import type { ClaimWorkflowItemRow } from "@/lib/claim-workflow";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

export async function POST(_request: Request, context: Context) {
    const actor = await requireClaimSession();
    if (!actor) {
        return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }
    if (actor.role !== "admin" && actor.role !== "claim") {
        return NextResponse.json({
            ok: false,
            code: "CLAIM_DOCS_FORBIDDEN",
            error: "Hanya role admin atau claim yang dapat generate dokumen klaim.",
        }, { status: 403 });
    }

    try {
        const { id } = await context.params;
        const [workflow] = await db
            .select()
            .from(claimWorkflow)
            .where(eq(claimWorkflow.id, id));
        if (!workflow) {
            return NextResponse.json({ ok: false, error: "Claim Workflow not found" }, { status: 404 });
        }

        if (
            workflow.status !== claimWorkflowStatuses.draft &&
            workflow.status !== claimWorkflowStatuses.needRevision
        ) {
            return NextResponse.json({
                ok: false,
                code: "CLAIM_DOCS_INVALID_STATE",
                error: "Generate dokumen hanya tersedia saat status Draft atau Need Revision.",
            }, { status: 409 });
        }

        const activeSubmissions = await getActiveSubmissions(id, db);
        if (activeSubmissions.length === 0) {
            return NextResponse.json({
                ok: false,
                code: "CLAIM_DOCS_NO_ACTIVE_SUBMISSION",
                error: "Tidak ada Berkas Claim aktif. Siapkan Baris Claim terlebih dahulu.",
            }, { status: 422 });
        }

        // Validasi setiap submission aktif.
        const itemsBySubmission = new Map<string, ClaimWorkflowItemRow[]>();
        for (const submission of activeSubmissions) {
            const subLabel = submission.scopeLabel || submission.scope || "submission";
            const subNoClaim = String(submission.noClaim || "").trim();
            if (!subNoClaim) {
                return NextResponse.json({
                    ok: false,
                    code: "CLAIM_DOCS_NO_CLAIM_REQUIRED",
                    error: "No Claim belum lengkap.",
                    submissionId: submission.id,
                }, { status: 422 });
            }
            const items = await db
                .select()
                .from(claimWorkflowItem)
                .where(eq(claimWorkflowItem.claimSubmissionId, submission.id));
            if (items.length === 0) {
                return NextResponse.json({
                    ok: false,
                    code: "CLAIM_DOCS_EMPTY_ITEMS",
                    error: `Berkas Claim "${subLabel}" belum memiliki item.`,
                    submissionId: submission.id,
                }, { status: 422 });
            }
            if (!(Number(submission.totalClaim || 0) > 0)) {
                return NextResponse.json({
                    ok: false,
                    code: "CLAIM_DOCS_TOTAL_ZERO",
                    error: `Berkas Claim "${subLabel}" memiliki Total Claim 0. Lengkapi DPP/Nilai Klaim.`,
                    submissionId: submission.id,
                }, { status: 422 });
            }
            const invalidItem = items.find(
                (item) => !(Number(item.dpp || 0) > 0) || !(Number(item.nilaiKlaim || 0) > 0),
            );
            if (invalidItem) {
                return NextResponse.json({
                    ok: false,
                    code: "CLAIM_DOCS_ITEM_INVALID",
                    error: `Berkas Claim "${subLabel}" punya item dengan DPP/Nilai Klaim 0.`,
                    submissionId: submission.id,
                    itemId: invalidItem.id,
                }, { status: 422 });
            }
            itemsBySubmission.set(submission.id, items);
        }

        const generatedAt = new Date();
        const writtenFiles: string[] = [];
        const previousFiles: string[] = [];

        // Build entries for combined generators.
        const entries = activeSubmissions.map((submission) => ({
            submission,
            items: itemsBySubmission.get(submission.id) ?? [],
        }));

        let letterPath = "";
        let summaryPath = "";
        let receiptPath = "";

        try {
            // 1. Surat Claim gabungan (banyak surat dalam 1 PDF).
            const letter = await generateCombinedClaimLetterPdf(workflow, entries, generatedAt);
            writtenFiles.push(letter.filePath);
            letterPath = letter.filePath;

            // 2. Summary gabungan (banyak summary dalam 1 PDF).
            const summary = await generateCombinedClaimSummaryPdf(workflow, entries, generatedAt);
            writtenFiles.push(summary.filePath);
            summaryPath = summary.filePath;

            // 3. Kwitansi gabungan (A4 Landscape, 2x2 per halaman).
            const receipt = await generateCombinedClaimReceiptPdf(workflow, entries, generatedAt);
            writtenFiles.push(receipt.filePath);
            receiptPath = receipt.filePath;

            // Collect previous files for cleanup.
            if (workflow.claimLetterPdfPath && workflow.claimLetterPdfPath !== letterPath) {
                previousFiles.push(workflow.claimLetterPdfPath);
            }
            if (workflow.summaryPdfPath && workflow.summaryPdfPath !== summaryPath) {
                previousFiles.push(workflow.summaryPdfPath);
            }
            if (workflow.receiptPdfPath && workflow.receiptPdfPath !== receiptPath) {
                previousFiles.push(workflow.receiptPdfPath);
            }

            // 4. Persist semua path dalam satu transaksi.
            await db.transaction(async (tx) => {
                const [workflowFresh] = await tx
                    .select({ status: claimWorkflow.status })
                    .from(claimWorkflow)
                    .where(eq(claimWorkflow.id, id));
                if (
                    !workflowFresh ||
                    (workflowFresh.status !== claimWorkflowStatuses.draft &&
                        workflowFresh.status !== claimWorkflowStatuses.needRevision)
                ) {
                    throw new Error("Status workflow berubah sebelum dokumen tersimpan.");
                }

                // Update workflow-level (source-of-truth).
                await tx
                    .update(claimWorkflow)
                    .set({
                        claimLetterPdfPath: letterPath,
                        claimLetterGeneratedAt: generatedAt,
                        claimLetterGeneratedBy: actor.id,
                        summaryPdfPath: summaryPath,
                        summaryGeneratedAt: generatedAt,
                        summaryGeneratedBy: actor.id,
                        receiptPdfPath: receiptPath,
                        receiptGeneratedAt: generatedAt,
                        receiptGeneratedBy: actor.id,
                        updatedAt: generatedAt,
                    })
                    .where(eq(claimWorkflow.id, id));

                // Mirror ke setiap submission untuk compatibility.
                for (const submission of activeSubmissions) {
                    if (submission.claimLetterPdfPath && submission.claimLetterPdfPath !== letterPath) {
                        previousFiles.push(submission.claimLetterPdfPath);
                    }
                    if (submission.summaryPdfPath && submission.summaryPdfPath !== summaryPath) {
                        previousFiles.push(submission.summaryPdfPath);
                    }
                    if (submission.receiptPdfPath && submission.receiptPdfPath !== receiptPath) {
                        previousFiles.push(submission.receiptPdfPath);
                    }
                    await tx
                        .update(claimSubmission)
                        .set({
                            claimLetterPdfPath: letterPath,
                            claimLetterGeneratedAt: generatedAt,
                            claimLetterGeneratedBy: actor.id,
                            summaryPdfPath: summaryPath,
                            summaryGeneratedAt: generatedAt,
                            summaryGeneratedBy: actor.id,
                            receiptPdfPath: receiptPath,
                            receiptGeneratedAt: generatedAt,
                            receiptGeneratedBy: actor.id,
                            updatedAt: generatedAt,
                        })
                        .where(eq(claimSubmission.id, submission.id));
                }

                await writeClaimAudit({
                    claimWorkflowId: id,
                    auditScope: claimAuditScopes.workflow,
                    actor,
                    action: "claim_documents_generated_all",
                    fromStatus: workflow.status,
                    toStatus: workflow.status,
                    metadata: {
                        activeSubmissionCount: activeSubmissions.length,
                        claimLetterPdfPath: letterPath,
                        summaryPdfPath: summaryPath,
                        receiptPdfPath: receiptPath,
                        combined: true,
                    },
                }, tx);
            });
        } catch (transactionError) {
            for (const file of writtenFiles) {
                await unlink(file).catch(() => {});
            }
            throw transactionError;
        }

        // Cleanup previous files (best-effort).
        for (const prev of previousFiles) {
            if (isPathInsideClaimDocumentRoot(prev)) {
                await unlink(prev).catch(() => {});
            }
        }

        return NextResponse.json({
            ok: true,
            success: true,
            claimLetterPdfPath: letterPath,
            summaryPdfPath: summaryPath,
            receiptPdfPath: receiptPath,
            activeSubmissionCount: activeSubmissions.length,
        });
    } catch (error) {
        console.error("[CLAIM DOCS GENERATE-ALL ERROR]", error);
        return NextResponse.json({
            ok: false,
            error: error instanceof Error ? error.message : "Gagal generate dokumen klaim.",
        }, { status: 500 });
    }
}
