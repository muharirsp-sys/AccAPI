/**
 * Tujuan: mengunci fingerprint idempotency upload sales receipt agar submit ganda tidak lolos.
 * Caller: `app/(dashboard)/api-wrapper/page.tsx` sebelum bulk `sales-receipt/bulk-save.do`.
 * Dependensi: `db`, `idempotencyLog`, Drizzle `inArray`.
 * Main Functions: `POST`.
 * Side Effects: baca/tulis tabel SQLite `idempotency_log`, atau preview duplicate tanpa write saat mode review dipakai.
 */
import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { idempotencyLog } from '@/db/schema';
import { inArray } from 'drizzle-orm';

export async function POST(req: Request) {
    try {
        const body = await req.json();
        const { keys, preview, allowDuplicateKeys, allowLockedKeys } = body; // Array of objects { key, invoiceNo, customerNo, amount, transDate, paymentMethod, source }

        if (!keys || !Array.isArray(keys) || keys.length === 0) {
            return NextResponse.json({ ok: true, blockedKeys: [], blockedEntries: [] });
        }

        const exactKeys = keys.map((k: any) => k.key);
        // Check existing keys
        const existing = await db.select().from(idempotencyLog).where(inArray(idempotencyLog.key, exactKeys));

        const now = new Date();
        const FIFTEEN_MINUTES = 15 * 60 * 1000;

        const blockedKeys: string[] = [];
        const blockedEntries: any[] = [];
        const toUpdateToProcessing: string[] = [];
        const toInsert: any[] = [];

        const existingMap = new Map(existing.map((r: any) => [r.key, r]));
        const seenInRequest = new Set<string>();
        const allowDuplicateKeySet = new Set(Array.isArray(allowDuplicateKeys) ? allowDuplicateKeys : []);
        const allowLockedKeySet = new Set(Array.isArray(allowLockedKeys) ? allowLockedKeys : []);

        for (const item of keys) {
            if (seenInRequest.has(item.key)) {
                if (!allowDuplicateKeySet.has(item.key)) {
                    blockedKeys.push(item.key);
                    blockedEntries.push({
                        key: item.key,
                        invoiceNo: item.invoiceNo,
                        customerNo: item.customerNo,
                        amount: item.amount,
                        transDate: item.transDate,
                        paymentMethod: item.paymentMethod,
                        status: 'IN_REQUEST_DUPLICATE',
                        reason: 'DUPLICATE_IN_UPLOAD'
                    });
                }
                continue;
            }
            seenInRequest.add(item.key);
            const ex = existingMap.get(item.key);
            if (ex) {
                if (ex.status === 'SUCCESS') {
                    if (!allowLockedKeySet.has(item.key)) {
                        blockedKeys.push(item.key);
                        blockedEntries.push({
                            key: item.key,
                            invoiceNo: ex.invoiceNo || item.invoiceNo,
                            customerNo: ex.customerNo || item.customerNo,
                            amount: ex.amount ?? item.amount,
                            transDate: ex.transDate || item.transDate,
                            paymentMethod: ex.paymentMethod || item.paymentMethod,
                            status: ex.status,
                            reason: 'ALREADY_SUCCESS'
                        });
                    }
                } else if (ex.status === 'PROCESSING') {
                    const lastUpdated = ex.updatedAt ? new Date(ex.updatedAt) : new Date(ex.createdAt);
                    if (now.getTime() - lastUpdated.getTime() > FIFTEEN_MINUTES) {
                        // Expired! We can overtake this.
                        if (!preview) toUpdateToProcessing.push(item.key);
                    } else {
                        // Still actively processing
                        if (!allowLockedKeySet.has(item.key)) {
                            blockedKeys.push(item.key);
                            blockedEntries.push({
                                key: item.key,
                                invoiceNo: ex.invoiceNo || item.invoiceNo,
                                customerNo: ex.customerNo || item.customerNo,
                                amount: ex.amount ?? item.amount,
                                transDate: ex.transDate || item.transDate,
                                paymentMethod: ex.paymentMethod || item.paymentMethod,
                                status: ex.status,
                                reason: 'STILL_PROCESSING'
                            });
                        }
                    }
                } else {
                    // FAILED or UNKNOWN -> allow retry
                    if (!preview) toUpdateToProcessing.push(item.key);
                }
            } else {
                if (!preview) {
                    toInsert.push({
                        key: item.key,
                        status: 'PROCESSING',
                        invoiceNo: item.invoiceNo,
                        customerNo: item.customerNo,
                        amount: item.amount,
                        transDate: item.transDate,
                        paymentMethod: item.paymentMethod,
                        source: item.source,
                        createdAt: now,
                        updatedAt: now
                    });
                }
            }
        }

        if (!preview && toInsert.length > 0) {
            await db.insert(idempotencyLog).values(toInsert);
        }
        
        if (!preview && toUpdateToProcessing.length > 0) {
            await db.update(idempotencyLog)
                    .set({ status: 'PROCESSING', updatedAt: now })
                    .where(inArray(idempotencyLog.key, toUpdateToProcessing));
        }

        return NextResponse.json({ ok: true, blockedKeys, blockedEntries });
    } catch (e: any) {
        console.error("Failed idempotency lock:", e);
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}
