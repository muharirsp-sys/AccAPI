import path from "node:path";
import { unlink } from "node:fs/promises";
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { claimSubmission, claimWorkflow, claimWorkflowItem } from "@/db/schema";
import {
    claimAuditScopes,
    claimDocumentTypes,
    claimWorkflowStatuses,
    getActiveSubmissions,
    isActiveSubmission,
    isPathInsideClaimDocumentRoot,
    requireClaimSession,
    writeClaimAudit,
} from "@/lib/claim-workflow";

const CLAIM_LETTERS_DIR = path.resolve(process.cwd(), "runtime", "claim-workflow", "letters");
const SUMMARY_DIR = path.resolve(process.cwd(), "runtime", "claim-workflow", "summaries");
const RECEIPT_DIR = path.resolve(process.cwd(), "runtime", "claim-workflow", "receipts");

function isPathInsideDir(targetPath: string, baseDir: string): boolean {
    const resolved = path.resolve(targetPath);
    return resolved === baseDir || resolved.startsWith(baseDir + path.sep);
}

function isPathInsideLettersDir(targetPath: string): boolean {
    return isPathInsideDir(targetPath, CLAIM_LETTERS_DIR);
}

function isPathInsideSummaryDir(targetPath: string): boolean {
    return isPathInsideDir(targetPath, SUMMARY_DIR);
}

function isPathInsideReceiptDir(targetPath: string): boolean {
    return isPathInsideDir(targetPath, RECEIPT_DIR);
}

/**
 * Phase R7c: bila return_to_draft, hapus juga PDF dari submission tree
 * (multi-submission). Helper ini terima path apapun yang berada di
 * bawah `runtime/claim-workflow/` (legacy dir maupun submission tree).
 */
function shouldUnlinkClaimDocument(targetPath: string | null | undefined): boolean {
    return Boolean(targetPath) && isPathInsideClaimDocumentRoot(targetPath as string);
}

type Context = { params: Promise<{ id: string }> };

type TransitionAction =
    | "mark_ready"
    | "return_to_draft"
    | "submit_to_principal";

const ACTIONS: ReadonlyArray<TransitionAction> = [
    "mark_ready",
    "return_to_draft",
    "submit_to_principal",
];

function isTransitionAction(value: unknown): value is TransitionAction {
    return typeof value === "string" && (ACTIONS as ReadonlyArray<string>).includes(value);
}

function buildSummary(workflow: typeof claimWorkflow.$inferSelect, itemCount: number) {
    return {
        id: workflow.id,
        claimWorkflowNo: workflow.claimWorkflowNo,
        status: workflow.status,
        totalDpp: Number(workflow.totalDpp || 0),
        totalPpn: Number(workflow.totalPpn || 0),
        totalPph: Number(workflow.totalPph || 0),
        totalClaim: Number(workflow.totalClaim || 0),
        totalPaid: Number(workflow.totalPaid || 0),
        remainingAmount: Number(workflow.remainingAmount || 0),
        submittedToPrincipalAt: workflow.submittedToPrincipalAt,
        updatedAt: workflow.updatedAt,
        itemCount,
    };
}

