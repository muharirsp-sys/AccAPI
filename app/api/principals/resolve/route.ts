/*
 * Tujuan: Resolver principal lewat HTTP (S7-2, BL-64): `?teks=&ruang=nama|kode_master_barang` -> cocok | tak_dikenal | ambigu.
 *   Untuk pemakai luar (Python tahap 2) agar SATU normalizer dipakai. Kontrak: docs/handover/S7-2-KONTRAK-PRINCIPAL-API.md.
 * Caller: pemakai S7-2b / Python (lewat HTTP, pola outlet_channel.py).
 * Dependensi: lib/principal/tulis.ts resolveTeks, requirePermission (principles.view).
 * Main Functions: GET.
 * Side Effects: DB read-only.
 */
import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/rbac/resolve";
import { jawabGalat, resolveTeks } from "@/lib/principal/tulis";

export async function GET(request: NextRequest) {
    const gate = await requirePermission(request, "principles.view");
    if (gate.response) return gate.response;
    try {
        const q = request.nextUrl.searchParams;
        return NextResponse.json({ ok: true, hasil: await resolveTeks(q.get("teks"), q.get("ruang")) });
    } catch (error) {
        return jawabGalat(error, "RESOLVE");
    }
}
