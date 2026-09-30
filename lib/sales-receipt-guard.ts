/**
 * Tujuan: AM-024 (owner D-18) — tulis sales-receipt lewat /api/proxy tidak boleh melewati idempotency.
 *   Setiap baris payload harus tercakup lock milik user ini (baris PROCESSING, identitas dasar sama) atau
 *   menghabiskan satu override tercatat (resend_success / allow_duplicate) dari lock yang sama.
 * Caller: app/api/proxy/route.ts.
 * Dependensi: idempotency_log (lockId/lockedBy, AM-050), idempotency_override (AM-052).
 * Side Effects: UPDATE idempotency_override.consumed_at (override sekali pakai), satu transaksi.
 */
import { and, asc, eq, inArray, isNull, sql, TransactionRollbackError } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { idempotencyLog, idempotencyOverride } from "@/db/schema";
import { rowsNeedingOverride } from "@/lib/idempotency-lock";
import { buildSalesReceiptIdempotencyPayload, salesReceiptBaseIdentity } from "@/lib/sales-receipt-fingerprint";

const CANONICAL_PATHS: Record<string, "bulk" | "single"> = {
    "/api/sales-receipt/bulk-save.do": "bulk",
    "/api/sales-receipt/save.do": "single",
};

const hasFlatKey = (v: unknown): boolean => Array.isArray(v)
    ? v.some(hasFlatKey)
    : Boolean(v) && typeof v === "object" && Object.entries(v as Record<string, unknown>).some(([k, x]) => /[.[\]]/.test(k) || hasFlatKey(x));

/**
 * null = boleh diteruskan; string = alasan penolakan (409).
 * ponytail: override dihabiskan SEBELUM proxy memeriksa sesi Accurate — sesi yang belum lengkap membuat
 * override hangus (Finance mengulang override). Diterima: sesi hampir selalu ada saat unggah.
 */
export async function authorizeSalesReceiptWrite(
    db: NodePgDatabase,
    input: { lockId: unknown; userId: string; payload: unknown; endpointPath: string },
): Promise<string | null> {
    const { lockId, userId } = input;
    if (typeof lockId !== "string" || !lockId) {
        return "Tulis sales-receipt hanya lewat unggah API Wrapper (bulk-save) dengan lock idempotency — proxy generik menolak kiriman tanpa lock.";
    }
    // Re-review 5cf065b0 M1: bentuk kabel ditentukan path MENTAH (flatten hanya bila mengandung "bulk-save.do"
    // dan payload array). Varian path (huruf besar, %2D) atau bentuk payload lain = yang diperiksa di sini
    // berbeda dari yang dikirim -> hanya path kanonik katalog, dengan bentuk yang sesuai.
    const kind = CANONICAL_PATHS[input.endpointPath];
    if (!kind) return "Path tulis sales-receipt harus persis /api/sales-receipt/bulk-save.do atau /api/sales-receipt/save.do.";
    if (kind === "bulk" ? !Array.isArray(input.payload) : Array.isArray(input.payload)) {
        return "Bentuk payload tidak sesuai endpoint: bulk-save = daftar baris, save = satu objek.";
    }
    // Yang diperiksa HARUS sama dengan yang dikirim (review e641e571 HIGH): flattenPayload menulis kunci
    // literal "detailInvoice[0].invoiceNo" / "data[0].x" ke kabel dan menimpa nilai bersarang yang diperiksa
    // di sini. Kunci ber-titik/kurung ditolak di kedalaman mana pun; detailInvoice wajib array.
    if (hasFlatKey(input.payload)) return "Payload sales-receipt tidak boleh memuat kunci ber-titik/kurung (bentuk rata).";
    const list = Array.isArray(input.payload) ? input.payload : [input.payload];
    if (!list.length || list.some((r) => !r || typeof r !== "object" || Array.isArray(r)
        || ((r as Record<string, unknown>).detailInvoice !== undefined && !Array.isArray((r as Record<string, unknown>).detailInvoice)))) {
        return "Payload sales-receipt tidak valid: setiap baris objek, detailInvoice berupa daftar.";
    }
    const rows = list as Record<string, unknown>[];

    const locked = await db
        .select({ key: idempotencyLog.key, customerNo: idempotencyLog.customerNo, transDate: idempotencyLog.transDate, invoiceNo: idempotencyLog.invoiceNo })
        .from(idempotencyLog)
        .where(and(eq(idempotencyLog.lockId, lockId), eq(idempotencyLog.lockedBy, userId), eq(idempotencyLog.status, "PROCESSING")));
    const rowKeys = [...new Set(rows.map((r) => buildSalesReceiptIdempotencyPayload(r).key))];
    const known = await db.select({ key: idempotencyLog.key }).from(idempotencyLog).where(inArray(idempotencyLog.key, rowKeys));
    const need = rowsNeedingOverride(rows, locked, new Set(known.map((k) => k.key)), buildSalesReceiptIdempotencyPayload, salesReceiptBaseIdentity);
    if (!need.length) return null;

    // Sisa baris: SATU override tercatat per baris, dihabiskan atomik (semua atau tidak sama sekali).
    return db.transaction(async (tx) => {
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
        return null;
    }).catch((e: unknown) => {
        if (e instanceof TransactionRollbackError) {
            return "Ada baris sales-receipt yang tidak terkunci oleh lock ini (atau izin kirim ulangnya sudah terpakai) — ulangi unggah dari API Wrapper.";
        }
        throw e;
    });
}
