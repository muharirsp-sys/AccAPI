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

/** Satu override manusia yang BENAR-BENAR dipakai (D-18): butuh finance.override_duplicate + alasan, dicatat audit. */
export type OverrideUse = {
    key: string;
    blockReason: BlockReason;
    previousStatus: string | null;
    action: "takeover" | "resend_success" | "allow_duplicate";
};

/** Alasan blok untuk baris tersimpan yang bukan FAILED. SENDING = proxy sudah meneruskan baris ke Accurate,
 * hasilnya belum tercatat (sedang berjalan, atau proses mati setelah kirim). */
function blockReasonFor(ex: LockRow, now: Date): BlockReason {
    if (ex.status === "SUCCESS") return "ALREADY_SUCCESS";
    if ((ex.status === "PROCESSING" || ex.status === "SENDING")
        && now.getTime() - (ex.updatedAt ?? ex.createdAt ?? now).getTime() <= STALE_PROCESSING_MS) return "STILL_PROCESSING";
    return "UNKNOWN_OUTCOME"; // PROCESSING/SENDING basi, UNKNOWN, status asing
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
 * Transisi yang boleh dilaporkan KLIEN lewat /api/idempotency/complete. Hanya menaikkan (mempersempit kiriman
 * ulang); FAILED hanya untuk baris yang BELUM pernah dikirim (PROCESSING). Baris yang sudah diteruskan proxy
 * (SENDING) hasilnya dicatat server dari jawaban Accurate — klien tidak bisa melapor FAILED palsu lalu
 * mengunci ulang otomatis (re-review d60433f2 MEDIUM skenario B).
 */
export function completeFromStatuses(status: "SUCCESS" | "FAILED" | "UNKNOWN"): string[] {
    if (status === "SUCCESS") return ["PROCESSING", "SENDING", "FAILED", "UNKNOWN"];
    if (status === "UNKNOWN") return ["PROCESSING", "SENDING", "FAILED"];
    return ["PROCESSING"];
}

export type RowOutcome = "SUCCESS" | "FAILED" | "UNKNOWN";

/**
 * Hasil per baris payload dari jawaban Accurate yang DILIHAT proxy (bukan laporan klien). `json` undefined =
 * timeout / bukan JSON. Ragu = UNKNOWN (memblokir sampai Finance). Galat menyeluruh beramplop (`{s:false,
 * d:["pesan"]}`, bukan per baris) = tidak ada baris tersimpan -> FAILED; 5xx/3xx = UNKNOWN walau beramplop
 * (seperti classifyProviderReply AM-014).
 * ponytail: "amplop s:false tanpa hasil per baris = tidak tersimpan" ASSUMED dari perilaku klien lama
 * (mode individu); bukti provider = D-16.
 */
export function classifySalesReceiptReply(n: number, json: unknown, httpStatus = 200): RowOutcome[] {
    const all = (o: RowOutcome): RowOutcome[] => Array.from({ length: n }, () => o);
    if (httpStatus >= 300 && !(httpStatus >= 400 && httpStatus < 500)) return all("UNKNOWN");
    const isItem = (x: unknown) => Boolean(x) && typeof x === "object" && typeof (x as { s?: unknown }).s === "boolean";
    const perRow = (list: unknown[]): RowOutcome[] => list.length === n
        ? list.map((x) => (isItem(x) ? ((x as { s: boolean }).s ? "SUCCESS" : "FAILED") : "UNKNOWN"))
        : all("UNKNOWN");
    if (Array.isArray(json)) return perRow(json);
    if (!json || typeof json !== "object") return all("UNKNOWN");
    const env = json as { s?: unknown; d?: unknown };
    if (Array.isArray(env.d) && env.d.some(isItem)) return perRow(env.d);
    return typeof env.s === "boolean" ? all(env.s ? "SUCCESS" : "FAILED") : all("UNKNOWN");
}

type Identified = { key: string; customerNo?: unknown; transDate?: unknown; invoiceNo?: unknown };

/**
 * AM-024 (D-18): rencana guard /api/proxy untuk tulis sales-receipt. `owned` = baris lock ini yang BELUM
 * terkirim atau DITOLAK Accurate (PROCESSING/FAILED). Baris payload lolos bila fingerprint-nya milik lock, atau
 * identitas dasarnya (pelanggan + tanggal + himpunan faktur) sama dengan baris milik lock — nominal sengaja tidak
 * ikut agar kiriman koreksi self-heal lolos (semantik nominal/tanggal = D-22, owner). Sisanya (`need`) harus
 * menghabiskan satu override tercatat per baris. `anchors[i]` = key idempotency_log yang hasilnya ditentukan
 * baris i (ditandai SENDING sebelum kirim, lalu hasil Accurate dicatat server) — kosong untuk baris override.
 */
export function planSalesReceiptRows(
    rows: Record<string, unknown>[],
    owned: Identified[],
    knownKeys: Set<string>,
    fingerprint: (row: Record<string, unknown>) => Identified,
    identity: (r: Omit<Identified, "key">) => string,
): { need: string[]; anchors: string[][] } {
    const ownedKeys = new Set(owned.map((r) => r.key));
    const byIdentity = new Map<string, string[]>();
    for (const r of owned) byIdentity.set(identity(r), [...(byIdentity.get(identity(r)) ?? []), r.key]);
    const seen = new Set<string>();
    const need: string[] = [];
    const anchors = rows.map(fingerprint).map((fp) => {
        // Salinan kedua dst. dari fingerprint yang sama dalam SATU payload = kirim ganda -> butuh override
        // allow_duplicate per salinan (review e641e571: lock [r] lalu proxy [r, r, r]).
        const copy = seen.has(fp.key);
        seen.add(fp.key);
        // Fingerprint yang SUDAH tercatat (SUCCESS/UNKNOWN/SENDING/milik lock lain) tidak boleh "ditutupi"
        // identitas yang sama: identitas di idempotency_log berasal dari entri klien (key palsu beridentitas sama).
        const anchor = ownedKeys.has(fp.key) ? [fp.key] : knownKeys.has(fp.key) ? [] : byIdentity.get(identity(fp)) ?? [];
        if (copy || anchor.length === 0) need.push(fp.key);
        return anchor;
    });
    return { need, anchors };
}

/** Kunci yang perlu override (bentuk lama, dipakai uji). */
export const rowsNeedingOverride = (...a: Parameters<typeof planSalesReceiptRows>) => planSalesReceiptRows(...a).need;
