/*
 * Tujuan: Daftar Tahun (level cascade pertama) dari invoice_map, hanya faktur INV.
 * Caller: app/(dashboard)/sales-history/page.tsx (dropdown Tahun).
 * Dependensi: lib/sales-history/service.ts, RBAC resolve.
 * Main Functions: GET.
 * Side Effects: DB read-only sales-history-inv.db.
 * Catatan: seluruh query tahun dibatasi referensi INV.
 */
import { NextResponse } from "next/server";
import { requirePermissionH } from "@/lib/rbac/resolve";
import { listSalesHistoryYears } from "@/lib/sales-history/service";

export const runtime = "nodejs";

export async function GET() {
    const gate = await requirePermissionH("sales_history.view");
    if (gate.response) return gate.response;

    try {
        return NextResponse.json({ ok: true, years: await listSalesHistoryYears() });
    } catch (error) {
        console.error("[SALES HISTORY YEARS ERROR]", error);
        return NextResponse.json({ ok: false, error: "Gagal memuat tahun." }, { status: 500 });
    }
}