export async function POST(request: Request, context: Context) {
    const actor = await requireClaimSession();
    if (!actor) {
        return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }
    if (actor.role !== "admin" && actor.role !== "claim") {
        return NextResponse.json({
            ok: false,
            code: "CLAIM_WORKFLOW_FORBIDDEN",
            error: "Hanya role admin atau claim yang dapat mengubah status Claim Workflow.",
        }, { status: 403 });
    }

    let body: { action?: unknown; note?: unknown } = {};
    if (request.headers.get("content-type")?.includes("application/json")) {
        body = await request.json().catch(() => ({}));
    }
    if (!isTransitionAction(body.action)) {
        return NextResponse.json({
            ok: false,
            code: "CLAIM_WORKFLOW_INVALID_ACTION",
            error: "Action harus salah satu dari: mark_ready, return_to_draft, submit_to_principal.",
        }, { status: 400 });
    }
    const action = body.action;
    if (body.note !== undefined && body.note !== null && typeof body.note !== "string") {
        return NextResponse.json({
            ok: false,
            code: "CLAIM_WORKFLOW_INVALID_NOTE",
            error: "Catatan harus berupa teks.",
        }, { status: 400 });
    }
    const note = typeof body.note === "string" && body.note.trim() !== "" ? body.note : null;

    try {
        const { id } = await context.params;
        const [workflow] = await db.select().from(claimWorkflow).where(eq(claimWorkflow.id, id));
        if (!workflow) {
            return NextResponse.json({ ok: false, error: "Claim Workflow not found" }, { status: 404 });
        }

        const fromStatus = workflow.status;
        let toStatus: string;

        let activeSubmissionsForSync: Awaited<ReturnType<typeof getActiveSubmissions>> = [];

        if (action === "mark_ready") {
            if (
                fromStatus !== claimWorkflowStatuses.draft &&
                fromStatus !== claimWorkflowStatuses.needRevision
            ) {
                return NextResponse.json({
                    ok: false,
                    code: "CLAIM_WORKFLOW_INVALID_STATE",
                    error: "Mark Ready hanya tersedia saat status Draft atau Need Revision.",
                }, { status: 409 });
            }
            toStatus = claimWorkflowStatuses.readyToSubmit;
        } else if (action === "return_to_draft") {
            if (fromStatus !== claimWorkflowStatuses.readyToSubmit) {
                return NextResponse.json({
                    ok: false,
                    code: "CLAIM_WORKFLOW_INVALID_STATE",
                    error: "Return to Draft hanya tersedia saat status Ready to Submit.",
                }, { status: 409 });
            }
            // return_to_draft dapat menginvalidasi Claim Letter PDF aktif dan
            // membuka kembali tax editing, jadi audit wajib mencatat alasan
            // konkret. Tolak jika note kosong/blank.
            if (!note) {
                return NextResponse.json({
                    ok: false,
                    code: "RETURN_TO_DRAFT_NOTE_REQUIRED",
                    error: "Alasan wajib diisi saat mengembalikan Claim Workflow ke Draft.",
                }, { status: 400 });
            }
            toStatus = claimWorkflowStatuses.draft;
        } else {
            // submit_to_principal
            if (fromStatus !== claimWorkflowStatuses.readyToSubmit) {
                return NextResponse.json({
                    ok: false,
                    code: "CLAIM_WORKFLOW_INVALID_STATE",
                    error: "Submit to Principal hanya tersedia saat status Ready to Submit.",
                }, { status: 409 });
            }
            toStatus = claimWorkflowStatuses.submittedToPrincipal;
        }

        // Validation untuk mark_ready: workflow harus memiliki item dan
        // total/komponen pajak per item harus konsisten > 0 sebelum dilock.
        //
        // BLOCKER FIX #1 (R7 Multi-Submission Aware):
        // Gate sekarang validasi per submission aktif, bukan workflow cache.
        // Submission aktif = submission dengan totalClaim > 0 atau itemCount > 0.
        // Default submission kosong (per_pengajuan, 0 item) diabaikan.
        const items = await db
            .select()
            .from(claimWorkflowItem)
            .where(eq(claimWorkflowItem.claimWorkflowId, id));
        if (action === "mark_ready") {
            if (items.length === 0) {
                return NextResponse.json({
                    ok: false,
                    code: "CLAIM_WORKFLOW_EMPTY_ITEMS",
                    error: "Claim Workflow harus memiliki minimal satu item sebelum Ready to Submit.",
                }, { status: 422 });
            }
            const totalClaim = Number(workflow.totalClaim || 0);
            if (!(totalClaim > 0)) {
                return NextResponse.json({
                    ok: false,
                    code: "CLAIM_WORKFLOW_TOTAL_ZERO",
                    error: "Total Claim harus lebih dari 0 sebelum Ready to Submit.",
                }, { status: 422 });
            }
            const invalidItem = items.find(
                (row) => !(Number(row.dpp || 0) > 0) || !(Number(row.nilaiKlaim || 0) > 0),
            );
            if (invalidItem) {
                return NextResponse.json({
                    ok: false,
                    code: "CLAIM_WORKFLOW_ITEM_INVALID",
                    error: "Setiap item harus memiliki DPP dan Nilai Klaim lebih dari 0 sebelum Ready to Submit.",
                    itemId: invalidItem.id,
                }, { status: 422 });
            }

            // R7 BLOCKER FIX: Validasi per submission aktif, bukan workflow cache.
            // Ambil semua submission aktif (ignore default kosong).
            const activeSubmissions = await getActiveSubmissions(id, db);
            activeSubmissionsForSync = activeSubmissions;

            if (activeSubmissions.length === 0) {
                return NextResponse.json({
                    ok: false,
                    code: "CLAIM_WORKFLOW_NO_ACTIVE_SUBMISSION",
                    error: "Tidak ada Berkas Claim aktif. Siapkan Baris Claim terlebih dahulu.",
                }, { status: 422 });
            }

            // Rule dokumen R7 (Generate Semua Dokumen):
            // Semua dokumen sekarang gabungan workflow-level:
            // - Surat Claim gabungan → workflow.claimLetterPdfPath
            // - Summary gabungan → workflow.summaryPdfPath
            // - Kwitansi gabungan → workflow.receiptPdfPath
            // Setiap submission aktif hanya perlu No Claim; path dokumen
            // dimirror dari workflow sehingga tidak perlu dicek per submission.
            for (const submission of activeSubmissions) {
                const subNoClaim = String(submission.noClaim || "").trim();

                if (!subNoClaim) {
                    return NextResponse.json({
                        ok: false,
                        code: "CLAIM_SUBMISSION_NO_CLAIM_REQUIRED",
                        error: "No Claim belum lengkap.",
                        submissionId: submission.id,
                    }, { status: 422 });
                }
            }

            // Dokumen gabungan workflow-level wajib ada.
            if (!workflow.claimLetterPdfPath) {
                return NextResponse.json({
                    ok: false,
                    code: "CLAIM_COMBINED_LETTER_REQUIRED",
                    error: "Surat Claim gabungan belum dibuat.",
                }, { status: 422 });
            }
            if (!workflow.summaryPdfPath) {
                return NextResponse.json({
                    ok: false,
                    code: "CLAIM_COMBINED_SUMMARY_REQUIRED",
                    error: "Summary gabungan belum dibuat.",
                }, { status: 422 });
            }
            if (!workflow.receiptPdfPath) {
                return NextResponse.json({
                    ok: false,
                    code: "CLAIM_COMBINED_RECEIPT_REQUIRED",
                    error: "Kwitansi gabungan belum dibuat.",
                }, { status: 422 });
            }

            // Semua submission aktif valid. Mark Ready bisa proceed.
        } else if (action === "submit_to_principal") {
            activeSubmissionsForSync = await getActiveSubmissions(id, db);
            if (activeSubmissionsForSync.length === 0) {
                return NextResponse.json({
                    ok: false,
                    code: "CLAIM_WORKFLOW_NO_ACTIVE_SUBMISSION",
                    error: "Tidak ada Berkas Claim aktif untuk dikirim ke principal.",
                }, { status: 422 });
            }
        }

        const now = new Date();
        const updatePayload: Partial<typeof claimWorkflow.$inferInsert> = {
            status: toStatus,
            updatedAt: now,
        };
        if (action === "submit_to_principal") {
            updatePayload.submittedToPrincipalAt = now;
        }
        // Phase R2: return_to_draft menginvalidate ketiga dokumen sekaligus
        // (Claim Letter, Summary, Kwitansi Claim) karena tax editing
        // dibuka kembali dan perubahan item bisa membuat dokumen lama
        // tidak konsisten dengan data terbaru.
        const invalidatedClaimLetterPdfPath = action === "return_to_draft"
            ? workflow.claimLetterPdfPath
            : null;
        const invalidatedSummaryPdfPath = action === "return_to_draft"
            ? workflow.summaryPdfPath
            : null;
        const invalidatedReceiptPdfPath = action === "return_to_draft"
            ? workflow.receiptPdfPath
            : null;
        if (action === "return_to_draft") {
            updatePayload.claimLetterPdfPath = null;
            updatePayload.claimLetterGeneratedAt = null;
            updatePayload.claimLetterGeneratedBy = null;
            updatePayload.summaryPdfPath = null;
            updatePayload.summaryGeneratedAt = null;
            updatePayload.summaryGeneratedBy = null;
            updatePayload.receiptPdfPath = null;
            updatePayload.receiptGeneratedAt = null;
            updatePayload.receiptGeneratedBy = null;
        }

        // Phase R7c — Multi No Claim:
        // return_to_draft juga harus menginvalidasi seluruh PDF dari
        // semua submission (Letter / Summary / Kwitansi). Tax editing
        // dibuka kembali per item -> setiap submission yang mengandalkan
        // item tersebut perlu di-regenerate. Path lama dikumpulkan untuk
        // unlink di luar transaksi (pola sama dengan workflow cache).
        const invalidatedSubmissionPdfPaths: Array<{
            submissionId: string;
            type: "letter" | "summary" | "receipt";
            path: string;
        }> = [];

        const auditMetadata: Record<string, unknown> = {
            totalDpp: Number(workflow.totalDpp || 0),
            totalPpn: Number(workflow.totalPpn || 0),
            totalPph: Number(workflow.totalPph || 0),
            totalClaim: Number(workflow.totalClaim || 0),
            totalPaid: Number(workflow.totalPaid || 0),
            remainingAmount: Number(workflow.remainingAmount || 0),
            itemCount: items.length,
            ...(invalidatedClaimLetterPdfPath ? { invalidatedClaimLetterPdfPath } : {}),
            ...(invalidatedSummaryPdfPath ? { invalidatedSummaryPdfPath } : {}),
            ...(invalidatedReceiptPdfPath ? { invalidatedReceiptPdfPath } : {}),
        };

        // Status transition + audit ditulis atomic agar tidak pernah ada
        // pergeseran status tanpa jejak audit.
        await db.transaction(async (tx) => {
            await tx
                .update(claimWorkflow)
                .set(updatePayload)
                .where(eq(claimWorkflow.id, id));

            // Phase R7c: invalidate semua submission PDF saat return.
            if (action === "return_to_draft") {
                const submissions = await tx
                    .select({
                        id: claimSubmission.id,
                        claimLetterPdfPath: claimSubmission.claimLetterPdfPath,
                        summaryPdfPath: claimSubmission.summaryPdfPath,
                        receiptPdfPath: claimSubmission.receiptPdfPath,
                    })
                    .from(claimSubmission)
                    .where(eq(claimSubmission.claimWorkflowId, id));
                for (const s of submissions) {
                    if (s.claimLetterPdfPath) {
                        invalidatedSubmissionPdfPaths.push({
                            submissionId: s.id,
                            type: claimDocumentTypes.letter,
                            path: s.claimLetterPdfPath,
                        });
                    }
                    if (s.summaryPdfPath) {
                        invalidatedSubmissionPdfPaths.push({
                            submissionId: s.id,
                            type: claimDocumentTypes.summary,
                            path: s.summaryPdfPath,
                        });
                    }
                    if (s.receiptPdfPath) {
                        invalidatedSubmissionPdfPaths.push({
                            submissionId: s.id,
                            type: claimDocumentTypes.receipt,
                            path: s.receiptPdfPath,
                        });
                    }
                    await tx
                        .update(claimSubmission)
                        .set({
                            claimLetterPdfPath: null,
                            claimLetterGeneratedAt: null,
                            claimLetterGeneratedBy: null,
                            summaryPdfPath: null,
                            summaryGeneratedAt: null,
                            summaryGeneratedBy: null,
                            receiptPdfPath: null,
                            receiptGeneratedAt: null,
                            receiptGeneratedBy: null,
                            updatedAt: now,
                        })
                        .where(eq(claimSubmission.id, s.id));
                }
                if (invalidatedSubmissionPdfPaths.length > 0) {
                    auditMetadata.invalidatedSubmissionPdfPaths = invalidatedSubmissionPdfPaths;
                }
            }

            if (action === "mark_ready" || action === "submit_to_principal") {
                const syncedSubmissions: Array<{
                    submissionId: string;
                    fromStatus: string;
                    toStatus: string;
                }> = [];
                for (const submission of activeSubmissionsForSync) {
                    if (
                        submission.status === claimWorkflowStatuses.closed ||
                        submission.status === claimWorkflowStatuses.paid ||
                        submission.status === claimWorkflowStatuses.cancelled ||
                        submission.status === toStatus
                    ) {
                        continue;
                    }
                    await tx
                        .update(claimSubmission)
                        .set({ status: toStatus, updatedAt: now })
                        .where(eq(claimSubmission.id, submission.id));
                    syncedSubmissions.push({
                        submissionId: submission.id,
                        fromStatus: submission.status,
                        toStatus,
                    });
                }
                if (syncedSubmissions.length > 0) {
                    auditMetadata.syncedSubmissionStatuses = syncedSubmissions;
                    await writeClaimAudit({
                        claimWorkflowId: id,
                        auditScope: claimAuditScopes.workflow,
                        actor,
                        action: "claim_submission_status_synced",
                        fromStatus,
                        toStatus,
                        note,
                        metadata: {
                            trigger: action,
                            activeSubmissionCount: activeSubmissionsForSync.length,
                            syncedSubmissions,
                        },
                    }, tx);
                }
            }

            await writeClaimAudit({
                claimWorkflowId: id,
                auditScope: claimAuditScopes.workflow,
                actor,
                action,
                fromStatus,
                toStatus,
                note,
                metadata: auditMetadata,
            }, tx);
        });

        // Setelah transaksi sukses, hapus PDF yang sudah di-invalidate supaya
        // file di disk tidak menumpuk. Audit log tetap menyimpan path lama
        // di field `invalidated*` untuk kebutuhan trace.
        if (
            invalidatedClaimLetterPdfPath &&
            isPathInsideLettersDir(invalidatedClaimLetterPdfPath)
        ) {
            await unlink(invalidatedClaimLetterPdfPath).catch(() => {});
        }
        if (
            invalidatedSummaryPdfPath &&
            isPathInsideSummaryDir(invalidatedSummaryPdfPath)
        ) {
            await unlink(invalidatedSummaryPdfPath).catch(() => {});
        }
        if (
            invalidatedReceiptPdfPath &&
            isPathInsideReceiptDir(invalidatedReceiptPdfPath)
        ) {
            await unlink(invalidatedReceiptPdfPath).catch(() => {});
        }
        // Phase R7c: best-effort unlink semua PDF submission yang ter-invalidate.
        for (const entry of invalidatedSubmissionPdfPaths) {
            if (shouldUnlinkClaimDocument(entry.path)) {
                await unlink(entry.path).catch(() => {});
            }
        }

        const [updated] = await db
            .select()
            .from(claimWorkflow)
            .where(eq(claimWorkflow.id, id));

        return NextResponse.json({
            ok: true,
            success: true,
            workflow: buildSummary(updated, items.length),
        });
    } catch (error) {
        console.error("[CLAIM WORKFLOW STATUS TRANSITION ERROR]", error);
        return NextResponse.json({
            ok: false,
            error: "Gagal mengubah status Claim Workflow.",
        }, { status: 500 });
    }
}
