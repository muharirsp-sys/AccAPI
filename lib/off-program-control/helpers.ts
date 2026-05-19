import { offPrinciples } from "./constants";
import type { OffBatchRow, OffItemRow, OffPaymentRow } from "./types";

export function getPrincipleByName(name: string) {
    return offPrinciples.find((item) => item.name === name);
}

export function getPrincipleByCode(code: string) {
    return offPrinciples.find((item) => item.code === code);
}

export function buildNoPengajuan(gelombang: string, principleCode: string, bulan: string, tahun: string) {
    return `${gelombang}/${principleCode}/${bulan}/${tahun}`;
}

export function sanitizePdfFileName(noPengajuan: string) {
    return `${noPengajuan.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "")}.pdf`;
}

export function parseCurrency(value: unknown) {
    if (typeof value === "number") return Number.isFinite(value) ? value : 0;
    const raw = String(value || "").trim();
    if (!raw) return 0;
    const cleaned = raw.replace(/[^\d,.-]/g, "");
    if (!cleaned) return 0;
    const hasComma = cleaned.includes(",");
    const hasDot = cleaned.includes(".");
    if (hasComma && hasDot) {
        const lastComma = cleaned.lastIndexOf(",");
        const lastDot = cleaned.lastIndexOf(".");
        const decimalSep = lastComma > lastDot ? "," : ".";
        const normalized = cleaned
            .replace(new RegExp(`\\${decimalSep === "," ? "." : ","}`, "g"), "")
            .replace(decimalSep, ".");
        return Number(normalized) || 0;
    }
    if (hasDot) return Number(cleaned.replace(/\./g, "")) || 0;
    if (hasComma) return Number(cleaned.replace(/,/g, "")) || 0;
    return Number(cleaned) || 0;
}

export function money(value: number | null | undefined) {
    return `Rp ${Number(value || 0).toLocaleString("id-ID")}`;
}

export function docsLabel(item: OffItemRow) {
    const docs = [
        item.kwt ? "KWT" : "",
        item.skp ? "SKP" : "",
        item.fp ? "FP" : "",
        item.pc ? "PC" : "",
        item.foto ? "Foto" : "",
        item.rekap ? "Rekap" : "",
        item.others ? "Others" : "",
    ].filter(Boolean);
    return docs.length ? docs.join(", ") : "-";
}

export function safeText(value: unknown) {
    return String(value ?? "").replace(/[^\x09\x0A\x0D\x20-\x7E]/g, "?");
}

export function fitText(value: unknown, maxChars: number) {
    const text = safeText(value);
    return text.length > maxChars ? `${text.slice(0, Math.max(0, maxChars - 1))}.` : text;
}

export function formatDateForPrint(value: string | null | undefined) {
    const raw = String(value || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw || "-";
    const [year, month, day] = raw.split("-");
    return `${day}/${month}/${year}`;
}

export function formatPeriodForPrint(value: string | null | undefined) {
    const raw = String(value || "").trim();
    if (!raw) return "-";
    const [start, end] = raw.split(" - ");
    if (start && end) return `${formatDateForPrint(start)} - ${formatDateForPrint(end)}`;
    return formatDateForPrint(raw);
}

export function publicBatch(batch: OffBatchRow) {
    return {
        ...batch,
        pdfUrl: batch.pdfPath ? `/api/off-program-control/batches/${batch.id}/pdf` : null,
    };
}

export function publicPayment(payment: OffPaymentRow) {
    const safePayment = { ...payment };
    delete (safePayment as Partial<OffPaymentRow>).paymentProofPath;
    return {
        ...safePayment,
        proofUrl: payment.paymentProofPath ? `/api/off-program-control/payments/${payment.id}/proof` : null,
    };
}
