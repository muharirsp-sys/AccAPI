import { NextResponse } from "next/server";
import { asc, count, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import {
    claimPayment,
    claimSubmission,
    claimWorkflow,
    claimWorkflowItem,
    offBatch,
    offBatchItem,
    offPayment,
    user,
} from "@/db/schema";
import {
    claimWorkflowStatuses,
    getActiveSubmissions,
    getOffFinanceGateForNoClaim,
    isActiveSubmission,
    recalcPaymentTotals,
    requireClaimSession,
} from "@/lib/claim-workflow";
import { requirePermissionH } from "@/lib/rbac/resolve";

type Context = { params: Promise<{ id: string }> };

function isPaymentDerivedStatus(status: string): boolean {
    return (
        status === claimWorkflowStatuses.submittedToPrincipal ||
        status === claimWorkflowStatuses.partiallyPaid ||
        status === claimWorkflowStatuses.paid
    );
}

// Normalisasi label metode pembayaran Finance ke bentuk tampilan yang
// konsisten ("Transfer" / "Tunai"). Nilai lain dipertahankan apa adanya
// (mis. "Giro"); null/empty → "-".
function normalizeFinancePaymentMethod(value: string | null | undefined): string {
    const trimmed = String(value ?? "").trim();
    if (!trimmed) return "-";
    const lower = trimmed.toLowerCase();
    if (lower === "transfer") return "Transfer";
    if (lower === "tunai" || lower === "cash") return "Tunai";
    return trimmed;
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
        const [row] = await db
            .select({
                workflow: claimWorkflow,
                offNoPengajuan: offBatch.noPengajuan,
            })
            .from(claimWorkflow)
            .leftJoin(offBatch, eq(claimWorkflow.offBatchId, offBatch.id))
            .where(eq(claimWorkflow.id, id));

        if (!row) {
            return NextResponse.json({ ok: false, error: "Claim Workflow not found" }, { status: 404 });
        }

        const items = await db
            .select()
            .from(claimWorkflowItem)
            .where(eq(claimWorkflowItem.claimWorkflowId, id));

        // Jenis Pembayaran (Finance) per item. Sumber prioritas:
        //   1. off_payment.payment_method via off_batch_item.financePaymentId
        //   2. fallback off_batch_item.caraBayar
        //   3. "-" bila tidak ada keduanya
        // Tidak ada perubahan schema; hanya enrich response detail.
        const offBatchItemIds = Array.from(
            new Set(
                items
                    .map((it) => it.offBatchItemId)
                    .filter((v): v is string => typeof v === "string" && v.length > 0),
            ),
        );
        const offBatchItemMethodMap = new Map<string, string | null>();
        if (offBatchItemIds.length > 0) {
            const offItems = await db
                .select({
                    id: offBatchItem.id,
                    caraBayar: offBatchItem.caraBayar,
                    financePaymentId: offBatchItem.financePaymentId,
                    paymentMethod: offPayment.paymentMethod,
                })
                .from(offBatchItem)
                .leftJoin(offPayment, eq(offBatchItem.financePaymentId, offPayment.id))
                .where(inArray(offBatchItem.id, offBatchItemIds));
            for (const oi of offItems) {
                const raw =
                    (oi.paymentMethod && String(oi.paymentMethod).trim()) ||
                    (oi.caraBayar && String(oi.caraBayar).trim()) ||
                    null;
                offBatchItemMethodMap.set(oi.id, normalizeFinancePaymentMethod(raw));
            }
        }
        const itemsWithFinanceMethod = items.map((it) => ({
            ...it,
            financePaymentMethodLabel: it.offBatchItemId
                ? offBatchItemMethodMap.get(it.offBatchItemId) ?? "-"
                : "-",
        }));
        const payments = await db
            .select()
            .from(claimPayment)
            .where(eq(claimPayment.claimWorkflowId, id))
            .orderBy(asc(claimPayment.paymentDate), asc(claimPayment.createdAt));
        // Phase R7b — Multi No Claim:
        // Sertakan daftar `claim_submission` di response detail supaya UI
        // bisa menampilkan section Submissions tanpa fetch tambahan.
        // Belum mengganti tampilan workflow-level (noClaim cache, PDF
        // paths, payment) — itu R7c/R7d.
        // BLOCKER FIX #2: Ambil submissions dengan itemCount dan filter aktif.
        // Submission aktif = totalClaim > 0 atau itemCount > 0.
        // Default submission kosong (per_pengajuan, 0 item) diabaikan dari count.
        const submissions = await db
            .select()
            .from(claimSubmission)
            .where(eq(claimSubmission.claimWorkflowId, id))
            .orderBy(asc(claimSubmission.createdAt));
        const submissionItemCounts = submissions.length > 0
            ? await db
                .select({
                    claimSubmissionId: claimWorkflowItem.claimSubmissionId,
                    count: count(claimWorkflowItem.id),
                })
                .from(claimWorkflowItem)
                .where(eq(claimWorkflowItem.claimWorkflowId, id))
                .groupBy(claimWorkflowItem.claimSubmissionId)
            : [];
        const submissionItemCountMap = new Map<string, number>();
        for (const row of submissionItemCounts) {
            if (row.claimSubmissionId) {
                submissionItemCountMap.set(row.claimSubmissionId, Number(row.count || 0));
            }
        }

        // Attach itemCount ke setiap submission untuk filter aktif
        const submissionsWithItemCount = submissions.map((s) => ({
            ...s,
            itemCount: submissionItemCountMap.get(s.id) ?? 0,
        }));

        // Filter submission aktif (abaikan default kosong)
        const activeSubmissions = submissionsWithItemCount.filter(isActiveSubmission);

        // noClaimList hanya dari submission aktif
        const noClaimList = activeSubmissions
            .map((s) => s.noClaim)
            .filter((value): value is string => typeof value === "string" && value.length > 0);
        // Resolve display name untuk No Claim assignor agar UI tidak harus
        // join sendiri. Aman: kalau noClaimAssignedBy NULL, lewati query.
        let noClaimAssignedByName: string | null = null;
        if (row.workflow.noClaimAssignedBy) {
            const [assignor] = await db
                .select({ name: user.name })
                .from(user)
                .where(eq(user.id, row.workflow.noClaimAssignedBy));
            noClaimAssignedByName = assignor?.name ?? null;
        }
        const canManageClaim = actor.role === "admin" || actor.role === "claim";
        // Phase R1: Claim Letter PDF dapat di-generate sejak Draft / Need
        // Revision. User wajib generate PDF dulu sebelum Mark Ready, karena
        // mark_ready memvalidasi `claimLetterPdfPath`. Generation tetap
        // tersedia di Ready to Submit / Submitted to Principal untuk
        // mengganti PDF aktif (regenerate skenario kecil).
        // Phase R2: aturan window yang sama dipakai untuk Summary & Receipt.
        const docGenerationAllowed = (
            row.workflow.status === claimWorkflowStatuses.draft ||
            row.workflow.status === claimWorkflowStatuses.needRevision ||
            row.workflow.status === claimWorkflowStatuses.readyToSubmit ||
            row.workflow.status === claimWorkflowStatuses.submittedToPrincipal
        );
        const canGenerateClaimLetter = canManageClaim && docGenerationAllowed;
        const canGenerateSummary = canManageClaim && docGenerationAllowed;
        const canGenerateReceipt = canManageClaim && docGenerationAllowed;

        // Phase R3 — Principal Payment + Outstanding:
        // Hitung totals payment dari list aktif/non-voided supaya UI dan
        // gating tombol payment selalu konsisten dengan perhitungan
        // backend (tidak bergantung pada nilai cache di kolom workflow
        // yang mungkin sedikit lag dari list payment terbaru).
        const totalClaim = Number(row.workflow.totalClaim || 0);
        const paymentTotals = recalcPaymentTotals(totalClaim, payments);
        const activePayments = payments.filter((p) => p.voidedAt === null);
        const voidedPayments = payments.filter((p) => p.voidedAt !== null);
        const activePaymentCountBySubmission = new Map<string, number>();
        for (const payment of activePayments) {
            if (!payment.claimSubmissionId) continue;
            activePaymentCountBySubmission.set(
                payment.claimSubmissionId,
                (activePaymentCountBySubmission.get(payment.claimSubmissionId) ?? 0) + 1,
            );
        }
        const paymentStatus = isPaymentDerivedStatus(row.workflow.status)
            ? paymentTotals.derivedStatus
            : row.workflow.status;
        const statusDriftWarning = isPaymentDerivedStatus(row.workflow.status) &&
            row.workflow.status !== paymentTotals.derivedStatus;
        const canAssignNoClaim = canManageClaim &&
            row.workflow.status !== claimWorkflowStatuses.closed;

        // OFF Finance gate for No Claim generation
        const offFinanceGate = await getOffFinanceGateForNoClaim(db, row.workflow.offBatchId);
        const isEditableStatus = (
            row.workflow.status === claimWorkflowStatuses.draft ||
            row.workflow.status === claimWorkflowStatuses.needRevision
        );
        const activeSubsMissingNoClaim = activeSubmissions.filter(
            (s) => !s.noClaim || String(s.noClaim).trim() === "",
        );
        const canGenerateNoClaim = canManageClaim && offFinanceGate.isPaid && isEditableStatus && activeSubsMissingNoClaim.length > 0;
        const noClaimGateReason = !canManageClaim
            ? "Role Anda tidak memiliki akses untuk assign No Claim."
            : !offFinanceGate.isPaid
                ? offFinanceGate.reason || "Menunggu validasi keuangan OFF Program. No Claim baru bisa dibuat setelah Finance OFF Paid."
                : !isEditableStatus
                    ? `Status workflow ${row.workflow.status} tidak mengizinkan edit No Claim.`
                    : activeSubsMissingNoClaim.length === 0
                        ? "Semua submission aktif sudah memiliki No Claim."
                        : null;
        const paymentAllowed = (
            paymentStatus === claimWorkflowStatuses.submittedToPrincipal ||
            paymentStatus === claimWorkflowStatuses.partiallyPaid
        );
        const canRecordPayment = canManageClaim && paymentAllowed && paymentTotals.remainingAmount > 0;
        const canVoidPayment = canManageClaim && row.workflow.status !== claimWorkflowStatuses.closed;

        // Phase R4 — Close Claim Workflow:
        // Bangun closeBlockers terurut sesuai prioritas user-facing.
        // canClose hanya true bila tidak ada blocker dan actor admin/claim.
        const closeBlockers: string[] = [];
        if (activeSubmissions.length === 0) {
            closeBlockers.push("Belum ada Berkas Claim aktif.");
        }
        const closeableSubmissions = activeSubmissions.filter((submission) => {
            if (submission.status === claimWorkflowStatuses.closed) return false;
            const submissionTotalClaim = Number(submission.totalClaim || 0);
            const submissionTotalPaid = Number(submission.totalPaid || 0);
            const submissionRemaining = Number(submission.remainingAmount || 0);
            const activePaymentCount = activePaymentCountBySubmission.get(submission.id) ?? 0;
            return (
                submission.status === claimWorkflowStatuses.paid &&
                String(submission.noClaim || "").trim() !== "" &&
                submissionTotalClaim > 0 &&
                activePaymentCount > 0 &&
                submissionTotalPaid >= submissionTotalClaim &&
                submissionRemaining === 0 &&
                Boolean(submission.claimLetterPdfPath) &&
                Boolean(submission.summaryPdfPath) &&
                Boolean(submission.receiptPdfPath)
            );
        });
        const openSubmissions = activeSubmissions.filter(
            (submission) => submission.status !== claimWorkflowStatuses.closed,
        );
        if (row.workflow.status === claimWorkflowStatuses.cancelled) {
            closeBlockers.push("Claim Workflow sudah Cancelled, tidak dapat di-Close.");
        }
        if (openSubmissions.length > 0 && closeableSubmissions.length === 0) {
            closeBlockers.push("Belum ada Berkas Claim yang memenuhi syarat Close.");
        }
        const canClose = canManageClaim && closeableSubmissions.length > 0;

        return NextResponse.json({
            ok: true,
            workflow: {
                ...row.workflow,
                offNoPengajuan: row.offNoPengajuan,
                noClaimAssignedByName,
                // Cache totals tetap dibaca oleh UI lama; juga override dengan
                // hasil recalc agar konsisten.
                totalPaid: paymentTotals.totalPaid,
                remainingAmount: paymentTotals.remainingAmount,
                paymentDerivedStatus: paymentTotals.derivedStatus,
                statusDriftWarning,
            },
            offBatch: {
                id: row.workflow.offBatchId,
                noPengajuan: row.offNoPengajuan,
            },
            items: itemsWithFinanceMethod,
            payments,
            activePayments,
            voidedPayments,
            paymentSummary: {
                totalClaim,
                totalPaid: paymentTotals.totalPaid,
                remainingAmount: paymentTotals.remainingAmount,
                paymentStatus,
                persistedStatus: row.workflow.status,
                paymentDerivedStatus: paymentTotals.derivedStatus,
                statusDriftWarning,
                paymentCount: payments.length,
                activePaymentCount: activePayments.length,
                voidedPaymentCount: voidedPayments.length,
            },
            // Phase R7b — Multi No Claim:
            // Submissions list selalu disertakan supaya UI bisa render
            // section Submissions.
            //
            // BLOCKER FIX #2 & #3:
            // - submissionCount = count submission aktif saja (bukan semua)
            // - activeSubmissions = submission dengan totalClaim > 0 atau itemCount > 0
            // - canEditItems HANYA untuk admin/claim (bukan staff read-only)
            // - isReadOnly flag eksplisit untuk staff
            submissions: submissionsWithItemCount,
            submissionCount: activeSubmissions.length,
            hasMultipleSubmissions: activeSubmissions.length > 1,
            activeSubmissionCount: activeSubmissions.length,
            noClaimList,
            noClaimDisplay: activeSubmissions.length === 0
                ? row.workflow.noClaim ?? null
                : activeSubmissions.length === 1
                    ? noClaimList[0] ?? null
                    : noClaimList.length > 0
                        ? `Multiple No Claim (${noClaimList.length})`
                        : null,
            canEditItems: canManageClaim,
            isReadOnly: !canManageClaim,
            canGenerateClaimLetter,
            canGenerateSummary,
            canGenerateReceipt,
            canAssignNoClaim,
            canGenerateNoClaim,
            noClaimGateReason,
            offFinanceStatus: offFinanceGate.financeStatus,
            offStatus: offFinanceGate.offStatus,
            offPaymentSummary: {
                totalNominal: offFinanceGate.totalNominal,
                totalPaid: offFinanceGate.totalPaid,
                isFullyPaid: offFinanceGate.isFullyPaid,
            },
            activeSubmissionMissingNoClaimCount: activeSubsMissingNoClaim.length,
            canRecordPayment,
            canVoidPayment,
            canClose,
            closeBlockers,
        });
    } catch (error) {
        console.error("[CLAIM WORKFLOW DETAIL ERROR]", error);
        return NextResponse.json({ ok: false, error: "Gagal mengambil detail Claim Workflow." }, { status: 500 });
    }
}
