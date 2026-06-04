/*
 * Tujuan: Helper untuk Phase R7a/R7b — Multi No Claim + Direct Claim
 *         Source. R7a hanya pure mapping helper (backfill); R7b menambah
 *         DB-aware helper untuk submission CRUD dan recalc aggregate.
 * Caller:
 *   - scripts/migrate-r7a-default-submission.mjs (R7a, via duplicated
 *     plain JS — file ini tetap source of truth secara konsep).
 *   - app/api/claim-workflow/[id]/submissions/* (R7b dan ke depan).
 *   - app/api/claim-workflow/[id]/items/[itemId]/route.ts (R7b — recalc
 *     submission setelah edit pajak item).
 *   - app/api/claim-workflow/[id]/no-claim/route.ts (R7b — sync ke
 *     default submission saat single-submission compatibility flow).
 * Dependensi: drizzle-orm, db schema. Helper tetap aman dipanggil baik
 *             di luar maupun di dalam transaksi.
 * Side Effects:
 *   - Pure mapping (`buildDefaultSubmissionFromWorkflow`,
 *     `getDefaultSubmissionScopeLabel`) → tidak ada.
 *   - DB-aware helpers menulis ke `claim_submission`,
 *     `claim_workflow_item.claim_submission_id`,
 *     `claim_payment.claim_submission_id`, dan
 *     `claim_workflow.{totalDpp,totalPpn,totalPph,totalClaim,totalPaid,
 *     remainingAmount,aggregateStatus}`.
 *
 * Catatan kunci:
 * - Recalc selalu memakai data fresh dari DB (bukan cache cross-call).
 * - Helper TIDAK mengubah `claim_workflow.status`. Status workflow tetap
 *   menjadi source-of-truth display sampai R7e. `aggregate_status` boleh
 *   dimirror dari `status` workflow saat ini.
 * - Helper TIDAK menyentuh PDF / payment route behavior — itu R7c/R7d.
 */
import { randomUUID } from "node:crypto";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
    claimPayment,
    claimSubmission,
    claimWorkflow,
    claimWorkflowItem,
} from "@/db/schema";
import {
    calculateRemainingAmount,
    derivePaymentStatus,
    recalcPaymentTotals,
} from "./calculations";
import {
    claimSubmissionScopes,
    claimSubmissionStatuses,
    claimWorkflowStatuses,
} from "./constants";
import type { ClaimSubmissionRow, ClaimWorkflowRow } from "./types";

/**
 * Tipe minimal untuk executor yang dipakai helper. Pick subset metode
 * drizzle-orm yang sama-sama tersedia di `db` global maupun transaksi
 * yang dihasilkan oleh `db.transaction(async (tx) => …)`. Hindari pakai
 * `typeof db` langsung karena transaksi tidak punya properti `$client`/
 * `batch`, sehingga TypeScript akan complain saat helper dipanggil
 * dengan `tx`.
 */
type DbExecutor = Pick<typeof db, "select" | "update" | "insert">;

// =============================================================================
// Pure helpers (R7a, dipertahankan)
// =============================================================================

/**
 * Hasilkan label scope default untuk submission backfill.
 */
export function getDefaultSubmissionScopeLabel(workflow: Pick<ClaimWorkflowRow, "claimWorkflowNo">): string {
    const trimmed = String(workflow.claimWorkflowNo ?? "").trim();
    return trimmed.length > 0 ? trimmed : "Pengajuan utama";
}

export type DefaultSubmissionDraft = Omit<ClaimSubmissionRow, "id" | "claimWorkflowId">;

/**
 * Bentuk satu draft `claim_submission` dari row `claim_workflow` lama.
 * Lihat dokumentasi lengkap di header file.
 */
