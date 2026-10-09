/*
 * Tujuan: Mengirim baris antrean ke Accurate — SATU-SATUNYA tempat request tulis faktur terjadi.
 * Caller: app/api/cron/post-invoices (terjadwal, bergerbang env) dan
 *         app/api/invoice-outbox/send (tombol Kirim, bergerbang izin + sesi penekannya).
 * Dependensi: db invoice_outbox + invoice_outbox_event, lib/accurate-invoice-write (status + identitas),
 *   lib/invoice-outbox-event (riwayat append-only).
 * Main Functions: sendQueuedInvoices, sapuSending.
 * Side Effects: MENULIS FAKTUR DI ACCURATE dan mengubah status antrean. Tidak bisa dibatalkan.
 *   Tiap klaim dan tiap hasil tercatat di invoice_outbox_event DALAM pernyataan SQL yang sama
 *   (CTE) dengan perubahan statusnya: status HTTP + potongan jawaban + pengirim (BL-17 + R6).
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
 * - `sending` yang tertinggal (proses mati di tengah kirim) TIDAK PERNAH kembali ke antrean:
 *   penyapu menjadikannya `unknown` setelah 15 menit (BL-16), di awal setiap Kirim dan cron.
 * - Nomor faktur milik Accurate (`typeAutoNumber`); identitas = database + record id.
 */
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { db as defaultDb } from "@/lib/db";
import { invoiceOutbox } from "@/db/schema";
import { barisPersenRupiah, classifySaveResponse, nextOutboxState, pakaiTanggalFaktur, type InvoicePayload, type SendOutcome } from "@/lib/accurate-invoice-write";
import { refreshRealization } from "@/lib/program-realization-store";
import { kodeGalat, potongJawaban } from "@/lib/invoice-outbox-event";

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
 * Ambang penyapu (BL-16, S6-0d): baris `sending` yang tidak berubah selama ini dianggap ditinggal
 * proses yang mati di tengah kirim. Jauh di atas umur sah sebuah klaim — satu klaim hidup paling
 * lama selama satu fetch save.do (timeout 60 dtk), dan route-nya dibatasi maxDuration 600 dtk.
 */
export const SAPU_SETELAH_MENIT = 15;

/**
 * `sending` > 15 menit -> `unknown` + event `sapu`, SATU pernyataan (CTE): tidak ada baris tersapu
 * tanpa jejak. Jam = `now()` DB, sama dengan jam klaim. Tidak pernah ke `queued`/`rejected`:
 * request-nya MUNGKIN sudah sampai ke Accurate. Mengembalikan kunci yang tersapu.
 */
export async function sapuSending(database: NodePgDatabase, actor: string): Promise<string[]> {
    const swept = await database.execute(sql`
        WITH disapu AS (
            UPDATE invoice_outbox SET state = 'unknown', updated_at = now(),
                last_error = ${`Tertahan "mengirim" lebih dari ${SAPU_SETELAH_MENIT} menit (proses berhenti di tengah kirim). `
                    + "Fakturnya MUNGKIN sudah terbentuk di Accurate — selesaikan lewat pencarian, jangan dikirim ulang."}
            WHERE state = 'sending' AND updated_at < now() - make_interval(mins => ${SAPU_SETELAH_MENIT})
            RETURNING order_id, attempts, updated_at)
        INSERT INTO invoice_outbox_event (order_id, jenis, state_from, state_to, actor, reason, detail)
        SELECT order_id, 'sapu', 'sending', 'unknown', ${actor},
               ${`sending > ${SAPU_SETELAH_MENIT} menit`}, jsonb_build_object('attempts', attempts)
        FROM disapu
        RETURNING order_id`);
    return swept.rows.map((row) => String((row as { order_id: unknown }).order_id));
}

