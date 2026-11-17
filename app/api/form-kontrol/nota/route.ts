/*
 * Tujuan: Nota belum lunas toko kunjungan (owner 16 Nov 2026) — GET ?salesCode=&custCode=&principle= -> { ok, nota: NotaToko | null }.
 *   Dibaca LANGSUNG dari Accurate (sisa sesudah pelunasan Incaso), cadangan cache bila Accurate tidak terbaca (sumber "sinkron").
 * Caller: app/(dashboard)/form-kontrol/visit/[custCode]/Nota.tsx (panel kunjungan + pertanyaan tagihan di langkah Status).
 * Dependensi: lib/rbac/resolve (form_kontrol.view), lib/form-kontrol (resolveScope, canAccessSales), lib/form-kontrol/nota-db, lib/beranda witaToday.
 * Side Effects: GET Accurate (baca-saja) + SELECT cache. Terpisah dari GET visit supaya kunjungan tetap terbuka cepat bila Accurate lambat.
 */
import { NextResponse } from "next/server";
import { requirePermissionH } from "@/lib/rbac/resolve";
import { canAccessSales, resolveScope } from "@/lib/form-kontrol";
import { bacaNotaToko } from "@/lib/form-kontrol/nota-db";
import { witaToday } from "@/lib/beranda";

export async function GET(req: Request) {
    const gate = await requirePermissionH("form_kontrol.view");
    if (gate.response) return gate.response;
    try {
        const q = new URL(req.url).searchParams;
        const salesCode = q.get("salesCode")?.trim() ?? "", custCode = q.get("custCode")?.trim() ?? "", principle = q.get("principle")?.trim() ?? "";
        if (!salesCode || !custCode || !principle) {
            return NextResponse.json({ ok: false, kode: "INPUT_TIDAK_VALID", error: "salesCode, custCode, dan principle wajib." }, { status: 400 });
        }
        if (!canAccessSales(await resolveScope(gate.session), salesCode)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
        return NextResponse.json({ ok: true, nota: await bacaNotaToko(custCode, principle, witaToday()) });
    } catch {
        return NextResponse.json({ ok: false, kode: "NOTA_TIDAK_TERBACA", error: "Nota belum lunas tidak terbaca dari Accurate maupun data sinkron." }, { status: 503 });
    }
}
