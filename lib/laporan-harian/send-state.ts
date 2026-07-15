/*
 * Tujuan: State machine pure untuk claim, retry, dan hasil akhir pengiriman Laporan Harian.
 * Caller: app/api/laporan-harian/[runId]/send/route.ts.
 * Dependensi: Tidak ada.
 * Main Functions: canClaimReportRun, finalReportRunStatus, RETRYABLE_RECIPIENT_STATUSES.
 * Side Effects: Tidak ada.
 */
export const RETRYABLE_RECIPIENT_STATUSES = ["pending", "failed"] as const;

export function canClaimReportRun(status: string): boolean {
    return status === "dry_run" || status === "failed";
}

export function finalReportRunStatus(failedRecipients: number): "sent" | "failed" {
    return failedRecipients === 0 ? "sent" : "failed";
}