/** Ketergantungan yang bisa diganti uji (Postgres evaluasi, simulator) — produksi memakai bawaan. */
export type SenderDeps = { db?: NodePgDatabase; refresh?: typeof refreshRealization };

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
    // `actor` = pengirim yang tercatat di riwayat: email penekan tombol, atau identitas cron.
    options: { targetDb: string; limit: number; orderIds?: string[]; invoiceDate?: string; actor: string },
    deps: SenderDeps = {},
): Promise<SendSummary> {
    const db = deps.db ?? defaultDb;
    // Penyapu dulu: baris yang ditinggal proses mati terlihat TIDAK PASTI sebelum apa pun dikirim.
    await sapuSending(db, options.actor);
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
        // Event `kirim` (pengirim + percobaan ke-n) ikut dalam SATU pernyataan: klaim tanpa jejak
        // tidak mungkin terjadi. Jam = jam DB (`now()`), sama dengan jam penyapu.
        const claimed = await db.execute(sql`
            WITH c AS (
                UPDATE invoice_outbox SET state = 'sending', attempts = attempts + 1, updated_at = now(),
                    payload = CASE WHEN ${options.invoiceDate ? 1 : 0} = 1 THEN ${JSON.stringify(payload)}::jsonb ELSE payload END
                WHERE order_id = ${row.orderId} AND state = 'queued'
                RETURNING order_id, attempts)
            INSERT INTO invoice_outbox_event (order_id, jenis, state_from, state_to, actor, detail)
            SELECT order_id, 'kirim', 'queued', 'sending', ${options.actor},
                   jsonb_build_object('attempt', attempts, 'target_db', ${options.targetDb}::text, 'trans_date', ${payload.transDate}::text)
            FROM c
            RETURNING order_id`);
        if (claimed.rows.length === 0) continue; // diklaim proses lain

        let outcome: SendOutcome;
        let httpStatus: number | null = null;
        let excerpt = "";
        let errorCode = "";
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
            httpStatus = response.status;
            const text = await response.text();
            excerpt = potongJawaban(text);
            // Non-JSON, null, JSON gateway, 5xx, 401/403/429, sukses tanpa id -> tidak pasti (AM-015/016, D-07).
            outcome = classifySaveResponse(response.status, text);
        } catch (error) {
            // Timeout atau koneksi putus: fakturnya MUNGKIN sudah terbentuk di Accurate.
            errorCode = kodeGalat(error);
            outcome = { kind: "no_answer", message: error instanceof Error ? error.message : "tanpa jawaban" };
        }

        const state = nextOutboxState("sending", outcome);
        const posted = outcome.kind === "posted" ? outcome : null;
        const message = outcome.kind === "posted" ? "" : outcome.message;
        try {
            // Hasil + event dalam satu pernyataan. Status hanya berubah bila baris MASIH `sending`
            // (penyapu bisa sudah menjadikannya unknown); event-nya tetap tercatat apa pun yang
            // terjadi pada barisnya — jawaban Accurate tidak boleh hilang.
            await db.execute(sql`
                WITH u AS (
                    UPDATE invoice_outbox SET state = ${state}, updated_at = now(),
                        accurate_db_id = CASE WHEN ${posted ? 1 : 0} = 1 THEN ${options.targetDb}::text ELSE accurate_db_id END,
                        accurate_id = CASE WHEN ${posted ? 1 : 0} = 1 THEN ${posted?.id ?? ""}::text ELSE accurate_id END,
                        accurate_number = CASE WHEN ${posted ? 1 : 0} = 1 THEN ${posted?.number ?? ""}::text ELSE accurate_number END,
                        last_error = ${message.slice(0, 1000)}
                    WHERE order_id = ${row.orderId} AND state = 'sending'
                    RETURNING order_id)
                INSERT INTO invoice_outbox_event
                    (order_id, jenis, state_from, state_to, actor, http_status, response_excerpt, error_code, reason, detail)
                SELECT ${row.orderId}, ${state}, 'sending', ${state}, ${options.actor}, ${httpStatus}::int, ${excerpt},
                       ${errorCode}, ${message.slice(0, 1000)},
                       jsonb_build_object('baris_diperbarui', EXISTS (SELECT 1 FROM u),
                           'accurate_id', ${posted?.id ?? ""}::text, 'number', ${posted?.number ?? ""}::text)`);
        } catch (error) {
            // Baris tetap `sending` -> penyapu menjadikannya TIDAK PASTI (bukan diam-diam aman dikirim ulang).
            console.error("[invoice-sender] hasil kirim tidak tercatat, baris tetap sending:", row.orderId, error);
        }

        if (state === "posted") {
            try {
                await (deps.refresh ?? refreshRealization)(row.orderId, {
                    databaseId: options.targetDb, sessionHost: session.sessionHost,
                    sessionId: session.sessionId, apiKey: session.accessToken,
                });
            } catch { /* Faktur sudah tersimpan; pemeriksaan bisa diulang tanpa mengirim ulang. */ }
        }

        results.push({
            orderId: row.orderId, state,
            ...(posted ? { accurateId: posted.id, number: posted.number } : { error: message.slice(0, 200) }),
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
