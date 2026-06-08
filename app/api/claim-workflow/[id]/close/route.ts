/*
 * Tujuan: Endpoint Close Claim Workflow — transisi `Paid` → `Closed`.
 *         Menggantikan langkah final di Excel ketika klaim sudah lunas
 *         dan dokumen sudah lengkap, sehingga workflow keluar dari
 *         monitoring outstanding.
 * Caller: UI detail Claim Workflow (admin/claim).
 * Dependensi: drizzle-orm, lib/claim-workflow (audit + helpers + access).
 * Side Effects: Update claim_workflow (status=Closed + closed_at/closed_by/
 *               close_note + recalc totals fresh dari claim_payment), tulis
 *               audit `claim_closed`, dalam satu transaksi.
 *
 * Phase R4 — Close Claim Workflow:
 *   Close gate (semua harus terpenuhi):
 *     - actor admin/claim
 *     - status = Paid
 *     - noClaim ada
 *     - totalClaim > 0
 *     - active payment >= 1
 *     - totalPaid (recalc dari active payment) >= totalClaim
 *     - remainingAmount (recalc) = 0
 *     - claim_letter_pdf_path / summary_pdf_path / receipt_pdf_path
 *       semuanya present
 *     - bukan sudah Closed dan bukan Cancelled
 *     - note non-empty
 *   Tidak butuh PEKA / EC / CN. Tidak menyentuh OFF.
 *
 * Phase R7e — Multi No Claim close:
 *   Multi-submission workflow ditolak `MULTI_SUBMISSION_CLOSE_ROUTE_DISABLED`.
 *   Single-submission tetap valid; close eksekusi gate single-submission
 *   lalu mirror ke submission tunggal (status Closed + closed metadata).
 */
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { claimPayment, claimSubmission, claimWorkflow } from "@/db/schema";
import {
    claimAuditScopes,
    claimWorkflowStatuses,
    recalcPaymentTotals,
    requireClaimSession,
    writeClaimAudit,
} from "@/lib/claim-workflow";

type Context = { params: Promise<{ id: string }> };

const CLOSE_NOTE_MAX = 1000;

