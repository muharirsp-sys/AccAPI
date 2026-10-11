/*
 * Tujuan: Riwayat principal_log satu principal (S7-2, BL-64), terbaru dulu, keyset `?sebelum=<id>&batas=<1..200>`.
 * Caller: layar S7b Data principal (bagian Riwayat).
 * Dependensi: lib/principal/tulis.ts riwayatPrincipal, requirePermission (principles.view).
 * Main Functions: GET.
 * Side Effects: DB read-only.
 */
import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/rbac/resolve";
import { jawabGalat, riwayatPrincipal } from "@/lib/principal/tulis";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, context: Context) {
    const gate = await requirePermission(request, "principles.view");
    if (gate.response) return gate.response;
    try {
        const { id } = await context.params;
        const q = request.nextUrl.searchParams;
        const angka = (k: string) => (/^\d{1,15}$/.test(q.get(k) ?? "") ? Number(q.get(k)) : undefined);
        return NextResponse.json({ ok: true, ...(await riwayatPrincipal(id, { sebelum: angka("sebelum"), batas: angka("batas") })) });
    } catch (error) {
        return jawabGalat(error, "HISTORY");
    }
}
