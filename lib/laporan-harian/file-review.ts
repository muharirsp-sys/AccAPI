/*
 * Tujuan: Validasi nama file laporan run-scoped dan bentuk contoh baris yang ringkas untuk review UI.
 * Caller: app/api/laporan-harian/[runId]/preview/route.ts; self-check file-review.test.ts.
 * Dependensi: Tidak ada.
 * Main Functions: isAllowedReviewFile, buildReviewSample.
 * Side Effects: Tidak ada; seluruh fungsi murni.
 */
const REVIEW_COLUMNS = [
    "NO_NOTA",
    "TANGGAL",
    "KODE_CUST",
    "CUSTOMER",
    "KODE_SALESMAN",
    "SALESMAN",
    "NAMA_BARANG",
    "QTY",
    "DPP",
    "PRINCIPAL",
];

export function isAllowedReviewFile(fileName: string, reportDate: string): boolean {
    return fileName.startsWith(`${reportDate}_`)
        && fileName.toLowerCase().endsWith(".xlsx")
        && !fileName.includes("/")
        && !fileName.includes("\\")
        && !fileName.includes("..");
}

export function buildReviewSample(matrix: unknown[][], limit = 25): {
    columns: string[];
    rows: unknown[][];
} {
    const headers = (matrix[0] ?? []).map((value) => String(value ?? "").trim());
    const indexes = REVIEW_COLUMNS
        .map((column) => ({ column, index: headers.indexOf(column) }))
        .filter((item) => item.index >= 0);

    return {
        columns: indexes.map((item) => item.column),
        rows: matrix.slice(1, limit + 1).map((row) => indexes.map((item) => row[item.index] ?? null)),
    };
}
