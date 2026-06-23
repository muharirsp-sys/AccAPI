import { NextResponse } from "next/server";
import { requirePermissionH } from "@/lib/rbac/resolve";
import { getAllSalesProfiles, updateSalesHierarchy, resolveScope } from "@/lib/form-kontrol";

export async function GET() {
    const gate = await requirePermissionH("form_kontrol.manage");
    if (gate.response) return gate.response;
    const session = gate.session;
    const scope = await resolveScope(session);
    if (scope.allowedSalesCodes !== null) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    try {
        const rows = await getAllSalesProfiles();
        return NextResponse.json({ rows });
    } catch {
        return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }
}

export async function PUT(req: Request) {
    const gate = await requirePermissionH("form_kontrol.manage");
    if (gate.response) return gate.response;
    const session = gate.session;
    const scope = await resolveScope(session);
    if (scope.allowedSalesCodes !== null) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    try {
        const { salesCode, spvName, smName } = await req.json();
        if (!salesCode) return NextResponse.json({ error: "Missing salesCode" }, { status: 400 });
        await updateSalesHierarchy(salesCode, spvName ?? null, smName ?? null);
        return NextResponse.json({ success: true });
    } catch {
        return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }
}
