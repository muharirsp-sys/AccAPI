/*
 * Tujuan: Tambah alias (ejaan lain) untuk satu principal / varian (S7-2, BL-64). alias_norm dihitung server dengan normalizer baku;
 *   tabrakan = 409 berkode, tak pernah menimpa. Kontrak: docs/handover/S7-2-KONTRAK-PRINCIPAL-API.md.
 * Caller: layar S7b Data principal.
 * Dependensi: lib/principal/tulis.ts tambahAlias, requirePermission (principles.upload).
 * Main Functions: POST { alias, jenis, sumber?, variantKey? }.
 * Side Effects: principal_alias + principal_log dalam satu transaksi.
 */
import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/rbac/resolve";
import { bacaBody, jawabGalat, tambahAlias } from "@/lib/principal/tulis";

type Context = { params: Promise<{ id: string }> };

export async function POST(request: NextRequest, context: Context) {
    const gate = await requirePermission(request, "principles.upload");
    if (gate.response) return gate.response;
    try {
        const { id } = await context.params;
        return NextResponse.json({ ok: true, ...(await tambahAlias(id, await bacaBody(request), gate.session.user.id)) }, { status: 201 });
    } catch (error) {
        return jawabGalat(error, "ALIAS POST");
    }
}
