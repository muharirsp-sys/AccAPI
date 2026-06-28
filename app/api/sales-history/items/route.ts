/*
 * Tujuan: Detail transaksi item untuk satu No Faktur INV (REFERENSI), level terakhir cascade.
 * Caller: app/(dashboard)/sales-history/page.tsx (saat faktur INV dipilih).
 * Dependensi: lib/sales-history/service.ts, RBAC resolve.
 * Main Functions: GET.
 * Side Effects: DB read-only sales-history-inv.db.
 * Catatan: equality referensi di service memakai idx_shi_referensi; non-INV dikembalikan kosong.
 */
import { NextRequest, NextResponse } from "next/server";
import { requirePermissionH } from "@/lib/rbac/resolve";
import { listSalesHistoryItems } from "@/lib/sales-history/service";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
    const gate = await requirePermissionH("sales_history.view");
    if (gate.response) return gate.response;

    try {
        const { searchParams } = new URL(request.url);
        const ref = (searchParams.get("ref") || "").trim();
        if (!ref) {
            return NextResponse.json({ ok: false, error: "Parameter 'ref' wajib." }, { status: 400 });
        }
        return NextResponse.json({ ok: true, items: await listSalesHistoryItems(ref) });
    } catch (error) {
        console.error("[SALES HISTORY ITEMS ERROR]", error);
        return NextResponse.json({ ok: false, error: "Gagal mengambil detail faktur." }, { status: 500 });
    }
}