import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { getFrequencyData } from "@/lib/form-kontrol";

export async function GET(req: Request) {
    const session = await auth.api.getSession({ headers: await headers() });
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    try {
        const { searchParams } = new URL(req.url);
        const salesCode = searchParams.get("salesCode") ?? "";
        const principle = searchParams.get("principle") ?? "";
        const today = new Date();
        const periodMonth = parseInt(searchParams.get("month") ?? String(today.getMonth() + 1), 10);
        const periodYear  = parseInt(searchParams.get("year")  ?? String(today.getFullYear()), 10);

        const result = await getFrequencyData(salesCode, principle, periodMonth, periodYear);
        return NextResponse.json(result);
    } catch {
        return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }
}
