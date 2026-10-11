/*
 * Tujuan: BL-62 aktif/nonaktifkan user (ban Better Auth + cabut sesi; TIDAK menghapus) — S7-1. Menggantikan plugin
 *   `ban-user`/`unban-user`/`remove-user` dari browser. Kontrak: docs/handover/S7-KONTRAK-ADMIN-API.md §5.4.
 * Side Effects: user.banned/banReason/banExpires, hapus sesi (nonaktif), audit `user.deactivate`/`user.activate` — satu
 *   transaksi + penjaga BL-61 (menonaktifkan diri / admin terakhir ditolak).
 */
import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { permissionAuditLog, user, userGroup } from "@/db/schema";
import { requirePermission } from "@/lib/rbac/resolve";
import { cabutSesi, galat, jawabGalat, tolakGrupTerakhir, transaksiOtorisasi, userTarget } from "@/lib/rbac/otorisasi";

type Context = { params: Promise<{ id: string }> };

export async function POST(request: NextRequest, context: Context) {
    const gate = await requirePermission(request, "users.manage");
    if (gate.response) return gate.response;
    const actor = gate.session!.user;
    const { id } = await context.params;

    const body = await request.json().catch(() => null);
    if (typeof body?.active !== "boolean") return galat(400, "INPUT_TIDAK_VALID", "active (boolean) wajib diisi.");
    const active = body.active as boolean;
    const reason = typeof body?.reason === "string" ? body.reason.trim() : "";
    if (reason.length > 200) return galat(400, "INPUT_TIDAK_VALID", "Alasan maksimal 200 karakter.");

    const now = new Date();
    try {
        const hasil = await transaksiOtorisasi(actor.id, async (tx) => {
            const t = await userTarget(tx, id);
            const aktifSekarang = !(t.banned && (!t.banExpires || t.banExpires > now));
            if (aktifSekarang === active) return { changed: false, sessionsRevoked: 0 };
            let sessionsRevoked = 0;
            if (active) {
                // User tanpa grup yang diaktifkan = akses role lama (bisa lebih tinggi) -> tetapkan grup dulu.
                const [g] = await tx.select({ g: userGroup.groupId }).from(userGroup).where(eq(userGroup.userId, id)).limit(1);
                if (!g) tolakGrupTerakhir([{ id: t.id, name: t.name }]);
                await tx.update(user).set({ banned: false, banReason: null, banExpires: null, updatedAt: now }).where(eq(user.id, id));
            } else {
                await tx.update(user).set({ banned: true, banReason: reason || "Dinonaktifkan admin", banExpires: null, updatedAt: now }).where(eq(user.id, id));
                sessionsRevoked = await cabutSesi(tx, id);
            }
            await tx.insert(permissionAuditLog).values({
                id: randomUUID(), actorUserId: actor.id, actorName: actor.name, action: active ? "user.activate" : "user.deactivate",
                targetUserId: id, detail: { userName: t.name, ...(active ? {} : { reason: reason || null, sessionsRevoked }) }, createdAt: now,
            });
            return { changed: true, sessionsRevoked };
        });
        return NextResponse.json({ ok: true, active, ...hasil });
    } catch (e) {
        return jawabGalat(e);
    }
}
