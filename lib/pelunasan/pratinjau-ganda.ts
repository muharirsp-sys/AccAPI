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

/** Target pencocokan riwayat: sidik jari baris (key) + kelompok pelanggan|tanggal pencarian list.do. */
export type TargetRiwayat = { key: string; customerNo: unknown; transDate: string };
type Kelompok = { customerNo: string; transDate: string; keys: Set<string> };

function kelompokkan(targets: TargetRiwayat[]) {
    const groupedTargets = new Map<string, Kelompok>();
    targets.forEach((item) => {
        const groupKey = `${item.customerNo}|${item.transDate}`;
        if (!groupedTargets.has(groupKey)) {
            groupedTargets.set(groupKey, {
                customerNo: item.customerNo as string,
                transDate: item.transDate,
                keys: new Set<string>()
            });
        }
        groupedTargets.get(groupKey)!.keys.add(item.key);
    });
    return [...groupedTargets.values()];
}

/**
 * W:1903-1977 (satu kelompok pelanggan+tanggal): list.do (≤ 5 halaman, ≤ 300 kandidat) → detail.do per kandidat → sidik
 * jari identik dengan kunci kelompok dicatat ke `hasil`. `ketat` (server, S6e-2 owner #6, fail-closed): jawaban yang tidak
 * terbaca (bukan `s:true`, detail kosong, daftar terpotong) MELEMPAR — klien (pratinjau) tetap menelan galat detail seperti dulu.
 */
async function riwayatKelompok(group: Kelompok, accurateFetch: AccurateFetch, hasil: Map<string, string[]>, ketat: boolean) {
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
        if (ketat && !(listRes?.s === true && Array.isArray(listRes.d))) throw new Error("daftar riwayat sales-receipt tidak terbaca");

        const pageRows = Array.isArray(listRes?.d) ? listRes.d : [];
        candidateReceipts.push(...pageRows);
        pageCount = Number(listRes?.sp?.pageCount || currentPage || 1);
        currentPage += 1;
    } while (currentPage <= pageCount && currentPage <= 5 && candidateReceipts.length < 300);
    if (ketat && currentPage <= pageCount) throw new Error("riwayat sales-receipt terpotong (> 5 halaman / 300 kandidat)");

    for (const candidate of candidateReceipts) {
        try {
            const detailRes = await accurateFetch('/api/sales-receipt/detail.do', 'GET', candidate?.id ? { id: candidate.id } : { number: candidate.number });
            if (ketat && !(detailRes?.s === true && detailRes.d && typeof detailRes.d === "object" && !Array.isArray(detailRes.d))) {
                throw new Error(`detail sales-receipt ${candidate?.number ?? candidate?.id ?? "?"} tidak terbaca`);
            }
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
            if (!group.keys.has(detailKey)) continue;

            if (!hasil.has(detailKey)) hasil.set(detailKey, []);
            const targetList = hasil.get(detailKey)!;
            const receiptNumber = String(detail.number || candidate.number || "").trim();
            if (receiptNumber && !targetList.includes(receiptNumber)) {
                targetList.push(receiptNumber);
            }
        } catch (detailErr) {
            if (ketat) throw detailErr;
            console.error("Accurate history preview detail error:", detailErr);
        }
    }
}

/** W:1903-1977: kunci fingerprint → nomor sales-receipt Accurate yang identik (per pelanggan + tanggal). Pratinjau klien:
 * kelompok berurutan, galat menghentikan pencarian (hasil sebagian) — perilaku lama, dikunci golden. */
export const pratinjauRiwayatAccurate = async (rows: Bebas[], accurateFetch: AccurateFetch) => {
    const matchedReceiptsByKey = new Map<string, string[]>();
    try {
        for (const group of kelompokkan(rows.map((row: Bebas) => buildSalesReceiptIdempotencyPayload(row)))) {
            await riwayatKelompok(group, accurateFetch, matchedReceiptsByKey, false);
        }
    } catch (historyErr) {
        console.error("Accurate history preview skipped:", historyErr);
    }
    return matchedReceiptsByKey;
};

/**
 * S6e-2 (owner #6): pemeriksaan riwayat di SERVER untuk satu paket, fail-closed. Logika pencocokan = pratinjau
 * (riwayatKelompok, mode ketat). `cocok` = kunci → nomor identik; `gagal` = kunci yang kelompoknya tidak terbaca (galat,
 * jawaban bukan `s:true`, terpotong, atau melewati `batasMs`) → ditahan pemanggil. Paling banyak `konkurensi` kelompok serentak.
 * Biaya per paket: per kelompok pelanggan+tanggal 1–5 list.do + 1 detail.do per kandidat.
 */
export async function periksaRiwayatAccurate(targets: TargetRiwayat[], accurateFetch: AccurateFetch, opsi: { konkurensi?: number; batasMs?: number } = {}) {
    const kelompok = kelompokkan(targets);
    const selesai = new Map<Kelompok, Map<string, string[]>>();
    const galat = new Map<Kelompok, string>();
    let berikut = 0;
    let habis = false;
    const pekerja = async () => {
        while (!habis && berikut < kelompok.length) {
            const g = kelompok[berikut++];
            const hasil = new Map<string, string[]>();
            try {
                await riwayatKelompok(g, accurateFetch, hasil, true);
                selesai.set(g, hasil);
            } catch (e) {
                galat.set(g, e instanceof Error ? e.message : String(e));
            }
        }
    };
    let tunda: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
        Promise.all(Array.from({ length: Math.min(opsi.konkurensi ?? 4, kelompok.length) }, pekerja)),
        new Promise<void>((r) => { tunda = setTimeout(r, opsi.batasMs ?? 60_000); }),
    ]);
    clearTimeout(tunda);
    habis = true; // kelompok yang belum selesai saat batas waktu = tidak terbaca (jawaban terlambat diabaikan)
    const cocok = new Map<string, string[]>();
    const gagal = new Map<string, string>();
    for (const g of kelompok) {
        const h = selesai.get(g);
        if (h) h.forEach((v, k) => cocok.set(k, [...v]));
        else g.keys.forEach((k) => gagal.set(k, galat.get(g) ?? "batas waktu pembacaan riwayat terlampaui"));
    }
    return { cocok, gagal };
}

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
