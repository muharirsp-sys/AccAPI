/*
 * Tujuan: Laporan ABCPI dari layar Laporan Harian — riwayat putaran, unduh pratinjau (tanpa kirim), kirim manual (closing akhir bulan
 *   atau kirim ulang). Tarik data Accurate saat itu juga.
 * Caller: app/(dashboard)/laporan-harian/AbcpiKirim.tsx.
 * Dependensi: requirePermission (laporan_harian.view / .send), lib/abcpi/jalankan.
 * Main Functions: GET (?pratinjau=YYYY-MM-DD → xlsx; tanpa parameter → riwayat), POST { tanggal, confirm: true } → kirim FTP + email.
 * Side Effects: GET baca Accurate; POST unggah FTP ABC, email penerima ABCPI dan admin, arsip data/abcpi.
 */
import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/rbac/resolve";
import { jalankanAbcpi, riwayatAbcpi } from "@/lib/abcpi/jalankan";

export const runtime = "nodejs";
export const maxDuration = 900;

export async function GET(req: NextRequest) {
    const gate = await requirePermission(req, "laporan_harian.view");
    if (gate.response) return gate.response;
    const tanggal = req.nextUrl.searchParams.get("pratinjau");
    if (!tanggal) return NextResponse.json({ riwayat: await riwayatAbcpi() });
    try {
        const hasil = await jalankanAbcpi({ tanggal, kirim: false, sumber: "manual" });
        if (!hasil.xlsx) return NextResponse.json(hasil, { status: 502 });
        return new NextResponse(new Uint8Array(hasil.xlsx), { headers: {
            "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "Content-Disposition": `attachment; filename="PRATINJAU_ABCPI_SP_${tanggal.replaceAll("-", "")}.xlsx"`,
            "X-Abcpi-Galat": encodeURIComponent(hasil.galat.join(" | ")).slice(0, 2000),
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
        return NextResponse.json({ status: "gagal", galat: ["Konfirmasi wajib: { tanggal: 'YYYY-MM-DD', confirm: true }"] }, { status: 400 });
    }
    try {
        const hasil = await jalankanAbcpi({ tanggal: body.tanggal, kirim: true, sumber: "manual" });
        return NextResponse.json(hasil, { status: hasil.status === "terkirim" ? 200 : 502 });
    } catch (e) {
        return NextResponse.json({ status: "gagal", galat: [(e as Error).message] }, { status: 409 });
    }
}
