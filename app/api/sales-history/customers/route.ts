/*
 * Tujuan: Daftar Customer untuk Tahun/Principal (level cascade ketiga), nama/alamat fresh dari customer_map.
 * Caller: app/(dashboard)/sales-history/page.tsx (dropdown Customer async-search; hanya faktur INV).
 * Dependensi: lib/sales-history/service.ts, RBAC resolve.
 * Main Functions: GET.
 * Side Effects: DB read-only sales-history-inv.db.
 * Catatan: query service join invoice_map -> customer_map; nama/alamat dari mapping, bukan data penjualan lama.
 */
import { NextRequest, NextResponse } from "next/server";
import { requirePermissionH } from "@/lib/rbac/resolve";
import { isValidSalesHistoryYear, listSalesHistoryCustomers, normalizePositiveInt } from "@/lib/sales-history/service";

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
        const customers = await listSalesHistoryCustomers({
            year,
            principal: (searchParams.get("principal") || "").trim(),
            q: (searchParams.get("q") || "").trim(),
            limit: normalizePositiveInt(searchParams.get("limit"), 50, 200),
        });
        return NextResponse.json({ ok: true, customers });
    } catch (error) {
        console.error("[SALES HISTORY CUSTOMERS ERROR]", error);
        return NextResponse.json({ ok: false, error: "Gagal memuat customer." }, { status: 500 });
    }
}