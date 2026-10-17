/*
 * Tujuan: GET ringkasan Kasir untuk tile Beranda (K3, BL-59) — selisih belum dijelaskan, salesman belum menyetor, hari belum ditutup,
 *   plus status baca Incaso. Angka Incaso null (BUKAN nol) bila status baca ≠ lengkap. Baca-saja: cache K1b + kasir_*, TANPA Accurate.
 * Caller: lib/beranda.ts SOURCES.kasir (profil Beranda Kasir). Kontrak: docs/handover/KASIR-KONTRAK.md §9.
 * Dependensi: lib/kasir/ringkasan (muatRingkasan), lib/kasir/hari (uraiTanggal, jawabanGalat), lib/rbac/resolve (kasir.view).
 * Main Functions: GET ?tanggal= -> 200 RingkasanKasir | 400 INPUT_SALAH | 500 GALAT_INTERNAL | 422 ANGKA_TIDAK_SAH.
 * Side Effects: SELECT saja (tanpa menulis kunci otomatis).
 */
import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/rbac/resolve";
import { bawaanHari, jawabanGalat, uraiTanggal } from "@/lib/kasir/hari";
import { muatRingkasan } from "@/lib/kasir/ringkasan";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
    const gate = await requirePermission(request, "kasir.view");
    if (gate.response) return gate.response;
    try {
        const tanggal = uraiTanggal(request.nextUrl.searchParams.get("tanggal"), bawaanHari.sekarang());
        return NextResponse.json(await muatRingkasan(tanggal, bawaanHari));
    } catch (e) {
        const j = jawabanGalat(e, "[KASIR RINGKASAN]");
        return NextResponse.json(j.body, { status: j.http });
    }
}
