/*
 * Tujuan: Laporan Sales › Tidak Order — kunjungan Form Kontrol tanpa order sebulan, per alasan dan per salesman (kontrak lib/laporan-sales/kontrak.ts
 *   JawabanTidakOrder + pilihanCabang; sumber Postgres ao_control_daily + no_order_reason + sales_profile).
 * Caller: app/(dashboard)/laporan-sales/tab/TidakOrder.tsx.
 * Dependensi: lib/rbac/resolve (supervisor_review.view), lib/form-kontrol/scope resolveScope (cakupan hierarki: SPV timnya, SM bawahannya,
 *   Admin/Manager semua — cakupan TIDAK dipercaya dari klien), lib/db, lib/laporan-sales/tidak-order (susunTidakOrder — murni).
 * Main Functions: GET ?bulan=YYYY-MM&cabang= -> JawabanTidakOrderLengkap. Side Effects: tidak ada (baca saja; tiga SELECT kecil).
 * Galat: 400 { error } bulan tidak sah; 403 { kode: "HIERARKI_BELUM_TERTAUT", error } cakupan non-global kosong; 500 { error } tanpa detail.
 * Sumber: periode = period_month/period_year ao_control_daily, GROUP BY (sales_code, status, no_order_reason_code) di SQL; label/kategori dari SEMUA
 *   baris no_order_reason (alasan nonaktif tetap berlabel); nama + cabang salesman dari sales_profile (cabang = sales_profile.branch).
 *   ponytail: tanpa indeks (period_year, period_month) = pindai tabel per permintaan; cukup selagi ao_control_daily ≤ ratusan ribu baris,
 *   di atas itu tambah indeks (butuh DDL, di luar slice baca-saja ini).
 */
import { NextResponse } from "next/server";
import { and, eq, inArray, sql } from "drizzle-orm";
import { requirePermissionH } from "@/lib/rbac/resolve";
import { resolveScope } from "@/lib/form-kontrol/scope";
import { db } from "@/lib/db";
import { aoControlDaily, noOrderReason, salesProfile } from "@/db/schema";
import { bulanSah, rentangBulan } from "@/lib/laporan-sales/kontrak";
import { susunTidakOrder, type JawabanTidakOrderLengkap } from "@/lib/laporan-sales/tidak-order";

export async function GET(req: Request) {
    const gate = await requirePermissionH("supervisor_review.view");
    if (gate.response) return gate.response;
    const q = new URL(req.url).searchParams;
    const bulan = q.get("bulan");
    if (!bulanSah(bulan)) return NextResponse.json({ error: "Parameter bulan harus YYYY-MM." }, { status: 400 });
    const cabang = q.get("cabang")?.trim().slice(0, 120) || null;
    try {
        const { allowedSalesCodes: cakupan } = await resolveScope(gate.session);
        // Cakupan non-global KOSONG = akun belum tertaut Hierarki: pesan jelas, bukan laporan kosong yang menyesatkan.
        if (cakupan?.length === 0) {
            return NextResponse.json({ kode: "HIERARKI_BELUM_TERTAUT", error: "Akun belum tertaut ke hierarki — hubungi Admin." }, { status: 403 });
        }
        const r = rentangBulan(bulan);
        const [baris, alasan, profil] = await Promise.all([
            db.select({ salesCode: aoControlDaily.salesCode, status: aoControlDaily.status, kode: aoControlDaily.noOrderReasonCode, jumlah: sql<number>`count(*)::int` })
                .from(aoControlDaily)
                .where(and(eq(aoControlDaily.periodMonth, r.bulan), eq(aoControlDaily.periodYear, r.tahun), cakupan === null ? undefined : inArray(aoControlDaily.salesCode, cakupan)))
                .groupBy(aoControlDaily.salesCode, aoControlDaily.status, aoControlDaily.noOrderReasonCode),
            db.select({ kode: noOrderReason.reasonCode, label: noOrderReason.label, kategori: noOrderReason.category }).from(noOrderReason),
            db.select({ salesCode: salesProfile.salesCode, nama: salesProfile.salesName, cabang: salesProfile.branch }).from(salesProfile)
                .where(cakupan === null ? undefined : inArray(salesProfile.salesCode, cakupan)),
        ]);
        const jawaban: JawabanTidakOrderLengkap = { bulan, ...susunTidakOrder({ baris, alasan, profil, cakupan, cabang }) };
        return NextResponse.json(jawaban, { headers: { "Cache-Control": "private, no-store" } });
    } catch (e) {
        console.error("[laporan-sales/tidak-order] gagal memuat:", e instanceof Error ? e.message : e);
        return NextResponse.json({ error: "Gagal memuat Tidak Order." }, { status: 500 });
    }
}
