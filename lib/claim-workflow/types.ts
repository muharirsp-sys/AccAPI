import {
    claimAuditLog,
    claimPayment,
    claimSubmission,
    claimWorkflow,
    claimWorkflowItem,
} from "@/db/schema";
import type { OffActor } from "@/lib/off-program-control";

export type ClaimActor = OffActor;
export type ClaimWorkflowRow = typeof claimWorkflow.$inferSelect;
export type ClaimWorkflowItemRow = typeof claimWorkflowItem.$inferSelect;
export type ClaimPaymentRow = typeof claimPayment.$inferSelect;
export type ClaimAuditLogRow = typeof claimAuditLog.$inferSelect;
// Phase R7a — Multi No Claim (additive):
// Type untuk row baru `claim_submission`. Belum dipakai oleh route apapun
// di R7a; dipakai oleh helper backfill dan akan menjadi tipe primer mulai
// R7b ketika submission grouping + item assignment masuk.
export type ClaimSubmissionRow = typeof claimSubmission.$inferSelect;

export type ClaimAmountCalculation = {
    dpp: number;
    ppnRate: number;
    ppnAmount: number;
    pphRate: number;
    pphAmount: number;
    nilaiKlaim: number;
};
