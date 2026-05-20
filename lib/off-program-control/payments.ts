import { offPaymentMethods } from "./constants";
import type { OffItemRow, OffPaymentRow } from "./types";

export function normalizePaymentMethod(value: string | null | undefined) {
    const normalized = String(value || "").trim().toLowerCase();
    if (normalized === "transfer") return "Transfer";
    if (normalized === "tunai") return "Tunai";
    return String(value || "-");
}

export function normalizeOffPaymentMethod(value: unknown) {
    const normalized = String(value || "").trim().toLowerCase();
    if (normalized === "transfer") return "Transfer";
    if (normalized === "tunai") return "Tunai";
    throw new Error("Jenis pembayaran hanya boleh Tunai atau Transfer.");
}

export function isOffPaymentMethod(value: unknown) {
    const normalized = String(value || "").trim();
    return offPaymentMethods.some((method) => method === normalized);
}

export function computeOffPaymentSummary(items: OffItemRow[]) {
    return items.reduce(
        (summary, item) => {
            const nominal = Number(item.nominal || 0);
            summary.total += nominal;
            const method = normalizePaymentMethod(item.caraBayar);
            if (method === "Transfer") summary.transfer += nominal;
            if (method === "Tunai") summary.tunai += nominal;
            return summary;
        },
        { total: 0, transfer: 0, tunai: 0 }
    );
}

export function computeOffFinancePaymentSummary(totalNominal: number, payments: OffPaymentRow[]) {
    const totalPaid = payments.reduce((total, payment) => total + Number(payment.paidAmount || 0), 0);
    const remainingAmount = Math.max(0, Number(totalNominal || 0) - totalPaid);
    return {
        totalNominal: Number(totalNominal || 0),
        totalPaid,
        remainingAmount,
        isFullyPaid: totalPaid === Number(totalNominal || 0) && Number(totalNominal || 0) > 0,
    };
}
