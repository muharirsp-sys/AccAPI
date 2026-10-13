import { NextResponse } from "next/server";
import { requirePermissionH } from "@/lib/rbac/resolve";
import { getSpvDashboard, resolveScope } from "@/lib/form-kontrol";

export async function GET(req: Request) {
    const gate = await requirePermissionH("form_kontrol.view");
    if (gate.response) return gate.response;
    const session = gate.session;

    try {
        const { searchParams } = new URL(req.url);
        const date = searchParams.get("date") ?? new Date().toISOString().slice(0, 10);
        // FK-MSM butir 3: nama SPV dari cakupan (resolveScope) — akun SPV TANPA sales_profile ikut terbaca (nama akun tanpa " (SPV)").
        // Admin/manager/admin_sales memilih SPV lewat parameter; SPV hanya timnya sendiri; peran lain (salesman, SM) tidak melihat tim SPV.
        const scope = await resolveScope(session);
        let spvName: string | null;
        if (scope.allowedSalesCodes === null) spvName = searchParams.get("spvName");
        else if (scope.role === "spv") spvName = scope.spvName ?? null;
        else return NextResponse.json({ error: "Forbidden" }, { status: 403 });

        if (!spvName) return NextResponse.json({ error: "SPV name not found" }, { status: 400 });

        const rows = await getSpvDashboard(spvName, date);
        return NextResponse.json({ rows, date, spvName });
    } catch {
        return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }
}
