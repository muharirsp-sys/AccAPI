/*
 * Tujuan: Foto toko NOO dari folder PRIVAT (data/private/noo) — hanya untuk akun yang boleh membaca NOO itu (salesman pengaju, SPV/SM tim,
 *   Admin/Admin Sales berizin kelola). Bukan foto KTP (KTP hanya lewat POST …/ktp yang dicatat audit).
 * Caller: <img src="/api/form-kontrol/noo/<id>/foto-toko"> di app/(dashboard)/form-kontrol/tabs/TabNoo.tsx.
 * Dependensi: lib/form-kontrol/noo (aksesNoo, bacaFotoToko), lib/order-cabang (jawabGalat).
 * Main Functions: GET.
 * Side Effects: Baca berkas; tidak menulis. `private, no-store` (tidak disimpan proxy/peramban bersama).
 */
import { NextResponse } from "next/server";
import { requirePermissionH } from "@/lib/rbac/resolve";
import { aksesNoo, bacaFotoToko } from "@/lib/form-kontrol/noo";
import { jawabGalat } from "@/lib/order-cabang";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
    const gate = await requirePermissionH("form_kontrol.view");
    if (gate.response) return gate.response;
    try {
        const { id } = await params;
        const hasil = await bacaFotoToko({ id, a: await aksesNoo(gate.session, gate.perms!) });
        if ("galat" in hasil) return jawabGalat(hasil.galat);
        return new NextResponse(new Uint8Array(hasil.foto), { headers: { "Content-Type": "image/jpeg", "Cache-Control": "private, no-store" } });
    } catch {
        return NextResponse.json({ ok: false, error: "Internal server error" }, { status: 500 });
    }
}
