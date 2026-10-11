/*
 * Tujuan: BL-62 atur sandi user oleh admin (dialog bertopeng, owner 11 Okt; tanpa email) — S7-1. Menggantikan plugin
 *   `/api/auth/admin/set-user-password` (butuh peran lama admin, tanpa audit, sesi tidak dicabut).
 * Caller: UI admin user. Kontrak: docs/handover/S7-KONTRAK-ADMIN-API.md §5.3.
 * Side Effects: hash = hasher Better Auth; akun credential diperbarui/dibuat; SEMUA sesi user dicabut; audit
 *   `user.password_set` — satu transaksi. Sandi/hash TIDAK pernah dicatat, dicetak, atau dikembalikan.
 */
import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { account, permissionAuditLog } from "@/db/schema";
import { requirePermission } from "@/lib/rbac/resolve";
import { cabutSesi, galat, jawabGalat, periksaSandi, transaksiOtorisasi, userTarget } from "@/lib/rbac/otorisasi";

type Context = { params: Promise<{ id: string }> };

export async function POST(request: NextRequest, context: Context) {
    const gate = await requirePermission(request, "users.manage");
    if (gate.response) return gate.response;
    const actor = gate.session!.user;
    const { id } = await context.params;

    const body = await request.json().catch(() => null);
    const ctx = await auth.$context;
    const salah = periksaSandi(body?.password, ctx.password.config.minPasswordLength, ctx.password.config.maxPasswordLength);
    if (salah) return galat(salah.status, salah.code, salah.message);
    const hash = await ctx.password.hash(body.password as string); // lambat (scrypt) -> di luar transaksi

    const now = new Date();
    try {
        const sessionsRevoked = await transaksiOtorisasi(actor.id, async (tx) => {
            const target = await userTarget(tx, id);
            const credential = and(eq(account.userId, id), eq(account.providerId, "credential"));
            const [ada] = await tx.select({ id: account.id }).from(account).where(credential).limit(1);
            if (ada) await tx.update(account).set({ password: hash, updatedAt: now }).where(credential);
            else await tx.insert(account).values({ id: randomUUID(), accountId: id, providerId: "credential", userId: id, password: hash, createdAt: now, updatedAt: now });
            const n = await cabutSesi(tx, id);
            await tx.insert(permissionAuditLog).values({
                id: randomUUID(), actorUserId: actor.id, actorName: actor.name, action: "user.password_set", targetUserId: id,
                detail: { userName: target.name, sessionsRevoked: n }, createdAt: now,
            });
            return n;
        });
        return NextResponse.json({ ok: true, sessionsRevoked });
    } catch (e) {
        return jawabGalat(e);
    }
}
