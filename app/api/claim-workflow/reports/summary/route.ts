/*
 * Tujuan: GET endpoint Summary Report (JSON) untuk Phase R5.
 * Caller: UI report page (`/claim-workflow/reports`).
 * Side Effects: Tidak ada. Read-only.
 */
import { NextRequest, NextResponse } from "next/server";
import {
    SUMMARY_REPORT_COLUMNS,
    buildSummaryReport,
    requireClaimSession,
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
        return NextResponse.json({
            ok: true,
            columns: SUMMARY_REPORT_COLUMNS,
            rows,
            rowCount: rows.length,
        });
    } catch (error) {
        console.error("[CLAIM REPORT SUMMARY ERROR]", error);
        return NextResponse.json({ ok: false, error: "Gagal membangun Summary Report." }, { status: 500 });
    }
}
