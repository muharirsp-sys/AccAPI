/*
 * Tujuan: Laporan Sales › Drop Size — nilai per faktur per tipe outlet (customer.category_name) untuk satu bulan, opsional per cabang.
 * Caller: app/(dashboard)/laporan-sales/tab/DropSize.tsx.
 * Dependensi: lib/rbac/resolve (sales_history.view), lib/db, lib/laporan-sales/kontrak (bulanSah, rentangBulan), lib/laporan-sales/drop-size (susunDropSize).
 * Main Functions: GET ?bulan=YYYY-MM&cabang= -> JawabanDropSize (+ fakturTanpaDpp). Side Effects: tidak ada (baca saja).
 * Sumber: Postgres sales_invoice (faktur INV, trans_date dd/MM/yyyy, nilai = dpp) LEFT JOIN customer lewat customerNo; satu kueri GROUP BY, tanpa raw_data.
 * Cakupan: seluruh perusahaan (sama dengan History Penjualan) — tanpa resolveScope.
 */
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { requirePermissionH } from "@/lib/rbac/resolve";
import { db } from "@/lib/db";
import { bulanSah, rentangBulan } from "@/lib/laporan-sales/kontrak";
import { susunDropSize, type JawabanDropSizeLengkap, type KelompokMentah } from "@/lib/laporan-sales/drop-size";

export async function GET(req: Request) {
    const gate = await requirePermissionH("sales_history.view");
    if (gate.response) return gate.response;
    const q = new URL(req.url).searchParams;
    const bulan = q.get("bulan");
    if (!bulanSah(bulan)) return NextResponse.json({ error: "Parameter bulan harus berformat YYYY-MM." }, { status: 400 });
    const cabang = q.get("cabang")?.trim().slice(0, 120) || null;
    try {
        // DISTINCT ON: customerNo tidak dijamin unik di tabel (hanya indeks biasa); tanpa ini JOIN menggandakan nilai faktur.
        // id DESC = baris TERBARU menang: cache customer hanya di-upsert (lib/sync.ts), baris tertua paling mungkin pelanggan yang sudah dihapus.
        // toko/faktur/nilai hanya dari faktur ber-dpp (dpp null = belum terbaca, dihitung terpisah di tanpa_dpp).
        const res = await db.execute(sql`
            SELECT c.branch_name AS cabang, c.category_name AS tipe,
                   (COUNT(DISTINCT si.customer_no) FILTER (WHERE si.dpp IS NOT NULL))::int AS toko,
                   COUNT(si.dpp)::int AS faktur,
                   COALESCE(SUM(si.dpp), 0)::float8 AS nilai,
                   (COUNT(*) FILTER (WHERE si.dpp IS NULL))::int AS tanpa_dpp
            FROM sales_invoice si
            LEFT JOIN (SELECT DISTINCT ON ("customerNo") "customerNo" AS no, branch_name, category_name FROM customer ORDER BY "customerNo", id DESC) c
                ON c.no = si.customer_no
            WHERE si.number LIKE 'INV%' AND si.trans_date LIKE ${rentangBulan(bulan).polaTransDate}
            GROUP BY c.branch_name, c.category_name`);
        const mentah = (res.rows as Array<{ cabang: string | null; tipe: string | null; toko: number; faktur: number; nilai: number; tanpa_dpp: number }>)
            .map((r): KelompokMentah => ({ cabang: r.cabang, tipe: r.tipe, toko: Number(r.toko), faktur: Number(r.faktur), nilai: Number(r.nilai), tanpaDpp: Number(r.tanpa_dpp) }));
        const jawaban: JawabanDropSizeLengkap = { bulan, ...susunDropSize(mentah, cabang) };
        return NextResponse.json(jawaban, { headers: { "Cache-Control": "private, no-store" } });
    } catch (e) {
        console.error("[laporan-sales/drop-size] gagal memuat:", e instanceof Error ? e.message : e);
        return NextResponse.json({ error: "Gagal memuat Drop Size." }, { status: 500 });
    }
}
