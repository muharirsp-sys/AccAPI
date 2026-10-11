/*
 * Tujuan: Route LAMA dropdown "Access Group" — DIPENSIUNKAN sebagai "ganti semua" (S7-1 BL-63). Kini = TAMBAH grup (bila belum
 *   anggota) + BINTANG grup itu; grup lain user TIDAK dihapus. Tetap hidup agar layar lama tidak patah sampai S7a memakai
 *   `groups/[id]/members` + `users/[id]/primary-group`. Kontrak: docs/handover/S7-KONTRAK-ADMIN-API.md §5.7.
 * Caller: `app/(dashboard)/admin/users/UserManagement.tsx` (dropdown; layar lama).
 * Side Effects: user_group (+ is_primary dua langkah), user.role (bila grup utama efektif berubah), audit `user_group.assign`
 *   (bila baru) + `user_group.star` — satu transaksi + penjaga BL-61.
 */
import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { accessGroup, userGroup, permissionAuditLog } from "@/db/schema";
import { requirePermission } from "@/lib/rbac/resolve";
import { anggota, detailUtama, galat, GalatOtorisasi, jawabGalat, mulaiUtama, pasangBintang, selesaiUtama, transaksiOtorisasi, userTarget } from "@/lib/rbac/otorisasi";

type Context = { params: Promise<{ id: string }> };

export async function POST(request: NextRequest, context: Context) {
    const gate = await requirePermission(request, "users.manage");
    if (gate.response) return gate.response;

    const { id: userId } = await context.params;
    const body = await request.json().catch(() => ({}));
    const groupId = typeof body?.groupId === "string" ? body.groupId.trim() : "";
    if (!groupId) return galat(400, "INPUT_TIDAK_VALID", "groupId wajib diisi");

    const actor = gate.session!.user;
    const now = new Date();
    try {
        const h = await transaksiOtorisasi(actor.id, async (tx) => {
            const target = await userTarget(tx, userId);
            const [group] = await tx.select({ id: accessGroup.id, name: accessGroup.name }).from(accessGroup).where(eq(accessGroup.id, groupId)).limit(1);
            if (!group) throw new GalatOtorisasi(404, "GRUP_TIDAK_ADA", "Group tidak ditemukan");
            const lama = await mulaiUtama(tx, userId);
            const baru = !(await anggota(tx, userId, groupId));
            if (baru) await tx.insert(userGroup).values({ userId, groupId, assignedBy: actor.id, assignedAt: now });
            await pasangBintang(tx, userId, groupId);
            const hasil = await selesaiUtama(tx, userId, lama);
            const base = { id: "", actorUserId: actor.id, actorName: actor.name, targetUserId: userId, targetGroupId: groupId, createdAt: now };
            if (baru) await tx.insert(permissionAuditLog).values({ ...base, id: randomUUID(), action: "user_group.assign", detail: { userName: target.name, groupName: group.name, via: "users/[id]/group" } });
            // Grup sudah berbintang = tanpa audit bintang (tinjauan A #7).
            if (hasil.bintangSebelum !== hasil.bintang || hasil.roleChanged) {
                await tx.insert(permissionAuditLog).values({ ...base, id: randomUUID(), action: "user_group.star", detail: { userName: target.name, groupName: group.name, via: "users/[id]/group", ...detailUtama(lama, hasil) } });
            }
            return hasil;
        });
        return NextResponse.json({ ok: true, role: h.roleAfter, primaryGroupId: h.primaryGroupId });
    } catch (e) {
        return jawabGalat(e);
    }
}
