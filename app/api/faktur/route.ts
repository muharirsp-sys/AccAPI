/*
 * Tujuan: Daftar faktur penjualan dari cache DB (sales_invoice) untuk halaman /faktur.
 * Caller: app/(dashboard)/faktur/page.tsx (gate RBAC sales_history.view).
 * Dependensi: db/schema (salesInvoiceCache), lib/rbac/resolve.
 * Side Effects: DB read-only.
 */
import { NextRequest, NextResponse } from "next/server";
import { and, desc, ilike, or, sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { salesInvoiceCache } from "@/db/schema";
import { requirePermissionH } from "@/lib/rbac/resolve";

export const runtime = "nodejs";

const PAGE_SIZE = 50;

export async function GET(request: NextRequest) {
    const gate = await requirePermissionH("sales_history.view");
    if (gate.response) return gate.response;

    try {
        const { searchParams } = new URL(request.url);
        const q = (searchParams.get("q") || "").trim().slice(0, 100);
        // Default INV saja: RJN/retur ikut masuk lewat kanal webhook yang sama (terbukti live
        // 2026-08-19), dan biasanya bukan yang dicari. ?all=1 untuk melihat semuanya.
        const showAll = searchParams.get("all") === "1";
        const page = Math.max(1, Number(searchParams.get("page")) || 1);

        const filters: SQL[] = [];
        if (!showAll) filters.push(ilike(salesInvoiceCache.number, "%INV%"));
        if (q) {
            filters.push(
                or(ilike(salesInvoiceCache.number, `%${q}%`), ilike(salesInvoiceCache.customerName, `%${q}%`)) as SQL,
            );
        }

        // ponytail: ambil PAGE_SIZE+1 buat tahu "ada halaman berikutnya" — tanpa COUNT(*) yang
        // harus memindai 179k baris tiap ketikan. Ganti ke count kalau nanti butuh nomor halaman.
        const rows = await db
            .select({
                id: salesInvoiceCache.id,
                number: salesInvoiceCache.number,
                transDate: salesInvoiceCache.transDate,
                customerNo: salesInvoiceCache.customerNo,
                customerName: salesInvoiceCache.customerName,
                totalAmount: salesInvoiceCache.totalAmount,
                outstanding: salesInvoiceCache.outstanding,
                status: salesInvoiceCache.status,
                dueDate: salesInvoiceCache.dueDate,
                age: salesInvoiceCache.age,
                lastUpdateAt: salesInvoiceCache.lastUpdateAt,
                createdAt: salesInvoiceCache.createdAt,
            })
            .from(salesInvoiceCache)
            .where(filters.length ? and(...filters) : sql`true`)
            // Urut WAKTU FAKTUR DIBUAT menurun, sejajar tabel Accurate. Tiga catatan:
            //  - `id` bukan urutan waktu (terbukti live: FRMT00243 ber-id lebih tinggi dari FRMT00248).
            //  - `last_update_at` juga salah untuk ini: nilainya ikut berubah saat faktur DILUNASI,
            //    sehingga faktur lama naik ke puncak (terbukti: MS00336 bertanggal 05/08 di atas).
            //  - `created_at` hanya terisi lewat webhook (list.do tidak mengirim createDate), jadi
            //    faktur lama jatuh ke fallback tanggal transaksi.
            .orderBy(
                sql`coalesce(${salesInvoiceCache.createdAt}, to_timestamp(${salesInvoiceCache.transDate}, 'DD/MM/YYYY')) DESC NULLS LAST`,
                desc(salesInvoiceCache.id),
            )
            .limit(PAGE_SIZE + 1)
            .offset((page - 1) * PAGE_SIZE);

        const hasMore = rows.length > PAGE_SIZE;
        return NextResponse.json({ ok: true, page, pageSize: PAGE_SIZE, hasMore, rows: rows.slice(0, PAGE_SIZE) });
    } catch (error) {
        console.error("[FAKTUR LIST ERROR]", error);
        return NextResponse.json({ ok: false, error: "Gagal memuat daftar faktur." }, { status: 500 });
    }
}
