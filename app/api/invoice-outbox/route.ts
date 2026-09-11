/*
 * Tujuan: Isi antrean faktur Accurate — yang menunggu, yang ditolak, dan yang TIDAK PASTI —
 *         beserta umur masalahnya, plus tindakan kirim ulang / batalkan antrean.
 * Caller: halaman Antrean Faktur (/antrean-faktur).
 * Dependensi: db invoice_outbox + principal_order_line (sales & outlet), lib/accurate-invoice-write.
 * Main Functions: GET (ringkasan + daftar), POST (aksi `resend` atau `discard`).
 * Side Effects: POST mengubah/menghapus satu baris antrean. TIDAK ADA request ke Accurate.
 *
 * Aturan yang tidak boleh dilanggar:
 * - `unknown` TIDAK PERNAH boleh dikirim ulang maupun dihapus dari sini. Tidak ada jawaban
 *   dari Accurate berarti fakturnya MUNGKIN sudah terbentuk, dan faktur ganda di sana tidak
 *   bisa dibatalkan. Penyelesaiannya rekonsiliasi `charField1`, bukan tombol.
 * - Umur masalah dihitung sejak `created_at` — saat faktur masuk antrean dan BELUM sampai ke
 *   Accurate — bukan sejak percobaan terakhir. Kalau dihitung dari `updated_at`, menekan
 *   "Kirim ulang" akan me-reset jam eskalasi, dan masalah yang berumur sehari bisa terlihat
 *   baru semenit. Yang lewat 2 jam adalah bahan eskalasi ke OM (keputusan pengguna).
 */
import { NextRequest, NextResponse } from "next/server";
import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { invoiceOutbox, principalOrderLine } from "@/db/schema";
import { resolveRequestPermissionsH } from "@/lib/rbac/resolve";
import { resendable, type OutboxState } from "@/lib/accurate-invoice-write";

export const runtime = "nodejs";

/** Keputusan pengguna 2026-09-11: masalah yang sudah berumur 2 jam tembus ke OM. */
export const ESCALATE_AFTER_MINUTES = 120;

const STATES = ["queued", "sending", "posted", "unknown", "rejected"] as const;

/** Kunci jalur laporan principal berbentuk `PRINCIPAL:NO-SO`; order internal memakai uuid. */
function soNoOf(orderId: string): string | null {
    const at = orderId.indexOf(":");
    return at > 0 ? orderId.slice(at + 1) : null;
}

export async function GET(request: NextRequest) {
    const gate = await resolveRequestPermissionsH();
    if (gate.response) return gate.response;
    if (!gate.perms?.has("order.view")) {
        return NextResponse.json({ ok: false, error: "Akses antrean faktur tidak diizinkan" }, { status: 403 });
    }

    const wanted = (request.nextUrl.searchParams.get("state") ?? "")
        .split(",").map((value) => value.trim()).filter((value) => (STATES as readonly string[]).includes(value));
    const onlyOverdue = request.nextUrl.searchParams.get("overdue") === "1";

    // Bawaan: semua yang BELUM selesai. Faktur yang sudah `posted` bukan pekerjaan siapa pun.
    const stateFilter = wanted.length ? inArray(invoiceOutbox.state, wanted) : ne(invoiceOutbox.state, "posted");
    const overdueFilter = sql`${invoiceOutbox.createdAt} < now() - make_interval(mins => ${ESCALATE_AFTER_MINUTES})`;

    const rows = await db.select({
        orderId: invoiceOutbox.orderId, customerNo: invoiceOutbox.customerNo, orderDate: invoiceOutbox.orderDate,
        state: invoiceOutbox.state, attempts: invoiceOutbox.attempts, lastError: invoiceOutbox.lastError,
        accurateNumber: invoiceOutbox.accurateNumber, queuedBy: invoiceOutbox.queuedBy,
        createdAt: invoiceOutbox.createdAt, updatedAt: invoiceOutbox.updatedAt,
        ageMinutes: sql<number>`floor(extract(epoch from (now() - ${invoiceOutbox.createdAt})) / 60)::int`,
    }).from(invoiceOutbox)
        .where(onlyOverdue ? and(stateFilter, ne(invoiceOutbox.state, "posted"), overdueFilter) : stateFilter)
        // Yang paling lama menggantung lebih dulu: itulah yang paling dekat ke eskalasi.
        .orderBy(asc(invoiceOutbox.createdAt)).limit(300);

    // Sales dan nama outlet tidak ada di antrean; untuk jalur laporan principal keduanya
    // diambil dari baris batch lewat nomor SO. Laporan OM wajib menyebut salesnya.
    const soNos = [...new Set(rows.map((row) => soNoOf(row.orderId)).filter(Boolean) as string[])];
    const context = new Map<string, { salesman: string; outlet: string }>();
    if (soNos.length) {
        const lines = await db.selectDistinct({
            soNo: principalOrderLine.soNo,
            salesman: principalOrderLine.salesmanInternal,
            outlet: principalOrderLine.customerName,
        }).from(principalOrderLine).where(inArray(principalOrderLine.soNo, soNos));
        for (const line of lines) {
            if (!context.has(line.soNo)) context.set(line.soNo, { salesman: line.salesman ?? "", outlet: line.outlet ?? "" });
        }
    }

    const counts = await db.select({ state: invoiceOutbox.state, total: sql<number>`count(*)::int` })
        .from(invoiceOutbox).groupBy(invoiceOutbox.state);
    const [overdue] = await db.select({ total: sql<number>`count(*)::int` }).from(invoiceOutbox)
        .where(and(ne(invoiceOutbox.state, "posted"), overdueFilter));

    return NextResponse.json({
        ok: true,
        escalateAfterMinutes: ESCALATE_AFTER_MINUTES,
        summary: Object.fromEntries(counts.map((row) => [row.state, row.total])),
        overdue: overdue?.total ?? 0,
        rows: rows.map((row) => {
            const soNo = soNoOf(row.orderId);
            return {
                ...row,
                soNo,
                source: soNo ? "laporan principal" : "order internal",
                salesman: soNo ? context.get(soNo)?.salesman ?? "" : "",
                outlet: soNo ? context.get(soNo)?.outlet ?? "" : "",
                overdue: row.state !== "posted" && row.ageMinutes >= ESCALATE_AFTER_MINUTES,
            };
        }),
    });
}

