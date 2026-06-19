import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { getVisitDetail } from "@/lib/form-kontrol";

export async function GET(req: Request) {
    const session = await auth.api.getSession({ headers: await headers() });
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    try {
        const { searchParams } = new URL(req.url);
        const salesCode = searchParams.get("salesCode") ?? "";
        const custCode  = searchParams.get("custCode") ?? "";
        const principle = searchParams.get("principle") ?? "";
        const date      = searchParams.get("date") ?? new Date().toISOString().slice(0, 10);

        if (!salesCode || !custCode || !principle) {
            return NextResponse.json({ error: "salesCode, custCode and principle are required" }, { status: 400 });
        }
        const detail = await getVisitDetail(salesCode, custCode, principle, date);
        if (!detail) return NextResponse.json({ error: "Store not found" }, { status: 404 });
        return NextResponse.json(detail);
    } catch {
        return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }
}
