import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { eq, and } from "drizzle-orm";
import { accessGroup, userGroup, user, permissionAuditLog } from "@/db/schema";
import { requirePermission } from "@/lib/rbac/resolve";
import { anggota, anggotaTunggal, galat, GalatOtorisasi, jawabGalat, tolakGrupTerakhir, transaksiOtorisasi, type Tx } from "@/lib/rbac/otorisasi";

type Context = { params: Promise<{ id: string }> };

/** Grup & user target dibaca DI DALAM transaksi (terhapus bersamaan -> 404, bukan FK 500). */
async function target(tx: Tx, groupId: string, userId: string) {
    const [group] = await tx.select({ id: accessGroup.id, name: accessGroup.name }).from(accessGroup).where(eq(accessGroup.id, groupId)).limit(1);
    if (!group) throw new GalatOtorisasi(404, "GRUP_TIDAK_ADA", "Group tidak ditemukan");
    const [targetUser] = await tx.select({ id: user.id, name: user.name }).from(user).where(eq(user.id, userId)).limit(1);
    if (!targetUser) throw new GalatOtorisasi(404, "USER_TIDAK_ADA", "User tidak ditemukan");
    return { group, targetUser };
}

async function userIdDari(request: NextRequest) {
    const body = await request.json().catch(() => ({}));
    return typeof body?.userId === "string" ? body.userId.trim() : "";
}

export async function POST(request: NextRequest, context: Context) {
    const gate = await requirePermission(request, "users.manage");
    if (gate.response) return gate.response;

    const { id } = await context.params;
    const userId = await userIdDari(request);
    if (!userId) return galat(400, "INPUT_TIDAK_VALID", "userId wajib diisi");

    const actor = gate.session!.user;
    const now = new Date();
    try {
        // Masuk grup juga bisa MENGURANGI akses (user tanpa grup kehilangan fallback role lama) -> penjaga tetap jalan.
        const added = await transaksiOtorisasi(actor.id, async (tx) => {
            const { group, targetUser } = await target(tx, id, userId);
            if (await anggota(tx, userId, id)) return false;
            await tx.insert(userGroup).values({ userId, groupId: id, assignedBy: actor.id, assignedAt: now });
            await tx.insert(permissionAuditLog).values({
                id: randomUUID(), actorUserId: actor.id, actorName: actor.name,
                action: "user_group.assign", targetUserId: userId, targetGroupId: id,
                detail: { userName: targetUser.name, groupName: group.name }, createdAt: now,
            });
            return true;
        });
        return NextResponse.json({ ok: true, added });
    } catch (e) {
        return jawabGalat(e);
    }
}

export async function DELETE(request: NextRequest, context: Context) {
    const gate = await requirePermission(request, "users.manage");
    if (gate.response) return gate.response;

    const { id } = await context.params;
    const userId = await userIdDari(request);
    if (!userId) return galat(400, "INPUT_TIDAK_VALID", "userId wajib diisi");

    const actor = gate.session!.user;
    const now = new Date();
    try {
        await transaksiOtorisasi(actor.id, async (tx) => {
            const { group, targetUser } = await target(tx, id, userId);
            if (!(await anggota(tx, userId, id))) throw new GalatOtorisasi(404, "BUKAN_ANGGOTA", "User bukan anggota grup ini");
            tolakGrupTerakhir(await anggotaTunggal(tx, id, [userId]));
            await tx.delete(userGroup).where(and(eq(userGroup.groupId, id), eq(userGroup.userId, userId)));
            await tx.insert(permissionAuditLog).values({
                id: randomUUID(), actorUserId: actor.id, actorName: actor.name,
                action: "user_group.remove", targetUserId: userId, targetGroupId: id,
                detail: { userName: targetUser.name, groupName: group.name }, createdAt: now,
            });
        });
        return NextResponse.json({ ok: true });
    } catch (e) {
        return jawabGalat(e);
    }
}
