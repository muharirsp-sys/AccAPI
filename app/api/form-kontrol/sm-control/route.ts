import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { getSmControl, saveSmControl } from "@/lib/form-kontrol";

export async function GET(req: Request) {
    const session = await auth.api.getSession({ headers: await headers() });
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    try {
        const { searchParams } = new URL(req.url);
        const smName = searchParams.get("smName") ?? session.user.name ?? "";
        const today = new Date();
        const dateStr = searchParams.get("date") ??
            `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;

        const rows = await getSmControl(smName, dateStr);
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
        const { smName, date, spvChecked, jksChecked, fotoChecked, coachingNote, deviations, followUp } = body;
        if (!smName || !date) {
            return NextResponse.json({ error: "Missing required fields (smName, date)" }, { status: 400 });
        }
        const id = await saveSmControl({
            smName, date, spvChecked, jksChecked, fotoChecked,
            coachingNote, deviations, followUp, createdBy: session.user.id,
        });
        return NextResponse.json({ success: true, id });
    } catch {
        return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }
}
