import { NextResponse } from "next/server";
import { requirePermissionH } from "@/lib/rbac/resolve";
import { saveCheckin, resolveScope, canAccessSales } from "@/lib/form-kontrol";
import { jawabGalat } from "@/lib/order-cabang";
import { witaToday } from "@/lib/beranda";

export async function POST(req: Request) {
    const gate = await requirePermissionH("form_kontrol.submit");
    if (gate.response) return gate.response;
    const session = gate.session;

    try {
        const body = await req.json();
        const { salesCode, custCode, principle, date, photoUrl, lat, lng, accuracy } = body;
        if (!salesCode || !custCode || !principle || !date || !photoUrl) {
            return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
        }
        const scope = await resolveScope(session);
        if (!canAccessSales(scope, salesCode)) {
            return NextResponse.json({ error: "Forbidden" }, { status: 403 });
        }
        // FK-MSM3: toko di luar rute tanggal itu (mis. kunjungan luar rute yang sudah dibatalkan) → 409 berkode, tanpa baris AO.
        const hasil = await saveCheckin({
            salesCode, custCode, principle, date, photoUrl, createdBy: session.user.id,
            penulis: { pemilik: scope.salesCode === salesCode, hariIni: witaToday() },
            lat: typeof lat === "number" ? lat : null,
            lng: typeof lng === "number" ? lng : null,
            accuracy: typeof accuracy === "number" ? accuracy : null,
        });
        if ("galat" in hasil) return jawabGalat(hasil.galat);
        return NextResponse.json({ success: true, id: hasil.id });
    } catch {
        return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }
}
