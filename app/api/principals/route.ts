/*
 * Tujuan: Daftar principal resmi (+ varian + alias) dan buat principal baru (S7-2, BL-64). Kontrak:
 *   docs/handover/S7-2-KONTRAK-PRINCIPAL-API.md.
 * Caller: layar S7b Data principal; pemakai S7-2b (principal-mapping, Master Barang, Python lewat HTTP).
 * Dependensi: lib/principal/tulis.ts, requirePermission (principles.view / principles.upload).
 * Main Functions: GET daftar, POST buat principal.
 * Side Effects: POST menulis principal + principal_alias (kode + nama resmi) + principal_log dalam satu transaksi.
 */
import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/rbac/resolve";
import { bacaBody, buatPrincipal, daftarPrincipal, jawabGalat } from "@/lib/principal/tulis";

export async function GET(request: NextRequest) {
    const gate = await requirePermission(request, "principles.view");
    if (gate.response) return gate.response;
    try {
        return NextResponse.json({ ok: true, principals: await daftarPrincipal() });
    } catch (error) {
        return jawabGalat(error, "GET");
    }
}

export async function POST(request: NextRequest) {
    const gate = await requirePermission(request, "principles.upload");
    if (gate.response) return gate.response;
    try {
        const hasil = await buatPrincipal(await bacaBody(request), gate.session.user.id);
        return NextResponse.json({ ok: true, ...hasil }, { status: 201 });
    } catch (error) {
        return jawabGalat(error, "POST");
    }
}
