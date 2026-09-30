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
import { isCompleteStatus } from '@/lib/idempotency-lock';
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
        // AM-025 (H05): dulu status apa pun dari klien ditulis ke key mana pun — "FAILED" di atas SUCCESS
        // membuka blok duplikat -> dokumen Accurate ganda. Kini hanya status akhir yang dikenal, dan hanya
        // untuk baris yang sedang PROCESSING (SUCCESS/FAILED/UNKNOWN tidak bisa ditulis ulang dari sini).
        // ponytail: tanpa kolom pemilik lock, sesi lain masih bisa menutup PROCESSING milik orang lain;
        // butuh kolom owner (perubahan skema) — lihat tracker AM-025.
        if (!isCompleteStatus(status) || keys.some((k: unknown) => typeof k !== 'string')) {
            return NextResponse.json({ error: 'status harus SUCCESS, FAILED, atau UNKNOWN; keys harus teks.' }, { status: 400 });
        }

        const now = new Date();
        await db.update(idempotencyLog)
                .set({ status, updatedAt: now })
                .where(and(inArray(idempotencyLog.key, keys), eq(idempotencyLog.status, 'PROCESSING')));

        return NextResponse.json({ ok: true });
    } catch (e: unknown) {
        console.error("Failed idempotency complete:", e);
        return NextResponse.json({ error: e instanceof Error ? e.message : "Failed idempotency complete" }, { status: 500 });
    }
}
