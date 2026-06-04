import { claimWorkflowStatuses } from "./constants";
import type { ClaimAmountCalculation, ClaimPaymentRow } from "./types";

function finiteAmount(value: number): number {
    return Number.isFinite(value) ? value : 0;
}

/**
 * Hitung komponen DPP/PPN/PPh/Nilai Klaim per item.
 *
 * Strategi pembulatan:
 * - PPN dan PPh dibulatkan ke rupiah penuh terlebih dahulu agar konsisten
 *   dengan praktik faktur pajak Indonesia (no fractional rupiah).
 * - `nilaiKlaim = dpp + ppnAmount - pphAmount` dihitung dari nilai yang
 *   sudah dibulatkan, sehingga sum-of-items selalu konsisten dengan
 *   `totalDpp + totalPpn - totalPph` (tidak ada drift float).
 */
export function calculateClaimAmount(
    dpp: number,
    ppnRate: number,
    pphRate: number,
): ClaimAmountCalculation {
    const normalizedDpp = finiteAmount(dpp);
    const normalizedPpnRate = finiteAmount(ppnRate);
    const normalizedPphRate = finiteAmount(pphRate);
    const ppnAmount = Math.round(normalizedDpp * normalizedPpnRate / 100);
    const pphAmount = Math.round(normalizedDpp * normalizedPphRate / 100);

    return {
        dpp: normalizedDpp,
        ppnRate: normalizedPpnRate,
        ppnAmount,
        pphRate: normalizedPphRate,
        pphAmount,
        nilaiKlaim: normalizedDpp + ppnAmount - pphAmount,
    };
}

/**
 * Outstanding tidak boleh negatif; overpayment belum dimodelkan.
 * Phase ini sengaja melakukan clamp ke 0 agar nilai outstanding selalu
 * bermakna untuk monitoring.
 *
 * TODO: Future overpayment support harus pakai field terpisah, bukan
 * negative remaining amount. Misalnya:
 *   overpaidAmount = max(totalPaid - totalClaim, 0)
 * dan tetap menyimpan remainingAmount = max(totalClaim - totalPaid, 0).
 */
export function calculateRemainingAmount(totalClaim: number, totalPaid: number): number {
    return Math.max(finiteAmount(totalClaim) - finiteAmount(totalPaid), 0);
}

// =============================================================================
// Phase R3 — Principal Payment + Outstanding
// =============================================================================

/**
 * Active payment didefinisikan sebagai `voidedAt IS NULL`. Helper ini
 * tidak melihat status workflow; void hanya mengeluarkan baris dari
 * perhitungan totalPaid tanpa hard-delete row supaya audit trail tetap
 * lengkap.
 */
export function isActivePayment(payment: Pick<ClaimPaymentRow, "voidedAt">): boolean {
    return payment.voidedAt === null || payment.voidedAt === undefined;
}

/**
 * Sum nominal active payment. Nilai non-finite atau negatif diabaikan
 * untuk mencegah drift kalau ada payment dengan amount NaN secara tidak
 * sengaja.
 */
export function sumActivePayments(
    payments: ReadonlyArray<Pick<ClaimPaymentRow, "paymentAmount" | "voidedAt">>,
): number {
    return payments.reduce((total, row) => {
        if (!isActivePayment(row)) return total;
        const amount = finiteAmount(Number(row.paymentAmount || 0));
        if (amount <= 0) return total;
        return total + amount;
    }, 0);
}

/**
 * Derive status workflow dari totals. Tidak menyentuh DB / context.
 *
 * Rule:
 * - totalPaid <= 0  → tetap di status sumber (Submitted to Principal kalau
 *   belum ada pembayaran apapun). Caller bertanggung jawab mempertahankan
 *   status sumber jika hasil derive `submittedToPrincipal` sementara
 *   workflow masih Draft (mis. caller harus reject perubahan).
 * - 0 < totalPaid dengan remainingAmount > 0 → `Partially Paid`.
 * - remainingAmount = 0 → `Paid`.
 *
 * `Paid` harus berarti outstanding sudah nol; tidak ada toleransi Rp1.
 */
export function derivePaymentStatus(
    totalClaim: number,
    totalPaid: number,
): string {
    const claim = finiteAmount(totalClaim);
    const paid = finiteAmount(totalPaid);
    if (paid <= 0 || claim <= 0) return claimWorkflowStatuses.submittedToPrincipal;
    if (calculateRemainingAmount(claim, paid) === 0) return claimWorkflowStatuses.paid;
    return claimWorkflowStatuses.partiallyPaid;
}

/**
 * Recalc semua angka payment-related dari list payment + totalClaim.
 * Mengembalikan totalPaid (sum active), remainingAmount (clamped >= 0),
 * dan status yang akan dipakai oleh route untuk update workflow.
 */
export function recalcPaymentTotals(
    totalClaim: number,
    payments: ReadonlyArray<Pick<ClaimPaymentRow, "paymentAmount" | "voidedAt">>,
): { totalPaid: number; remainingAmount: number; derivedStatus: string } {
    const totalPaid = sumActivePayments(payments);
    return {
        totalPaid,
        remainingAmount: calculateRemainingAmount(totalClaim, totalPaid),
        derivedStatus: derivePaymentStatus(totalClaim, totalPaid),
    };
}
