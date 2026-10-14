import { NextResponse } from "next/server";
import { requirePermissionH } from "@/lib/rbac/resolve";
import { getVisitDetail, resolveScope, canAccessSales, cekRuteKunjungan } from "@/lib/form-kontrol";
import { witaToday } from "@/lib/beranda";

export async function GET(req: Request) {
    const gate = await requirePermissionH("form_kontrol.view");
    if (gate.response) return gate.response;
    const session = gate.session;

    try {
        const { searchParams } = new URL(req.url);
        const salesCode = searchParams.get("salesCode") ?? "";
        const custCode  = searchParams.get("custCode") ?? "";
        const principle = searchParams.get("principle") ?? "";
        const date      = searchParams.get("date") ?? new Date().toISOString().slice(0, 10);

        if (!salesCode || !custCode || !principle) {
            return NextResponse.json({ error: "salesCode, custCode and principle are required" }, { status: 400 });
        }
        const scope = await resolveScope(session);
        if (!canAccessSales(scope, salesCode)) {
            return NextResponse.json({ error: "Forbidden" }, { status: 403 });
        }
        const detail = await getVisitDetail(salesCode, custCode, principle, date);
        if (!detail) return NextResponse.json({ error: "Store not found" }, { status: 404 });
        // FK-MSM3: toko tidak di rute tanggal ini (dan belum punya baris AO) → layar menampilkan penjelasan, bukan wizard check-in.
        const galat = await cekRuteKunjungan({ salesCode, custCode, principle, date, penulis: { pemilik: scope.salesCode === salesCode, hariIni: witaToday() } });
        return NextResponse.json({ ...detail, bukanRute: galat ? { kode: galat.kode, error: galat.error } : null });
    } catch {
        return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }
}
