/*
 * Tujuan: Menyiapkan faktur Accurate dari satu order internal — dry-run atau masuk antrean.
 * Caller: halaman Order Masuk (petugas), izin `order.edit`.
 * Dependensi: FastAPI GET /orders/{id} (order beku), lib/accurate-invoice-write, lib/accurate-units, lib/order-salesman,
 *   db invoice_outbox + accurate_employee.
 * Main Functions: POST (dry-run default, `queue: true` untuk memasukkan ke antrean; `salesman` = nomor pegawai Accurate, WAJIB
 *   saat antre — C7), GET (status).
 * Side Effects: Queue membekukan payload + jejak program dalam satu insert invoice_outbox; dry-run hanya baca.
 *   TIDAK ADA request tulis ke Accurate di sini — pengirimannya di /api/cron/post-invoices.
 *
 * Satuan diambil dari master satuan Accurate (`unit/list.do`, read-only) supaya `itemUnitId`
 * tidak pernah ditebak; kalau satuan order tidak ada di master, payload GAGAL dibuat.
 */
import { NextRequest, NextResponse } from "next/server";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { accurateEmployee, invoiceOutbox } from "@/db/schema";
import { antrekan, pencariPenekan } from "@/lib/invoice-outbox-actions";
import { resolveRequestPermissions } from "@/lib/rbac/resolve";
import { buildInvoicePayload, type InvoiceOrder } from "@/lib/accurate-invoice-write";
import { accurateUnits } from "@/lib/accurate-units";
import { salesmanOrder } from "@/lib/order-salesman";
import { resolveOrderBranch } from "@/lib/order-branch";
import { programSnapshot } from "@/lib/program-realization";

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
    const gate = await resolveRequestPermissions(request);
    if (gate.response) return gate.response;
    if (!gate.perms?.has("order.edit")) {
        return NextResponse.json({ ok: false, error: "Hanya petugas yang boleh menyiapkan faktur" }, { status: 403 });
    }
    const { id } = await context.params;
    const body = await request.json().catch(() => ({})) as { queue?: unknown; salesman?: unknown };
    const wantQueue = body?.queue === true;
    // C7 (owner 8 Okt 2026): SATU salesman per order, disalin ke tiap baris — bentuk sama dengan jalur Order Principal.
    // Dipilih petugas saat antre (Order Masuk dulu tidak mengirim sales sama sekali); diperiksa ke master SEBELUM order dibaca,
    // supaya antre tanpa salesman tidak pernah sampai membekukan payload. Nomor dinormalkan trim+upper di KEDUA sisi (SQL di sini,
    // salesmanOrder di lib) — sync menyimpan upper, tetapi baris lama/manual tidak boleh lolos atau tertolak karena spasi/huruf.
    const kodeSalesman = typeof body?.salesman === "string" ? body.salesman.trim().toUpperCase() : "";
    const pegawai = kodeSalesman
        ? await db.select({ id: accurateEmployee.id, number: accurateEmployee.number, name: accurateEmployee.name,
            salesman: accurateEmployee.salesman, suspended: accurateEmployee.suspended })
            .from(accurateEmployee).where(sql`upper(trim(${accurateEmployee.number})) = ${kodeSalesman}`)
        : [];
    const salesman = salesmanOrder({ queue: wantQueue, kode: kodeSalesman, pegawai });
    if (!salesman.ok) return NextResponse.json({ ok: false, error: salesman.error }, { status: salesman.status });

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

    const salesmanInfo = salesman.opsi ? { number: salesman.opsi.salesmanNumber, id: salesman.opsi.masterSalesmanId, name: salesman.nama ?? "" } : null;
    let payload;
    try {
        payload = buildInvoicePayload(fetched.order, {
            unitIds: master.units,
            branchId: orderBranch.branchId,
            typeAutoNumber: orderBranch.autoNumberId,
            ...salesman.opsi,
        });
    } catch (error) {
        // Payload gagal dibuat = ada yang tidak pasti (satuan, pelanggan, angka belum beku).
        // Ini penolakan yang benar, bukan galat server.
        return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Payload faktur gagal dibuat" }, { status: 409 });
    }

    if (!wantQueue) {
        // Dry-run: payload persis yang akan dikirim, tanpa menulis DB dan tanpa Accurate.
        return NextResponse.json({ ok: true, dry_run: true, payload, branch: orderBranch, salesman: salesmanInfo });
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
    const order = fetched.order;
    const queuedBy = String(gate.session?.user?.email ?? gate.session?.user?.id ?? "");
    // Baris antrean + event `antre` satu transaksi (BL-17); order yang pernah dibuang dicari dulu (E2).
    const pencari = await pencariPenekan(db, String(gate.session?.user?.id ?? ""));
    const hasil = await antrekan(db, {
        entries: [{ orderId: id, customerNo: payload.customerNo, orderDate: order.order_date, payload, programSnapshot: programSnapshot(order) }],
        actor: queuedBy, targetDb: pencari.targetDb, cari: pencari.cari,
    });
    if (hasil.blocked.length) return NextResponse.json({ ok: false, error: hasil.blocked[0].reason }, { status: 409 });
    if (hasil.posted.length) {
        return NextResponse.json({ ok: true, queued: false, posted: hasil.posted[0],
            pesan: `Faktur ${hasil.posted[0].number || hasil.posted[0].accurateId} sudah ada di Accurate — ditandai terposting, tidak dikirim.` });
    }
    if (!hasil.queued.length) return NextResponse.json({ ok: false, error: "Order ini sudah ada di antrean faktur" }, { status: 409 });
    return NextResponse.json({ ok: true, queued: true, payload, salesman: salesmanInfo });
}

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
    const gate = await resolveRequestPermissions(request);
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
