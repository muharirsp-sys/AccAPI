/**
 * Tujuan: AM-024 (owner D-18) — tulis sales-receipt lewat /api/proxy tidak boleh melewati idempotency.
 *   Setiap baris payload harus tercakup lock milik user ini (baris belum terkirim / ditolak Accurate, identitas
 *   dasar sama) atau menghabiskan satu override tercatat (resend_success / allow_duplicate) dari lock yang sama.
 *   Baris yang lolos ditandai SENDING SEBELUM diteruskan, dan hasilnya dicatat SERVER dari jawaban Accurate
 *   (re-review d60433f2 MEDIUM): klien tidak bisa mengirim ulang dengan lock yang sama atau melapor FAILED palsu.
 * Caller: app/api/proxy/route.ts.
 * Dependensi: idempotency_log (lockId/lockedBy, AM-050), idempotency_override (AM-052), lib/idempotency-lock.
 * Side Effects: satu transaksi — UPDATE idempotency_override.consumed_at (sekali pakai) + idempotency_log
 *   status SENDING; sesudah kirim UPDATE status SUCCESS/FAILED/UNKNOWN.
 */
import { and, asc, eq, inArray, isNull, sql, TransactionRollbackError } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { idempotencyLog, idempotencyOverride } from "@/db/schema";
import { planSalesReceiptRows, type RowOutcome } from "@/lib/idempotency-lock";
import { buildSalesReceiptIdempotencyPayload, salesReceiptBaseIdentity } from "@/lib/sales-receipt-fingerprint";

const CANONICAL_PATHS: Record<string, "bulk" | "single"> = {
    "/api/sales-receipt/bulk-save.do": "bulk",
    "/api/sales-receipt/save.do": "single",
};
const OWNED_STATUSES = ["PROCESSING", "FAILED"]; // belum terkirim, atau ditolak Accurate (dicatat server)

const isObj = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const hasFlatKey = (v: unknown): boolean => Array.isArray(v)
    ? v.some(hasFlatKey)
    : Boolean(v) && typeof v === "object" && Object.entries(v as Record<string, unknown>).some(([k, x]) => /[.[\]]/.test(k) || hasFlatKey(x));
// Elemen yang dibaca rumus fingerprint harus objek; selain itu fingerprint melempar (500) — re-review LOW.
const badDetail = (d: unknown) => !isObj(d) || (d.detailDiscount !== undefined && (!Array.isArray(d.detailDiscount) || !d.detailDiscount.every(isObj)));

export type SalesReceiptWrite = { lockId: unknown; userId: string; payload: unknown; endpointPath: string; method: string };
/** Lolos guard: `anchors[i]` = key idempotency_log yang hasilnya ditentukan baris payload ke-i. */
export type SalesReceiptDispatch = { lockId: string; userId: string; anchors: string[][] };

/** Pemeriksaan murni (tanpa DB/sesi/jaringan). null = lanjut; teks = alasan penolakan (409). */
export function checkSalesReceiptWrite(input: Omit<SalesReceiptWrite, "userId">): string | null {
    if (typeof input.lockId !== "string" || !input.lockId) {
        return "Tulis sales-receipt hanya lewat unggah API Wrapper (bulk-save) dengan lock idempotency — proxy generik menolak kiriman tanpa lock.";
    }
    // Re-review d60433f2 LOW: GET mengubah payload menjadi query (yang diperiksa ≠ yang dikirim).
    if (String(input.method).toUpperCase() !== "POST") return "Tulis sales-receipt hanya dengan method POST.";
    // Re-review 5cf065b0 M1: bentuk kabel ditentukan path MENTAH (flatten hanya bila mengandung "bulk-save.do"
    // dan payload array). Varian path (huruf besar, %2D) atau bentuk payload lain = yang diperiksa di sini
    // berbeda dari yang dikirim -> hanya path kanonik katalog, dengan bentuk yang sesuai.
    const kind = Object.hasOwn(CANONICAL_PATHS, input.endpointPath) ? CANONICAL_PATHS[input.endpointPath] : undefined;
    if (!kind) return "Path tulis sales-receipt harus persis /api/sales-receipt/bulk-save.do atau /api/sales-receipt/save.do.";
    if (kind === "bulk" ? !Array.isArray(input.payload) : Array.isArray(input.payload)) {
        return "Bentuk payload tidak sesuai endpoint: bulk-save = daftar baris, save = satu objek.";
    }
    // Yang diperiksa HARUS sama dengan yang dikirim (review e641e571 HIGH): flattenPayload menulis kunci
    // literal "detailInvoice[0].invoiceNo" / "data[0].x" ke kabel dan menimpa nilai bersarang yang diperiksa
    // di sini. Kunci ber-titik/kurung ditolak di kedalaman mana pun; detailInvoice wajib array.
    if (hasFlatKey(input.payload)) return "Payload sales-receipt tidak boleh memuat kunci ber-titik/kurung (bentuk rata).";
    const list = Array.isArray(input.payload) ? input.payload : [input.payload];
    if (!list.length || list.some((r) => !isObj(r) || (r.detailInvoice !== undefined
        && (!Array.isArray(r.detailInvoice) || r.detailInvoice.some(badDetail))))) {
        return "Payload sales-receipt tidak valid: setiap baris objek, detailInvoice daftar objek, detailDiscount daftar objek.";
    }
    return null;
}

