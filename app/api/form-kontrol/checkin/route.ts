import { NextResponse } from "next/server";
import { requirePermissionH } from "@/lib/rbac/resolve";
import { saveCheckin, resolveScope, canAccessSales } from "@/lib/form-kontrol";

export async function POST(req: Request) {
    const gate = await requirePermissionH("form_kontrol.submit");
    if (gate.response) return gate.response;
    const session = gate.session;

    try {
        const body = await req.json();
        const { salesCode, custCode, principle, date, photoUrl, lat, lng, accuracy } = body;
        if (!salesCode || !custCode || !principle || !date || !photoUrl) {
            return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
        }
        if (!canAccessSales(await resolveScope(session), salesCode)) {
            return NextResponse.json({ error: "Forbidden" }, { status: 403 });
        }
        const id = await saveCheckin({
            salesCode, custCode, principle, date, photoUrl, createdBy: session.user.id,
            lat: typeof lat === "number" ? lat : null,
            lng: typeof lng === "number" ? lng : null,
            accuracy: typeof accuracy === "number" ? accuracy : null,
        });
        return NextResponse.json({ success: true, id });
    } catch {
        return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }
}
