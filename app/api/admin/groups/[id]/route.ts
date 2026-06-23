import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { accessGroup, groupPermission, userGroup, user, permissionAuditLog } from "@/db/schema";
import { requirePermission } from "@/lib/rbac/resolve";
import { isValidPermissionKey } from "@/lib/rbac/registry";

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

export async function PATCH(request: NextRequest, context: Context) {
    const gate = await requirePermission(request, "users.manage");
    if (gate.response) return gate.response;

    const { id } = await context.params;
    const [existing] = await db.select().from(accessGroup).where(eq(accessGroup.id, id)).limit(1);
    if (!existing) return NextResponse.json({ error: "Group tidak ditemukan" }, { status: 404 });

    const body = await request.json().catch(() => ({}));
    const actor = gate.session!.user;
    const now = new Date();

    if (body.name !== undefined || body.description !== undefined) {
        const name = String(body.name ?? existing.name).trim();
        const description = String(body.description ?? existing.description ?? "").trim();
        if (!name) return NextResponse.json({ error: "Nama group wajib diisi" }, { status: 400 });
        await db.update(accessGroup).set({ name, description, updatedAt: now }).where(eq(accessGroup.id, id));
        await db.insert(permissionAuditLog).values({
            id: randomUUID(), actorUserId: actor.id, actorName: actor.name,
            action: "group.update", targetGroupId: id, detail: { name, description }, createdAt: now,
        });
    }

    if (Array.isArray(body.permissions)) {
        const keys = body.permissions as string[];
        const invalid = keys.filter((k) => !isValidPermissionKey(k));
        if (invalid.length > 0) return NextResponse.json({ error: `Key tidak valid: ${invalid.join(", ")}` }, { status: 400 });
        await db.delete(groupPermission).where(eq(groupPermission.groupId, id));
        if (keys.length > 0) await db.insert(groupPermission).values(keys.map((k) => ({ groupId: id, permissionKey: k })));
        await db.insert(permissionAuditLog).values({
            id: randomUUID(), actorUserId: actor.id, actorName: actor.name,
            action: "group_permission.sync", targetGroupId: id, detail: { keyCount: keys.length }, createdAt: now,
        });
    }

    return NextResponse.json({ ok: true });
}

export async function DELETE(request: NextRequest, context: Context) {
    const gate = await requirePermission(request, "users.manage");
    if (gate.response) return gate.response;

    const { id } = await context.params;
    const [existing] = await db.select().from(accessGroup).where(eq(accessGroup.id, id)).limit(1);
    if (!existing) return NextResponse.json({ error: "Group tidak ditemukan" }, { status: 404 });
    if (existing.isPreset) return NextResponse.json({ error: "Preset group tidak bisa dihapus" }, { status: 409 });

    const actor = gate.session!.user;
    const now = new Date();
    await db.delete(groupPermission).where(eq(groupPermission.groupId, id));
    await db.delete(userGroup).where(eq(userGroup.groupId, id));
    await db.delete(accessGroup).where(eq(accessGroup.id, id));
    await db.insert(permissionAuditLog).values({
        id: randomUUID(), actorUserId: actor.id, actorName: actor.name,
        action: "group.delete", targetGroupId: id, detail: { name: existing.name }, createdAt: now,
    });

    return NextResponse.json({ ok: true });
}