export function buildDefaultSubmissionFromWorkflow(
    workflow: ClaimWorkflowRow,
    now: Date,
): DefaultSubmissionDraft {
    return {
        noClaim: workflow.noClaim ?? null,
        noClaimAssignedAt: workflow.noClaimAssignedAt ?? null,
        noClaimAssignedBy: workflow.noClaimAssignedBy ?? null,
        scope: claimSubmissionScopes.perPengajuan,
        scopeLabel: getDefaultSubmissionScopeLabel(workflow),
        status: workflow.status,
        totalDpp: Number(workflow.totalDpp || 0),
        totalPpn: Number(workflow.totalPpn || 0),
        totalPph: Number(workflow.totalPph || 0),
        totalClaim: Number(workflow.totalClaim || 0),
        totalPaid: Number(workflow.totalPaid || 0),
        remainingAmount: Number(workflow.remainingAmount || 0),
        submittedToPrincipalAt: workflow.submittedToPrincipalAt ?? null,
        claimLetterPdfPath: workflow.claimLetterPdfPath ?? null,
        claimLetterGeneratedAt: workflow.claimLetterGeneratedAt ?? null,
        claimLetterGeneratedBy: workflow.claimLetterGeneratedBy ?? null,
        summaryPdfPath: workflow.summaryPdfPath ?? null,
        summaryGeneratedAt: workflow.summaryGeneratedAt ?? null,
        summaryGeneratedBy: workflow.summaryGeneratedBy ?? null,
        receiptPdfPath: workflow.receiptPdfPath ?? null,
        receiptGeneratedAt: workflow.receiptGeneratedAt ?? null,
        receiptGeneratedBy: workflow.receiptGeneratedBy ?? null,
        closedAt: workflow.closedAt ?? null,
        closedBy: workflow.closedBy ?? null,
        closeNote: workflow.closeNote ?? null,
        createdBy: workflow.createdBy ?? null,
        createdAt: workflow.createdAt ?? now,
        updatedAt: now,
    };
}

// =============================================================================
// DB-aware helpers (R7b)
// =============================================================================

/**
 * Phase R7 BLOCKER FIX: Helper untuk menentukan apakah submission adalah
 * submission aktif (punya data meaningful) atau submission kosong yang harus
 * diabaikan dari count dan gate.
 *
 * Submission aktif adalah submission yang memenuhi salah satu:
 * - totalClaim > 0, ATAU
 * - itemCount > 0 (punya minimal 1 item assigned)
 *
 * Default submission kosong (scope=per_pengajuan, 0 item, 0 total) yang
 * dibuat saat create workflow dari OFF akan ter-filter sebagai non-aktif.
 *
 * Usage:
 * - Mark Ready gate: validasi hanya submission aktif
 * - GET detail route: count hanya submission aktif
 * - UI display: tampilkan hanya submission aktif
 */
export function isActiveSubmission(submission: {
    totalClaim?: number | string | null;
    itemCount?: number | null;
}): boolean {
    const totalClaim = Number(submission.totalClaim || 0);
    const itemCount = Number(submission.itemCount || 0);
    return totalClaim > 0 || itemCount > 0;
}

/**
 * Ambil daftar submission aktif untuk workflow. Filter submission kosong.
 * Dipakai oleh gate dan count yang harus abaikan default submission kosong.
 */
export async function getActiveSubmissions(
    workflowId: string,
    executor: DbExecutor = db,
): Promise<Array<ClaimSubmissionRow & { itemCount: number }>> {
    // Fetch submissions dengan item count via subquery
    const submissions = await executor
        .select({
            submission: claimSubmission,
            itemCount: sql<number>`(
                SELECT COUNT(*)
                FROM ${claimWorkflowItem}
                WHERE ${claimWorkflowItem.claimSubmissionId} = ${claimSubmission.id}
            )`.as("itemCount"),
        })
        .from(claimSubmission)
        .where(eq(claimSubmission.claimWorkflowId, workflowId))
        .orderBy(asc(claimSubmission.createdAt));

    // Filter hanya submission aktif
    return submissions
        .map((row) => ({
            ...row.submission,
            itemCount: Number(row.itemCount || 0),
        }))
        .filter(isActiveSubmission);
}

