/*
 * Tujuan: Mengirim baris antrean ke Accurate — SATU-SATUNYA tempat request tulis faktur terjadi.
 * Caller: app/api/cron/post-invoices (terjadwal, bergerbang env) dan
 *         app/api/invoice-outbox/send (tombol Kirim, bergerbang izin + sesi penekannya).
 * Dependensi: db invoice_outbox, lib/accurate-invoice-write (status + identitas).
 * Main Functions: sendQueuedInvoices.
 * Side Effects: MENULIS FAKTUR DI ACCURATE dan mengubah status antrean. Tidak bisa dibatalkan.
 *
 * Dipisah dari route-nya supaya dua pintu masuk memakai jalur kirim yang SAMA PERSIS. Kalau
 * masing-masing menyalin logikanya, satu pintu akan menyimpang tanpa ada yang tahu — dan
 * penyimpangan di jalur ini berarti faktur salah yang tidak bisa ditarik.
 *
 * Aturan yang tidak boleh dilanggar:
 * - Baris diklaim jadi `sending` SEBELUM request dikirim. Proses yang mati di tengah tidak
 *   boleh meninggalkan baris yang terlihat aman dikirim ulang.
 * - Timeout / koneksi putus = TIDAK PASTI (`unknown`), bukan gagal. Tidak pernah dikirim ulang
 *   otomatis: kunci unik lokal tidak menjamin tidak ada faktur ganda di Accurate.
 * - Satu `unknown` MENGHENTIKAN sisa batch. Satu jaringan bermasalah tidak boleh menghasilkan
 *   sepuluh faktur yang tidak jelas nasibnya.
 * - Nomor faktur milik Accurate (`typeAutoNumber`); identitas = database + record id.
 */
import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { invoiceOutbox } from "@/db/schema";
import { barisPersenRupiah, nextOutboxState, pakaiTanggalFaktur, readInvoiceIdentity, type InvoicePayload, type SendOutcome } from "@/lib/accurate-invoice-write";
import { refreshRealization } from "@/lib/program-realization-store";

export type SenderSession = {
    sessionHost: string;
    sessionId: string;
    accessToken: string;
};

export type SendResult = {
    orderId: string;
    state: string;
    accurateId?: string;
    number?: string;
    error?: string;
};

export type SendSummary = { results: SendResult[]; sent: number; unknown: number; rejected: number; error?: string };

/**
 * Jawaban cron atas hasil kirim. Penolakan SEBELUM kirim (`error`) wajib diteruskan: satu baris
 * antrean lama yang ditolak (mis. persen + rupiah, INV/2609/KN01376) menahan seluruh putaran, dan
 * tanpa ini cron melapor `{ok:true, sent:0}` tiap putaran — antrean macet tanpa satu pun tanda.
 */
export function jawabanCron(outcome: SendSummary): { status: number; body: Record<string, unknown> } {
    if (outcome.error) return { status: 409, body: { ok: false, error: outcome.error, sent: 0, unknown: 0, results: [] } };
    return { status: 200, body: { ok: outcome.unknown === 0, sent: outcome.sent, unknown: outcome.unknown, results: outcome.results } };
}

/**
 * Ambil yang `queued` lalu kirim satu per satu. `orderIds` mempersempit ke baris tertentu;
 * tanpa itu, seluruh antrean yang menunggu (sampai `limit`) ikut.
 *
 * `invoiceDate` (yyyy-MM-dd) = tanggal faktur pilihan petugas. Diperiksa untuk SEMUA baris
 * sebelum satu pun terkirim: satu baris yang SO-nya lebih baru dari tanggal itu menggagalkan
 * seluruh tekanan, bukan sebagian terkirim sebagian tidak.
 */
