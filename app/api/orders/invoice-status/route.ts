/*
 * Tujuan: Status antrean faktur untuk SEKUMPULAN order internal sekaligus (daftar Order Masuk: Di antrean / Difakturkan / Tidak pasti /
 *   Ditolak, plus nomor faktur). Versi banyak-order dari GET /api/orders/[id]/invoice — satu kueri, bukan satu permintaan per baris.
 * Caller: app/(dashboard)/orders (List Report). Izin `order.view`.
 * Dependensi: db invoice_outbox, lib/rbac/resolve.
 * Main Functions: GET (?ids=uuid,uuid,… maks. 100 — sama dengan batas daftar FastAPI /orders).
 * Side Effects: DB read-only.
 */
import { NextRequest, NextResponse } from "next/server";
import { inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { invoiceOutbox } from "@/db/schema";
import { resolveRequestPermissionsH } from "@/lib/rbac/resolve";

export const runtime = "nodejs";

const MAKS = 100;

export async function GET(request: NextRequest) {
    const gate = await resolveRequestPermissionsH();
    if (gate.response) return gate.response;
    if (!gate.perms?.has("order.view")) {
        return NextResponse.json({ ok: false, error: "Akses order tidak diizinkan" }, { status: 403 });
    }
    const ids = [...new Set((request.nextUrl.searchParams.get("ids") ?? "").split(",").map((id) => id.trim()).filter(Boolean))];
    if (ids.length > MAKS) return NextResponse.json({ ok: false, error: `Maksimal ${MAKS} order sekali minta` }, { status: 400 });
    const rows = ids.length
        ? await db.select({
            orderId: invoiceOutbox.orderId, state: invoiceOutbox.state, accurateNumber: invoiceOutbox.accurateNumber,
            lastError: invoiceOutbox.lastError, updatedAt: invoiceOutbox.updatedAt,
        }).from(invoiceOutbox).where(inArray(invoiceOutbox.orderId, ids))
        : [];
    return NextResponse.json({ ok: true, outbox: rows });
}