/**
 * Ambil semua submission untuk satu workflow, urut createdAt asc.
 * Tidak mutate apapun. Bisa dipanggil di luar atau di dalam transaksi.
 */
export async function getWorkflowSubmissions(
    workflowId: string,
    executor: DbExecutor = db,
): Promise<ClaimSubmissionRow[]> {
    return executor
        .select()
        .from(claimSubmission)
        .where(eq(claimSubmission.claimWorkflowId, workflowId))
        .orderBy(asc(claimSubmission.createdAt));
}

/**
 * Pastikan workflow punya minimal satu submission. Idempotent.
 *
 * Bila belum ada submission sama sekali (mis. workflow baru dibuat dari
 * OFF tanpa migration), buat default submission dari field workflow,
 * lalu link semua item + payment yang masih NULL ke submission tersebut.
 *
 * Bila sudah ada submission, return submission tertua (paling awal
 * dibuat) tanpa side effect tambahan.
 *
 * Selalu dijalankan dalam executor (db atau tx). Caller bertanggung jawab
 * atas transaksi luar.
 */
export async function getOrCreateDefaultSubmission(
    executor: DbExecutor,
    workflow: ClaimWorkflowRow,
    now: Date = new Date(),
): Promise<ClaimSubmissionRow> {
    const existing = await getWorkflowSubmissions(workflow.id, executor);
    if (existing.length > 0) return existing[0];

    const draft = buildDefaultSubmissionFromWorkflow(workflow, now);
    const id = randomUUID();
    await executor.insert(claimSubmission).values({
        id,
        claimWorkflowId: workflow.id,
        ...draft,
    });

    // Link item + payment yang masih NULL. Aman karena indempotent
    // (filter `IS NULL`).
    await executor
        .update(claimWorkflowItem)
        .set({ claimSubmissionId: id, updatedAt: now })
        .where(
            and(
                eq(claimWorkflowItem.claimWorkflowId, workflow.id),
                isNull(claimWorkflowItem.claimSubmissionId),
            ),
        );
    await executor
        .update(claimPayment)
        .set({ claimSubmissionId: id, updatedAt: now })
        .where(
            and(
                eq(claimPayment.claimWorkflowId, workflow.id),
                isNull(claimPayment.claimSubmissionId),
            ),
        );

    const [created] = await executor
        .select()
        .from(claimSubmission)
        .where(eq(claimSubmission.id, id));
    return created;
}

/**
 * Recalc totals satu submission dari `claim_workflow_item` yang
 * ditugaskan ke submission tersebut. Update kolom totals + updatedAt.
 *
 * `totalPaid` dan `remainingAmount` di submission TIDAK di-recalc di
 * sini karena payment masih workflow-level di R7b. R7d akan menangani
 * payment per submission. Untuk R7b, totalPaid submission dipertahankan
 * apa adanya (default 0 untuk submission baru).
 */
export async function recalcSubmissionTotals(
    executor: DbExecutor,
    submissionId: string,
    now: Date = new Date(),
): Promise<{
    totalDpp: number;
    totalPpn: number;
    totalPph: number;
    totalClaim: number;
    itemCount: number;
}> {
    const items = await executor
        .select({
            dpp: claimWorkflowItem.dpp,
            ppnAmount: claimWorkflowItem.ppnAmount,
            pphAmount: claimWorkflowItem.pphAmount,
            nilaiKlaim: claimWorkflowItem.nilaiKlaim,
        })
        .from(claimWorkflowItem)
        .where(eq(claimWorkflowItem.claimSubmissionId, submissionId));

    const totals = items.reduce(
        (acc, row) => ({
            totalDpp: acc.totalDpp + Number(row.dpp || 0),
            totalPpn: acc.totalPpn + Number(row.ppnAmount || 0),
            totalPph: acc.totalPph + Number(row.pphAmount || 0),
            totalClaim: acc.totalClaim + Number(row.nilaiKlaim || 0),
        }),
        { totalDpp: 0, totalPpn: 0, totalPph: 0, totalClaim: 0 },
    );

    await executor
        .update(claimSubmission)
        .set({
            totalDpp: totals.totalDpp,
            totalPpn: totals.totalPpn,
            totalPph: totals.totalPph,
            totalClaim: totals.totalClaim,
            // remainingAmount mengikuti totalClaim - totalPaid (totalPaid
            // submission belum dipakai sampai R7d, default 0). Tetap
            // di-recalc supaya konsisten.
            remainingAmount: calculateRemainingAmount(totals.totalClaim, 0),
            updatedAt: now,
        })
        .where(eq(claimSubmission.id, submissionId));

    return { ...totals, itemCount: items.length };
}

