import { NextResponse } from "next/server";
import { requirePermissionH } from "@/lib/rbac/resolve";
import { getReasons } from "@/lib/form-kontrol";

export async function GET() {
    const gate = await requirePermissionH("form_kontrol.view");
    if (gate.response) return gate.response;

    try {
        const rows = await getReasons();
        return NextResponse.json({ rows });
    } catch {
        return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }
}
