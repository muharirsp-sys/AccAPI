/*
 * Tujuan: Menyiapkan faktur Accurate dari satu order internal — dry-run atau masuk antrean.
 * Caller: halaman Order Masuk (petugas), izin `order.edit`.
 * Dependensi: FastAPI GET /orders/{id} (order beku), lib/accurate-invoice-write, lib/accurate-units, db invoice_outbox.
 * Main Functions: POST (dry-run default, `queue: true` untuk memasukkan ke antrean), GET (status).
 * Side Effects: Dry-run TIDAK menulis apa pun. Queue menulis satu baris invoice_outbox.
 *   TIDAK ADA request tulis ke Accurate di sini — pengirimannya di /api/cron/post-invoices.
 *
 * Satuan diambil dari master satuan Accurate (`unit/list.do`, read-only) supaya `itemUnitId`
 * tidak pernah ditebak; kalau satuan order tidak ada di master, payload GAGAL dibuat.
 */
import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { invoiceOutbox } from "@/db/schema";
import { resolveRequestPermissionsH } from "@/lib/rbac/resolve";
import { buildInvoicePayload, type InvoiceOrder } from "@/lib/accurate-invoice-write";
import { accurateUnits } from "@/lib/accurate-units";
import { resolveOrderBranch } from "@/lib/order-branch";

export const runtime = "nodejs";

const BACKEND = process.env.FASTAPI_BASE_URL || process.env.NEXT_PUBLIC_FASTAPI_BASE_URL || "http://localhost:8000";

async function fetchOrder(request: NextRequest, id: string): Promise<{ order?: InvoiceOrder; error?: string; status?: number }> {
    const cookie = request.headers.get("cookie");
    let upstream: Response;
    try {
        upstream = await fetch(`${BACKEND}/orders/${encodeURIComponent(id)}`, {
            headers: { ...(cookie ? { cookie } : {}) },
            signal: AbortSignal.timeout(20_000),
        });
    } catch {
        return { error: "Backend order tidak dapat dihubungi", status: 502 };
    }
    const body = await upstream.json().catch(() => ({}));
    if (!upstream.ok) return { error: String(body?.detail || "Order tidak dapat dibaca"), status: upstream.status };
    return { order: body.order as InvoiceOrder };
}

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
    const gate = await resolveRequestPermissionsH();
    if (gate.response) return gate.response;
    if (!gate.perms?.has("order.edit")) {
        return NextResponse.json({ ok: false, error: "Hanya petugas yang boleh menyiapkan faktur" }, { status: 403 });
    }
    const { id } = await context.params;
    const wantQueue = await request.json().then((body) => body?.queue === true).catch(() => false);

    const fetched = await fetchOrder(request, id);
    if (!fetched.order) return NextResponse.json({ ok: false, error: fetched.error }, { status: fetched.status ?? 502 });

    const master = await accurateUnits();
    if (!master.units) return NextResponse.json({ ok: false, error: master.error }, { status: 503 });

    // Cabang dan seri penomoran datang dari PELANGGAN order ini, bukan dari env tunggal:
    // penomoran Faktur Penjualan berjalan per cabang, dan satu outlet punya customerNo
    // berbeda per cabang. Env `ACCURATE_INVOICE_BRANCH_ID` yang lama sengaja tidak dipakai
    // lagi — satu cabang untuk semua faktur adalah sumber nomor nyasar.
    const resolvedBranch = await resolveOrderBranch(fetched.order.customer_no ?? "");
    if (!resolvedBranch.branch) {
        return NextResponse.json({ ok: false, error: resolvedBranch.error }, { status: 409 });
    }
    const orderBranch = resolvedBranch.branch;

    let payload;
    try {
        payload = buildInvoicePayload(fetched.order, {
            unitIds: master.units,
            branchId: orderBranch.branchId,
            typeAutoNumber: orderBranch.autoNumberId,
        });
    } catch (error) {
        // Payload gagal dibuat = ada yang tidak pasti (satuan, pelanggan, angka belum beku).
        // Ini penolakan yang benar, bukan galat server.
        return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Payload faktur gagal dibuat" }, { status: 409 });
    }

    if (!wantQueue) {
        // Dry-run: payload persis yang akan dikirim, tanpa menyentuh DB maupun Accurate.
        return NextResponse.json({ ok: true, dry_run: true, payload, branch: orderBranch });
    }

    const existing = await db.select({ state: invoiceOutbox.state }).from(invoiceOutbox)
        .where(eq(invoiceOutbox.orderId, id)).limit(1);
    if (existing.length > 0) {
        // Order yang sudah pernah masuk antrean TIDAK ditimpa: kalau statusnya `posted` atau
        // `unknown`, menimpanya bisa membuat faktur kedua di Accurate.
        return NextResponse.json({
            ok: false, error: `Order ini sudah ada di antrean faktur (status ${existing[0].state})`,
        }, { status: 409 });
    }
    await db.insert(invoiceOutbox).values({
        orderId: id,
        customerNo: payload.customerNo,
        orderDate: fetched.order.order_date,
        state: "queued",
        payload,
        queuedBy: String(gate.session?.user?.email ?? gate.session?.user?.id ?? ""),
    });
    return NextResponse.json({ ok: true, queued: true, payload });
}

export async function GET(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
    const gate = await resolveRequestPermissionsH();
    if (gate.response) return gate.response;
    if (!gate.perms?.has("order.view")) {
        return NextResponse.json({ ok: false, error: "Akses order tidak diizinkan" }, { status: 403 });
    }
    const { id } = await context.params;
    const [row] = await db.select({
        state: invoiceOutbox.state, attempts: invoiceOutbox.attempts, lastError: invoiceOutbox.lastError,
        accurateId: invoiceOutbox.accurateId, accurateNumber: invoiceOutbox.accurateNumber,
        accurateDbId: invoiceOutbox.accurateDbId, updatedAt: invoiceOutbox.updatedAt,
    }).from(invoiceOutbox).where(eq(invoiceOutbox.orderId, id)).limit(1);
    return NextResponse.json({ ok: true, order_id: id, outbox: row ?? null });
}
