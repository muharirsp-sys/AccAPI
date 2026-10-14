// NOO (owner 13 Okt 2026, P7): status ORDER/aktif untuk kunjungan toko baru (kode NOO) ditolak 409 berkode — lib/form-kontrol/noo tolakOrderNoo.
import { tolakOrderNoo } from "@/lib/form-kontrol/noo";
import { NextResponse } from "next/server";
import { requirePermissionH } from "@/lib/rbac/resolve";
import { getTodayRoute, upsertAoControl, getAoForDate, writeKontrolAudit, resolveScope, canAccessSales, getReasons, validateNoOrderReason } from "@/lib/form-kontrol";
import type { AoStatus } from "@/lib/form-kontrol";
import { jawabGalat } from "@/lib/order-cabang";
import { witaToday } from "@/lib/beranda";

export async function GET(req: Request) {
    const gate = await requirePermissionH("form_kontrol.view");
    if (gate.response) return gate.response;
    const session = gate.session;

    try {
        const { searchParams } = new URL(req.url);
        const salesCode = searchParams.get("salesCode") ?? "";
        const principle = searchParams.get("principle") ?? "";
        const today = new Date();
        const dateStr = searchParams.get("date") ??
            `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;

        const scope = await resolveScope(session);
        if (salesCode && !canAccessSales(scope, salesCode)) {
            return NextResponse.json({ error: "Forbidden" }, { status: 403 });
        }
        // non-admin tanpa salesCode eksplisit → batasi ke miliknya, jangan bocorkan global
        if (!salesCode && scope.allowedSalesCodes !== null) {
            return NextResponse.json({ rows: [], summary: { total: 0, ordered: 0, notOrder: 0, notVisited: 0, priority: 0 } });
        }

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
    const gate = await requirePermissionH("form_kontrol.submit");
    if (gate.response) return gate.response;
    const session = gate.session;

    try {
        const body = await req.json();
        const { salesCode, custCode, principle, date, status, isVisited, noOrderReasonCode, noOrderNote } = body;
        if (!salesCode || !custCode || !principle || !date || !status) {
            return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
        }
        const scope = await resolveScope(session);
        if (!canAccessSales(scope, salesCode)) {
            return NextResponse.json({ error: "Forbidden" }, { status: 403 });
        }
        const noo = await tolakOrderNoo(custCode, status);
        if (noo) return noo;

        const reasonCode = typeof noOrderReasonCode === "string" && noOrderReasonCode.trim() ? noOrderReasonCode.trim() : null;
        const existing = (await getAoForDate(salesCode, principle, date)).find((r) => r.custCode === custCode);
        const reasonError = validateNoOrderReason(status, reasonCode, (await getReasons()).map((r) => r.reasonCode), existing);
        if (reasonError) return NextResponse.json({ error: reasonError }, { status: 400 });
        // FK-MSM3: hanya toko di rute tanggal itu (JKS atau luar rute belum batal) → selain itu 409 berkode, tanpa baris AO yatim.
        const hasil = await upsertAoControl({
            salesCode, custCode, principle, date,
            status: status as AoStatus,
            isVisited, noOrderReasonCode: reasonCode, noOrderNote,
            createdBy: session.user.id, penulis: { pemilik: scope.salesCode === salesCode, hariIni: witaToday() },
        });
        if ("galat" in hasil) return jawabGalat(hasil.galat);
        await writeKontrolAudit("ao", hasil.id, "upsert", session.user.id, session.user.name, body);
        return NextResponse.json({ success: true, id: hasil.id });
    } catch {
        return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }
}
