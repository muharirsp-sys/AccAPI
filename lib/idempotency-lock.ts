/**
 * Tujuan: keputusan MURNI lock idempotency upload sales-receipt (AM-025, H05) — tanpa DB, teruji.
 * Caller: app/api/idempotency/lock/route.ts, app/api/idempotency/complete/route.ts.
 * Aturan: key yang hasilnya MUNGKIN sudah terposting ke Accurate (SUCCESS, PROCESSING aktif atau basi,
 *   UNKNOWN, status asing) diblokir dan hanya lewat konfirmasi manusia (allowLockedKeys) — tidak pernah
 *   diambil alih diam-diam. Hanya key baru dan FAILED yang dikunci ulang otomatis.
 */
export const STALE_PROCESSING_MS = 15 * 60 * 1000;

export type LockEntry = {
    key: string;
    invoiceNo?: string | null;
    customerNo?: string | null;
    amount?: number | null;
    transDate?: string | null;
    paymentMethod?: string | null;
    source?: string | null;
};
export type LockRow = LockEntry & { status: string; updatedAt?: Date | null; createdAt?: Date | null };
export type BlockReason = "DUPLICATE_IN_UPLOAD" | "ALREADY_SUCCESS" | "STILL_PROCESSING" | "UNKNOWN_OUTCOME";
export type BlockedEntry = LockEntry & { status: string; reason: BlockReason };

export function decideLock(entries: LockEntry[], existing: Map<string, LockRow>, now: Date, allowDuplicate: Set<string>, allowLocked: Set<string>) {
    const blocked: BlockedEntry[] = [];
    const toInsert: LockEntry[] = [];
    const toRetry: string[] = [];
    const seen = new Set<string>();
    const block = (item: LockEntry, ex: LockRow | undefined, status: string, reason: BlockReason) => blocked.push({
        key: item.key,
        invoiceNo: ex?.invoiceNo || item.invoiceNo,
        customerNo: ex?.customerNo || item.customerNo,
        amount: ex?.amount ?? item.amount,
        transDate: ex?.transDate || item.transDate,
        paymentMethod: ex?.paymentMethod || item.paymentMethod,
        status,
        reason,
    });

    for (const item of entries) {
        if (seen.has(item.key)) {
            if (!allowDuplicate.has(item.key)) block(item, undefined, "IN_REQUEST_DUPLICATE", "DUPLICATE_IN_UPLOAD");
            continue;
        }
        seen.add(item.key);
        const ex = existing.get(item.key);
        if (!ex) toInsert.push(item);
        else if (ex.status === "FAILED") toRetry.push(item.key);
        else if (allowLocked.has(item.key)) continue; // dikonfirmasi manusia: kirim, tanpa menulis ulang status
        else if (ex.status === "SUCCESS") block(item, ex, ex.status, "ALREADY_SUCCESS");
        else if (ex.status === "PROCESSING" && now.getTime() - (ex.updatedAt ?? ex.createdAt ?? now).getTime() <= STALE_PROCESSING_MS) {
            block(item, ex, ex.status, "STILL_PROCESSING");
        } else block(item, ex, "UNKNOWN", "UNKNOWN_OUTCOME"); // PROCESSING basi, UNKNOWN, status asing
    }
    return { blocked, toInsert, toRetry };
}

const COMPLETE_STATUSES = new Set(["SUCCESS", "FAILED", "UNKNOWN"]);
export const isCompleteStatus = (s: unknown): s is "SUCCESS" | "FAILED" | "UNKNOWN" => typeof s === "string" && COMPLETE_STATUSES.has(s);
