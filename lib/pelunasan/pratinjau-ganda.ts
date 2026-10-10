/**
 * Tujuan: pratinjau duplikat sales-receipt sebelum eksekusi — dipindah UTUH dari W:30-45 (tipe) dan W:1903-2053
 *   `app/(dashboard)/api-wrapper/page.tsx` basis 5d6cc936 (S6e-1): duplikat dalam unggahan, kunci yang diblokir lock
 *   idempotency (pratinjau), dan kemiripan histori sales-receipt Accurate. Perilaku dikunci golden.
 * Caller: app/(dashboard)/api-wrapper/page.tsx (previewSalesReceiptDuplicates, executeBulkPayload); S6e-2.
 * Main Functions: pratinjauRiwayatAccurate, pratinjauDuplikat.
 * Side Effects: GET Accurate sales-receipt/list.do & detail.do lewat `accurateFetch` DIINJEKSI; pratinjau lock lewat
 *   `pratinjauKunci` DIINJEKSI (halaman: POST /api/idempotency/lock {preview:true}); console.error saat histori galat.
 */
import { buildSalesReceiptIdempotencyPayload } from "../sales-receipt-fingerprint.ts";
import type { Bebas } from "./sel.ts";
import type { AccurateFetch } from "./retur.ts";

export type DuplicateConflictReason = "DUPLICATE_IN_UPLOAD" | "ALREADY_SUCCESS" | "STILL_PROCESSING" | "UNKNOWN_OUTCOME" | "ACCURATE_HISTORY";

export type DuplicateReviewEntry = {
    reviewId: string;
    key: string;
    row: Record<string, unknown>;
    originalIndex: number;
    invoiceNo: string;
    customerNo: string;
    amount: number;
    transDate: string;
    paymentMethod: string;
    reasons: DuplicateConflictReason[];
    recommended: boolean;
    matchedReceiptNumbers: string[];
};

/** W:1903-1977: kunci fingerprint → nomor sales-receipt Accurate yang identik (per pelanggan + tanggal). */
export const pratinjauRiwayatAccurate = async (rows: Bebas[], accurateFetch: AccurateFetch) => {
    const rowKeys = rows.map((row: Bebas) => buildSalesReceiptIdempotencyPayload(row));
    const targetKeys = new Set(rowKeys.map((item) => item.key));
    const groupedTargets = new Map<string, { customerNo: string; transDate: string; keys: Set<string> }>();

    rowKeys.forEach((item) => {
        const groupKey = `${item.customerNo}|${item.transDate}`;
        if (!groupedTargets.has(groupKey)) {
            groupedTargets.set(groupKey, {
                customerNo: item.customerNo,
                transDate: item.transDate,
                keys: new Set<string>()
            });
        }
        groupedTargets.get(groupKey)!.keys.add(item.key);
    });

    const matchedReceiptsByKey = new Map<string, string[]>();

    try {
        for (const group of groupedTargets.values()) {
            let currentPage = 1;
            let pageCount = 1;
            const candidateReceipts: Bebas[] = [];

            do {
                const listRes = await accurateFetch('/api/sales-receipt/list.do', 'GET', {
                    fields: "id,number,customer,branch,transDate,chequeAmount,paymentMethod,description",
                    "filter.customerNo": group.customerNo,
                    "filter.transDate.op": "EQUAL",
                    "filter.transDate.val": group.transDate,
                    "sp.pageSize": 100,
                    "sp.page": currentPage
                });

                const pageRows = Array.isArray(listRes?.d) ? listRes.d : [];
                candidateReceipts.push(...pageRows);
                pageCount = Number(listRes?.sp?.pageCount || currentPage || 1);
                currentPage += 1;
            } while (currentPage <= pageCount && currentPage <= 5 && candidateReceipts.length < 300);

            for (const candidate of candidateReceipts) {
                try {
                    const detailRes = await accurateFetch('/api/sales-receipt/detail.do', 'GET', candidate?.id ? { id: candidate.id } : { number: candidate.number });
                    const detail = detailRes?.d || detailRes;
                    if (!detail) continue;

                    const detailPayload = {
                        customerNo: detail.customerNo || detail.customer?.customerNo || group.customerNo,
                        transDate: detail.transDate || group.transDate,
                        paymentMethod: detail.paymentMethod || "",
                        chequeAmount: detail.chequeAmount || 0,
                        detailInvoice: Array.isArray(detail.detailInvoice) ? detail.detailInvoice : []
                    };

                    const detailKey = buildSalesReceiptIdempotencyPayload(detailPayload).key;
                    if (!targetKeys.has(detailKey) || !group.keys.has(detailKey)) continue;

                    if (!matchedReceiptsByKey.has(detailKey)) matchedReceiptsByKey.set(detailKey, []);
                    const targetList = matchedReceiptsByKey.get(detailKey)!;
                    const receiptNumber = String(detail.number || candidate.number || "").trim();
                    if (receiptNumber && !targetList.includes(receiptNumber)) {
                        targetList.push(receiptNumber);
                    }
                } catch (detailErr) {
                    console.error("Accurate history preview detail error:", detailErr);
                }
            }
        }
    } catch (historyErr) {
        console.error("Accurate history preview skipped:", historyErr);
    }

    return matchedReceiptsByKey;
};

