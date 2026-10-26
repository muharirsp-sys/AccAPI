/*
 * Tujuan: Laporan Enigma dari layar Laporan Harian — riwayat, unduh pratinjau (tanpa unggah), unggah manual (mis. closing bulan lalu).
 * Caller: app/(dashboard)/laporan-harian/KirimPrincipal.tsx (kode "enigma").
 * Dependensi: requirePermission (laporan_harian.view / .send), lib/enigma/jalankan.
 * Main Functions: GET (?pratinjau=YYYY-MM-DD → xlsx; tanpa parameter → riwayat), POST { tanggal, confirm: true } → unggah portal.
 * Side Effects: GET baca Accurate; POST unggah ke enigma.enesis.com dan email admin.
 */
import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/rbac/resolve";
import { jalankanEnigma, riwayatEnigma } from "@/lib/enigma/jalankan";

export const runtime = "nodejs";
export const maxDuration = 1800;

export async function GET(req: NextRequest) {
    const gate = await requirePermission(req, "laporan_harian.view");
    if (gate.response) return gate.response;
    const tanggal = req.nextUrl.searchParams.get("pratinjau");
    if (!tanggal) return NextResponse.json({ riwayat: await riwayatEnigma() });
    try {
        const hasil = await jalankanEnigma({ tanggal, kirim: false, sumber: "manual" });
        if (!hasil.xlsx) return NextResponse.json(hasil, { status: 502 });
        return new NextResponse(new Uint8Array(hasil.xlsx), { headers: {
            "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "Content-Disposition": `attachment; filename="PRATINJAU_ENIGMA_${tanggal.replaceAll("-", "")}.xlsx"`,
        } });
    } catch (e) {
        return NextResponse.json({ status: "gagal", galat: [(e as Error).message] }, { status: 409 });
    }
}

export async function POST(req: NextRequest) {
    const gate = await requirePermission(req, "laporan_harian.send");
    if (gate.response) return gate.response;
    const body = await req.json().catch(() => ({})) as { tanggal?: unknown; confirm?: unknown };
    if (body.confirm !== true || typeof body.tanggal !== "string") {
        return NextResponse.json({ status: "gagal", galat: ["Konfirmasi wajib: { tanggal: 'YYYY-MM-DD', confirm: true }"], peringatan: [] }, { status: 400 });
    }
    try {
        const hasil = await jalankanEnigma({ tanggal: body.tanggal, kirim: true, sumber: "manual" });
        return NextResponse.json(hasil, { status: hasil.status === "terkirim" ? 200 : 502 });
    } catch (e) {
        return NextResponse.json({ status: "gagal", galat: [(e as Error).message], peringatan: [] }, { status: 409 });
    }
}
