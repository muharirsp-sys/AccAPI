import { offFinanceStatuses } from "./constants";
import type { OffBatchRow, OffItemRow, OffPaymentRow } from "./types";

export function canProcessFinancePayment(batch: OffBatchRow) {
  const payableStatuses = [
    offFinanceStatuses.waitingPayment,
    offFinanceStatuses.partialPaid,
    offFinanceStatuses.needCorrection,
  ] as string[];
  return (
    batch.smStatus === "Approved by SM" &&
    batch.claimStatus === "Approved" &&
    batch.omStatus === "Approved" &&
    payableStatuses.includes(batch.financeStatus)
  );
}

export function canOpenFinalClaim(batch: OffBatchRow) {
  return (
    batch.financeStatus === offFinanceStatuses.paid &&
    ["Waiting Claim Final Verification", "Incomplete Documents"].includes(
      batch.finalStatus,
    ) &&
    batch.status === "Paid"
  );
}

export function paymentsHaveProofs(payments: OffPaymentRow[]) {
  return (
    payments.length > 0 &&
    payments.every(
      (payment) => payment.paymentProofPath && payment.paymentProofName,
    )
  );
}

export function computeBatchProgress(batch: OffBatchRow): number {
  const status = batch.status;
  const financeStatus = batch.financeStatus;
  const finalStatus = batch.finalStatus;

  if (status === "Cancelled" || status === "Cancelled by OM") return 0;
  if (finalStatus === "Completed" || status === "Completed") return 100;
  if (finalStatus === "Incomplete Documents") return 90;
  if (finalStatus === "Waiting Claim Final Verification" || status === "Paid")
    return 85;
  if (financeStatus === "Partial Paid" || status === "Partial Paid") return 75;
  if (
    batch.omStatus === "Approved" &&
    ["Waiting Payment", "Not Started"].includes(financeStatus)
  )
    return 65;
  if (
    batch.claimStatus === "Approved" ||
    status === "Claim Approved" ||
    status === "Ready for OM" ||
    status === "Waiting OM"
  )
    return 50;
  if (batch.smStatus === "Approved by SM" || status === "Approved by SM")
    return 35;
  if (status === "Submitted to SM" || batch.smStatus === "Waiting Review")
    return 20;
  if (
    status === "Draft" ||
    status === "Returned by SM" ||
    status === "Returned by Claim"
  )
    return 10;
  return 10;
}

export function hasMinimalFinalChecklist(item: OffItemRow): boolean {
  return Boolean(
    item.finalKwt ||
    item.finalSkp ||
    item.finalFp ||
    item.finalPc ||
    item.finalFoto ||
    item.finalRekap ||
    item.finalOthers,
  );
}
