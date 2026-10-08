/*
 * Tujuan: Helper murni layar Rekonsiliasi (dipindah dari app/(dashboard)/reconciliation/page.tsx saat migrasi Fiori S3):
 *   label status, kalimat penyebab selisih, lembar ekspor XLSX. Perilaku sama dengan sebelumnya.
 * Caller: app/(dashboard)/reconciliation/Rekonsiliasi.tsx, tests.
 * Dependensi: tipe hasil sales-reconciliation / return-reconciliation.
 * Main Functions: statusLabel, causeLines, returnCauseLines, statusTone, exportSheets, fileSize, SALES_STATUSES, RETURN_STATUSES.
 * Side Effects: Tidak ada.
 */
import type { Tone } from "@/components/fiori/core";
import type { ReconciliationResult, ReconciliationStatus } from "@/lib/off-program-control/sales-reconciliation";
import type { ReturnReconciliationResult, ReturnStatus } from "@/lib/off-program-control/return-reconciliation";

export type Division = "FAKTUR" | "PEMBELIAN" | "RETURN";
export type UiStatus = ReconciliationStatus | ReturnStatus;

export const SALES_STATUSES: ReconciliationStatus[] = [
    "MATCH", "QTY_MISMATCH", "VALUE_MISMATCH", "QTY_AND_VALUE_MISMATCH", "MISSING_INTERNAL", "MISSING_PRINCIPAL",
    "UNMAPPED_SKU", "UNIT_CONVERSION_ERROR", "INVALID_DATA",
];
export const RETURN_STATUSES: ReturnStatus[] = [
    "MATCH", "QTY_MISMATCH", "VALUE_MISMATCH", "QTY_AND_VALUE_MISMATCH", "MISSING_ACCURATE", "MISSING_PRINCIPAL", "UNMAPPED", "INVALID_DATA",
];

const FIXED_LABEL: Partial<Record<UiStatus, string>> = {
    MATCH: "Cocok", QTY_MISMATCH: "Selisih jumlah", VALUE_MISMATCH: "Selisih nilai", QTY_AND_VALUE_MISMATCH: "Selisih jumlah dan nilai",
    MISSING_INTERNAL: "Data Accurate tidak ditemukan", INVALID_DATA: "Data tidak valid",
};
const AMOUNT_LABEL = { gross: "Nilai jual", discount: "Diskon", dpp: "DPP", tax: "Pajak", net: "Nilai bersih" } as const;

export const number = new Intl.NumberFormat("id-ID", { maximumFractionDigits: 2 });
export const currency = new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 2 });
const money = (value: number) => `Rp${number.format(value)}`;
const direction = (difference: number, formatted: string) => `Accurate ${difference < 0 ? "kurang" : "lebih"} ${formatted}`;

export function statusLabel(status: UiStatus, principal: string): string {
    if (status === "MISSING_ACCURATE") return "Data Accurate tidak ditemukan";
    if (status === "MISSING_PRINCIPAL") return `Data ${principal} tidak ditemukan`;
    if (status === "UNMAPPED_SKU" || status === "UNMAPPED") return `SKU ${principal} belum dipetakan`;
    if (status === "UNIT_CONVERSION_ERROR") return "Konversi satuan gagal";
    return FIXED_LABEL[status] ?? status;
}

export function statusTone(status: UiStatus): Tone {
    if (status === "MATCH") return "pos";
    if (status === "QTY_MISMATCH" || status === "VALUE_MISMATCH" || status === "QTY_AND_VALUE_MISMATCH") return "warn";
    return "neg";
}

export function causeLines(row: ReconciliationResult, principal: string): string[] {
    if (row.status === "MATCH") return ["Tidak ada selisih."];
    if (row.status === "MISSING_INTERNAL") return ["Data tidak ditemukan di Accurate."];
    if (row.status === "MISSING_PRINCIPAL") return [`Data tidak ditemukan di ${principal}.`];
    if (row.status === "UNMAPPED_SKU") return [`SKU ${principal} belum memiliki pasangan produk Accurate.`];
    if (row.status === "UNIT_CONVERSION_ERROR") return [`Konversi satuan gagal; periksa master ${principal} dan baris sumber.`];
    if (row.status === "INVALID_DATA") return ["Data tidak dapat dibandingkan; periksa format sumber."];
    const causes: string[] = [];
    if (row.quantityDifference !== 0)
        causes.push(`Jumlah: Accurate ${number.format(row.accurateQuantity)}, ${principal} ${number.format(row.principalQuantity)} — ${direction(row.quantityDifference, number.format(Math.abs(row.quantityDifference)))}`);
    for (const item of row.amountDifferences)
        causes.push(`${AMOUNT_LABEL[item.component]}: Accurate ${money(item.accurate)}, ${principal} ${money(item.kino)} — ${direction(item.difference, money(Math.abs(item.difference)))}`);
    causes.push(...row.warnings.map((w) => w === "UNMAPPED_CUSTOMER" ? `Pelanggan ${principal} belum dipetakan.` : w === "UNMAPPED_SALESMAN" ? `Salesman ${principal} belum dipetakan.` : w));
    return causes;
}

