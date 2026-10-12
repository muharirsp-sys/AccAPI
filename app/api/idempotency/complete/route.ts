/**
 * Tujuan: menandai status akhir fingerprint idempotency upload sales receipt.
 * Caller: `app/(dashboard)/api-wrapper/page.tsx` sesudah hasil bulk `sales-receipt/bulk-save.do`.
 * Dependensi: `db`, `idempotencyLog`, `isCompleteStatus` (lib/idempotency-lock).
 * Main Functions: `POST`.
 * Side Effects: update status/updatedAt di tabel SQLite `idempotency_log`.
 */
import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { idempotencyLog } from '@/db/schema';
import { and, eq, inArray } from 'drizzle-orm';
import { completeFromStatuses, isCompleteStatus } from '@/lib/idempotency-lock';
import { requireApiSession } from '@/lib/api-security';

export async function POST(req: Request) {
    try {
        const authCheck = await requireApiSession(req);
        if (authCheck.response) return authCheck.response;

        const body = await req.json();
        const { keys, status, lockId } = body;

        if (!keys || !Array.isArray(keys) || keys.length === 0) {
            return NextResponse.json({ ok: true });
        }
        // AM-025 (H05): dulu status apa pun dari klien ditulis ke key mana pun — "FAILED" di atas SUCCESS
        // membuka blok duplikat -> dokumen Accurate ganda. Kini hanya status akhir yang dikenal, dan hanya
        // untuk baris yang sedang PROCESSING (SUCCESS/FAILED/UNKNOWN tidak bisa ditulis ulang dari sini).
        if (!isCompleteStatus(status) || keys.some((k: unknown) => typeof k !== 'string')) {
            return NextResponse.json({ error: 'status harus SUCCESS, FAILED, atau UNKNOWN; keys harus teks.' }, { status: 400 });
        }
        // AM-050 (owner D-18): hanya pemilik lock — lockId dari /lock DAN user yang sama. Sesi lain tidak
        // bisa lagi menandai FAILED baris PROCESSING orang lain (yang membuatnya dicoba ulang otomatis).
        if (typeof lockId !== 'string' || !lockId) {
            return NextResponse.json({ error: 'lockId wajib (dari /api/idempotency/lock).' }, { status: 400 });
        }

        // Hanya menaikkan (SUCCESS/UNKNOWN boleh di atas FAILED — review AM-025 F3 & MEDIUM). FAILED hanya untuk
        // baris yang belum pernah diteruskan proxy; hasil baris SENDING dicatat server (re-review d60433f2).
        const from = completeFromStatuses(status);
        const now = new Date();
        const updated = await db.update(idempotencyLog)
                .set({ status, updatedAt: now })
                .where(and(
                    inArray(idempotencyLog.key, keys),
                    inArray(idempotencyLog.status, from),
                    eq(idempotencyLog.lockId, lockId),
                    eq(idempotencyLog.lockedBy, String(authCheck.session.user.id)),
                ))
                .returning({ key: idempotencyLog.key });

        // `updated` < keys: baris bukan milik lock ini, atau transisi tidak sah — tidak diubah (bukan galat).
        return NextResponse.json({ ok: true, updated: updated.length });
    } catch (e: unknown) {
        console.error("Failed idempotency complete:", e);
        return NextResponse.json({ error: e instanceof Error ? e.message : "Failed idempotency complete" }, { status: 500 });
    }
}
