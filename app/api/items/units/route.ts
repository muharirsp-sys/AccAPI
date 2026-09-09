/*
 * Tujuan: Daftar satuan yang sah untuk satu kode barang, dari master Accurate.
 * Caller: halaman Order Masuk (dropdown satuan) dan nanti aplikasi Web Sales.
 * Dependensi: lib/item-price (itemUnits), db/schema (item), lib/rbac/resolve.
 * Main Functions: GET.
 * Side Effects: DB read-only.
 *
 * Satuan TIDAK boleh diketik bebas: item `M5012001000740` berharga BAG 15.900 dan KRT
 * 1.144.800 (72x), jadi satuan yang salah membuat nilai order salah. `units` kosong berarti
 * item ini belum punya baris harga (mis. produksi sebelum sync harga jual) — pemanggil
 * memutuskan sendiri, jangan menebak "PCS".
 */
import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { item } from "@/db/schema";
import { itemUnits } from "@/lib/item-price";
import { resolveRequestPermissionsH } from "@/lib/rbac/resolve";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
    const gate = await resolveRequestPermissionsH();
    if (gate.response) return gate.response;
    if (!gate.perms?.has("order.create") && !gate.perms?.has("websales.create")) {
        return NextResponse.json({ ok: false, error: "Akses master barang tidak diizinkan" }, { status: 403 });
    }

    const code = (request.nextUrl.searchParams.get("code") ?? "").trim();
    if (!code) return NextResponse.json({ ok: false, error: "Parameter code wajib diisi" }, { status: 400 });

    const [master] = await db.select({ no: item.no, name: item.name }).from(item).where(eq(item.no, code)).limit(1);
    const units = (await itemUnits([code])).get(code) ?? [];
    return NextResponse.json({ ok: true, code, found: Boolean(master), name: master?.name ?? "", units });
}
