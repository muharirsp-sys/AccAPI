import { NextResponse } from "next/server";
import { requirePermissionH } from "@/lib/rbac/resolve";
import { getJksPrinciples, resolveScope } from "@/lib/form-kontrol";

export async function GET() {
    const gate = await requirePermissionH("form_kontrol.view");
    if (gate.response) return gate.response;
    const session = gate.session;

    try {
        const scope = await resolveScope(session);
        // FK-MSM butir 1: principal = JKS aktif milik cakupan (salesman: miliknya; SPV: timnya; admin: semua). [] = belum ada JKS.
        return NextResponse.json({ ...scope, principles: await getJksPrinciples(scope.allowedSalesCodes) });
    } catch {
        return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }
}
