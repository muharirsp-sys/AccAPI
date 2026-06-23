import { NextResponse } from "next/server";
import { requirePermissionH } from "@/lib/rbac/resolve";
import { resolveScope } from "@/lib/form-kontrol";

export async function GET() {
    const gate = await requirePermissionH("form_kontrol.view");
    if (gate.response) return gate.response;
    const session = gate.session;

    try {
        const scope = await resolveScope(session);
        return NextResponse.json(scope);
    } catch {
        return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }
}
