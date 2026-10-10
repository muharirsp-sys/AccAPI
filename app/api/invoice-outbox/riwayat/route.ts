/*
 * Tujuan: Riwayat satu baris antrean faktur (BL-17) — siapa melakukan apa dan jawaban Accurate per percobaan,
 *         dari invoice_outbox_event (append-only, S6-0d). Juga untuk baris yang sudah DIBUANG (event `buang`).
 * Caller: halaman Antrean Faktur (dialog Riwayat, S6c).
 * Dependensi: db invoice_outbox_event, rbac.
 * Main Functions: GET ?orderId=.
 * Side Effects: BACA SAJA. Salinan payload di event `buang` tidak dikirim (besar dan tidak dibaca layar).
 */
import { NextRequest, NextResponse } from "next/server";
import { asc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { invoiceOutboxEvent } from "@/db/schema";
import { requirePermission } from "@/lib/rbac/resolve";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
    const gate = await requirePermission(request, "order.view");
    if (gate.response) return gate.response;
    const orderId = (request.nextUrl.searchParams.get("orderId") ?? "").trim();
    if (!orderId) return NextResponse.json({ ok: false, error: "orderId wajib diisi" }, { status: 400 });
    // ponytail: 200 event terlama per order; satu SO jarang lebih dari belasan percobaan. Halaman bila ada yang melewatinya.
    const events = await db.select({
        id: invoiceOutboxEvent.id, jenis: invoiceOutboxEvent.jenis, stateFrom: invoiceOutboxEvent.stateFrom, stateTo: invoiceOutboxEvent.stateTo,
        actor: invoiceOutboxEvent.actor, httpStatus: invoiceOutboxEvent.httpStatus, responseExcerpt: invoiceOutboxEvent.responseExcerpt,
        errorCode: invoiceOutboxEvent.errorCode, reason: invoiceOutboxEvent.reason, createdAt: invoiceOutboxEvent.createdAt,
        detail: sql<Record<string, unknown> | null>`${invoiceOutboxEvent.detail} - 'payload'`,
    }).from(invoiceOutboxEvent).where(eq(invoiceOutboxEvent.orderId, orderId))
        .orderBy(asc(invoiceOutboxEvent.createdAt), asc(invoiceOutboxEvent.id)).limit(200);
    return NextResponse.json({ ok: true, orderId, events });
}
