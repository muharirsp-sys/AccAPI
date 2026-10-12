/**
 * Tujuan: hitungan status idempotency_log (sales-receipt) untuk tile Beranda Admin Incaso (BL-41, S6e-2 butir 6), total dan
 *   per database Accurate lock (NULL = baris sebelum S6e-2, "tidak tercatat"); opsional daftar baris (≤ 200, tanpa payload).
 * Caller: app/api/idempotency/summary/route.ts.
 * Main Functions: ringkasanIdempotensi, daftarBarisRingkasan.
 * Side Effects: SELECT idempotency_log saja.
 * Basi = SELARAS dengan Selesaikan (bolehDiselesaikan, tinjauan B6): SENDING >= 2 mnt (UMUR_SELESAIKAN_MS), PROCESSING > 15 mnt
 * (STALE_PROCESSING_MS) terhadap coalesce(updatedAt, createdAt); kolom timestamp tanpa zona berisi jam UTC (Date JS) —
 * pembanding dikirim sebagai ISO UTC::timestamp, pola CAS lock route.
 */
import { and, desc, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { idempotencyLog } from "@/db/schema";
import { STALE_PROCESSING_MS } from "@/lib/idempotency-lock";
import { UMUR_SELESAIKAN_MS } from "@/lib/idempotency-resolve";

const ekspresiBasi = (now: Date) => {
    const t = sql`coalesce(${idempotencyLog.updatedAt}, ${idempotencyLog.createdAt})`;
    const iso = (ms: number) => new Date(now.getTime() - ms).toISOString();
    return sql<boolean>`CASE WHEN ${idempotencyLog.status} = 'SENDING' THEN ${t} <= ${iso(UMUR_SELESAIKAN_MS)}::timestamp
        ELSE ${t} < ${iso(STALE_PROCESSING_MS)}::timestamp END`;
};

type Grup = { status: string; basi: boolean | null; n: number };
function hitungan(rows: Grup[]) {
    const hitung = (status: string, stale?: boolean) => rows
        .filter((r) => r.status === status && (stale === undefined || Boolean(r.basi) === stale))
        .reduce((a, r) => a + Number(r.n), 0);
    const unknown = hitung("UNKNOWN");
    const sendingStale = hitung("SENDING", true);
    return { uncertain: { unknown, sendingStale, total: unknown + sendingStale }, retryable: hitung("FAILED"), processingStale: hitung("PROCESSING", true) };
}

/** `saring` = syarat tambahan (uji membatasi ke barisnya sendiri); route tidak memakainya. */
export async function ringkasanIdempotensi(db: NodePgDatabase, now: Date, saring?: SQL) {
    const basi = ekspresiBasi(now);
    const rows = await db.select({ status: idempotencyLog.status, basi, databaseId: idempotencyLog.databaseId, n: sql<number>`count(*)::int` })
        .from(idempotencyLog)
        .where(and(inArray(idempotencyLog.status, ["UNKNOWN", "SENDING", "FAILED", "PROCESSING"]), saring))
        .groupBy(sql`1`, sql`2`, sql`3`); // posisi: ekspresi basi berparameter tidak dikenali sama bila diulang ($1 ≠ $7)
    const perDb = new Map<string | null, Grup[]>();
    for (const r of rows) perDb.set(r.databaseId, [...(perDb.get(r.databaseId) ?? []), r]);
    return {
        ...hitungan(rows),
        // NULL = lock sebelum S6e-2 (database tidak dicatat) — dikelompokkan "tidak tercatat".
        perDatabase: [...perDb].map(([databaseId, g]) => ({ databaseId, label: databaseId ?? "tidak tercatat", ...hitungan(g) }))
            .filter((d) => d.uncertain.total + d.retryable + d.processingStale > 0),
        staleMinutes: STALE_PROCESSING_MS / 60_000,
        asOf: now.toISOString(),
    };
}

export const BATAS_BARIS_RINGKASAN = 200;

/** Daftar baris tile = baris yang bisa ditindak: Tidak pasti (UNKNOWN + SENDING >= 2 mnt), PROCESSING basi (> 15 mnt) — keduanya
 * boleh diselesaikan — dan Gagal boleh diulang (FAILED); terbaru dulu, ≤ 200, tanpa payload. `databaseId` = saring database lock. */
export async function daftarBarisRingkasan(db: NodePgDatabase, now: Date, saring?: SQL, databaseId?: string) {
    const basi = ekspresiBasi(now);
    const rows = await db.select({
        key: idempotencyLog.key, status: idempotencyLog.status, customerNo: idempotencyLog.customerNo, transDate: idempotencyLog.transDate,
        invoiceNo: idempotencyLog.invoiceNo, amount: idempotencyLog.amount, databaseId: idempotencyLog.databaseId, updatedAt: idempotencyLog.updatedAt,
    }).from(idempotencyLog)
        .where(and(or(inArray(idempotencyLog.status, ["UNKNOWN", "FAILED"]), and(inArray(idempotencyLog.status, ["SENDING", "PROCESSING"]), basi)), saring,
            databaseId === undefined ? undefined : eq(idempotencyLog.databaseId, databaseId)))
        .orderBy(desc(sql`coalesce(${idempotencyLog.updatedAt}, ${idempotencyLog.createdAt})`))
        .limit(BATAS_BARIS_RINGKASAN + 1);
    return {
        rows: rows.slice(0, BATAS_BARIS_RINGKASAN).map((r) => ({ ...r,
            category: r.status === "FAILED" ? "retryable" : r.status === "PROCESSING" ? "processingStale" : "uncertain" })),
        rowsTruncated: rows.length > BATAS_BARIS_RINGKASAN,
    };
}
