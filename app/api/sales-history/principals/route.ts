/*
 * Tujuan: Daftar Principal (level cascade kedua) dari invoice_map, opsional terfilter Tahun, hanya faktur INV.
 * Caller: app/(dashboard)/sales-history/page.tsx (dropdown Principal setelah Tahun).
 * Dependensi: lib/sales-history/service.ts, RBAC resolve.
 * Main Functions: GET.
 * Side Effects: DB read-only sales-history-inv.db.
 * Catatan: filter tahun memakai range tanggal di service agar index tanggal efektif.
 */
import { NextRequest, NextResponse } from "next/server";
import { requirePermissionH } from "@/lib/rbac/resolve";
import { isValidSalesHistoryYear, listSalesHistoryPrincipals } from "@/lib/sales-history/service";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
    const gate = await requirePermissionH("sales_history.view");
    if (gate.response) return gate.response;

    try {
        const { searchParams } = new URL(request.url);
        const year = (searchParams.get("year") || "").trim();
        if (!isValidSalesHistoryYear(year)) {
            return NextResponse.json({ ok: false, error: "Parameter 'year' tidak valid." }, { status: 400 });
        }
        return NextResponse.json({ ok: true, principals: await listSalesHistoryPrincipals({ year }) });
    } catch (error) {
        console.error("[SALES HISTORY PRINCIPALS ERROR]", error);
        return NextResponse.json({ ok: false, error: "Gagal memuat principal." }, { status: 500 });
    }
}