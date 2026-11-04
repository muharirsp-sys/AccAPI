/*
 * Tujuan: Pratinjau satu nomor faktur untuk layar Potong Tagihan Incaso (owner 3 Nov 2026): pelanggan, sisa tagihan tersinkron,
 *   potongan OPC yang sudah tercatat, sisa yang masih bisa dipotong, dan apakah pelanggannya cocok dengan toko item.
 *   Hanya pratinjau; aturan yang mengikat tetap diperiksa ulang di route finance-payment saat menyimpan.
 * Caller: app/(dashboard)/off-program-control/opc/peran/Incaso.tsx.
 * Dependensi: lib/off-program-control/potong-tagihan{,-db}.
 * Main Functions: GET.
 * Side Effects: baca DB saja.
 */
import { NextResponse } from "next/server";
import { cariFakturPotong, potonganTerpakai } from "@/lib/off-program-control/potong-tagihan-db";
import { cocokPelanggan, nomorFakturKunci } from "@/lib/off-program-control/potong-tagihan";
import { requirePermissionH } from "@/lib/rbac/resolve";

export async function GET(request: Request) {
    const gate = await requirePermissionH("off_program_control.potong_tagihan");
    if (gate.response) return gate.response;
    const url = new URL(request.url);
    const no = String(url.searchParams.get("no") || "").trim().slice(0, 80);
    const toko = String(url.searchParams.get("toko") || "");
    if (!no) return NextResponse.json({ ok: false, error: "Nomor faktur wajib diisi." }, { status: 400 });
    try {
        const hasil = (await cariFakturPotong([no])).get(nomorFakturKunci(no)) ?? [];
        if (hasil.length === 0) return NextResponse.json({ ok: true, ditemukan: false });
        if (new Set(hasil.map((f) => f.id)).size > 1) return NextResponse.json({ ok: true, ditemukan: true, ganda: true });
        const f = hasil[0];
        const terpakai = (await potonganTerpakai([f.number])).get(nomorFakturKunci(f.number)) ?? 0;
        return NextResponse.json({
            ok: true, ditemukan: true, ganda: false,
            faktur: {
                number: f.number, customerNo: f.customerNo, customerName: f.customerName, outstanding: f.outstanding, terpakai,
                sisa: f.outstanding == null ? null : Math.max(0, f.outstanding - terpakai),
                cocok: cocokPelanggan(toko, f.customerNo, f.customerName),
            },
        });
    } catch (error) {
        console.error("[OFF FAKTUR POTONG ERROR]", error);
        return NextResponse.json({ ok: false, error: "Gagal membaca data faktur." }, { status: 500 });
    }
}
