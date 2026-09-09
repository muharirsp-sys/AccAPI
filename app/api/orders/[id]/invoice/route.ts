/*
 * Tujuan: Menyiapkan faktur Accurate dari satu order internal — dry-run atau masuk antrean.
 * Caller: halaman Order Masuk (petugas), izin `order.edit`.
 * Dependensi: FastAPI GET /orders/{id} (order beku), lib/accurate-invoice-write, db invoice_outbox.
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
import { resolveSyncCredentials } from "@/lib/accurate-session";
import { buildInvoicePayload, type InvoiceOrder } from "@/lib/accurate-invoice-write";

export const runtime = "nodejs";

const BACKEND = process.env.FASTAPI_BASE_URL || process.env.NEXT_PUBLIC_FASTAPI_BASE_URL || "http://localhost:8000";

/** Master satuan Accurate: 37 baris (terbukti live 2026-09-08), jadi satu halaman cukup. */
async function accurateUnits(): Promise<{ units?: Map<string, number>; error?: string }> {
    const resolved = await resolveSyncCredentials();
    if (!resolved.creds) return { error: resolved.error };
    const { sessionHost, sessionId, apiKey } = resolved.creds;
    const units = new Map<string, number>();
    for (let page = 1; page <= 5; page += 1) {
        const url = `${sessionHost}/accurate/api/unit/list.do?sp.page=${page}&sp.pageSize=100&fields=id,name`;
        const response = await fetch(url, {
            headers: { Authorization: `Bearer ${apiKey}`, "X-Session-ID": sessionId, Accept: "application/json" },
            signal: AbortSignal.timeout(20_000),
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok || body?.s !== true) return { error: "Master satuan Accurate tidak dapat dibaca" };
        const rows = Array.isArray(body.d) ? body.d : [];
        for (const row of rows) {
            const name = String(row?.name ?? "").trim().toUpperCase();
            const id = Number(row?.id);
            if (name && Number.isFinite(id)) units.set(name, id);
        }
        if (rows.length < 100) break;
    }
    return units.size > 0 ? { units } : { error: "Master satuan Accurate kosong" };
}

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

    let payload;
    try {
        const branchId = Number(process.env.ACCURATE_INVOICE_BRANCH_ID);
        payload = buildInvoicePayload(fetched.order, {
            unitIds: master.units,
            branchId: Number.isFinite(branchId) ? branchId : undefined,
        });
    } catch (error) {
        // Payload gagal dibuat = ada yang tidak pasti (satuan, pelanggan, angka belum beku).
        // Ini penolakan yang benar, bukan galat server.
        return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Payload faktur gagal dibuat" }, { status: 409 });
    }

    if (!wantQueue) {
        // Dry-run: payload persis yang akan dikirim, tanpa menyentuh DB maupun Accurate.
        return NextResponse.json({ ok: true, dry_run: true, payload });
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