/**
 * Recalc cache totals di `claim_workflow` dari sum semua submissions.
 *
 * Untuk R7b:
 * - totalDpp/totalPpn/totalPph/totalClaim → sum submissions.
 * - totalPaid/remainingAmount → tetap pakai workflow level (cache lama)
 *   karena payment masih workflow-level. Akan diganti di R7d.
 * - aggregateStatus → mirror dari workflow.status saat ini. Akan
 *   menjadi derived (aggregate dari submission status) di R7e.
 *
 * Tidak mengubah `claim_workflow.status` supaya behavior route existing
 * (mark_ready, submit_to_principal, payment, close) tidak berubah.
 */
export async function recalcWorkflowAggregateFromSubmissions(
    executor: DbExecutor,
    workflowId: string,
    now: Date = new Date(),
): Promise<{
    totalDpp: number;
    totalPpn: number;
    totalPph: number;
    totalClaim: number;
    submissionCount: number;
}> {
    const [aggregate] = await executor
        .select({
            totalDpp: sql<number>`COALESCE(SUM(${claimSubmission.totalDpp}), 0)`,
            totalPpn: sql<number>`COALESCE(SUM(${claimSubmission.totalPpn}), 0)`,
            totalPph: sql<number>`COALESCE(SUM(${claimSubmission.totalPph}), 0)`,
            totalClaim: sql<number>`COALESCE(SUM(${claimSubmission.totalClaim}), 0)`,
            submissionCount: sql<number>`COUNT(*)`,
        })
        .from(claimSubmission)
        .where(eq(claimSubmission.claimWorkflowId, workflowId));

    const totalDpp = Number(aggregate?.totalDpp || 0);
    const totalPpn = Number(aggregate?.totalPpn || 0);
    const totalPph = Number(aggregate?.totalPph || 0);
    const totalClaim = Number(aggregate?.totalClaim || 0);
    const submissionCount = Number(aggregate?.submissionCount || 0);

    // Ambil totalPaid + status existing untuk mempertahankan
    // remainingAmount (workflow level, R3) dan mirror aggregate_status.
    const [workflow] = await executor
        .select({
            totalPaid: claimWorkflow.totalPaid,
            status: claimWorkflow.status,
        })
        .from(claimWorkflow)
        .where(eq(claimWorkflow.id, workflowId));
    const totalPaid = Number(workflow?.totalPaid || 0);

    await executor
        .update(claimWorkflow)
        .set({
            totalDpp,
            totalPpn,
            totalPph,
            totalClaim,
            // remainingAmount tetap pakai formula R3 dengan totalPaid
            // existing supaya kompat dengan route payment yang akan
            // tetap menulis cache ini sampai R7d.
            remainingAmount: calculateRemainingAmount(totalClaim, totalPaid),
            aggregateStatus: workflow?.status ?? null,
            updatedAt: now,
        })
        .where(eq(claimWorkflow.id, workflowId));

    return { totalDpp, totalPpn, totalPph, totalClaim, submissionCount };
}

/**
 * Pastikan submission tertentu memang milik workflow yang dimaksud.
 * Throw error dengan kode standar bila tidak. Caller route diharapkan
 * meng-catch dan map ke 404/409.
 */
