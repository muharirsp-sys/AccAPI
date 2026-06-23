import { NextResponse } from "next/server";
import { requirePermissionH } from "@/lib/rbac/resolve";
import { saveCheckout, resolveScope, canAccessSales } from "@/lib/form-kontrol";

export async function POST(req: Request) {
    const gate = await requirePermissionH("form_kontrol.submit");
    if (gate.response) return gate.response;
    const session = gate.session;

    try {
        const body = await req.json();
        const { salesCode, custCode, principle, date, photoUrl } = body;
        if (!salesCode || !custCode || !principle || !date || !photoUrl) {
            return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
        }
        if (!canAccessSales(await resolveScope(session), salesCode)) {
            return NextResponse.json({ error: "Forbidden" }, { status: 403 });
        }
        await saveCheckout({ salesCode, custCode, principle, date, photoUrl });
        return NextResponse.json({ success: true });
    } catch {
        return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }
}
