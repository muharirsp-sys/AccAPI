/*
 * Tujuan: GET endpoint Paid Report (JSON) untuk Phase R5.
 *         Transaction-based: satu row per claim_payment.
 * Caller: UI report page.
 * Side Effects: Tidak ada. Read-only.
 */
import { NextRequest, NextResponse } from "next/server";
import {
    PAID_REPORT_COLUMNS,
    buildPaidReport,
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
        const rows = await buildPaidReport({
            status: searchParams.get("status"),
            principleCode: searchParams.get("principleCode"),
            dateFrom: searchParams.get("dateFrom"),
            dateTo: searchParams.get("dateTo"),
            includeVoided: searchParams.get("includeVoided") === "true",
        });
        return NextResponse.json({
            ok: true,
            columns: PAID_REPORT_COLUMNS,
            rows,
            rowCount: rows.length,
        });
    } catch (error) {
        console.error("[CLAIM REPORT PAID ERROR]", error);
        return NextResponse.json({ ok: false, error: "Gagal membangun Paid Report." }, { status: 500 });
    }
}
