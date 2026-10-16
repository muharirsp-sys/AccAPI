/*
 * Tujuan: GET satu hari Kasir ↔ Incaso (K2a, BL-59) untuk layar /kasir — status hari (kunci 20.00 WITA, event), status baca K1b, baris
 *   per ORANG (pelunasan vs setoran per metode), ember tak teralokasi, non-kas, penghalang Tutup, sidik, riwayat revisi & penjelasan,
 *   pilihan pegawai; `orang=` menambah rincian faktur. Angka Incaso HANYA bila status baca `lengkap` (selain itu null + sebab).
 * Caller: K2b halaman /kasir. Kontrak: docs/handover/KASIR-KONTRAK.md §8.3.
 * Dependensi: lib/kasir/hari (muatHari, uraiTanggal, jawabanGalat, bawaanHari), lib/rbac/resolve (kasir.view).
 * Main Functions: GET ?tanggal=&orang= -> 200 JawabanHari | 400 INPUT_SALAH | 500 GALAT_INTERNAL.
 * Side Effects: SELECT saja, KECUALI kunci 20.00 WITA yang belum dicatat -> INSERT event `kunci` oleh 'sistem' (sekali; gagal tak
 *   menggagalkan GET). TANPA Accurate.
 */
import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/rbac/resolve";
import { bawaanHari, GalatKasir, jawabanGalat, muatHari, uraiTanggal } from "@/lib/kasir/hari";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
    const gate = await requirePermission(request, "kasir.view");
    if (gate.response) return gate.response;
    try {
        const q = request.nextUrl.searchParams;
        const tanggal = uraiTanggal(q.get("tanggal"), bawaanHari.sekarang());
        const orang = q.get("orang");
        if (orang !== null && [...orang].length > 100) throw new GalatKasir(400, "INPUT_SALAH", "Kode orang terlalu panjang.", { field: "orang" });
        return NextResponse.json(await muatHari(tanggal, { orang }, bawaanHari));
    } catch (e) {
        const j = jawabanGalat(e, "[KASIR HARI]");
        return NextResponse.json(j.body, { status: j.http });
    }
}
