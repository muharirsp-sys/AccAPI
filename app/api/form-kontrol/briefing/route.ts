import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { getBriefings, saveBriefing } from "@/lib/form-kontrol";

export async function GET(req: Request) {
    const session = await auth.api.getSession({ headers: await headers() });
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    try {
        const { searchParams } = new URL(req.url);
        const spvName = searchParams.get("spvName") ?? session.user.name ?? "";
        const today = new Date();
        const dateStr = searchParams.get("date") ??
            `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;

        const rows = await getBriefings(spvName, dateStr);
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
        const { spvName, date, session: briefingSession, agenda, tokoDialas, penyebab, solusi } = body;
        if (!spvName || !date || !briefingSession) {
            return NextResponse.json({ error: "Missing required fields (spvName, date, session)" }, { status: 400 });
        }
        if (briefingSession !== "pagi" && briefingSession !== "sore") {
            return NextResponse.json({ error: "session must be pagi or sore" }, { status: 400 });
        }
        const id = await saveBriefing({
            spvName, date, session: briefingSession,
            agenda, tokoDialas, penyebab, solusi,
            createdBy: session.user.id,
        });
        return NextResponse.json({ success: true, id });
    } catch {
        return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }
}
