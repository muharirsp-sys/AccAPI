/*
 * Tujuan: BL-63 tandai / lepas BINTANG grup utama user (owner 11 Okt: opsional; menentukan Beranda; grup preset menurunkan
 *   user.role) — S7-1. Kontrak: docs/handover/S7-KONTRAK-ADMIN-API.md §4, §5.6.
 * Side Effects: user_group.is_primary (dua langkah), user.role (bila grup utama efektif berubah), audit `user_group.star` /
 *   `user_group.unstar` — satu transaksi + penjaga BL-61.
 */
import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { permissionAuditLog } from "@/db/schema";
import { requirePermission } from "@/lib/rbac/resolve";
import { anggota, detailUtama, galat, GalatOtorisasi, jawabGalat, mulaiUtama, pasangBintang, selesaiUtama, transaksiOtorisasi, userTarget } from "@/lib/rbac/otorisasi";

type Context = { params: Promise<{ id: string }> };

async function ubah(request: NextRequest, context: Context, pasang: boolean) {
    const gate = await requirePermission(request, "users.manage");
    if (gate.response) return gate.response;
    const actor = gate.session!.user;
    const { id } = await context.params;
    let groupId: string | null = null;
    if (pasang) {
        const body = await request.json().catch(() => null);
        groupId = typeof body?.groupId === "string" ? body.groupId.trim() : "";
        if (!groupId) return galat(400, "INPUT_TIDAK_VALID", "groupId wajib diisi");
    }
    const now = new Date();
    try {
        const h = await transaksiOtorisasi(actor.id, async (tx) => {
            const t = await userTarget(tx, id);
            if (groupId && !(await anggota(tx, id, groupId))) throw new GalatOtorisasi(404, "BUKAN_ANGGOTA", "User bukan anggota grup ini");
            const lama = await mulaiUtama(tx, id);
            await pasangBintang(tx, id, groupId);
            const hasil = await selesaiUtama(tx, id, lama);
            await tx.insert(permissionAuditLog).values({
                id: randomUUID(), actorUserId: actor.id, actorName: actor.name, action: groupId ? "user_group.star" : "user_group.unstar",
                targetUserId: id, targetGroupId: groupId ?? lama?.groupId ?? null, detail: { userName: t.name, ...detailUtama(lama, hasil) }, createdAt: now,
            });
            return hasil;
        });
        return NextResponse.json({ ok: true, primaryGroupId: h.primaryGroupId, role: h.roleAfter, roleChanged: h.roleChanged });
    } catch (e) {
        return jawabGalat(e);
    }
}

export async function PUT(request: NextRequest, context: Context) {
    return ubah(request, context, true);
}

export async function DELETE(request: NextRequest, context: Context) {
    return ubah(request, context, false);
}
