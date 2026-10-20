/*
 * Tujuan: Laporan Sales › Monitoring Harian — nilai DPP faktur INV per (pelanggan, salesman) per tanggal sebulan + MTD
 *   (kontrak lib/laporan-sales/kontrak.ts JawabanHarian; sumber Postgres sales_invoice).
 * Caller: app/(dashboard)/laporan-sales/tab/Harian.tsx.
 * Dependensi: lib/rbac/resolve (supervisor_review.view), lib/form-kontrol/scope resolveScope (cakupan hierarki: SPV timnya, SM bawahannya,
 *   Admin/Manager semua — cakupan TIDAK dipercaya dari klien), lib/laporan-sales/harian.
 * Main Functions: GET ?bulan=YYYY-MM&cabang= -> JawabanHarian. Side Effects: tidak ada (baca saja).
 */
import { NextResponse } from "next/server";
import { requirePermissionH } from "@/lib/rbac/resolve";
import { resolveScope } from "@/lib/form-kontrol/scope";
import { bulanSah } from "@/lib/laporan-sales/kontrak";
import { muatHarian } from "@/lib/laporan-sales/harian";

export async function GET(req: Request) {
    const gate = await requirePermissionH("supervisor_review.view");
    if (gate.response) return gate.response;
    const q = new URL(req.url).searchParams;
    const bulan = q.get("bulan");
    if (!bulanSah(bulan)) return NextResponse.json({ error: "Parameter bulan harus YYYY-MM." }, { status: 400 });
    try {
        const scope = await resolveScope(gate.session);
        // Cakupan non-global KOSONG = akun belum tertaut Hierarki: pesan jelas, bukan tabel kosong yang menyesatkan.
        if (scope.allowedSalesCodes?.length === 0) {
            return NextResponse.json({ kode: "HIERARKI_BELUM_TERTAUT", error: "Akun belum tertaut ke hierarki — hubungi Admin." }, { status: 403 });
        }
        const jawaban = await muatHarian(scope, { bulan, cabang: q.get("cabang")?.trim() || null });
        return NextResponse.json(jawaban, { headers: { "Cache-Control": "private, no-store" } });
    } catch (e) {
        console.error("[laporan-sales/harian] gagal memuat:", e instanceof Error ? e.message : e);
        return NextResponse.json({ error: "Gagal memuat Monitoring Harian." }, { status: 500 });
    }
}
