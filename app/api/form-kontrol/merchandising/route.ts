import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { getMerchandisingForDate, saveMerchandising } from "@/lib/form-kontrol";

export async function GET(req: Request) {
    const session = await auth.api.getSession({ headers: await headers() });
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    try {
        const { searchParams } = new URL(req.url);
        const salesCode = searchParams.get("salesCode") ?? "";
        const principle = searchParams.get("principle") ?? "";
        const today = new Date();
        const dateStr = searchParams.get("date") ??
            `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;

        const rows = await getMerchandisingForDate(salesCode, principle, dateStr);
        return NextResponse.json({ rows, total: rows.length });
    } catch {
        return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }
}

export async function POST(req: Request) {
    const session = await auth.api.getSession({ headers: await headers() });
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    try {
        const body = await req.json();
        const { salesCode, custCode, principle, date } = body;
        if (!salesCode || !custCode || !principle || !date) {
            return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
        }
        const id = await saveMerchandising({
            salesCode, custCode, principle, date,
            produkJelas: body.produkJelas ?? false,
            displayRapi: body.displayRapi ?? false,
            dibersihkan: body.dibersihkan ?? false,
            ditataulang: body.ditataulang ?? false,
            posisiMudah: body.posisiMudah ?? false,
            semuaSku: body.semuaSku ?? false,
            photoUrl: body.photoUrl ?? null,
            stepPhotos: body.stepPhotos ?? null,
            note: body.note ?? null,
        });
        return NextResponse.json({ success: true, id });
    } catch {
        return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }
}
