import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { getAllSalesProfiles, updateSalesHierarchy, resolveScope } from "@/lib/form-kontrol";

export async function GET() {
    const session = await auth.api.getSession({ headers: await headers() });
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
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
    const session = await auth.api.getSession({ headers: await headers() });
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
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
