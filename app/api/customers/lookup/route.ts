/*
 * Tujuan: Konfirmasi pelanggan Accurate dari kodenya — nama dan kategori harga.
 * Caller: halaman Order Sales dan Order Masuk (memastikan kode pelanggan benar sebelum kirim).
 * Dependensi: db/schema (customer), lib/rbac/resolve.
 * Main Functions: GET.
 * Side Effects: DB read-only.
 *
 * Kategori harga menentukan tier harga yang dipakai. Pelanggan tanpa kategori bukan galat —
 * harganya jatuh ke harga standar — tetapi sales harus melihatnya, bukan menebak.
 */
import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { customer } from "@/db/schema";
import { resolveRequestPermissionsH } from "@/lib/rbac/resolve";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
    const gate = await resolveRequestPermissionsH();
    if (gate.response) return gate.response;
    if (!gate.perms?.has("order.create") && !gate.perms?.has("websales.create")) {
        return NextResponse.json({ ok: false, error: "Akses master pelanggan tidak diizinkan" }, { status: 403 });
    }

    const no = (request.nextUrl.searchParams.get("no") ?? "").trim();
    if (!no) return NextResponse.json({ ok: false, error: "Parameter no wajib diisi" }, { status: 400 });

    const [row] = await db.select({
        name: customer.name, area: customer.area,
        priceCategoryName: customer.priceCategoryName,
    }).from(customer).where(eq(customer.customerNo, no)).limit(1);
    return NextResponse.json({
        ok: true, no, found: Boolean(row), name: row?.name ?? "", area: row?.area ?? "",
        priceCategoryName: row?.priceCategoryName ?? "",
    });
}
