import { offBatch, offBatchItem, offPayment } from "@/db/schema";

export type OffActor = {
    id: string;
    name: string;
    role: string;
};

export type OffBatchRow = typeof offBatch.$inferSelect;
export type OffItemRow = typeof offBatchItem.$inferSelect;
export type OffPaymentRow = typeof offPayment.$inferSelect;

export type OffPaymentSummary = {
    totalNominal: number;
    totalPaid: number;
    remainingAmount: number;
    isFullyPaid: boolean;
};
