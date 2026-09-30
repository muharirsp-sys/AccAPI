/**
 * Tujuan: mengunci fingerprint idempotency upload sales receipt agar submit ganda tidak lolos.
 * Caller: `app/(dashboard)/api-wrapper/page.tsx` sebelum bulk `sales-receipt/bulk-save.do`.
 * Dependensi: `db`, `idempotencyLog`, `idempotencyOverride`, `decideLock` (lib/idempotency-lock), RBAC resolver.
 * Main Functions: `POST` -> {ok, lockId, blockedKeys, blockedEntries}.
 * Side Effects: baca/tulis `idempotency_log` (+ pemilik lock) dan `idempotency_override`, atau preview tanpa write.
 */
import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { idempotencyLog, idempotencyOverride } from '@/db/schema';
import { and, eq, inArray, sql, TransactionRollbackError } from 'drizzle-orm';
import { resolveRequestPermissions } from '@/lib/rbac/resolve';
import { decideLock, type LockEntry } from '@/lib/idempotency-lock';

export async function POST(req: Request) {
    try {
        const access = await resolveRequestPermissions(req);
        if (access.response) return access.response;
        const actor = String(access.session!.user.id);

        const body = await req.json();
        const { keys, preview, allowDuplicateKeys, allowLockedKeys, overrideReason } = body; // Array of objects { key, invoiceNo, customerNo, amount, transDate, paymentMethod, source }

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
        const { blocked, toInsert, toRetry, toTakeover, overrides } = decideLock(
            entries,
            new Map(existing.map((r) => [r.key, r])),
            now,
            new Set(Array.isArray(allowDuplicateKeys) ? allowDuplicateKeys : []),
            new Set(Array.isArray(allowLockedKeys) ? allowLockedKeys : []),
        );

        // D-18 (owner 2026-09-30): override blok duplikat = membuka kiriman ulang ke Accurate -> hanya
        // Finance (finance.retry_post), alasan wajib, ditegakkan di sini — bukan hanya UI.
        const reason = typeof overrideReason === 'string' ? overrideReason.trim() : '';
        if (!preview && overrides.length > 0) {
            if (!access.perms!.has('finance.retry_post')) {
                return NextResponse.json({ error: 'Override blok duplikat hanya untuk kewenangan Finance (finance.retry_post).' }, { status: 403 });
            }
            if (reason.length < 15) {
                return NextResponse.json({ error: 'Alasan override wajib (minimal 15 karakter).' }, { status: 400 });
            }
        }

        // AM-050: pemilik lock. Hanya pemegang lockId ini (user yang sama) yang boleh menutup barisnya
        // lewat /complete dan mengirimnya lewat /api/proxy.
        const lockId = preview ? null : randomUUID();
        const owner = { lockId, lockedBy: actor };

        // Semua-atau-tidak-sama-sekali (review AM-025 F2): halaman membatalkan kiriman bila ada yang
        // terblokir, jadi mengunci sebagian hanya meninggalkan PROCESSING yatim.
        if (!preview && blocked.length === 0) await db.transaction(async (tx) => {
            // Tulis ATOMIK per key: dua lock bersamaan atas key yang sama -> hanya satu yang menang;
            // yang kalah diblokir STILL_PROCESSING (dulu cek-lalu-tulis: keduanya lolos lalu mengirim).
            const won = new Set<string>();
            if (toInsert.length > 0) {
                const rows = await tx.insert(idempotencyLog).values(toInsert.map((item) => ({
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
                    ...owner,
                }))).onConflictDoNothing().returning({ key: idempotencyLog.key });
                rows.forEach((r) => won.add(r.key));
            }
            if (toRetry.length > 0) {
                const rows = await tx.update(idempotencyLog)
                    .set({ status: 'PROCESSING', updatedAt: now, ...owner })
                    .where(and(inArray(idempotencyLog.key, toRetry), eq(idempotencyLog.status, 'FAILED')))
                    .returning({ key: idempotencyLog.key });
                rows.forEach((r) => won.add(r.key));
            }
            for (const t of toTakeover) {
                // CAS status + updatedAt teramati; date_trunc: baris dari SQL now() bermikrodetik, Date JS milidetik.
                const rows = await tx.update(idempotencyLog)
                    .set({ status: 'PROCESSING', updatedAt: now, ...owner })
                    .where(and(
                        eq(idempotencyLog.key, t.key),
                        eq(idempotencyLog.status, t.status),
                        sql`date_trunc('milliseconds', ${idempotencyLog.updatedAt}) IS NOT DISTINCT FROM ${t.updatedAt ? t.updatedAt.toISOString() : null}::timestamp`,
                    ))
                    .returning({ key: idempotencyLog.key });
                rows.forEach((r) => won.add(r.key));
            }
            const byKey = new Map(entries.map((e) => [e.key, e]));
            for (const key of [...toInsert.map((e) => e.key), ...toRetry, ...toTakeover.map((t) => t.key)]) {
                if (!won.has(key)) blocked.push({ ...byKey.get(key)!, status: 'PROCESSING', reason: 'STILL_PROCESSING' });
            }
            if (blocked.length > 0) tx.rollback(); // kalah balapan satu key = tidak mengunci apa pun
            // Jejak override (D-18) di transaksi yang SAMA: lock yang batal tidak meninggalkan jejak palsu.
            if (overrides.length > 0) {
                await tx.insert(idempotencyOverride).values(overrides.map((o) => ({
                    id: randomUUID(),
                    lockId: lockId!,
                    key: o.key,
                    actor,
                    reason,
                    blockReason: o.blockReason,
                    previousStatus: o.previousStatus,
                    action: o.action,
                })));
            }
        }).catch((e: unknown) => {
            if (!(e instanceof TransactionRollbackError)) throw e;
        });

        const locked = !preview && blocked.length === 0;
        return NextResponse.json({ ok: true, lockId: locked ? lockId : null, blockedKeys: blocked.map((b) => b.key), blockedEntries: blocked });
    } catch (e: unknown) {
        console.error("Failed idempotency lock:", e);
        return NextResponse.json({ error: e instanceof Error ? e.message : "Failed idempotency lock" }, { status: 500 });
    }
}
