/*
 * Tujuan: Cari pelanggan Accurate (nama/kode) untuk pemilih pelanggan Order Sales & Order Baru (O1, owner 12 Okt 2026).
 * Caller: app/(dashboard)/sales/OrderSales.tsx, app/(dashboard)/orders/OrderBaru.tsx (O2).
 * Dependensi: db customer/branch (hasil sync), lib/order-cabang (cakupanCabang), lib/principal-validation (channelOutlet), lib/rbac/resolve.
 * Main Functions: GET ?q=&branchId=&limit= (limit 1–50, bawaan 20).
 * Side Effects: DB read-only.
 *
 * Izin: `websales.create` (Order Sales) ATAU `order.create` (Order Baru) — sama dengan /api/customers/lookup. Salesman HANYA cabangnya
 * (cabang karyawan Accurate tertaut); `branchId` cabang lain DITOLAK 403. Petugas internal (`order.view`) semua cabang atau saring
 * `branchId`. Tanpa pelanggan suspended dan tanpa pelanggan bercabang kosong (keduanya tak bisa diorder). Galat DB = 500, bukan daftar kosong.
 */
import { NextRequest, NextResponse } from "next/server";
import { and, asc, eq, ilike, isNotNull, or, sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { branch, customer } from "@/db/schema";
import { angkaQuery, cakupanCabang, jawabGalat, polaLike, tolakCabangLain } from "@/lib/order-cabang";
import { channelOutlet } from "@/lib/principal-validation";
import { resolveRequestPermissions } from "@/lib/rbac/resolve";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
    const gate = await resolveRequestPermissions(request);
    if (gate.response) return gate.response;
    if (!gate.perms?.has("websales.create") && !gate.perms?.has("order.create")) {
        return NextResponse.json({ ok: false, kode: "TIDAK_DIIZINKAN", error: "Akses master pelanggan tidak diizinkan" }, { status: 403 });
    }
    const p = request.nextUrl.searchParams;
    const q = (p.get("q") ?? "").trim().slice(0, 80);
    const branchId = angkaQuery(p.get("branchId"));
    const limit = angkaQuery(p.get("limit")) ?? 20;
    if (branchId === undefined || limit === undefined || limit < 1 || limit > 50) {
        return NextResponse.json({ ok: false, kode: "INPUT_TIDAK_VALID", error: "branchId harus angka; limit 1–50" }, { status: 400 });
    }

    const scope = await cakupanCabang(String(gate.session?.user?.id ?? ""), gate.perms);
    if ("galat" in scope) return jawabGalat(scope.galat);
    const cakupan = scope.cakupan;
    const luar = tolakCabangLain(cakupan, branchId, `Cabang ${branchId}`);
    if (luar) return jawabGalat(luar);
    const cabang = cakupan.semua ? branchId : cakupan.branchId;

    const syarat: SQL[] = [eq(customer.suspended, false), isNotNull(customer.branchId)];
    if (cabang !== null) syarat.push(eq(customer.branchId, cabang));
    if (q) syarat.push(or(ilike(customer.name, polaLike(q)), ilike(customer.customerNo, polaLike(q)))!);
    const rows = await db.select({
        id: customer.id, customerNo: customer.customerNo, name: customer.name, branchId: customer.branchId,
        branchName: sql<string | null>`coalesce(${branch.name}, ${customer.branchName})`,
        categoryName: customer.categoryName, priceCategoryName: customer.priceCategoryName, alamat: customer.alamat,
    }).from(customer).leftJoin(branch, eq(branch.id, customer.branchId)).where(and(...syarat))
        // Kode persis lebih dulu (sales sering mengetik kode), lalu nama.
        .orderBy(sql`(upper(${customer.customerNo}) = upper(${q})) desc`, asc(customer.name), asc(customer.customerNo))
        .limit(limit);
    return NextResponse.json({
        ok: true,
        cakupan: cakupan.semua ? { semua: true, branchId: null, branchName: null }
            : { semua: false, branchId: cakupan.branchId, branchName: cakupan.branchName },
        items: rows.map((r) => ({ ...r, channel: channelOutlet(r.categoryName) })),
    });
}
