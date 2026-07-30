/*
 * Tujuan: Validasi pilihan file dan alamat penerima internal untuk pengiriman trial Laporan Harian.
 * Caller: app/api/laporan-harian/upload/route.ts dan app/api/laporan-harian/[runId]/send/route.ts.
 * Dependensi: Tidak ada.
 * Main Functions: internalRecipientAllowlist, selectRequestedFiles, validateInternalRecipients.
 * Side Effects: Tidak ada; seluruh fungsi murni.
 */

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizeEmail(value: string): string {
    return value.trim().toLowerCase();
}

export function internalRecipientAllowlist(configured: string | undefined, sessionEmail: string | null | undefined): string[] {
    const candidates = [
        ...(configured ?? "").split(/[;,\n]/),
        sessionEmail ?? "",
    ];
    return [...new Set(
        candidates
            .map(normalizeEmail)
            .filter((email) => EMAIL_PATTERN.test(email)),
    )].sort();
}

export function selectRequestedFiles(available: string[], requested: unknown): string[] {
    const allowed = new Set(available.map((name) => name.trim()).filter(Boolean));
    if (!Array.isArray(requested)) return [...allowed];

    return [...new Set(
        requested
            .filter((value): value is string => typeof value === "string")
            .map((value) => value.trim())
            .filter((value) => allowed.has(value)),
    )];
}

export function validateInternalRecipients(allowlist: string[], requested: unknown): {
    recipients: string[];
    rejected: string[];
} {
    const allowed = new Set(allowlist.map(normalizeEmail));
    const supplied = Array.isArray(requested)
        ? requested.filter((value): value is string => typeof value === "string").map(normalizeEmail)
        : [];
    const unique = [...new Set(supplied.filter(Boolean))];
    return {
        recipients: unique.filter((email) => allowed.has(email)),
        rejected: unique.filter((email) => !allowed.has(email)),
    };
}
