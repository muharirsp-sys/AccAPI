/*
 * Tujuan: Aksi manusia atas baris antrean faktur — Buang dan Antre ulang — beserta jejaknya.
 * Caller: app/api/invoice-outbox (POST). Dipisah dari route agar diuji dengan Postgres evaluasi
 *   (route memakai next/headers sehingga tidak bisa dipanggil di luar request).
 * Dependensi: invoice_outbox + invoice_outbox_event, lib/accurate-invoice-write (aturan status),
 *   lib/invoice-outbox-event.
 * Main Functions: aksiAntrean.
 * Side Effects: UPDATE/DELETE satu baris invoice_outbox + INSERT event dalam SATU transaksi.
 *   TIDAK ADA request ke Accurate di berkas ini.
 */
import { and, eq, inArray } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { invoiceOutbox } from "@/db/schema";
import { discardable, resendable, type OutboxState } from "@/lib/accurate-invoice-write";
import { catatEvent } from "@/lib/invoice-outbox-event";

export type AksiJawaban = { status: number; body: Record<string, unknown> };

const BERUBAH: AksiJawaban = { status: 409, body: { ok: false, error: "Status berubah sebelum tindakan dijalankan; muat ulang halaman" } };

export async function aksiAntrean(
    database: NodePgDatabase,
    input: { orderId: string; action: "resend" | "discard"; actor: string; reason: string },
): Promise<AksiJawaban> {
    const { orderId, action, actor, reason } = input;
    const [row] = await database.select({ state: invoiceOutbox.state }).from(invoiceOutbox)
        .where(eq(invoiceOutbox.orderId, orderId)).limit(1);
    if (!row) return { status: 404, body: { ok: false, error: "Baris antrean tidak ditemukan" } };

    const allowed = action === "discard" ? discardable(row.state as OutboxState) : resendable(row.state as OutboxState);
    if (!allowed) {
        const alasan = row.state === "unknown"
            ? "Statusnya TIDAK PASTI: Accurate tidak menjawab, jadi fakturnya mungkin sudah terbentuk di sana. "
              + "Selesaikan dulu lewat \"Selesaikan tidak pasti\" (pencarian faktur di Accurate); jangan pernah dikirim ulang dari sini."
            : action === "discard"
                ? `Status ${row.state} tidak boleh dibuang: fakturnya mungkin atau pasti sudah ada di Accurate.`
                : `Status ${row.state} tidak boleh dilepas ulang.`;
        return { status: 409, body: { ok: false, error: alasan } };
    }

    if (action === "discard") {
        // Yang DITOLAK (Accurate menjawab dan menolak) dan yang MASIH MENUNGGU (belum pernah
        // satu request pun terkirim) — keduanya dipastikan tidak punya faktur di Accurate.
        // `queued` ikut karena payload BEKU saat diantrekan: kalau aturan pembentuk payload
        // berubah (mis. salesman mulai ikut dikirim), satu-satunya cara memperbaruinya adalah
        // membuang barisnya lalu mengantrekan ulang dari batch.
        // BL-17: barisnya tetap DIHAPUS (PK bebas untuk antre ulang), salinannya masuk event `buang`.
        const removed = await database.transaction(async (tx) => {
            const rows = await tx.delete(invoiceOutbox)
                .where(and(eq(invoiceOutbox.orderId, orderId), inArray(invoiceOutbox.state, ["rejected", "queued"])))
                .returning();
            for (const gone of rows) {
                await catatEvent(tx, {
                    orderId, jenis: "buang", stateFrom: gone.state, stateTo: null, actor, reason,
                    detail: {
                        queued_at: gone.createdAt.toISOString(), queued_by: gone.queuedBy, attempts: gone.attempts,
                        last_error: gone.lastError, customer_no: gone.customerNo, order_date: String(gone.orderDate),
                        payload: gone.payload,
                    },
                });
            }
            return rows.length;
        });
        return removed ? { status: 200, body: { ok: true, orderId, action, state: null } } : BERUBAH;
    }

    // Kirim ulang = kembalikan ke `queued` supaya pengirim terjadwal mengambilnya. Angkanya
    // TIDAK dihitung ulang: payload dibekukan saat diantrekan. Kalau yang salah adalah
    // angkanya, yang benar adalah `discard` lalu antrekan ulang dari batch yang diperbaiki.
    const updated = await database.transaction(async (tx) => {
        const rows = await tx.update(invoiceOutbox)
            .set({ state: "queued", updatedAt: new Date() })
            .where(and(eq(invoiceOutbox.orderId, orderId), eq(invoiceOutbox.state, "rejected")))
            .returning({ orderId: invoiceOutbox.orderId, attempts: invoiceOutbox.attempts });
        if (rows.length) await catatEvent(tx, { orderId, jenis: "antre_ulang", stateFrom: "rejected", stateTo: "queued", actor, reason });
        return rows;
    });
    return updated.length
        ? { status: 200, body: { ok: true, orderId, action, state: "queued", attempts: updated[0].attempts } }
        : BERUBAH;
}
