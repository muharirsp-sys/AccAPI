import { bebanItem, offPaymentMethods } from "./constants";
import type { OffItemRow, OffPaymentRow } from "./types";

export type OffCaraBayar = (typeof offPaymentMethods)[number];

/** Pesan galat cara bayar; route membandingkan teks ini untuk menjawab 400. */
export const PESAN_CARA_BAYAR = "Jenis pembayaran hanya boleh Transfer, Tunai, atau Potong Tagihan.";

function kenali(value: unknown): OffCaraBayar | null {
    const normalized = String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
    if (normalized === "transfer") return "Transfer";
    if (normalized === "tunai" || normalized === "cash") return "Tunai";
    if (normalized === "potong tagihan") return "Potong Tagihan";
    return null;
}

/** Untuk tampilan: nilai dikenal dinormalisasi, selain itu apa adanya ("-" bila kosong). */
export function normalizePaymentMethod(value: string | null | undefined) {
    return kenali(value) ?? String(value || "-");
}

/** Untuk penyimpanan: melempar PESAN_CARA_BAYAR bila bukan Transfer/Tunai/Potong Tagihan. */
export function normalizeOffPaymentMethod(value: unknown): OffCaraBayar {
    const method = kenali(value);
    if (!method) throw new Error(PESAN_CARA_BAYAR);
    return method;
}

export function isOffPaymentMethod(value: unknown) {
    const normalized = String(value || "").trim();
    return offPaymentMethods.some((method) => method === normalized);
}

export type OffRingkasBayar = { total: number; transfer: number; tunai: number; potongTagihan: number; bebanDistributor: number };

/** Ringkasan per cara bayar + total item DM (dana principal di distributor, tidak diklaim). Nominal boleh angka atau teks yang sudah diurai pemanggil. */
export function computeOffPaymentSummary(items: Array<Pick<OffItemRow, "nominal" | "caraBayar"> & { beban?: string | null }>): OffRingkasBayar {
    return items.reduce(
        (summary, item) => {
            const nominal = Number(item.nominal || 0);
            summary.total += nominal;
            const method = kenali(item.caraBayar);
            if (method === "Transfer") summary.transfer += nominal;
            if (method === "Tunai") summary.tunai += nominal;
            if (method === "Potong Tagihan") summary.potongTagihan += nominal;
            if (bebanItem(item.beban) === "DM") summary.bebanDistributor += nominal;
            return summary;
        },
        { total: 0, transfer: 0, tunai: 0, potongTagihan: 0, bebanDistributor: 0 }
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
