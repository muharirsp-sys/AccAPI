/*
 * Tujuan: Normalisasi payload progress FastAPI sebelum disimpan ke PostgreSQL tanpa menebak salesman.
 * Caller: app/api/laporan-harian/upload/route.ts; self-check progress-normalize.test.ts.
 * Dependensi: Tidak ada.
 * Main Functions: normalizeDailyProgressRows.
 * Side Effects: Tidak ada; fungsi murni.
 */
export interface DailyProgressRow {
    salesCode: string;
    principle: string;
    branch: string;
    date: string;
    periodMonth: number;
    periodYear: number;
    achievedValueDpp: number;
    achievedEc: number;
    achievedAo: number;
    achievedIa: number;
    invoiceNumber?: string | null;
}

export interface DailyProgressInputRow extends Omit<DailyProgressRow, "salesCode"> {
    salesCode?: string | null;
}

export interface UnmappedProgressSummary {
    rows: number;
    achievedValueDpp: number;
    branches: string[];
}

function unmappedSalesCode(branch: string): string {
    const key = branch.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-|-$/g, "");
    return `UNMAPPED:${key || "UNKNOWN"}`;
}

/** Pertahankan nilai progress tanpa menebak salesman saat sumber tidak memiliki kode. */
export function normalizeDailyProgressRows(rows: DailyProgressInputRow[]): {
    rows: DailyProgressRow[];
    unmapped: UnmappedProgressSummary;
} {
    const branches = new Set<string>();
    let unmappedRows = 0;
    let unmappedDpp = 0;
    const normalized = rows.map((row) => {
        const rawCode = typeof row.salesCode === "string" ? row.salesCode.trim() : "";
        const missing = !rawCode || ["<NA>", "NAN", "NONE", "NULL"].includes(rawCode.toUpperCase());
        if (!missing) return { ...row, salesCode: rawCode };

        const branch = typeof row.branch === "string" ? row.branch.trim() : "";
        branches.add((branch || "UNKNOWN").toUpperCase());
        unmappedRows += 1;
        unmappedDpp += Number.isFinite(row.achievedValueDpp) ? row.achievedValueDpp : 0;
        return { ...row, salesCode: unmappedSalesCode(branch) };
    });

    return {
        rows: normalized,
        unmapped: {
            rows: unmappedRows,
            achievedValueDpp: unmappedDpp,
            branches: [...branches].sort(),
        },
    };
}
