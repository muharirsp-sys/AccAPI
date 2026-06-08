/*
 * Tujuan: GET CSV export Outstanding Report untuk Phase R5.
 */
import { NextRequest, NextResponse } from "next/server";
import {
    OUTSTANDING_REPORT_COLUMNS,
    buildOutstandingReport,
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
        const rows = await buildOutstandingReport({
            status: searchParams.get("status"),
            principleCode: searchParams.get("principleCode"),
        });
        const csv = rowsToCsv(OUTSTANDING_REPORT_COLUMNS, rows);
        const fileName = `claim-outstanding-report-${todayStamp()}.csv`;
        return new NextResponse(csv, {
            headers: {
                "Content-Type": "text/csv; charset=utf-8",
                "Content-Disposition": `attachment; filename="${fileName}"`,
                "Cache-Control": "no-store",
            },
        });
    } catch (error) {
        console.error("[CLAIM REPORT OUTSTANDING EXPORT ERROR]", error);
        return NextResponse.json({ ok: false, error: "Gagal export Outstanding Report." }, { status: 500 });
    }
}
