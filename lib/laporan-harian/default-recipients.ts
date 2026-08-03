/*
 * Tujuan: Default aman untuk penerima laporan khusus ANI/JONAL bila DB belum pernah disimpan lewat UI mapping.
 * Caller: upload laporan harian dan API admin mapping.
 * Dependensi: Tidak ada.
 * Main Functions: SPECIAL_REPORT_RECIPIENTS, withSpecialReportRecipients.
 * Side Effects: Tidak ada; fungsi murni.
 */
export const SPECIAL_REPORT_RECIPIENTS = [
    { keyword: "ANI", emails: "Oktavianitalo@gmail.com", active: true },
    { keyword: "JONAL", emails: "Lawalata.jonal@yahoo.com", active: true },
] as const;

export function withSpecialReportRecipients<T extends { keyword: string; emails: string; active: boolean }>(rows: T[]) {
    const keywords = new Set(rows.map((row) => row.keyword.trim().toLowerCase()));
    return [
        ...rows,
        ...SPECIAL_REPORT_RECIPIENTS.filter((row) => !keywords.has(row.keyword.toLowerCase())),
    ];
}
