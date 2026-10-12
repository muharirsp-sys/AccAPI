/*
 * Tujuan: Aktif/nonaktif satu principal (S7-2, BL-64). TIDAK ada jalur ubah `code` (400 KODE_TETAP; trigger S7-0 menjaga di DB)
 *   maupun ubah nama. Kontrak: docs/handover/S7-2-KONTRAK-PRINCIPAL-API.md.
 * Caller: layar S7b Data principal.
 * Dependensi: lib/principal/tulis.ts, requirePermission (principles.upload).
 * Main Functions: PATCH { isActive }.
 * Side Effects: UPDATE principal.is_active + principal_log (satu transaksi); status sama = tanpa perubahan.
 */
import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/rbac/resolve";
import { bacaBody, hanyaKunci, jawabGalat, ubahAktifPrincipal } from "@/lib/principal/tulis";

type Context = { params: Promise<{ id: string }> };

export async function PATCH(request: NextRequest, context: Context) {
    const gate = await requirePermission(request, "principles.upload");
    if (gate.response) return gate.response;
    try {
        const { id } = await context.params;
        const body = await bacaBody(request);
        hanyaKunci(body, ["isActive"]);
        return NextResponse.json({ ok: true, ...(await ubahAktifPrincipal(id, body.isActive, gate.session.user.id)) });
    } catch (error) {
        return jawabGalat(error, "PATCH");
    }
}
