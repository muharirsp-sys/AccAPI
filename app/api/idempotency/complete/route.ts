/**
 * Tujuan: menandai status akhir fingerprint idempotency upload sales receipt.
 * Caller: `app/(dashboard)/api-wrapper/page.tsx` sesudah hasil bulk `sales-receipt/bulk-save.do`.
 * Dependensi: `db`, `idempotencyLog`, Drizzle `inArray`.
 * Main Functions: `POST`.
 * Side Effects: update status/updatedAt di tabel SQLite `idempotency_log`.
 */
import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { idempotencyLog } from '@/db/schema';
import { inArray } from 'drizzle-orm';
import { requireApiSession } from '@/lib/api-security';

export async function POST(req: Request) {
    try {
        const authCheck = await requireApiSession(req);
        if (authCheck.response) return authCheck.response;

        const body = await req.json();
        const { keys, status } = body; 

        if (!keys || !Array.isArray(keys) || keys.length === 0) {
            return NextResponse.json({ ok: true });
        }

        const now = new Date();
        await db.update(idempotencyLog)
                .set({ status, updatedAt: now })
                .where(inArray(idempotencyLog.key, keys));

        return NextResponse.json({ ok: true });
    } catch (e: unknown) {
        console.error("Failed idempotency complete:", e);
        return NextResponse.json({ error: e instanceof Error ? e.message : "Failed idempotency complete" }, { status: 500 });
    }
}
