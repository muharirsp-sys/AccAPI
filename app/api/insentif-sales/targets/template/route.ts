/*
 * Tujuan: GET template Excel untuk input target.
 * Caller: Frontend TargetInputSection download button.
 * Dependensi: lib/insentif-sales (generateTargetTemplate).
 * Main Functions: GET handler returns XLSX file.
 * Side Effects: None (read-only).
 */

import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/rbac/resolve";
import { generateTargetTemplate } from "@/lib/insentif-sales-excel";

export async function GET(request: Request) {
    const gate = await requirePermission(request, "insentif_sales.view");
    if (gate.response) return gate.response;

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
