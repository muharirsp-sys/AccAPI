/*
 * Tujuan: Daftar faktur INV untuk tabel Sales History; No Faktur menjadi row tabel, bukan dropdown.
 * Caller: app/(dashboard)/sales-history/page.tsx (tabel faktur setelah filter Tahun/Principal/Customer).
 * Dependensi: lib/sales-history/service.ts, RBAC resolve.
 * Main Functions: GET.
 * Side Effects: DB read-only sales-history-inv.db; HTTP Elasticsearch bila pencarian produk aktif dan env tersedia.
 * Catatan: pagination server-side. Search produk memakai Elasticsearch jika index tersedia, lalu fallback SQLite LIKE.
 */
import { NextRequest, NextResponse } from "next/server";
import { requirePermissionH } from "@/lib/rbac/resolve";
import { isValidSalesHistoryYear, listSalesHistoryInvoices, normalizePositiveInt } from "@/lib/sales-history/service";

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
        const result = await listSalesHistoryInvoices({
            year,
            principal: (searchParams.get("principal") || "").trim(),
            kodeCust: (searchParams.get("kodeCust") || "").trim(),
            product: (searchParams.get("product") || "").trim(),
            page: normalizePositiveInt(searchParams.get("page"), 1, 1000000),
            limit: normalizePositiveInt(searchParams.get("limit"), 50, 200),
        });
        return NextResponse.json({ ok: true, ...result });
    } catch (error) {
        console.error("[SALES HISTORY INVOICES ERROR]", error);
        return NextResponse.json({ ok: false, error: "Gagal memuat faktur." }, { status: 500 });
    }
}