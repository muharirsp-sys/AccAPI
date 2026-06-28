/*
 * Tujuan: Root backend status Sales History: kesiapan DB, jumlah data, rentang tanggal, dan status Elasticsearch.
 * Caller: admin/manual smoke dan halaman Sales History bila perlu health check.
 * Dependensi: lib/sales-history/service.ts, lib/sales-history/search.ts, RBAC resolve.
 * Main Functions: GET.
 * Side Effects: DB read-only sales-history-inv.db; HTTP count Elasticsearch bila env tersedia.
 * Catatan: guard sales_history.view agar data operasional tidak terbuka publik.
 */
import { NextResponse } from "next/server";
import { requirePermissionH } from "@/lib/rbac/resolve";
import { getSalesHistoryDatabaseStatus, listSalesHistoryYears } from "@/lib/sales-history/service";
import { getSalesHistoryElasticsearchStatus } from "@/lib/sales-history/search";

export const runtime = "nodejs";

export async function GET() {
    const gate = await requirePermissionH("sales_history.view");
    if (gate.response) return gate.response;

    try {
        const [database, years, elasticsearch] = await Promise.all([
            getSalesHistoryDatabaseStatus(),
            listSalesHistoryYears(),
            getSalesHistoryElasticsearchStatus(),
        ]);
        return NextResponse.json({ ok: true, database, years, elasticsearch });
    } catch (error) {
        console.error("[SALES HISTORY STATUS ERROR]", error);
        return NextResponse.json({ ok: false, error: "Gagal membaca status Sales History." }, { status: 500 });
    }
}