export async function sendQueuedInvoices(
    session: SenderSession,
    options: { targetDb: string; limit: number; orderIds?: string[]; invoiceDate?: string },
): Promise<SendSummary> {
    const picked = (options.orderIds ?? []).map((id) => id.trim()).filter(Boolean);
    const rows = await db.select().from(invoiceOutbox)
        .where(picked.length
            ? and(eq(invoiceOutbox.state, "queued"), inArray(invoiceOutbox.orderId, picked))
            : eq(invoiceOutbox.state, "queued"))
        .orderBy(asc(invoiceOutbox.createdAt)).limit(options.limit);

    const siap = rows.map((row) => {
        const hasil = pakaiTanggalFaktur(row.payload as InvoicePayload, String(row.orderDate), options.invoiceDate);
        // Antrean dari sebelum 5 Okt 2026 bisa membawa persen + rupiah pada satu baris; Accurate
        // membuang rupiahnya (INV/2609/KN01376). Dibuang dari antrean lalu diantrekan ulang.
        const campur = barisPersenRupiah(hasil.payload);
        return campur.length && !hasil.error
            ? { row, ...hasil, error: `${campur.length} baris persen + rupiah (Accurate membuang rupiahnya) — buang dari antrean lalu antrekan ulang` }
            : { row, ...hasil };
    });
    const ditolak = siap.filter((entry) => entry.error);
    if (ditolak.length) {
        return {
            results: [], sent: 0, unknown: 0, rejected: 0,
            error: `Tidak ada faktur dikirim: ${ditolak.map((entry) => `${entry.row.orderId} (${entry.error})`).join("; ")}`,
        };
    }

    const results: SendResult[] = [];
    for (const { row, payload } of siap) {
        // Klaim dulu: `sending` menandai bahwa request MUNGKIN sudah terkirim. Payload bertanggal
        // pilihan disimpan DI KLAIM YANG SAMA, jadi yang tercatat = yang benar-benar dikirim.
        const claimed = await db.update(invoiceOutbox)
            .set({ state: "sending", attempts: row.attempts + 1, updatedAt: new Date(), ...(options.invoiceDate ? { payload } : {}) })
            .where(and(eq(invoiceOutbox.orderId, row.orderId), eq(invoiceOutbox.state, row.state)))
            .returning({ orderId: invoiceOutbox.orderId });
        if (claimed.length === 0) continue; // diklaim proses lain

        let outcome: SendOutcome;
        try {
            const response = await fetch(`${session.sessionHost}/accurate/api/sales-invoice/save.do`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Accept: "application/json",
                    Authorization: `Bearer ${session.accessToken}`,
                    "X-Session-ID": session.sessionId,
                },
                body: JSON.stringify(payload),
                signal: AbortSignal.timeout(60_000),
            });
            const text = await response.text();
            let body: unknown;
            try {
                body = JSON.parse(text);
            } catch {
                // Respons non-JSON: kita tidak tahu fakturnya terbentuk atau tidak.
                outcome = { kind: "no_answer", message: `respons non-JSON (${response.status})` };
                body = null;
            }
            if (body !== null) {
                const identity = readInvoiceIdentity(body);
                outcome = identity.ok
                    ? { kind: "posted", id: identity.id, number: identity.number }
                    : { kind: "rejected", message: identity.message };
            }
        } catch (error) {
            // Timeout atau koneksi putus: fakturnya MUNGKIN sudah terbentuk di Accurate.
            outcome = { kind: "no_answer", message: error instanceof Error ? error.message : "tanpa jawaban" };
        }

        const state = nextOutboxState("sending", outcome!);
        await db.update(invoiceOutbox).set({
            state,
            updatedAt: new Date(),
            ...(outcome!.kind === "posted"
                ? { accurateDbId: options.targetDb, accurateId: outcome!.id, accurateNumber: outcome!.number, lastError: "" }
                : { lastError: outcome!.message.slice(0, 1000) }),
        }).where(eq(invoiceOutbox.orderId, row.orderId));

        if (state === "posted") {
            try {
                await refreshRealization(row.orderId, {
                    databaseId: options.targetDb, sessionHost: session.sessionHost,
                    sessionId: session.sessionId, apiKey: session.accessToken,
                });
            } catch { /* Faktur sudah tersimpan; pemeriksaan bisa diulang tanpa mengirim ulang. */ }
        }

        results.push({
            orderId: row.orderId, state,
            ...(outcome!.kind === "posted"
                ? { accurateId: outcome!.id, number: outcome!.number }
                : { error: outcome!.message.slice(0, 200) }),
        });
        // Status TIDAK PASTI menghentikan batch.
        if (state === "unknown") break;
    }

    return {
        results,
        sent: results.filter((item) => item.state === "posted").length,
        unknown: results.filter((item) => item.state === "unknown").length,
        rejected: results.filter((item) => item.state === "rejected").length,
    };
}
