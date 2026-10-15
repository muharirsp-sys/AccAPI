/*
 * Tujuan: Konfirmasi pelanggan Accurate dari kodenya — nama dan kategori harga.
 * Caller: halaman Order Sales dan Order Masuk (memastikan kode pelanggan benar sebelum kirim).
 * Dependensi: db/schema (customer), lib/order-cabang (cakupanCabang), lib/rbac/resolve.
 * Main Functions: GET.
 * Side Effects: DB read-only.
 *
 * Kategori harga menentukan tier harga yang dipakai. Pelanggan tanpa kategori bukan galat —
 * harganya jatuh ke harga standar — tetapi sales harus melihatnya, bukan menebak.
 *
 * O1 putaran 1 (butir 14): salesman hanya boleh membaca pelanggan CABANGNYA (sama dengan /api/customers/search) — kode cabang lain/tanpa
 * cabang = 403 `CABANG_DI_LUAR_CAKUPAN`, akun belum tertaut = `SALESMAN_BELUM_TERHUBUNG`. Petugas internal (`order.view`) semua cabang.
 * Putaran 2: pelanggan suspended = 409 `PELANGGAN_SUSPENDED` (sama dengan pencarian & pratinjau).
 */
import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { customer } from "@/db/schema";
import { cakupanCabang, jawabGalat } from "@/lib/order-cabang";
import { resolveRequestPermissions } from "@/lib/rbac/resolve";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
    const gate = await resolveRequestPermissions(request);
    if (gate.response) return gate.response;
    if (!gate.perms?.has("order.create") && !gate.perms?.has("websales.create")) {
        return NextResponse.json({ ok: false, error: "Akses master pelanggan tidak diizinkan" }, { status: 403 });
    }

    const no = (request.nextUrl.searchParams.get("no") ?? "").trim();
    if (!no) return NextResponse.json({ ok: false, error: "Parameter no wajib diisi" }, { status: 400 });

    const scope = await cakupanCabang(String(gate.session?.user?.id ?? ""), gate.perms);
    if ("galat" in scope) return jawabGalat(scope.galat);
    const [row] = await db.select({
        name: customer.name, area: customer.area,
        priceCategoryName: customer.priceCategoryName, branchId: customer.branchId, suspended: customer.suspended,
    }).from(customer).where(eq(customer.customerNo, no)).limit(1);
    const cakupan = scope.cakupan;
    if (row && !cakupan.semua && row.branchId !== cakupan.branchId) {
        return jawabGalat({ status: 403, kode: "CABANG_DI_LUAR_CAKUPAN",
            error: `Pelanggan ${no} di luar cabang Anda (${cakupan.branchName || cakupan.branchId}). Salesman hanya bisa order untuk cabangnya sendiri.` });
    }
    // Selaras dengan pencarian (yang menyembunyikan suspended) dan periksaOrder: pelanggan suspended tidak bisa diorder (putaran 2 INFO B).
    if (row?.suspended) {
        return jawabGalat({ status: 409, kode: "PELANGGAN_SUSPENDED", error: `Pelanggan ${no} (${row.name}) nonaktif (suspended) di Accurate; tidak bisa diorder.` });
    }
    return NextResponse.json({
        ok: true, no, found: Boolean(row), name: row?.name ?? "", area: row?.area ?? "",
        priceCategoryName: row?.priceCategoryName ?? "",
    });
}
