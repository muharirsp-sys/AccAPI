/**
 * Tujuan: mengunci fingerprint idempotency upload sales receipt agar submit ganda tidak lolos.
 * Caller: `app/(dashboard)/api-wrapper/page.tsx` sebelum bulk `sales-receipt/bulk-save.do`.
 * Dependensi: `db`, `idempotencyLog`, `decideLock` (lib/idempotency-lock).
 * Main Functions: `POST`.
 * Side Effects: baca/tulis tabel `idempotency_log`, atau preview duplicate tanpa write saat mode review dipakai.
 */
import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { idempotencyLog } from '@/db/schema';
import { and, eq, inArray } from 'drizzle-orm';
import { requireApiSession } from '@/lib/api-security';
import { decideLock, type LockEntry } from '@/lib/idempotency-lock';

export async function POST(req: Request) {
    try {
        const authCheck = await requireApiSession(req);
        if (authCheck.response) return authCheck.response;

        const body = await req.json();
        const { keys, preview, allowDuplicateKeys, allowLockedKeys } = body; // Array of objects { key, invoiceNo, customerNo, amount, transDate, paymentMethod, source }

        if (!keys || !Array.isArray(keys) || keys.length === 0) {
            return NextResponse.json({ ok: true, blockedKeys: [], blockedEntries: [] });
        }
        if (keys.some((k: unknown) => typeof (k as LockEntry)?.key !== 'string' || !(k as LockEntry).key)) {
            return NextResponse.json({ error: 'Setiap key idempotency wajib berupa teks.' }, { status: 400 });
        }

        const entries = keys as LockEntry[];
        const existing = await db.select().from(idempotencyLog).where(inArray(idempotencyLog.key, entries.map((k) => k.key)));
        const now = new Date();
        // AM-025 (H05): PROCESSING basi/UNKNOWN tidak lagi diambil alih diam-diam — lihat lib/idempotency-lock.
        const { blocked, toInsert, toRetry } = decideLock(
            entries,
            new Map(existing.map((r) => [r.key, r])),
            now,
            new Set(Array.isArray(allowDuplicateKeys) ? allowDuplicateKeys : []),
            new Set(Array.isArray(allowLockedKeys) ? allowLockedKeys : []),
        );

        if (!preview) {
            // Tulis ATOMIK per key: dua lock bersamaan atas key yang sama -> hanya satu yang menang;
            // yang kalah diblokir STILL_PROCESSING (dulu cek-lalu-tulis: keduanya lolos lalu mengirim).
            const won = new Set<string>();
            if (toInsert.length > 0) {
                const rows = await db.insert(idempotencyLog).values(toInsert.map((item) => ({
                    key: item.key,
                    status: 'PROCESSING',
                    invoiceNo: item.invoiceNo,
                    customerNo: item.customerNo,
                    amount: item.amount,
                    transDate: item.transDate,
                    paymentMethod: item.paymentMethod,
                    source: item.source,
                    createdAt: now,
                    updatedAt: now,
                }))).onConflictDoNothing().returning({ key: idempotencyLog.key });
                rows.forEach((r) => won.add(r.key));
            }
            if (toRetry.length > 0) {
                const rows = await db.update(idempotencyLog)
                    .set({ status: 'PROCESSING', updatedAt: now })
                    .where(and(inArray(idempotencyLog.key, toRetry), eq(idempotencyLog.status, 'FAILED')))
                    .returning({ key: idempotencyLog.key });
                rows.forEach((r) => won.add(r.key));
            }
            const byKey = new Map(entries.map((e) => [e.key, e]));
            for (const key of [...toInsert.map((e) => e.key), ...toRetry]) {
                if (!won.has(key)) blocked.push({ ...byKey.get(key)!, status: 'PROCESSING', reason: 'STILL_PROCESSING' });
            }
        }

        return NextResponse.json({ ok: true, blockedKeys: blocked.map((b) => b.key), blockedEntries: blocked });
    } catch (e: unknown) {
        console.error("Failed idempotency lock:", e);
        return NextResponse.json({ error: e instanceof Error ? e.message : "Failed idempotency lock" }, { status: 500 });
    }
}
