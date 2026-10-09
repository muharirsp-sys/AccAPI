/*
 * Tujuan: Riwayat antrean faktur APPEND-ONLY (BL-17 + R6, S6-0d) — siapa melakukan apa pada baris
 *         antrean mana, dan jawaban Accurate apa adanya per percobaan (tidak pernah ditimpa).
 * Caller: lib/invoice-sender (kirim/hasil/sapu), app/api/invoice-outbox (buang, antre ulang,
 *         selesaikan), app/api/principal-order/queue + app/api/orders/[id]/invoice (antre).
 * Dependensi: tabel invoice_outbox_event (db/schema.ts, scripts/migrate-pg.mjs).
 * Main Functions: potongJawaban, kodeGalat, catatEvent, waktuAntrePertama, pernahDibuang, menitSejakKirimTerakhir.
 * Side Effects: catatEvent = INSERT invoice_outbox_event. Tidak ada UPDATE/DELETE di sini — dan
 *   DDL manual (docs/handover/DDL_OUTBOX_EVENT.sql) menolaknya di tingkat DB.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { invoiceOutboxEvent, type INVOICE_OUTBOX_EVENT_KINDS } from "@/db/schema";

export type OutboxEventKind = (typeof INVOICE_OUTBOX_EVENT_KINDS)[number];
/** db global atau transaksi (`tx`) — keduanya punya insert/select. */
export type OutboxDb = Pick<NodePgDatabase, "insert" | "select" | "selectDistinct">;

export type OutboxEvent = {
    orderId: string;
    jenis: OutboxEventKind;
    stateFrom?: string | null;
    stateTo?: string | null;
    actor: string;
    httpStatus?: number | null;
    responseExcerpt?: string;
    errorCode?: string;
    reason?: string;
    detail?: Record<string, unknown> | null;
};

/** Batas kolom response_excerpt (CHECK di DB). */
export const BATAS_POTONGAN = 500;

export const potongJawaban = (text: unknown) => String(text ?? "").slice(0, BATAS_POTONGAN);

/** Kode galat jaringan untuk dicatat: `TimeoutError`, `ECONNRESET` (cause.code), dst. */
export function kodeGalat(error: unknown): string {
    const err = error as { name?: string; code?: string; cause?: { code?: string } } | null | undefined;
    return [err?.name, err?.cause?.code ?? err?.code].filter(Boolean).join(":").slice(0, 100);
}

export async function catatEvent(database: OutboxDb, ...events: OutboxEvent[]) {
    if (!events.length) return;
    await database.insert(invoiceOutboxEvent).values(events.map((event) => ({
        orderId: event.orderId,
        jenis: event.jenis,
        stateFrom: event.stateFrom ?? null,
        stateTo: event.stateTo ?? null,
        actor: event.actor.slice(0, 200),
        httpStatus: event.httpStatus ?? null,
        responseExcerpt: potongJawaban(event.responseExcerpt),
        errorCode: (event.errorCode ?? "").slice(0, 100),
        reason: (event.reason ?? "").slice(0, 1000),
        detail: event.detail ?? null,
    })));
}

/**
 * Waktu order ini PERTAMA kali masuk antrean — dasar jendela pencarian faktur (AM-029). Baris
 * antrean bisa sudah dibuang lalu dibuat ulang (created_at baru), jadi riwayat ikut dibaca:
 * event tertua untuk order ini, atau `queued_at` yang disalin event `buang` dari baris yang dihapus.
 */
export async function waktuAntrePertama(database: OutboxDb, orderId: string, rowCreatedAt?: Date | null): Promise<Date | null> {
    const [row] = await database.select({
        first: sql<string | null>`min(least(${invoiceOutboxEvent.createdAt}, (${invoiceOutboxEvent.detail}->>'queued_at')::timestamptz))`,
    }).from(invoiceOutboxEvent).where(eq(invoiceOutboxEvent.orderId, orderId));
    const times = [row?.first ? new Date(row.first) : null, rowCreatedAt ?? null]
        .filter((value): value is Date => value instanceof Date && !Number.isNaN(value.getTime()));
    return times.length ? new Date(Math.min(...times.map((value) => value.getTime()))) : null;
}

/** Kunci antrean yang PERNAH dibuang (event `buang`): mengantrekannya lagi wajib didahului pencarian faktur. */
export async function pernahDibuang(database: OutboxDb, orderIds: string[]): Promise<Set<string>> {
    if (!orderIds.length) return new Set();
    const rows = await database.selectDistinct({ orderId: invoiceOutboxEvent.orderId }).from(invoiceOutboxEvent)
        .where(and(eq(invoiceOutboxEvent.jenis, "buang"), inArray(invoiceOutboxEvent.orderId, orderIds)));
    return new Set(rows.map((row) => row.orderId));
}

/**
 * Menit sejak event `kirim` TERAKHIR order ini menurut jam DB (`now()`, sama dengan penyapu), atau
 * null bila belum pernah dikirim. Dasar masa tunggu "Tetapkan tidak terposting": save.do yang
 * timeout bisa tetap tersimpan belakangan di Accurate.
 */
export async function menitSejakKirimTerakhir(database: OutboxDb, orderId: string): Promise<number | null> {
    const [row] = await database.select({
        menit: sql<number | null>`extract(epoch from (now() - max(${invoiceOutboxEvent.createdAt}))) / 60`,
    }).from(invoiceOutboxEvent).where(and(eq(invoiceOutboxEvent.orderId, orderId), eq(invoiceOutboxEvent.jenis, "kirim")));
    return row?.menit === null || row?.menit === undefined ? null : Number(row.menit);
}
