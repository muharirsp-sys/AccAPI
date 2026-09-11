/** Tujuan: Laporan benefit order/faktur per periode, dan pemeriksaan ulang Accurate.
 * Caller: /summary/realization. Dependensi: RBAC, invoice_outbox, program-realization-store, request-origin.
 * Main Functions: GET (100 order/page), POST (verifikasi satu faktur).
 * Side Effects: PostgreSQL baca; POST membaca Accurate dan memperbarui status lokal.
 */
import { NextRequest, NextResponse } from "next/server";
import { and, asc, eq, gte, lte, gt, or } from "drizzle-orm";
import { db } from "@/lib/db";
import { invoiceOutbox } from "@/db/schema";
import { resolveRequestPermissionsH } from "@/lib/rbac/resolve";
import { resolveSyncCredentials } from "@/lib/accurate-session";
import { refreshRealization } from "@/lib/program-realization-store";
import type { InvoiceOrder } from "@/lib/accurate-invoice-write";
import { hasExpectedOrigin } from "@/lib/request-origin";
export const runtime = "nodejs";

async function access(edit = false) {
    const gate = await resolveRequestPermissionsH();
    if (gate.response) return gate.response;
    if (!gate.perms?.has("summary.view") || !gate.perms.has(edit ? "order.edit" : "order.view"))
        return NextResponse.json({ error: "Akses Summary dan order diperlukan" }, { status: 403 });
}
const validDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s)) && new Date(s).toISOString().slice(0,10) === s;
export async function GET(request: NextRequest) {
    const denied = await access(); if (denied) return denied;
    const q = request.nextUrl.searchParams, from = q.get("from") || "", to = q.get("to") || "";
    if (!validDate(from) || !validDate(to) || from > to || Date.parse(to)-Date.parse(from)>366*86400000)
        return NextResponse.json({ error: "Pilih periode valid, maksimal satu tahun" }, { status: 400 });
    const cursorDate = q.get("afterDate"), cursorId = q.get("afterId");
    if (cursorDate && (!validDate(cursorDate) || !cursorId || cursorId.length > 80))
        return NextResponse.json({ error: "Posisi halaman tidak valid" }, { status: 400 });
    const rows = await db.select({ orderId: invoiceOutbox.orderId, customer: invoiceOutbox.customerNo, date: invoiceOutbox.orderDate,
        state: invoiceOutbox.state, invoiceId: invoiceOutbox.accurateId, invoiceNumber: invoiceOutbox.accurateNumber,
        databaseId: invoiceOutbox.accurateDbId, snapshot: invoiceOutbox.programSnapshot,
        realization: invoiceOutbox.realization, checkedAt: invoiceOutbox.realizationCheckedAt }).from(invoiceOutbox)
        .where(and(gte(invoiceOutbox.orderDate, from), lte(invoiceOutbox.orderDate, to),
            cursorDate ? or(gt(invoiceOutbox.orderDate, cursorDate), and(eq(invoiceOutbox.orderDate, cursorDate), gt(invoiceOutbox.orderId, cursorId!))) : undefined))
        .orderBy(asc(invoiceOutbox.orderDate), asc(invoiceOutbox.orderId)).limit(101);
    const hasMore = rows.length > 100, page = rows.slice(0,100);
    return NextResponse.json({ ok: true, hasMore, next: hasMore ? { afterDate: page[99].date, afterId: page[99].orderId } : null,
        rows: page.map(({ snapshot, ...row }) => {
            const order = snapshot as InvoiceOrder | null;
            return { ...row, plannedDiscount: order?.result.discount ?? null,
                plannedPrograms: (order?.result.applications ?? []).map(a => ({ ...a, name: order?.rules?.find(p=>p.id===a.program_id)?.name ?? a.program_id })) };
        }) });
}
export async function POST(request: NextRequest) {
    const denied = await access(true); if (denied) return denied;
    const publicUrl = process.env.BETTER_AUTH_URL || process.env.NEXT_PUBLIC_APP_URL
        || (process.env.NODE_ENV === "production" ? "" : request.nextUrl.origin);
    if (!hasExpectedOrigin(request.headers.get("origin"), publicUrl))
        return NextResponse.json({ error: "Asal permintaan tidak cocok" }, { status: 403 });
    const body = await request.json().catch(()=>null);
    if (!body || typeof body.orderId !== "string" || !/^[a-zA-Z0-9-]{1,80}$/.test(body.orderId))
        return NextResponse.json({ error: "ID order tidak valid" }, { status: 400 });
    const resolved = await resolveSyncCredentials();
    if (!resolved.creds) return NextResponse.json({ error: "Sesi Accurate belum siap" }, { status: 503 });
    try { return NextResponse.json({ ok: true, realization: await refreshRealization(body.orderId, resolved.creds) }); }
    catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Pemeriksaan gagal" }, { status: 409 }); }
}
