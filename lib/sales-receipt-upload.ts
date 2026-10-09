/**
 * Tujuan: laporan per baris unggah sales-receipt di API Wrapper (tinjauan S6-0a). Status idempotency baris dicatat
 *   SERVER dari jawaban Accurate (lib/sales-receipt-guard.ts, classifySalesReceiptReply); halaman hanya melaporkan.
 *   Penolakan Accurate = status TIDAK PASTI (C11, owner 8 Okt 2026) — bukan "berhasil terposting", bukan gagal yang
 *   boleh dikirim ulang otomatis.
 * Caller: app/(dashboard)/api-wrapper/page.tsx (executeBulkPayload, handleConfirmDuplicateReview).
 * Side Effects: tidak ada (murni).
 */
import { classifySalesReceiptReply } from "@/lib/idempotency-lock";

export type RowReport = { ok: boolean; message: string; item?: unknown };

const isItem = (x: unknown) => Boolean(x) && typeof x === "object" && typeof (x as { s?: unknown }).s === "boolean";
const text = (v: unknown): string => typeof v === "string" ? v
    : Array.isArray(v) ? v.map(text).filter(Boolean).join("; ")
        : v && typeof v === "object" && "d" in v ? text((v as { d: unknown }).d)
            : v === undefined || v === null ? "" : JSON.stringify(v);

/** `data` = JSON yang diterima halaman dari /api/proxy (undefined = timeout/jaringan); `noAnswer` = galat bila tanpa jawaban. */
export function salesReceiptRowReports(n: number, data: unknown, noAnswer = ""): RowReport[] {
    const outcomes = classifySalesReceiptReply(n, data);
    const env = data as { s?: unknown; d?: unknown } | null | undefined;
    // Jawaban Accurate = amplop {s, d} atau daftar hasil per baris; {error} dari proxy (504/502/400) bukan jawaban Accurate.
    const answered = Array.isArray(data) || (Boolean(env) && typeof env === "object" && typeof env!.s === "boolean");
    const items = Array.isArray(data) ? data : Array.isArray(env?.d) && env!.d.some(isItem) ? env!.d : null;
    const cause = text((env as { error?: unknown } | null | undefined)?.error) || noAnswer;
    return outcomes.map((o, i) => {
        const item = items && items.length === n ? items[i] : undefined;
        if (o === "SUCCESS") return { ok: true, message: "", item: item ?? data };
        return answered
            ? { ok: false, item, message: `Accurate menolak: ${text(item ?? data) || "tanpa pesan"} — status tidak pasti, butuh pemeriksaan/override Finance` }
            : { ok: false, item, message: `Tanpa jawaban Accurate${cause ? ` (${cause})` : ""} — status tidak pasti, cek Accurate sebelum kirim ulang` };
    });
}

/** Proxy menolak tulis sales-receipt SEBELUM dikirim (lock/override tidak mencakup baris) — 409 berkode. */
export const isLockRequired = (err: unknown) =>
    (err as { rawErrorObject?: { code?: unknown } } | null)?.rawErrorObject?.code === "SALES_RECEIPT_LOCK_REQUIRED";

/**
 * Override yang BENAR-BENAR dipakai server (decideLock): duplikat-dalam-unggahan hanya bila key itu muncul ≥ 2 kali
 * di baris final; blok server (SUCCESS/PROCESSING/UNKNOWN) selalu. Pilihan bawaan (baris pertama duplikat) tidak
 * butuh alasan override.
 */
export function overrideKeysNeeded(finalKeys: string[], duplicateCandidates: string[], lockedKeys: string[]) {
    const count = new Map<string, number>();
    for (const k of finalKeys) count.set(k, (count.get(k) ?? 0) + 1);
    return {
        allowDuplicateKeys: [...new Set(duplicateCandidates)].filter((k) => (count.get(k) ?? 0) > 1),
        allowLockedKeys: [...new Set(lockedKeys)],
    };
}
