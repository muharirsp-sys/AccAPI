/*
 * Tujuan: State machine pure untuk claim, retry, dan hasil akhir pengiriman Laporan Harian.
 * Caller: app/api/laporan-harian/[runId]/send/route.ts.
 * Dependensi: Tidak ada.
 * Main Functions: canClaimReportRun, finalReportRunStatus, RETRYABLE_RECIPIENT_STATUSES.
 * Side Effects: Tidak ada.
 */
/** Status run dan penerima — tipe kolom report_run.status / report_run_recipient.send_status (db/schema.ts). */
export type ReportRunStatus = "dry_run" | "sending" | "sent" | "failed";
export type RecipientSendStatus = "pending" | "sent" | "failed" | "skipped";

export const RETRYABLE_RECIPIENT_STATUSES = ["pending", "failed"] as const satisfies readonly RecipientSendStatus[];

/** Run "sending" yang klaimnya lebih tua dari ini dianggap macet: prosesnya mati di tengah kirim (route maxDuration 5 menit). */
export const MACET_MENIT = 10;

// ponytail: jam klaim disimpan di kolom `note` ("sending_at:<ISO>"), di samping "email_mode:..." yang sudah ada di sana —
// tanpa kolom baru, jadi tanpa migrasi. Batasnya: teks bebas; bila run butuh lebih banyak jejak, pindahkan ke kolom sendiri.
const SENDING_AT = /(?:; )?sending_at:(\S+)/;

/** Jam klaim terakhir; null untuk run yang diklaim sebelum penanda ini ada. */
export function sendingAtDariNote(note: string | null | undefined): Date | null {
    const t = Date.parse(note?.match(SENDING_AT)?.[1] ?? "");
    return Number.isNaN(t) ? null : new Date(t);
}

/** Note dengan jam klaim baru (penanda lama diganti, bukan ditumpuk). */
export function catatSendingAt(note: string | null | undefined, now: Date): string {
    const bersih = (note ?? "").replace(SENDING_AT, "");
    return `${bersih}${bersih ? "; " : ""}sending_at:${now.toISOString()}`;
}

/**
 * BL-29 (owner 17 Nov 2026): run "sending" yang klaimnya sudah lebih dari MACET_MENIT = prosesnya mati (galat DB, container
 * diganti saat deploy). Umur dihitung dari jam klaim; run lama tanpa penanda memakai createdAt.
 */
export function runMacet(status: string, note: string | null | undefined, createdAt: string | Date, now: Date): boolean {
    if (status !== "sending") return false;
    const sejak = sendingAtDariNote(note) ?? new Date(createdAt);
    return now.getTime() - sejak.getTime() > MACET_MENIT * 60_000;
}

/** Boleh diklaim untuk dikirim: belum pernah, gagal, atau macet. Penerima yang sudah `sent` tidak dikirimi lagi. */
export function canClaimReportRun(status: string, macet = false): boolean {
    return status === "dry_run" || status === "failed" || (status === "sending" && macet);
}

export function finalReportRunStatus(failedRecipients: number): "sent" | "failed" {
    return failedRecipients === 0 ? "sent" : "failed";
}