export async function assertSubmissionBelongsToWorkflow(
    submissionId: string,
    workflowId: string,
    executor: DbExecutor = db,
): Promise<ClaimSubmissionRow> {
    const [row] = await executor
        .select()
        .from(claimSubmission)
        .where(eq(claimSubmission.id, submissionId));
    if (!row) {
        throw Object.assign(new Error("Claim Submission not found"), {
            code: "CLAIM_SUBMISSION_NOT_FOUND",
            status: 404,
        });
    }
    if (row.claimWorkflowId !== workflowId) {
        throw Object.assign(new Error("Claim Submission tidak milik workflow ini."), {
            code: "CLAIM_SUBMISSION_WRONG_WORKFLOW",
            status: 409,
        });
    }
    return row;
}

/**
 * Cek apakah workflow + submission saat ini editable untuk operasi R7b
 * (create submission, assign item, edit scope/noClaim). Editable bila
 * workflow status `Draft` atau `Need Revision`. Lebih ketat dari window
 * existing untuk menghindari interaksi dengan dokumen/payment.
 */
export function isSubmissionEditableWorkflowStatus(status: string): boolean {
    return (
        status === claimSubmissionStatuses.draft ||
        status === claimSubmissionStatuses.needRevision
    );
}

// =============================================================================
// Payment helpers (R7d)
// =============================================================================

/**
 * Status submission yang menerima payment baru / void payment. Sama dengan
 * status workflow R3 (Submitted to Principal / Partially Paid). Closed
 * tidak boleh menerima payment, Paid juga tidak (sudah lunas).
 */
export function isSubmissionPaymentAllowedStatus(status: string): boolean {
    return (
        status === claimSubmissionStatuses.submittedToPrincipal ||
        status === claimSubmissionStatuses.partiallyPaid
    );
}

/**
 * Status yang boleh ter-derive dari payment recalc. Dipakai oleh route
 * untuk decide apakah mau menulis ulang status atau preserve.
 */
export function isSubmissionPaymentDerivedStatus(status: string): boolean {
    return (
        status === claimSubmissionStatuses.submittedToPrincipal ||
        status === claimSubmissionStatuses.partiallyPaid ||
        status === claimSubmissionStatuses.paid
    );
}

/**
 * Recalc totalPaid / remainingAmount / status untuk satu submission dari
 * `claim_payment` aktif (voidedAt IS NULL) yang ter-link ke
 * submission tersebut.
 *
 * Update kolom `claim_submission.totalPaid`, `remainingAmount`, dan
 * (opsional, bila currentStatus berada di derived window) `status`.
 *
 * Return: totals + nextStatus + previousStatus.
 *
 * Tidak menyentuh payment row baru — caller bertanggung jawab insert /
 * update payment sebelum memanggil helper ini.
 */
export async function recalcSubmissionPaymentTotals(
    executor: DbExecutor,
    submissionId: string,
    now: Date = new Date(),
): Promise<{
    totalClaim: number;
    totalPaid: number;
    remainingAmount: number;
    derivedStatus: string;
    previousStatus: string;
    nextStatus: string;
    statusChanged: boolean;
    activePaymentCount: number;
    voidedPaymentCount: number;
}> {
    const [submission] = await executor
        .select()
        .from(claimSubmission)
        .where(eq(claimSubmission.id, submissionId));
    if (!submission) {
        throw Object.assign(new Error("Claim Submission not found"), {
            code: "CLAIM_SUBMISSION_NOT_FOUND",
            status: 404,
        });
    }
    const totalClaim = Number(submission.totalClaim || 0);
    const payments = await executor
        .select({
            paymentAmount: claimPayment.paymentAmount,
            voidedAt: claimPayment.voidedAt,
        })
        .from(claimPayment)
        .where(eq(claimPayment.claimSubmissionId, submissionId));
    const totals = recalcPaymentTotals(totalClaim, payments);
    const previousStatus = submission.status;
    // Hanya overwrite status bila currentStatus ada di derived window.
    // Ini menjaga workflow yang masih Draft / Ready / Closed dari
    // perubahan status liar via payment route.
    const nextStatus = isSubmissionPaymentDerivedStatus(previousStatus)
        ? totals.derivedStatus
        : previousStatus;

    const activePaymentCount = payments.filter((p) => p.voidedAt === null).length;
    const voidedPaymentCount = payments.length - activePaymentCount;

    await executor
        .update(claimSubmission)
        .set({
            totalPaid: totals.totalPaid,
            remainingAmount: totals.remainingAmount,
            status: nextStatus,
            updatedAt: now,
        })
        .where(eq(claimSubmission.id, submissionId));

    return {
        totalClaim,
        totalPaid: totals.totalPaid,
        remainingAmount: totals.remainingAmount,
        derivedStatus: totals.derivedStatus,
        previousStatus,
        nextStatus,
        statusChanged: nextStatus !== previousStatus,
        activePaymentCount,
        voidedPaymentCount,
    };
}

