/*
 * Tujuan: GET CSV export Paid Report untuk Phase R5.
 */
import { NextRequest, NextResponse } from "next/server";
import {
    PAID_REPORT_COLUMNS,
    buildPaidReport,
    canActorReadClaimWorkflow,
    requireClaimSession,
    rowsToCsv,
    todayStamp,
} from "@/lib/claim-workflow";

export async function GET(request: NextRequest) {
    const actor = await requireClaimSession();
    if (!actor) {
        return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }
    if (!canActorReadClaimWorkflow(actor)) {
        return NextResponse.json({
            ok: false,
            error: "Role Anda tidak memiliki akses report Claim Workflow.",
        }, { status: 403 });
    }

    try {
        const { searchParams } = new URL(request.url);
        const rows = await buildPaidReport({
            status: searchParams.get("status"),
            principleCode: searchParams.get("principleCode"),
            dateFrom: searchParams.get("dateFrom"),
            dateTo: searchParams.get("dateTo"),
            includeVoided: searchParams.get("includeVoided") === "true",
        });
        const csv = rowsToCsv(PAID_REPORT_COLUMNS, rows);
        const fileName = `claim-paid-report-${todayStamp()}.csv`;
        return new NextResponse(csv, {
            headers: {
                "Content-Type": "text/csv; charset=utf-8",
                "Content-Disposition": `attachment; filename="${fileName}"`,
                "Cache-Control": "no-store",
            },
        });
    } catch (error) {
        console.error("[CLAIM REPORT PAID EXPORT ERROR]", error);
        return NextResponse.json({ ok: false, error: "Gagal export Paid Report." }, { status: 500 });
    }
}
