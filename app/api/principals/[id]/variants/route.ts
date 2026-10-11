/*
 * Tujuan: Tambah varian dan aktif/nonaktif varian satu principal (S7-2, BL-64; KINO NON_FOOD, FORISA MT/GT, HEINZ HZ/BS).
 *   Kontrak: docs/handover/S7-2-KONTRAK-PRINCIPAL-API.md.
 * Caller: layar S7b Data principal.
 * Dependensi: lib/principal/tulis.ts, requirePermission (principles.upload).
 * Main Functions: POST { variantKey, name? }, PATCH { variantKey, isActive }.
 * Side Effects: principal_variant (+ alias nama varian) + principal_log dalam satu transaksi.
 */
import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/rbac/resolve";
import { bacaBody, hanyaKunci, jawabGalat, tambahVarian, ubahAktifVarian } from "@/lib/principal/tulis";

type Context = { params: Promise<{ id: string }> };

export async function POST(request: NextRequest, context: Context) {
    const gate = await requirePermission(request, "principles.upload");
    if (gate.response) return gate.response;
    try {
        const { id } = await context.params;
        return NextResponse.json({ ok: true, ...(await tambahVarian(id, await bacaBody(request), gate.session.user.id)) }, { status: 201 });
    } catch (error) {
        return jawabGalat(error, "VARIAN POST");
    }
}

export async function PATCH(request: NextRequest, context: Context) {
    const gate = await requirePermission(request, "principles.upload");
    if (gate.response) return gate.response;
    try {
        const { id } = await context.params;
        const body = await bacaBody(request);
        hanyaKunci(body, ["variantKey", "isActive"]);
        return NextResponse.json({ ok: true, ...(await ubahAktifVarian(id, body, gate.session.user.id)) });
    } catch (error) {
        return jawabGalat(error, "VARIAN PATCH");
    }
}
