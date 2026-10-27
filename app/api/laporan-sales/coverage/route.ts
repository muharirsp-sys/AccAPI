/*
 * Tujuan: Laporan Sales — Coverage Ganda: toko JKS aktif yang dilayani > 1 salesman (principal sama). Tanpa bulan: JKS = rute berlaku sekarang.
 * Caller: app/(dashboard)/laporan-sales/tab/Coverage.tsx (kontrak lib/laporan-sales/kontrak.ts JawabanCoverage).
 * Dependensi: lib/rbac/resolve (supervisor_review.view), lib/form-kontrol/scope resolveScope, lib/laporan-sales/coverage.
 * Main Functions: GET ?principle= -> JawabanCoverage. Side Effects: tidak ada (baca saja).
 * Cakupan dari sesi (resolveScope), BUKAN dari parameter klien. Non-global tanpa salesman tertaut = 403 HIERARKI_BELUM_TERTAUT.
 */
import { NextResponse } from "next/server";
import { requirePermissionH } from "@/lib/rbac/resolve";
import { resolveScope } from "@/lib/form-kontrol/scope";
import { muatCoverage } from "@/lib/laporan-sales/coverage";

export async function GET(req: Request) {
    const gate = await requirePermissionH("supervisor_review.view");
    if (gate.response) return gate.response;
    const principle = new URL(req.url).searchParams.get("principle")?.trim() || null;
    if (principle && principle.length > 100) return NextResponse.json({ error: "Principal tidak sah." }, { status: 400 });
    try {
        const scope = await resolveScope(gate.session);
        if (scope.allowedSalesCodes !== null && scope.allowedSalesCodes.length === 0) {
            return NextResponse.json({ kode: "HIERARKI_BELUM_TERTAUT", error: "Akun belum tertaut ke hierarki. Hubungi Admin." }, { status: 403 });
        }
        return NextResponse.json(await muatCoverage(scope, principle), { headers: { "Cache-Control": "private, no-store" } });
    } catch (e) {
        console.error("[laporan-sales/coverage] gagal memuat:", e instanceof Error ? e.message : e);
        return NextResponse.json({ error: "Gagal memuat Coverage Ganda." }, { status: 500 });
    }
}