export async function POST(request: NextRequest) {
    const gate = await resolveRequestPermissionsH();
    if (gate.response) return gate.response;
    if (!gate.perms?.has("order.edit")) {
        return NextResponse.json({ ok: false, error: "Hanya petugas yang boleh melepas ulang faktur" }, { status: 403 });
    }
    const body = await request.json().catch(() => ({}));
    const orderId = String(body?.orderId ?? "").trim();
    const action = String(body?.action ?? "").trim();
    if (!orderId) return NextResponse.json({ ok: false, error: "orderId wajib diisi" }, { status: 400 });
    if (action !== "resend" && action !== "discard") {
        return NextResponse.json({ ok: false, error: "action harus `resend` atau `discard`" }, { status: 400 });
    }

    const [row] = await db.select({ state: invoiceOutbox.state }).from(invoiceOutbox)
        .where(eq(invoiceOutbox.orderId, orderId)).limit(1);
    if (!row) return NextResponse.json({ ok: false, error: "Baris antrean tidak ditemukan" }, { status: 404 });

    if (!resendable(row.state as OutboxState)) {
        const alasan = row.state === "unknown"
            ? "Statusnya TIDAK PASTI: Accurate tidak menjawab, jadi fakturnya mungkin sudah terbentuk di sana. "
              + "Cocokkan dulu lewat pencarian charField1 di Accurate; jangan pernah dikirim ulang dari sini."
            : `Status ${row.state} tidak boleh dilepas ulang.`;
        return NextResponse.json({ ok: false, error: alasan }, { status: 409 });
    }

    if (action === "discard") {
        // Hanya untuk yang DITOLAK: Accurate menjawab dan menolak, jadi dipastikan tidak ada
        // fakturnya di sana. Barisnya dibuang supaya batch yang sudah diperbaiki bisa
        // diantrekan lagi dengan angka baru — payload lama beku dan tidak ikut terbarui.
        await db.delete(invoiceOutbox).where(and(eq(invoiceOutbox.orderId, orderId), eq(invoiceOutbox.state, "rejected")));
        return NextResponse.json({ ok: true, orderId, action, state: null });
    }

    // Kirim ulang = kembalikan ke `queued` supaya pengirim terjadwal mengambilnya. Angkanya
    // TIDAK dihitung ulang: payload dibekukan saat diantrekan. Kalau yang salah adalah
    // angkanya, yang benar adalah `discard` lalu antrekan ulang dari batch yang diperbaiki.
    const updated = await db.update(invoiceOutbox)
        .set({ state: "queued", updatedAt: new Date() })
        .where(and(eq(invoiceOutbox.orderId, orderId), eq(invoiceOutbox.state, "rejected")))
        .returning({ orderId: invoiceOutbox.orderId, attempts: invoiceOutbox.attempts });
    if (updated.length === 0) {
        return NextResponse.json({ ok: false, error: "Status berubah sebelum tindakan dijalankan; muat ulang halaman" }, { status: 409 });
    }
    return NextResponse.json({ ok: true, orderId, action, state: "queued", attempts: updated[0].attempts });
}
