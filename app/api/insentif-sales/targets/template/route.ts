/*
 * Tujuan: GET template Excel untuk input target.
 * Caller: Frontend TargetInputSection download button.
 * Dependensi: lib/insentif-sales (generateTargetTemplate).
 * Main Functions: GET handler returns XLSX file.
 * Side Effects: None (read-only).
 */

import { NextResponse } from "next/server";
import { requireApiSession } from "@/lib/api-security";
import { generateTargetTemplate } from "@/lib/insentif-sales-excel";

export async function GET(request: Request) {
    const authCheck = await requireApiSession(request);
    if (authCheck.response) return authCheck.response;

    try {
        const templateBuffer = generateTargetTemplate();
        return new NextResponse(Buffer.from(templateBuffer), {
            headers: {
                "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                "Content-Disposition": "attachment; filename=target_template.xlsx",
            },
        });
    } catch (err) {
        return NextResponse.json(
            { error: err instanceof Error ? err.message : "Failed to generate template" },
            { status: 500 }
        );
    }
}
