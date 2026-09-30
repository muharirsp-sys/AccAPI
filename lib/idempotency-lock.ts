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

/** Satu override manusia yang BENAR-BENAR dipakai (D-18): butuh finance.retry_post + alasan, dicatat audit. */
export type OverrideUse = {
    key: string;
    blockReason: BlockReason;
    previousStatus: string | null;
    action: "takeover" | "resend_success" | "allow_duplicate";
};

/** Alasan blok untuk baris tersimpan yang bukan FAILED. */
function blockReasonFor(ex: LockRow, now: Date): BlockReason {
    if (ex.status === "SUCCESS") return "ALREADY_SUCCESS";
    if (ex.status === "PROCESSING" && now.getTime() - (ex.updatedAt ?? ex.createdAt ?? now).getTime() <= STALE_PROCESSING_MS) return "STILL_PROCESSING";
    return "UNKNOWN_OUTCOME"; // PROCESSING basi, UNKNOWN, status asing
}

export function decideLock(entries: LockEntry[], existing: Map<string, LockRow>, now: Date, allowDuplicate: Set<string>, allowLocked: Set<string>) {
    const blocked: BlockedEntry[] = [];
    const toInsert: LockEntry[] = [];
    const toRetry: string[] = [];
    // Dikonfirmasi manusia & bukan SUCCESS: kunci ulang HANYA bila baris masih persis yang dilihat
    // (status + updatedAt) — dua override bersamaan tidak boleh sama-sama menang (review AM-025 F1).
    const toTakeover: Array<{ key: string; status: string; updatedAt: Date | null }> = [];
    const overrides: OverrideUse[] = [];
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
            else overrides.push({ key: item.key, blockReason: "DUPLICATE_IN_UPLOAD", previousStatus: existing.get(item.key)?.status ?? null, action: "allow_duplicate" });
            continue;
        }
        seen.add(item.key);
        const ex = existing.get(item.key);
        if (!ex) toInsert.push(item);
        else if (ex.status === "FAILED") toRetry.push(item.key);
        else if (allowLocked.has(item.key)) {
            const blockReason = blockReasonFor(ex, now);
            // SUCCESS yang dikirim ulang atas konfirmasi tetap SUCCESS (complete tak menyentuhnya).
            if (ex.status !== "SUCCESS") toTakeover.push({ key: item.key, status: ex.status, updatedAt: ex.updatedAt ?? null });
            overrides.push({ key: item.key, blockReason, previousStatus: ex.status, action: ex.status === "SUCCESS" ? "resend_success" : "takeover" });
        } else {
            const reason = blockReasonFor(ex, now);
            block(item, ex, reason === "UNKNOWN_OUTCOME" ? "UNKNOWN" : ex.status, reason);
        }
    }
    return { blocked, toInsert, toRetry, toTakeover, overrides };
}

const COMPLETE_STATUSES = new Set(["SUCCESS", "FAILED", "UNKNOWN"]);
export const isCompleteStatus = (s: unknown): s is "SUCCESS" | "FAILED" | "UNKNOWN" => typeof s === "string" && COMPLETE_STATUSES.has(s);

/**
 * AM-024 (D-18): guard /api/proxy untuk tulis sales-receipt. Baris payload lolos bila identitas dasarnya
 * (pelanggan + tanggal + himpunan faktur) cocok dengan baris PROCESSING milik lock ini — nominal sengaja
 * tidak ikut agar kiriman koreksi self-heal tetap lolos. Sisanya harus menghabiskan satu override tercatat
 * (resend_success / allow_duplicate) per baris; kembalian = fingerprint key yang perlu override.
 * ponytail: baris PROCESSING milik lock sendiri bisa dikirim berulang oleh klien yang sengaja memanggil
 * proxy berkali-kali sebelum `complete`; plafon = command server sales-receipt yang mencatat hasil per baris
 * (seperti purchase-payment AM-014).
 */
export function rowsNeedingOverride(
    rows: Record<string, unknown>[],
    lockedProcessing: Array<{ customerNo?: unknown; transDate?: unknown; invoiceNo?: unknown }>,
    fingerprint: (row: Record<string, unknown>) => { key: string; customerNo?: unknown; transDate?: unknown; invoiceNo?: unknown },
    identity: (r: { customerNo?: unknown; transDate?: unknown; invoiceNo?: unknown }) => string,
): string[] {
    const covered = new Set(lockedProcessing.map(identity));
    return rows.map(fingerprint).filter((fp) => !covered.has(identity(fp))).map((fp) => fp.key);
}