/**
 * Derive workflow aggregate status dari semua submissions.
 *
 * Aturan (konservatif):
 *   - 0 submission        → fallback ke current workflow status (caller decide).
 *   - all submissions Closed                       → Closed
 *   - all submissions in {Paid, Closed} dan ≥1 Paid → Paid
 *   - any submission Partially Paid                → Partially Paid
 *   - any submission Submitted to Principal/Paid   → Submitted to Principal
 *     (workflow tidak Paid karena ada submission belum lunas)
 *   - all submissions Ready to Submit              → Ready to Submit
 *   - any submission Need Revision                 → Need Revision
 *   - else → Draft
 *
 * Workflow tidak boleh `Closed` kecuali semua submission Closed.
 * Workflow tidak boleh `Paid` kalau ada submission yang belum Paid/Closed.
 */
export function deriveWorkflowAggregateStatus(
    submissions: ReadonlyArray<Pick<ClaimSubmissionRow, "status">>,
    fallback: string = claimWorkflowStatuses.draft,
): string {
    if (submissions.length === 0) return fallback;
    const statuses = submissions.map((s) => s.status);
    const allClosed = statuses.every((s) => s === claimWorkflowStatuses.closed);
    if (allClosed) return claimWorkflowStatuses.closed;
    const allPaidOrClosed = statuses.every(
        (s) => s === claimWorkflowStatuses.paid || s === claimWorkflowStatuses.closed,
    );
    const hasPaid = statuses.includes(claimWorkflowStatuses.paid);
    if (allPaidOrClosed && hasPaid) return claimWorkflowStatuses.paid;
    if (statuses.includes(claimWorkflowStatuses.partiallyPaid)) {
        return claimWorkflowStatuses.partiallyPaid;
    }
    if (
        statuses.includes(claimWorkflowStatuses.submittedToPrincipal) ||
        statuses.includes(claimWorkflowStatuses.paid)
    ) {
        return claimWorkflowStatuses.submittedToPrincipal;
    }
    if (statuses.every((s) => s === claimWorkflowStatuses.readyToSubmit)) {
        return claimWorkflowStatuses.readyToSubmit;
    }
    if (statuses.includes(claimWorkflowStatuses.needRevision)) {
        return claimWorkflowStatuses.needRevision;
    }
    return claimWorkflowStatuses.draft;
}

/**
 * Recalc cache workflow totals dari payments + recalc aggregate status
 * dari submissions. Phase R7d-onwards: workflow.totalPaid /
 * remainingAmount / status di-derive dari sum submissions.
 *
 * Helper ini menggantikan `recalcWorkflowAggregateFromSubmissions` saat
 * payment recalc juga dibutuhkan. Behavior:
 *   - totalDpp/Ppn/Pph/Claim → sum submissions.
 *   - totalPaid → sum submission.totalPaid.
 *   - remainingAmount = max(totalClaim - totalPaid, 0).
 *   - aggregateStatus → derive dari submissions.
 *   - status workflow → derive dari submissions HANYA bila berada di
 *     payment-derived window atau Closed (jangan ubah Draft → Paid).
 *
 * Tidak menyentuh `submitted_to_principal_at` workflow.
 */
