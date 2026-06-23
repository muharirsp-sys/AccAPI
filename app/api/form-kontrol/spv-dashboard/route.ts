import { NextResponse } from "next/server";
import { requirePermissionH } from "@/lib/rbac/resolve";
import { getScopeForUser, getSpvDashboard } from "@/lib/form-kontrol";

export async function GET(req: Request) {
    const gate = await requirePermissionH("form_kontrol.view");
    if (gate.response) return gate.response;
    const session = gate.session;

    try {
        const { searchParams } = new URL(req.url);
        const date = searchParams.get("date") ?? new Date().toISOString().slice(0, 10);
        const role = (session.user as { role?: string }).role ?? "staff";
        let spvName: string | null = null;

        if (role === "admin" || role === "manager" || role === "admin_sales") {
            spvName = searchParams.get("spvName");
        } else {
            const profile = await getScopeForUser(session.user.id);
            spvName = profile?.spvName ?? profile?.salesName ?? null;
        }

        if (!spvName) return NextResponse.json({ error: "SPV name not found" }, { status: 400 });

        const rows = await getSpvDashboard(spvName, date);
        return NextResponse.json({ rows, date, spvName });
    } catch {
        return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }
}
