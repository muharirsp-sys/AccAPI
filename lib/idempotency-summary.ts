/**
 * Tujuan: hitungan status idempotency_log (sales-receipt) untuk tile Beranda Admin Incaso (BL-41, S6e-2 butir 6).
 * Caller: app/api/idempotency/summary/route.ts.
 * Main Functions: ringkasanIdempotensi.
 * Side Effects: SELECT idempotency_log saja.
 * Basi = sama dengan lock (STALE_PROCESSING_MS, 15 mnt) terhadap coalesce(updatedAt, createdAt); kolom timestamp tanpa zona
 * berisi jam UTC (Date JS) — pembanding dikirim sebagai ISO UTC::timestamp, pola CAS lock route.
 */
import { and, inArray, sql, type SQL } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { idempotencyLog } from "@/db/schema";
import { STALE_PROCESSING_MS } from "@/lib/idempotency-lock";

/** `saring` = syarat tambahan (uji membatasi ke barisnya sendiri); route tidak memakainya. */
export async function ringkasanIdempotensi(db: NodePgDatabase, now: Date, saring?: SQL) {
    const batas = new Date(now.getTime() - STALE_PROCESSING_MS).toISOString();
    const basi = sql<boolean>`coalesce(${idempotencyLog.updatedAt}, ${idempotencyLog.createdAt}) < ${batas}::timestamp`;
    const rows = await db.select({ status: idempotencyLog.status, basi, n: sql<number>`count(*)::int` })
        .from(idempotencyLog)
        .where(and(inArray(idempotencyLog.status, ["UNKNOWN", "SENDING", "FAILED", "PROCESSING"]), saring))
        .groupBy(sql`1`, sql`2`); // posisi: ekspresi basi berparameter tidak dikenali sama bila diulang ($1 ≠ $7)
    const hitung = (status: string, stale?: boolean) => rows
        .filter((r) => r.status === status && (stale === undefined || Boolean(r.basi) === stale))
        .reduce((a, r) => a + Number(r.n), 0);
    const unknown = hitung("UNKNOWN");
    const sendingStale = hitung("SENDING", true);
    return {
        uncertain: { unknown, sendingStale, total: unknown + sendingStale },
        retryable: hitung("FAILED"),
        processingStale: hitung("PROCESSING", true),
        perDatabase: null,
        staleMinutes: STALE_PROCESSING_MS / 60_000,
        asOf: now.toISOString(),
    };
}
