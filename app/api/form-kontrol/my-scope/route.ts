import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { getScopeForUser } from "@/lib/form-kontrol";

export async function GET() {
    const session = await auth.api.getSession({ headers: await headers() });
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    try {
        const role = (session.user as { role?: string }).role ?? "staff";

        if (role === "admin" || role === "manager" || role === "admin_sales") {
            return NextResponse.json({ role, allowedSalesCodes: null, allowedSpvIds: null });
        }

        const profile = await getScopeForUser(session.user.id);
        if (profile) {
            return NextResponse.json({
                role: role === "staff" ? "salesman" : role,
                salesCode: profile.salesCode,
                salesName: profile.salesName,
                principle: profile.principle ?? null,
                spvName: profile.spvName ?? null,
                smName: profile.smName ?? null,
                allowedSalesCodes: [profile.salesCode],
            });
        }

        return NextResponse.json({ role, allowedSalesCodes: [] });
    } catch {
        return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }
}
