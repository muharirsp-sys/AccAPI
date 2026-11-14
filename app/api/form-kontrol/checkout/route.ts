import { NextResponse } from "next/server";
import { requirePermissionH } from "@/lib/rbac/resolve";
import { saveCheckout, resolveScope, canAccessSales } from "@/lib/form-kontrol";
import { periksaGps } from "@/lib/form-kontrol/gps";
import { jawabGalat } from "@/lib/order-cabang";
import { periksaLokasiKunjungan } from "@/lib/form-kontrol/lokasi-db";

export async function POST(req: Request) {
    const gate = await requirePermissionH("form_kontrol.submit");
    if (gate.response) return gate.response;
    const session = gate.session;

    try {
        const body = await req.json();
        const { salesCode, custCode, principle, date, photoUrl, lat, lng, accuracy, alasanLuarRadius } = body;
        if (!salesCode || !custCode || !principle || !date || !photoUrl) {
            return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
        }
        // Owner 14 Nov 2026: GPS wajib juga saat check-out (jarak check-out ke toko + lama di toko = analisa kunjungan di Supervisor Review).
        const gps = periksaGps({ lat, lng, accuracy }, "check-out");
        if ("galat" in gps) return jawabGalat(gps.galat);
        if (!canAccessSales(await resolveScope(session), salesCode)) {
            return NextResponse.json({ error: "Forbidden" }, { status: 403 });
        }
        // Owner 14 Nov 2026: radius titik toko juga saat check-out; di luar radius = 409 DI_LUAR_RADIUS, atau ajuan ke IT bila beralasan.
        const lokasi = await periksaLokasiKunjungan(custCode, gps.titik, alasanLuarRadius, "checkout", session.user.id);
        if ("galat" in lokasi) return jawabGalat(lokasi.galat);
        await saveCheckout({ salesCode, custCode, principle, date, photoUrl, ...gps.titik, ajuan: lokasi.ajuan });
        return NextResponse.json({ success: true, diajukanKeIt: Boolean(lokasi.ajuan) });
    } catch {
        return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }
}
