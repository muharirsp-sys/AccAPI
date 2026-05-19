import { offFinanceStatuses } from "./constants";
import type { OffBatchRow, OffPaymentRow } from "./types";

export function canProcessFinancePayment(batch: OffBatchRow) {
    const payableStatuses = [
        offFinanceStatuses.waitingPayment,
        offFinanceStatuses.partialPaid,
        offFinanceStatuses.needCorrection,
    ] as string[];
    return batch.smStatus === "Approved by SM"
        && batch.claimStatus === "Approved"
        && batch.omStatus === "Approved"
        && payableStatuses.includes(batch.financeStatus);
}

export function canOpenFinalClaim(batch: OffBatchRow) {
    return batch.financeStatus === offFinanceStatuses.paid
        && batch.finalStatus === "Waiting Claim Final Verification"
        && batch.status === "Finance Paid";
}

export function paymentsHaveProofs(payments: OffPaymentRow[]) {
    return payments.length > 0 && payments.every((payment) => payment.paymentProofPath && payment.paymentProofName);
}