export async function recalcWorkflowAggregateWithPayments(
    executor: DbExecutor,
    workflowId: string,
    now: Date = new Date(),
): Promise<{
    totalDpp: number;
    totalPpn: number;
    totalPph: number;
    totalClaim: number;
    totalPaid: number;
    remainingAmount: number;
    submissionCount: number;
    aggregateStatus: string;
    workflowStatus: string;
    workflowStatusChanged: boolean;
}> {
    const submissions = await executor
        .select({
            id: claimSubmission.id,
            status: claimSubmission.status,
            totalDpp: claimSubmission.totalDpp,
            totalPpn: claimSubmission.totalPpn,
            totalPph: claimSubmission.totalPph,
            totalClaim: claimSubmission.totalClaim,
            totalPaid: claimSubmission.totalPaid,
        })
        .from(claimSubmission)
        .where(eq(claimSubmission.claimWorkflowId, workflowId));

    const totalDpp = submissions.reduce((acc, s) => acc + Number(s.totalDpp || 0), 0);
    const totalPpn = submissions.reduce((acc, s) => acc + Number(s.totalPpn || 0), 0);
    const totalPph = submissions.reduce((acc, s) => acc + Number(s.totalPph || 0), 0);
    const totalClaim = submissions.reduce((acc, s) => acc + Number(s.totalClaim || 0), 0);
    const totalPaid = submissions.reduce((acc, s) => acc + Number(s.totalPaid || 0), 0);
    const remainingAmount = calculateRemainingAmount(totalClaim, totalPaid);
    const aggregateStatus = deriveWorkflowAggregateStatus(submissions);

    const [workflow] = await executor
        .select({ status: claimWorkflow.status })
        .from(claimWorkflow)
        .where(eq(claimWorkflow.id, workflowId));
    const previousStatus = workflow?.status ?? claimWorkflowStatuses.draft;

    // Hanya update workflow.status bila currentStatus sudah di derived
    // window (Submitted to Principal / Partially Paid / Paid / Closed).
    // Workflow Draft / Ready to Submit / Need Revision biarkan untuk
    // dikontrol oleh status route — payment recalc tidak boleh mendorong
    // workflow ke Paid bila itemnya belum Submitted.
    const inDerivedWindow =
        previousStatus === claimWorkflowStatuses.submittedToPrincipal ||
        previousStatus === claimWorkflowStatuses.partiallyPaid ||
        previousStatus === claimWorkflowStatuses.paid;
    const nextStatus = inDerivedWindow ? aggregateStatus : previousStatus;

    await executor
        .update(claimWorkflow)
        .set({
            totalDpp,
            totalPpn,
            totalPph,
            totalClaim,
            totalPaid,
            remainingAmount,
            aggregateStatus,
            status: nextStatus,
            updatedAt: now,
        })
        .where(eq(claimWorkflow.id, workflowId));

    return {
        totalDpp,
        totalPpn,
        totalPph,
        totalClaim,
        totalPaid,
        remainingAmount,
        submissionCount: submissions.length,
        aggregateStatus,
        workflowStatus: nextStatus,
        workflowStatusChanged: nextStatus !== previousStatus,
    };
}

/**
 * Cek apakah workflow ini "single-submission". Dipakai oleh route legacy
 * payment / close untuk decide apakah proxy ke default submission atau
 * 409. Kembalikan submissionId tunggal bila ada, atau null bila multi /
 * tidak ada.
 */
export async function getSingleSubmissionId(
    executor: DbExecutor,
    workflowId: string,
): Promise<string | null> {
    const rows = await executor
        .select({ id: claimSubmission.id })
        .from(claimSubmission)
        .where(eq(claimSubmission.claimWorkflowId, workflowId));
    if (rows.length !== 1) return null;
    return rows[0].id;
}
