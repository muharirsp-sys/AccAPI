import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { accessGroup, groupPermission, userGroup, user, permissionAuditLog } from "@/db/schema";
import { requirePermission } from "@/lib/rbac/resolve";
import { isValidPermissionKey } from "@/lib/rbac/registry";
import { anggotaTunggal, galat, GalatOtorisasi, jawabGalat, tolakGrupTerakhir, transaksiOtorisasi, type Tx } from "@/lib/rbac/otorisasi";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, context: Context) {
    const gate = await requirePermission(request, "users.manage");
    if (gate.response) return gate.response;

    const { id } = await context.params;
    const [group] = await db.select().from(accessGroup).where(eq(accessGroup.id, id)).limit(1);
    if (!group) return NextResponse.json({ error: "Group tidak ditemukan" }, { status: 404 });

    const permissions = await db
        .select({ key: groupPermission.permissionKey })
        .from(groupPermission)
        .where(eq(groupPermission.groupId, id));

    const members = await db
        .select({ userId: userGroup.userId, assignedAt: userGroup.assignedAt, assignedBy: userGroup.assignedBy, userName: user.name, userEmail: user.email })
        .from(userGroup)
        .innerJoin(user, eq(userGroup.userId, user.id))
        .where(eq(userGroup.groupId, id));

    return NextResponse.json({ group, permissions: permissions.map((p) => p.key), members });
}

const tidakAda = () => new GalatOtorisasi(404, "GRUP_TIDAK_ADA", "Group tidak ditemukan");

/** Baris grup dikunci FOR UPDATE di dalam transaksi (AM-057); terhapus sesudah permintaan dibuat -> 404. */
async function kunciGrup(tx: Tx, id: string) {
    const [locked] = await tx.select().from(accessGroup).where(eq(accessGroup.id, id)).for("update");
    if (!locked) throw tidakAda();
    return locked;
}

export async function PATCH(request: NextRequest, context: Context) {
    const gate = await requirePermission(request, "users.manage");
    if (gate.response) return gate.response;

    const { id } = await context.params;
    const body = await request.json().catch(() => ({}));
    const actor = gate.session!.user;
    const now = new Date();

    // Semua validasi SEBELUM tulis apa pun (AM-057 LOW: dulu nama tersimpan lalu izin ditolak).
    const ubahNama = body.name !== undefined || body.description !== undefined;
    if (ubahNama && body.name !== undefined && !String(body.name ?? "").trim()) return galat(400, "INPUT_TIDAK_VALID", "Nama group wajib diisi");
    const keys = Array.isArray(body.permissions) ? [...new Set(body.permissions as unknown[])] : null;
    if (keys) {
        const invalid = keys.filter((k) => typeof k !== "string" || !isValidPermissionKey(k)).map(String);
        if (invalid.length > 0) return galat(400, "KUNCI_TIDAK_VALID", `Key tidak valid: ${invalid.join(", ")}`, { invalid });
    }

    try {
        // Nama + izin + audit = SATU transaksi; penjaga BL-61 sesudahnya (kunci global, lalu baris grup FOR UPDATE).
        await transaksiOtorisasi(actor.id, async (tx) => {
            const locked = await kunciGrup(tx, id);
            if (ubahNama) {
                const name = String(body.name ?? locked.name).trim();
                const description = String(body.description ?? locked.description ?? "").trim();
                if (locked.isPreset && name !== locked.name) {
                    throw new GalatOtorisasi(409, "PRESET_NAMA_TERKUNCI", "Nama grup preset tidak bisa diubah.");
                }
                await tx.update(accessGroup).set({ name, description, updatedAt: now }).where(eq(accessGroup.id, id));
                await tx.insert(permissionAuditLog).values({
                    id: randomUUID(), actorUserId: actor.id, actorName: actor.name,
                    action: "group.update", targetGroupId: id, detail: { name, description }, createdAt: now,
                });
            }
            if (keys) {
                const next = keys as string[];
                // AM-057: kunci lama dibaca SESUDAH baris grup terkunci -> audit added/removed pasti.
                const before = new Set((await tx.select({ key: groupPermission.permissionKey }).from(groupPermission).where(eq(groupPermission.groupId, id))).map((r) => r.key));
                if (locked.isPreset && locked.name === "Admin" && !next.includes("users.manage")) {
                    throw new GalatOtorisasi(409, "ADMIN_PRESET_TERKUNCI", "Kunci users.manage pada grup preset Admin tidak bisa dicabut.");
                }
                const added = next.filter((k) => !before.has(k)).sort();
                const removed = [...before].filter((k) => !next.includes(k)).sort();
                await tx.delete(groupPermission).where(eq(groupPermission.groupId, id));
                if (next.length > 0) await tx.insert(groupPermission).values(next.map((k) => ({ groupId: id, permissionKey: k })));
                await tx.insert(permissionAuditLog).values({
                    id: randomUUID(), actorUserId: actor.id, actorName: actor.name,
                    action: "group_permission.sync", targetGroupId: id, detail: { keyCount: next.length, added, removed }, createdAt: now,
                });
            }
        });
    } catch (e) {
        return jawabGalat(e);
    }
    return NextResponse.json({ ok: true });
}

export async function DELETE(request: NextRequest, context: Context) {
    const gate = await requirePermission(request, "users.manage");
    if (gate.response) return gate.response;

    const { id } = await context.params;
    const actor = gate.session!.user;
    const now = new Date();
    try {
        await transaksiOtorisasi(actor.id, async (tx) => {
            const existing = await kunciGrup(tx, id);
            if (existing.isPreset) throw new GalatOtorisasi(409, "PRESET_TIDAK_BISA_DIHAPUS", "Preset group tidak bisa dihapus");
            tolakGrupTerakhir(await anggotaTunggal(tx, id));
            await tx.delete(groupPermission).where(eq(groupPermission.groupId, id));
            await tx.delete(userGroup).where(eq(userGroup.groupId, id));
            await tx.delete(accessGroup).where(eq(accessGroup.id, id));
            await tx.insert(permissionAuditLog).values({
                id: randomUUID(), actorUserId: actor.id, actorName: actor.name,
                action: "group.delete", targetGroupId: id, detail: { name: existing.name }, createdAt: now,
            });
        });
    } catch (e) {
        return jawabGalat(e);
    }
    return NextResponse.json({ ok: true });
}
