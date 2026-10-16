/*
 * Tujuan: Tutup hari Kasir ↔ Incaso (K2a, BL-59): hanya bila status baca `lengkap` ∧ `lengkap_pada` ≤ 15 mnt (FOR SHARE), tidak ada
 *   selisih / tak teralokasi yang belum dijelaskan, dan sidik angka klien = server. Snapshot hari disimpan (CHECK tutup_tuntas).
 * Caller: K2b dialog `tutup` di /kasir. Kontrak: docs/handover/KASIR-KONTRAK.md §8.6.
 * Dependensi: lib/kasir/hari (uraiTutup, tutupHari), lib/rbac/resolve (kasir.tutup).
 * Main Functions: POST { tanggal, sidik } -> 200 { event } | { sudahDitutup } | 400 | 409 BACA_BELUM_SEGAR / TERHALANG / ANGKA_BERUBAH /
 *   HARI_TERKUNCI | 503 SESI_SINKRON | 500 | 502 TIDAK_PASTI.
 * Side Effects: INSERT kasir_hari_event `tutup` (append-only). TANPA Accurate.
 */
import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/rbac/resolve";
import { bawaanHari, jawabanGalat, tutupHari, uraiTutup } from "@/lib/kasir/hari";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
    const gate = await requirePermission(request, "kasir.tutup");
    if (gate.response) return gate.response;
    try {
        const isian = uraiTutup(await request.json().catch(() => null), bawaanHari.sekarang());
        return NextResponse.json({ ok: true, ...(await tutupHari(isian, gate.session.user.id, bawaanHari)) });
    } catch (e) {
        const j = jawabanGalat(e, "[KASIR TUTUP]");
        return NextResponse.json(j.body, { status: j.http });
    }
}
