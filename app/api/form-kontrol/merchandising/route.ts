import { NextResponse } from "next/server";
import { requirePermissionH } from "@/lib/rbac/resolve";
import { getMerchandisingForDate, saveMerchandising, resolveScope, canAccessSales } from "@/lib/form-kontrol";
import { jawabGalat } from "@/lib/order-cabang";
import { witaToday } from "@/lib/beranda";
import { muatSaranKunjungan } from "@/lib/form-kontrol/item-super-db";
import { periksaTawaran } from "@/lib/form-kontrol/item-super";

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
        if (!salesCode && scope.allowedSalesCodes !== null) {
            return NextResponse.json({ rows: [], total: 0 });
        }
        const rows = await getMerchandisingForDate(salesCode, principle, dateStr);
        return NextResponse.json({ rows, total: rows.length });
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
        const { salesCode, custCode, principle, date } = body;
        if (!salesCode || !custCode || !principle || !date) {
            return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
        }
        const scope = await resolveScope(session);
        if (!canAccessSales(scope, salesCode)) {
            return NextResponse.json({ error: "Forbidden" }, { status: 403 });
        }
        // Item Super (owner 13 Nov 2026): saran dihitung ulang di server; semua saran wajib harus dijawab (ditawarkan/dipesan/alasan).
        const saran = await muatSaranKunjungan({ salesCode, custCode, principle, tanggal: date });
        const cek = periksaTawaran(body.itemSuper ?? null, saran);
        if ("error" in cek) return NextResponse.json({ kode: "ITEM_SUPER_BELUM_LENGKAP", error: cek.error }, { status: 400 });
        const namaBarang = new Map([...saran.wajib, ...saran.lain].map((s) => [s.kodeBarang, s.namaBarang]));
        // FK-MSM3: hanya toko di rute tanggal itu (JKS atau luar rute belum batal) → selain itu 409 berkode.
        const hasil = await saveMerchandising({
            tawaran: cek.baris.map((b) => ({ ...b, namaBarang: namaBarang.get(b.kodeBarang) ?? b.kodeBarang })), dibuatOleh: session.user.id,
            salesCode, custCode, principle, date, penulis: { pemilik: scope.salesCode === salesCode, hariIni: witaToday() },
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
        if ("galat" in hasil) return jawabGalat(hasil.galat);
        return NextResponse.json({ success: true, id: hasil.id });
    } catch {
        return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }
}