type KunciFingerprint = ReturnType<typeof buildSalesReceiptIdempotencyPayload>;

/**
 * W:1979-2053. `pratinjauKunci` = pratinjau lock idempotency (dipanggil DULU, seperti kode lama), wajib melempar bila
 * server menolak. Mengembalikan null bila tidak ada yang perlu ditinjau.
 */
export const pratinjauDuplikat = async <K extends string>(rows: Bebas[], routeKey: K, deps: {
    accurateFetch: AccurateFetch;
    pratinjauKunci: (keysPayload: KunciFingerprint[]) => Promise<{ blockedEntries?: Array<{ key: string; reason?: string }> }>;
}) => {
    const keysPayload = rows.map((row: Bebas) => buildSalesReceiptIdempotencyPayload(row));
    const uploadDuplicateIndexes = new Map<string, number[]>();
    keysPayload.forEach((item, index) => {
        if (!uploadDuplicateIndexes.has(item.key)) uploadDuplicateIndexes.set(item.key, []);
        uploadDuplicateIndexes.get(item.key)!.push(index);
    });

    const previewData = await deps.pratinjauKunci(keysPayload);
    const accurateHistoryMap = await pratinjauRiwayatAccurate(rows, deps.accurateFetch);

    const blockedReasonMap = new Map<string, DuplicateConflictReason[]>();
    (previewData.blockedEntries || []).forEach((entry: Bebas) => {
        const reason = entry.reason as DuplicateConflictReason;
        if (!blockedReasonMap.has(entry.key)) blockedReasonMap.set(entry.key, []);
        if (reason && !blockedReasonMap.get(entry.key)!.includes(reason)) {
            blockedReasonMap.get(entry.key)!.push(reason);
        }
    });

    const firstIndexByKey = new Map<string, number>();
    uploadDuplicateIndexes.forEach((indexes, key) => {
        firstIndexByKey.set(key, Math.min(...indexes));
    });

    const passthroughRows: Array<{ originalIndex: number; row: Bebas }> = [];
    const reviewRows: DuplicateReviewEntry[] = [];
    const selections: Record<string, boolean> = {};

    rows.forEach((row: Bebas, index: number) => {
        const keyMeta = keysPayload[index];
        const reasons: DuplicateConflictReason[] = [];
        const duplicateIndexes = uploadDuplicateIndexes.get(keyMeta.key) || [];
        if (duplicateIndexes.length > 1) reasons.push("DUPLICATE_IN_UPLOAD");
        (blockedReasonMap.get(keyMeta.key) || []).forEach((reason) => {
            if (!reasons.includes(reason)) reasons.push(reason);
        });
        const matchedReceiptNumbers = accurateHistoryMap.get(keyMeta.key) || [];
        if (matchedReceiptNumbers.length > 0 && !reasons.includes("ACCURATE_HISTORY")) {
            reasons.push("ACCURATE_HISTORY");
        }

        if (reasons.length === 0) {
            passthroughRows.push({ originalIndex: index, row });
            return;
        }

        const reviewId = `${keyMeta.key}__${index}`;
        const recommended = reasons.every((reason) => reason === "DUPLICATE_IN_UPLOAD") && firstIndexByKey.get(keyMeta.key) === index;
        reviewRows.push({
            reviewId,
            key: keyMeta.key,
            row,
            originalIndex: index,
            invoiceNo: keyMeta.invoiceNo,
            customerNo: keyMeta.customerNo,
            amount: keyMeta.amount,
            transDate: keyMeta.transDate,
            paymentMethod: keyMeta.paymentMethod,
            reasons,
            recommended,
            matchedReceiptNumbers
        });
        selections[reviewId] = recommended;
    });

    if (reviewRows.length === 0) return null;
    return { routeKey, passthroughRows, reviewRows, selections };
};
