/*
 * Tujuan: GET CSV export Summary Report untuk Phase R5.
 * Caller: UI tombol "Export CSV Summary".
 * Side Effects: Tidak ada. Read-only. Stream CSV ke client.
 */
import { NextRequest, NextResponse } from "next/server";
import {
    SUMMARY_REPORT_COLUMNS,
    buildSummaryReport,
    requireClaimSession,
    rowsToCsv,
    todayStamp,
} from "@/lib/claim-workflow";
import { requirePermissionH } from "@/lib/rbac/resolve";

export async function GET(request: NextRequest) {
    const actor = await requireClaimSession();
    if (!actor) {
        return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }
    const gate = await requirePermissionH("claim_workflow.export");
    if (gate.response) return gate.response;

    try {
        const { searchParams } = new URL(request.url);
        const rows = await buildSummaryReport({
            status: searchParams.get("status"),
            principleCode: searchParams.get("principleCode"),
            dateFrom: searchParams.get("dateFrom"),
            dateTo: searchParams.get("dateTo"),
            onlyOpen: searchParams.get("onlyOpen") === "true",
        });
        const csv = rowsToCsv(SUMMARY_REPORT_COLUMNS, rows);
        const fileName = `claim-summary-report-${todayStamp()}.csv`;
        return new NextResponse(csv, {
            headers: {
                "Content-Type": "text/csv; charset=utf-8",
                "Content-Disposition": `attachment; filename="${fileName}"`,
                "Cache-Control": "no-store",
            },
        });
    } catch (error) {
        console.error("[CLAIM REPORT SUMMARY EXPORT ERROR]", error);
        return NextResponse.json({ ok: false, error: "Gagal export Summary Report." }, { status: 500 });
    }
}
