/*
 * Tujuan: Laporan Sales › Target vs Realisasi — target insentif vs realisasi DPP MTD per cabang × principal untuk satu bulan
 *   (kontrak lib/laporan-sales/kontrak.ts JawabanTarget; hitungan lib/laporan-sales/target.ts, sumber lib/insentif-sales = dashboard Insentif).
 * Caller: app/(dashboard)/laporan-sales/tab/Target.tsx.
 * Dependensi: lib/rbac/resolve (insentif_sales.view_all = seluruh perusahaan, tanpa penyaringan per orang), lib/laporan-sales/{kontrak,target}.
 * Main Functions: GET ?bulan=YYYY-MM -> JawabanTarget; 400 { error } bila bulan tidak sah; 500 { error } tanpa detail.
 * Side Effects: tidak ada (baca saja).
 */
import { NextResponse } from "next/server";
import { requirePermissionH } from "@/lib/rbac/resolve";
import { bulanSah } from "@/lib/laporan-sales/kontrak";
import { muatTarget } from "@/lib/laporan-sales/target";

export async function GET(req: Request) {
    const gate = await requirePermissionH("insentif_sales.view_all");
    if (gate.response) return gate.response;
    const bulan = new URL(req.url).searchParams.get("bulan");
    if (!bulanSah(bulan)) return NextResponse.json({ error: "Parameter bulan harus YYYY-MM." }, { status: 400 });
    try {
        return NextResponse.json(await muatTarget(bulan), { headers: { "Cache-Control": "private, no-store" } });
    } catch (e) {
        console.error("[laporan-sales/target] gagal memuat:", e instanceof Error ? e.message : e);
        return NextResponse.json({ error: "Gagal memuat Target vs Realisasi." }, { status: 500 });
    }
}
