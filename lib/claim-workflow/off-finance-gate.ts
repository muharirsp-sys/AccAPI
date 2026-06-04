/*
 * Tujuan: Read-only helper untuk mengecek apakah OFF Finance sudah Paid
 *         sebelum No Claim boleh di-generate/assign di Claim Workflow.
 * Caller: Route no-claim (legacy) dan submission PATCH (R7b).
 * Dependensi: drizzle-orm, db schema, off-program-control payments helper.
 * Side Effects: Tidak ada — hanya read.
 *
 * Rule bisnis:
 *   - Claim Workflow tetap boleh dibuat setelah OFF `omStatus === "Approved"`.
 *   - Generate/save No Claim hanya boleh jika OFF Finance sudah Paid.
 *   - Paid = `off_batch.financeStatus === "Paid"` + aggregate off_payment
 *     fully paid (totalPaid >= totalNominal, totalNominal > 0).
 *   - Ini payment OFF internal, BUKAN claim payment principal.
 */
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { offBatch, offPayment } from "@/db/schema";
import { offFinanceStatuses } from "@/lib/off-program-control/constants";

type DbExecutor = Pick<typeof db, "select">;

export type OffFinanceGateResult = {
    isPaid: boolean;
    financeStatus: string;
    offStatus: string;
    totalNominal: number;
    totalPaid: number;
    isFullyPaid: boolean;
    reason: string | null;
};

/**
 * Cek apakah OFF batch terkait sudah fully paid oleh Finance internal.
 * Return objek gate yang bisa dipakai oleh route untuk memutuskan apakah
 * No Claim boleh di-assign.
 *
 * @param executor — `db` global atau `tx` dalam transaksi.
 * @param offBatchId — ID OFF batch yang terkait dengan Claim Workflow.
 */
export async function getOffFinanceGateForNoClaim(
    executor: DbExecutor,
    offBatchId: string,
): Promise<OffFinanceGateResult> {
    // 1. Baca OFF batch header
    const [batch] = await executor
        .select({
            id: offBatch.id,
            status: offBatch.status,
            financeStatus: offBatch.financeStatus,
            totalNominal: offBatch.totalNominal,
        })
        .from(offBatch)
        .where(eq(offBatch.id, offBatchId));

    if (!batch) {
        return {
            isPaid: false,
            financeStatus: "Unknown",
            offStatus: "Unknown",
            totalNominal: 0,
            totalPaid: 0,
            isFullyPaid: false,
            reason: "OFF Batch tidak ditemukan.",
        };
    }

    // 2. Baca semua off_payment untuk batch ini
    const payments = await executor
        .select({
            id: offPayment.id,
            paidAmount: offPayment.paidAmount,
        })
        .from(offPayment)
        .where(eq(offPayment.batchId, offBatchId));

    // 3. Hitung summary — computeOffFinancePaymentSummary hanya membaca
    //    `paidAmount` dari setiap item, jadi kita compute inline supaya
    //    tidak perlu fetch kolom penuh.
    const totalNominal = Number(batch.totalNominal || 0);
    const totalPaid = payments.reduce((sum, p) => sum + Number(p.paidAmount || 0), 0);
    const remainingAmount = Math.max(0, totalNominal - totalPaid);
    const isFullyPaid = totalPaid === totalNominal && totalNominal > 0;

    // 4. Gate logic: financeStatus === "Paid" DAN aggregate fully paid
    const financeStatusIsPaid = batch.financeStatus === offFinanceStatuses.paid;
    const isPaid = financeStatusIsPaid && isFullyPaid;

    let reason: string | null = null;
    if (!isPaid) {
        if (!financeStatusIsPaid) {
            reason = `Menunggu validasi keuangan OFF Program. No Claim baru bisa dibuat setelah Finance OFF Paid. Status saat ini: ${batch.financeStatus}.`;
        } else if (!isFullyPaid) {
            reason = `Finance status Paid tetapi total pembayaran belum sesuai total nominal (${totalPaid.toLocaleString("id-ID")} / ${totalNominal.toLocaleString("id-ID")}). No Claim baru bisa dibuat setelah seluruh nominal terbayar.`;
        }
    }

    return {
        isPaid,
        financeStatus: batch.financeStatus,
        offStatus: batch.status,
        totalNominal,
        totalPaid,
        isFullyPaid,
        reason,
    };
}
