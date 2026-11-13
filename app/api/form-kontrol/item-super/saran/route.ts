/*
 * Tujuan: Saran item super satu kunjungan (owner 13 Nov 2026) — GET ?salesCode&custCode&principle&date -> { channel, wajib, lain, tersimpan,
 *   riwayatTerbaca, adaDaftar }. Dipakai langkah Merchandising di wizard Kunjungan.
 * Caller: app/(dashboard)/form-kontrol/visit/[custCode]/Kunjungan.tsx.
 * Dependensi: lib/form-kontrol (resolveScope, canAccessSales), lib/form-kontrol/item-super-db (muatSaranKunjungan).
 * Side Effects: baca Postgres + SQLite History Penjualan.
 */
import { NextResponse } from "next/server";
import { requirePermissionH } from "@/lib/rbac/resolve";
import { canAccessSales, resolveScope } from "@/lib/form-kontrol";
import { muatSaranKunjungan } from "@/lib/form-kontrol/item-super-db";

export async function GET(req: Request) {
    const gate = await requirePermissionH("form_kontrol.view");
    if (gate.response) return gate.response;
    try {
        const p = new URL(req.url).searchParams;
        const salesCode = p.get("salesCode") ?? "", custCode = p.get("custCode") ?? "", principle = p.get("principle") ?? "", tanggal = p.get("date") ?? "";
        if (!salesCode || !custCode || !principle || !/^\d{4}-\d{2}-\d{2}$/.test(tanggal)) {
            return NextResponse.json({ error: "salesCode, custCode, principle, dan date wajib." }, { status: 400 });
        }
        if (!canAccessSales(await resolveScope(gate.session), salesCode)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
        return NextResponse.json(await muatSaranKunjungan({ salesCode, custCode, principle, tanggal }));
    } catch {
        return NextResponse.json({ error: "Saran item super belum berhasil dimuat." }, { status: 500 });
    }
}
