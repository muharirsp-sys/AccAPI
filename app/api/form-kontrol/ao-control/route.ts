import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { getTodayRoute, upsertAoControl, getAoForDate, writeKontrolAudit } from "@/lib/form-kontrol";
import type { AoStatus } from "@/lib/form-kontrol";

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

        if (!salesCode || !principle) {
            const rows = await getAoForDate(salesCode, principle, dateStr);
            const summary = { total: rows.length, ordered: 0, notOrder: 0, notVisited: rows.length, priority: 0 };
            for (const r of rows) {
                if (r.status === "ordered" || r.status === "active") summary.ordered++;
                else if (r.status === "not_order") summary.notOrder++;
                else if (r.status === "not_visited") summary.notVisited++;
                else if (r.status === "priority") summary.priority++;
            }
            return NextResponse.json({ rows, summary });
        }

        const route = await getTodayRoute(salesCode, principle, dateStr);
        const summary = { total: route.length, ordered: 0, notOrder: 0, notVisited: 0, priority: 0 };
        for (const r of route) {
            if (!r.aoStatus || r.aoStatus === "not_visited") summary.notVisited++;
            else if (r.aoStatus === "ordered" || r.aoStatus === "active") summary.ordered++;
            else if (r.aoStatus === "not_order") summary.notOrder++;
            else if (r.aoStatus === "priority") summary.priority++;
        }
        return NextResponse.json({ rows: route, summary, date: dateStr });
    } catch {
        return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }
}

export async function POST(req: Request) {
    const session = await auth.api.getSession({ headers: await headers() });
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    try {
        const body = await req.json();
        const { salesCode, custCode, principle, date, status, isVisited, noOrderReasonCode, noOrderNote } = body;
        if (!salesCode || !custCode || !principle || !date || !status) {
            return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
        }
        const id = await upsertAoControl({
            salesCode, custCode, principle, date,
            status: status as AoStatus,
            isVisited, noOrderReasonCode, noOrderNote,
            createdBy: session.user.id,
        });
        await writeKontrolAudit("ao", id, "upsert", session.user.id, session.user.name, body);
        return NextResponse.json({ success: true, id });
    } catch {
        return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }
}
