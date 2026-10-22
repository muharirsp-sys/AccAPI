/*
 * Tujuan: API tab "Top 30" /laporan-sales: 30 produk + 30 pelanggan teratas sebulan menurut nilai (DPP) atau qty (kontrak JawabanTop30).
 * Caller: app/(dashboard)/laporan-sales/tab/Top30.tsx — GET /api/laporan-sales/top30?bulan=YYYY-MM&principle=&urut=nilai|qty.
 * Dependensi: lib/rbac/resolve (requirePermissionH), lib/laporan-sales/{kontrak,top30}.
 * Main Functions: GET.
 * Side Effects: DB read-only sales-history-inv.db. Izin sales_history.view (cakupan History Penjualan = seluruh perusahaan).
 */
import { NextRequest, NextResponse } from "next/server";
import { requirePermissionH } from "@/lib/rbac/resolve";
import { bulanSah } from "@/lib/laporan-sales/kontrak";
import { laporanTop30 } from "@/lib/laporan-sales/top30";

export const runtime = "nodejs";

const TANPA_SIMPAN = { "Cache-Control": "private, no-store" };
const galat = (error: string, status: number) => NextResponse.json({ error }, { status, headers: TANPA_SIMPAN });

export async function GET(request: NextRequest) {
    const gate = await requirePermissionH("sales_history.view");
    if (gate.response) return gate.response;

    const params = new URL(request.url).searchParams;
    const bulan = params.get("bulan");
    if (!bulanSah(bulan)) return galat("Parameter 'bulan' wajib berformat YYYY-MM.", 400);
    const urut = params.get("urut") || "nilai";
    if (urut !== "nilai" && urut !== "qty") return galat("Parameter 'urut' harus 'nilai' atau 'qty'.", 400);
    const principle = (params.get("principle") || "").trim();
    if (principle.length > 100) return galat("Parameter 'principle' terlalu panjang.", 400);

    try {
        return NextResponse.json(await laporanTop30(bulan, principle || null, urut), { headers: TANPA_SIMPAN });
    } catch (error) {
        console.error("[LAPORAN SALES TOP30 ERROR]", error);
        return galat("Laporan Top 30 gagal dimuat.", 500);
    }
}
