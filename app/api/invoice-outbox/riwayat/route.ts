/*
 * Tujuan: Riwayat satu baris antrean faktur (BL-17) — siapa melakukan apa dan jawaban Accurate per percobaan,
 *         dari invoice_outbox_event (append-only, S6-0d). Juga untuk baris yang sudah DIBUANG (event `buang`).
 * Caller: halaman Antrean Faktur (dialog Riwayat, S6c).
 * Dependensi: lib/invoice-outbox-event (bacaRiwayat), rbac.
 * Main Functions: GET ?orderId= → { events (200 terbaru, lama → baru), terpotong }.
 * Side Effects: BACA SAJA. Salinan payload di event `buang` tidak dikirim (besar dan tidak dibaca layar).
 */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { bacaRiwayat } from "@/lib/invoice-outbox-event";
import { requirePermission } from "@/lib/rbac/resolve";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
    const gate = await requirePermission(request, "order.view");
    if (gate.response) return gate.response;
    const orderId = (request.nextUrl.searchParams.get("orderId") ?? "").trim();
    if (!orderId) return NextResponse.json({ ok: false, error: "orderId wajib diisi" }, { status: 400 });
    // 200 catatan TERBARU (lama → baru); `terpotong` = ada yang lebih tua dan tidak dikirim.
    return NextResponse.json({ ok: true, orderId, ...(await bacaRiwayat(db, orderId)) });
}