export async function POST(request: Request, context: Context) {
    const actor = await requireClaimSession();
    if (!actor) {
        return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }
    if (actor.role !== "admin" && actor.role !== "claim") {
        return NextResponse.json({
            ok: false,
            code: "CLAIM_CLOSE_FORBIDDEN",
            error: "Hanya role admin atau claim yang dapat menutup Claim Workflow.",
        }, { status: 403 });
    }

    let body: { note?: unknown } = {};
    if (request.headers.get("content-type")?.includes("application/json")) {
        body = await request.json().catch(() => ({}));
    }
    if (typeof body.note !== "string") {
        return NextResponse.json({
            ok: false,
            code: "CLAIM_CLOSE_NOTE_INVALID",
            error: "Catatan close harus berupa teks.",
        }, { status: 400 });
    }
    const note = body.note.trim().slice(0, CLOSE_NOTE_MAX);
    if (!note) {
        return NextResponse.json({
            ok: false,
            code: "CLAIM_CLOSE_NOTE_REQUIRED",
            error: "Catatan close wajib diisi.",
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
                return { error: { status: 404, code: "CLAIM_WORKFLOW_NOT_FOUND", message: "Claim Workflow not found" } } as const;
            }

            // Phase R7e — Multi No Claim close guard:
            const submissions = await tx
                .select({ id: claimSubmission.id, status: claimSubmission.status })
                .from(claimSubmission)
                .where(eq(claimSubmission.claimWorkflowId, id));
            if (submissions.length > 1) {
                return {
                    error: {
                        status: 409,
                        code: "MULTI_SUBMISSION_CLOSE_ROUTE_DISABLED",
                        message: "Workflow memiliki beberapa No Claim. Close dilakukan per submission.",
                    },
                } as const;
            }
            const targetSubmissionId = submissions[0]?.id ?? null;

            const previousStatus = workflow.status;

            // Tolak status final / non-eligible lebih awal supaya error message
            // jelas sebelum gate detail.
            if (previousStatus === claimWorkflowStatuses.closed) {
                return {
                    error: {
                        status: 409,
                        code: "CLAIM_CLOSE_ALREADY_CLOSED",
                        message: "Claim Workflow sudah Closed.",
                    },
                } as const;
            }
            if (previousStatus === claimWorkflowStatuses.cancelled) {
                return {
                    error: {
                        status: 409,
                        code: "CLAIM_CLOSE_CANCELLED",
                        message: "Claim Workflow sudah Cancelled, tidak dapat di-Close.",
                    },
                } as const;
            }
            if (previousStatus !== claimWorkflowStatuses.paid) {
                return {
                    error: {
                        status: 409,
                        code: "CLAIM_CLOSE_NOT_PAID",
                        message: "Close hanya tersedia saat status Paid.",
                    },
                } as const;
            }

            const totalClaim = Number(workflow.totalClaim || 0);
            if (!(totalClaim > 0)) {
                return {
                    error: {
                        status: 422,
                        code: "CLAIM_CLOSE_TOTAL_ZERO",
                        message: "Total Claim harus lebih dari 0 sebelum Close.",
                    },
                } as const;
            }
            if (!String(workflow.noClaim || "").trim()) {
                return {
                    error: {
                        status: 422,
                        code: "CLAIM_CLOSE_NO_CLAIM_REQUIRED",
                        message: "No Claim wajib ter-assign sebelum Close.",
                    },
                } as const;
            }
            if (!workflow.claimLetterPdfPath) {
                return {
                    error: {
                        status: 422,
                        code: "CLAIM_CLOSE_CLAIM_LETTER_REQUIRED",
                        message: "Claim Letter PDF wajib tersedia sebelum Close.",
                    },
                } as const;
            }
            if (!workflow.summaryPdfPath) {
                return {
                    error: {
                        status: 422,
                        code: "CLAIM_CLOSE_SUMMARY_REQUIRED",
                        message: "Claim Summary PDF wajib tersedia sebelum Close.",
                    },
                } as const;
            }
            if (!workflow.receiptPdfPath) {
                return {
                    error: {
                        status: 422,
                        code: "CLAIM_CLOSE_RECEIPT_REQUIRED",
                        message: "Kwitansi Claim PDF wajib tersedia sebelum Close.",
                    },
                } as const;
            }

            // Recalc fresh dari claim_payment active rows. Tidak boleh percaya
            // cache claim_workflow.totalPaid karena bisa drift dari payment
            // di luar route payment standar (mis. seed manual).
            const payments = await tx
                .select({
                    paymentAmount: claimPayment.paymentAmount,
                    voidedAt: claimPayment.voidedAt,
                })
                .from(claimPayment)
                .where(eq(claimPayment.claimWorkflowId, id));
            const activePaymentCount = payments.filter((p) => p.voidedAt === null).length;
            if (activePaymentCount === 0) {
                return {
                    error: {
                        status: 422,
                        code: "CLAIM_CLOSE_NO_ACTIVE_PAYMENT",
                        message: "Minimal satu pembayaran aktif diperlukan sebelum Close.",
                    },
                } as const;
            }
            const totals = recalcPaymentTotals(totalClaim, payments);
            if (totals.totalPaid < totalClaim) {
                return {
                    error: {
                        status: 422,
                        code: "CLAIM_CLOSE_TOTAL_PAID_INSUFFICIENT",
                        message: "Total Paid belum mencapai Total Claim. Catat pembayaran tambahan terlebih dahulu.",
                    },
                } as const;
            }
            if (totals.remainingAmount > 0) {
                return {
                    error: {
                        status: 422,
                        code: "CLAIM_CLOSE_OUTSTANDING_NOT_ZERO",
                        message: "Outstanding belum 0. Close memerlukan remainingAmount = 0.",
                    },
                } as const;
            }

            const now = new Date();
            await tx
                .update(claimWorkflow)
                .set({
                    status: claimWorkflowStatuses.closed,
                    closedAt: now,
                    closedBy: actor.id,
                    closeNote: note,
                    // Sinkronkan cache totals dengan recalc supaya snapshot
                    // konsisten dengan keputusan close.
                    totalPaid: totals.totalPaid,
                    remainingAmount: totals.remainingAmount,
                    aggregateStatus: claimWorkflowStatuses.closed,
                    updatedAt: now,
                })
                .where(eq(claimWorkflow.id, id));

            // Phase R7e — mirror close ke submission tunggal supaya
            // source-of-truth submission konsisten dengan cache workflow.
            if (targetSubmissionId) {
                await tx
                    .update(claimSubmission)
                    .set({
                        status: claimWorkflowStatuses.closed,
                        closedAt: now,
                        closedBy: actor.id,
                        closeNote: note,
                        totalPaid: totals.totalPaid,
                        remainingAmount: totals.remainingAmount,
                        updatedAt: now,
                    })
                    .where(eq(claimSubmission.id, targetSubmissionId));
            }

            await writeClaimAudit({
                claimWorkflowId: id,
                claimSubmissionId: targetSubmissionId,
                auditScope: targetSubmissionId
                    ? claimAuditScopes.submission
                    : claimAuditScopes.workflow,
                actor,
                action: "claim_closed",
                fromStatus: previousStatus,
                toStatus: claimWorkflowStatuses.closed,
                note,
                metadata: {
                    previousStatus,
                    newStatus: claimWorkflowStatuses.closed,
                    totalClaim,
                    totalPaid: totals.totalPaid,
                    remainingAmount: totals.remainingAmount,
                    noClaim: workflow.noClaim,
                    activePaymentCount,
                    summaryPdfPath: workflow.summaryPdfPath,
                    claimLetterPdfPath: workflow.claimLetterPdfPath,
                    receiptPdfPath: workflow.receiptPdfPath,
                    submissionId: targetSubmissionId,
                    viaLegacyWorkflowRoute: true,
                },
            }, tx);

            // Phase R6 — Close response snapshot:
            // Bangun snapshot response dari nilai yang sudah commit di
            // transaksi ini, tanpa re-fetch terpisah di luar transaksi.
            // Hal ini menghindari race kalau ada writer lain (mis. void
            // payment yang ditolak setelah Closed) berjalan tepat setelah
            // transaksi close ini commit dan sebelum re-fetch terjadi.
            const snapshot = {
                id,
                status: claimWorkflowStatuses.closed,
                totalClaim,
                totalPaid: totals.totalPaid,
                remainingAmount: totals.remainingAmount,
                closedAt: now,
                closedBy: actor.id,
                closeNote: note,
            } as const;

            return {
                ok: true,
                previousStatus,
                totals,
                activePaymentCount,
                closedAt: now,
                snapshot,
            } as const;
        });

        if (result.error) {
            return NextResponse.json(
                { ok: false, code: result.error.code, error: result.error.message },
                { status: result.error.status },
            );
        }

        return NextResponse.json({
            ok: true,
            success: true,
            workflow: result.snapshot,
            previousStatus: result.previousStatus,
        });
    } catch (error) {
        console.error("[CLAIM WORKFLOW CLOSE ERROR]", error);
        return NextResponse.json({ ok: false, error: "Gagal menutup Claim Workflow." }, { status: 500 });
    }
}
