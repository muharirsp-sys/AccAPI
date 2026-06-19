import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { getJksList, upsertJksRows } from "@/lib/form-kontrol";

export async function GET(req: Request) {
    const session = await auth.api.getSession({ headers: await headers() });
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    try {
        const { searchParams } = new URL(req.url);
        const salesCode     = searchParams.get("salesCode") ?? undefined;
        const principle     = searchParams.get("principle") ?? undefined;
        const hariKunjungan = searchParams.get("hariKunjungan") ?? undefined;
        const page          = Math.max(1, parseInt(searchParams.get("page") ?? "1", 10));
        const limit         = Math.min(200, parseInt(searchParams.get("limit") ?? "50", 10));
        const offset        = (page - 1) * limit;

        const result = await getJksList({ salesCode, principle, hariKunjungan, isActive: true }, limit, offset);
        return NextResponse.json({ ...result, page, limit });
    } catch {
        return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }
}

export async function POST(req: Request) {
    const session = await auth.api.getSession({ headers: await headers() });
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    try {
        const body = await req.json();
        const rows = Array.isArray(body) ? body : (body.rows ?? []);
        if (!Array.isArray(rows) || rows.length === 0) {
            return NextResponse.json({ error: "No rows provided" }, { status: 400 });
        }
        const result = await upsertJksRows(rows);
        return NextResponse.json({ success: true, ...result });
    } catch {
        return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }
}
