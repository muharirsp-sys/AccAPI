/*
 * Tujuan: GET endpoint Outstanding Report (JSON) untuk Phase R5.
 *         Berbasis Excel sheet "MONITOR OUTSTANDING".
 * Caller: UI report page.
 * Side Effects: Tidak ada. Read-only.
 */
import { NextRequest, NextResponse } from "next/server";
import {
    OUTSTANDING_REPORT_COLUMNS,
    buildOutstandingReport,
    canActorReadClaimWorkflow,
    requireClaimSession,
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
        return NextResponse.json({
            ok: true,
            columns: OUTSTANDING_REPORT_COLUMNS,
            rows,
            rowCount: rows.length,
        });
    } catch (error) {
        console.error("[CLAIM REPORT OUTSTANDING ERROR]", error);
        return NextResponse.json({ ok: false, error: "Gagal membangun Outstanding Report." }, { status: 500 });
    }
}
