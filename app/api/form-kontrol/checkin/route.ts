import { NextResponse } from "next/server";
import { requirePermissionH } from "@/lib/rbac/resolve";
import { saveCheckin, resolveScope, canAccessSales } from "@/lib/form-kontrol";
import { jawabGalat } from "@/lib/order-cabang";
import { periksaGps } from "@/lib/form-kontrol/gps";
import { periksaLokasiKunjungan } from "@/lib/form-kontrol/lokasi-db";
import { witaToday } from "@/lib/beranda";

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
        // Owner 14 Nov 2026: GPS wajib saat check-in (titik salesman = bahan analisa kunjungan + briefing); tanpa titik = 400 berkode.
        const gps = periksaGps({ lat, lng, accuracy }, "check-in");
        if ("galat" in gps) return jawabGalat(gps.galat);
        const scope = await resolveScope(session);
        if (!canAccessSales(scope, salesCode)) {
            return NextResponse.json({ error: "Forbidden" }, { status: 403 });
        }
        // Owner 14 Nov 2026: radius titik toko (fix 20 m / validasi 100 m); di luar radius = 409 DI_LUAR_RADIUS, atau ajuan ke IT bila beralasan.
        const lokasi = await periksaLokasiKunjungan(custCode, gps.titik, alasanLuarRadius, "checkin", session.user.id);
        if ("galat" in lokasi) return jawabGalat(lokasi.galat);
        // FK-MSM3: toko di luar rute tanggal itu (mis. kunjungan luar rute yang sudah dibatalkan) → 409 berkode, tanpa baris AO.
        const hasil = await saveCheckin({
            salesCode, custCode, principle, date, photoUrl, createdBy: session.user.id,
            penulis: { pemilik: scope.salesCode === salesCode, hariIni: witaToday() },
            lat: gps.titik.lat, lng: gps.titik.lng, accuracy: gps.titik.accuracy, ajuan: lokasi.ajuan,
        });
        if ("galat" in hasil) return jawabGalat(hasil.galat);
        return NextResponse.json({ success: true, id: hasil.id, diajukanKeIt: Boolean(lokasi.ajuan) });
    } catch {
        return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }
}