export function returnCauseLines(row: ReturnReconciliationResult, principal: string): string[] {
    if (row.status === "MATCH") return ["Tidak ada selisih."];
    if (row.status === "INVALID_DATA") return row.invalidReason ? [row.invalidReason] : row.warnings.length ? row.warnings : ["Data tidak valid."];
    const causes: string[] = [];
    if (row.status === "MISSING_ACCURATE") causes.push("Data tidak ditemukan di Accurate.");
    else if (row.status === "MISSING_PRINCIPAL") causes.push(`Data tidak ditemukan di ${principal}.`);
    else if (row.status === "UNMAPPED") {
        if (row.principalProductCode && !row.accurateProductCode) causes.push(`Produk ${row.principalProductCode} belum memiliki mapping Accurate.`);
        else if (row.accurateProductCode && !row.principalProductCode) causes.push(`Produk ${row.accurateProductCode} belum memiliki mapping ${principal}.`);
        else causes.push(`Produk Accurate belum memiliki mapping ${principal}.`);
        return causes;
    }
    if (row.quantityDifference !== 0)
        causes.push(`Qty: Accurate ${number.format(row.accurateQuantity)}, ${principal} ${number.format(row.principalQuantity)} — ${direction(row.quantityDifference, number.format(Math.abs(row.quantityDifference)))}`);
    if (Math.abs(row.dppDifference) > 1)
        causes.push(`DPP: Accurate ${money(row.accurateDpp)}, ${principal} ${money(row.principalDpp)} — ${direction(row.dppDifference, money(Math.abs(row.dppDifference)))}`);
    return causes.length ? causes : row.warnings;
}

const excelText = (value: string) => (/^[=+\-@]/.test(value) ? `'${value}` : value);

export function fileSize(bytes: number): string {
    return bytes < 1_048_576 ? `${number.format(bytes / 1024)} KB` : `${number.format(bytes / 1_048_576)} MB`;
}

/** Lembar Ringkasan + Detail untuk ekspor; kolom lengkap meski layar menyembunyikan sebagian. */
export function exportSheets(division: Division, principal: string, summary: Record<string, number>, results: Array<ReconciliationResult | ReturnReconciliationResult>) {
    const statuses: UiStatus[] = division === "FAKTUR" ? SALES_STATUSES : RETURN_STATUSES;
    const ringkasan = statuses.map((status) => ({ Status: excelText(status), Jumlah: summary[status] ?? 0 }));
    const detail = division !== "FAKTUR"
        ? (results as ReturnReconciliationResult[]).map((row) => ({
            Status: excelText(row.status),
            [division === "PEMBELIAN" ? "Dokumen Pembelian" : "Invoice"]: excelText(row.invoiceNumber),
            [division === "PEMBELIAN" ? "Supplier" : "Pelanggan"]: excelText(row.customerCode),
            "Produk Accurate": excelText(row.accurateProductCode ?? ""), [`Produk ${principal}`]: excelText(row.principalProductCode ?? ""),
            "Qty Accurate": row.accurateQuantity, [`Qty ${principal}`]: row.principalQuantity, "Selisih Qty": row.quantityDifference,
            "DPP Accurate": row.accurateDpp, [`DPP ${principal}`]: row.principalDpp, "Selisih DPP": row.dppDifference,
            "Pajak Accurate": row.accurateTax, [`Pajak ${principal}`]: row.principalTax,
            "Total Accurate": row.accurateTotal, [`Total ${principal}`]: row.principalTotal,
            "Penyebab selisih": excelText(returnCauseLines(row, principal).join("\n")),
            "Baris Accurate": row.accurateSourceRows.join(", "), [`Baris ${principal}`]: row.principalSourceRows.join(", "),
        }))
        : (results as ReconciliationResult[]).map((row) => ({
            Status: excelText(row.status), Order: excelText(row.orderNumber), "Produk Internal": excelText(row.internalProductCode),
            "Kelas Transaksi": excelText(row.transactionClass), "Qty Accurate": row.accurateQuantity, "Qty Prinsipal": row.principalQuantity,
            "Selisih Qty": row.quantityDifference, "Net Accurate": row.accurateNet, "Net Prinsipal": row.principalNet,
            "Selisih Net": row.valueDifference, Peringatan: excelText(row.warnings.join(", ")),
            "Baris Accurate": row.accurateSourceRows.join(", "), [`Baris ${principal}`]: row.principalSourceRows.join(", "),
        }));
    const prefix = division === "RETURN"
        ? principal === "SHINZUI" ? "hasil-rekonsiliasi-return-shinzui" : `rekonsiliasi-return-${principal.toLowerCase()}`
        : division === "PEMBELIAN" ? `rekonsiliasi-pembelian-${principal.toLowerCase()}` : `hasil-rekonsiliasi-${principal.toLowerCase()}`;
    return { ringkasan, detail, fileName: `${prefix}-${new Date().toISOString().slice(0, 10)}.xlsx` };
}
