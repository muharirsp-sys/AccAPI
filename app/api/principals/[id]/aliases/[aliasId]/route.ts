/*
 * Tujuan: Hapus satu alias principal (S7-2, BL-64); alias kode principal tidak bisa dihapus (409 ALIAS_KODE_TETAP).
 *   Kontrak: docs/handover/S7-2-KONTRAK-PRINCIPAL-API.md.
 * Caller: layar S7b Data principal.
 * Dependensi: lib/principal/tulis.ts hapusAlias, requirePermission (principles.delete).
 * Main Functions: DELETE.
 * Side Effects: DELETE principal_alias + principal_log (isi lama) dalam satu transaksi.
 */
import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/rbac/resolve";
import { hapusAlias, jawabGalat } from "@/lib/principal/tulis";

type Context = { params: Promise<{ id: string; aliasId: string }> };

export async function DELETE(request: NextRequest, context: Context) {
    const gate = await requirePermission(request, "principles.delete");
    if (gate.response) return gate.response;
    try {
        const { id, aliasId } = await context.params;
        return NextResponse.json({ ok: true, ...(await hapusAlias(id, aliasId, gate.session.user.id)) });
    } catch (error) {
        return jawabGalat(error, "ALIAS DELETE");
    }
}