/**
 * Teks = ditolak (409). Objek = lolos; baris milik lock sudah ditandai SENDING dan override sudah dihabiskan,
 * dalam SATU transaksi (dua kiriman bersamaan dengan lock yang sama: yang kedua menunggu lalu ditolak).
 * `dryRun`: hanya menilai (tanpa menulis apa pun) — dipakai proxy saat sesi Accurate belum lengkap.
 */
export async function authorizeSalesReceiptWrite(
    db: NodePgDatabase,
    input: SalesReceiptWrite,
    opts: { dryRun?: boolean } = {},
): Promise<string | SalesReceiptDispatch> {
    const bad = checkSalesReceiptWrite(input);
    if (bad) return bad;
    const lockId = input.lockId as string;
    const { userId } = input;
    const rows = (Array.isArray(input.payload) ? input.payload : [input.payload]) as Record<string, unknown>[];
    const rowKeys = [...new Set(rows.map((r) => buildSalesReceiptIdempotencyPayload(r).key))];
    const ownLock = and(eq(idempotencyLog.lockId, lockId), eq(idempotencyLog.lockedBy, userId));

    let result: string | SalesReceiptDispatch = "Ada baris sales-receipt yang tidak terkunci oleh lock ini (atau izin kirim ulangnya sudah terpakai) — ulangi unggah dari API Wrapper.";
    await db.transaction(async (tx) => {
        const owned = await tx
            .select({ key: idempotencyLog.key, customerNo: idempotencyLog.customerNo, transDate: idempotencyLog.transDate, invoiceNo: idempotencyLog.invoiceNo })
            .from(idempotencyLog)
            .where(and(ownLock, inArray(idempotencyLog.status, OWNED_STATUSES)))
            .for("update");
        const known = await tx.select({ key: idempotencyLog.key }).from(idempotencyLog).where(inArray(idempotencyLog.key, rowKeys));
        const { need, anchors } = planSalesReceiptRows(rows, owned, new Set(known.map((k) => k.key)), buildSalesReceiptIdempotencyPayload, salesReceiptBaseIdentity);

        // Sisa baris: SATU override tercatat per baris, dihabiskan atomik (semua atau tidak sama sekali).
        for (const key of need) {
            const [o] = await tx.select({ id: idempotencyOverride.id })
                .from(idempotencyOverride)
                .where(and(
                    eq(idempotencyOverride.lockId, lockId),
                    eq(idempotencyOverride.key, key),
                    eq(idempotencyOverride.actor, userId),
                    isNull(idempotencyOverride.consumedAt),
                    inArray(idempotencyOverride.action, ["resend_success", "allow_duplicate"]),
                ))
                .orderBy(asc(idempotencyOverride.createdAt))
                .limit(1)
                .for("update", { skipLocked: true });
            if (!o) tx.rollback();
            await tx.update(idempotencyOverride).set({ consumedAt: sql`now()` }).where(eq(idempotencyOverride.id, o.id));
        }

        // Tandai SEBELUM kirim: baris SENDING bukan lagi milik lock (tidak bisa dikirim ulang) dan tidak bisa
        // dilaporkan FAILED oleh klien (completeFromStatuses). Proses mati setelah ini = baris memblokir (UNKNOWN).
        const anchorKeys = [...new Set(anchors.flat())];
        if (anchorKeys.length) {
            const marked = await tx.update(idempotencyLog)
                .set({ status: "SENDING", updatedAt: new Date() })
                .where(and(ownLock, inArray(idempotencyLog.key, anchorKeys), inArray(idempotencyLog.status, OWNED_STATUSES)))
                .returning({ key: idempotencyLog.key });
            if (marked.length !== anchorKeys.length) tx.rollback();
        }
        result = { lockId, userId, anchors };
        if (opts.dryRun) tx.rollback();
    }).catch((e: unknown) => {
        if (!(e instanceof TransactionRollbackError)) throw e;
    });
    return result;
}

const RANK: Record<RowOutcome, number> = { FAILED: 0, UNKNOWN: 1, SUCCESS: 2 };

/**
 * Catat hasil per baris dari jawaban Accurate yang dilihat proxy. Beberapa baris ke key yang sama (salinan
 * diizinkan, koreksi self-heal) -> hasil paling memblokir menang (SUCCESS > UNKNOWN > FAILED). Hanya baris yang
 * masih SENDING milik lock ini yang diubah; gagal mencatat = baris tetap SENDING (memblokir, fail-closed).
 */
export async function recordSalesReceiptOutcome(db: NodePgDatabase, dispatch: SalesReceiptDispatch, outcomes: RowOutcome[]) {
    const byKey = new Map<string, RowOutcome>();
    dispatch.anchors.forEach((keys, i) => {
        const o = outcomes[i] ?? "UNKNOWN";
        for (const k of keys) {
            const prev = byKey.get(k);
            if (!prev || RANK[o] > RANK[prev]) byKey.set(k, o);
        }
    });
    for (const status of ["SUCCESS", "UNKNOWN", "FAILED"] as const) {
        const keys = [...byKey].filter(([, o]) => o === status).map(([k]) => k);
        if (!keys.length) continue;
        await db.update(idempotencyLog).set({ status, updatedAt: new Date() }).where(and(
            eq(idempotencyLog.lockId, dispatch.lockId),
            eq(idempotencyLog.lockedBy, dispatch.userId),
            eq(idempotencyLog.status, "SENDING"),
            inArray(idempotencyLog.key, keys),
        ));
    }
}
