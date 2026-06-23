import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { eq, and } from "drizzle-orm";
import { db } from "@/lib/db";
import { accessGroup, userGroup, user, permissionAuditLog } from "@/db/schema";
import { requirePermission } from "@/lib/rbac/resolve";

type Context = { params: Promise<{ id: string }> };

export async function POST(request: NextRequest, context: Context) {
    const gate = await requirePermission(request, "users.manage");
    if (gate.response) return gate.response;

    const { id } = await context.params;
    const [group] = await db.select({ id: accessGroup.id }).from(accessGroup).where(eq(accessGroup.id, id)).limit(1);
    if (!group) return NextResponse.json({ error: "Group tidak ditemukan" }, { status: 404 });

    const body = await request.json().catch(() => ({}));
    const userId = String(body.userId || "").trim();
    if (!userId) return NextResponse.json({ error: "userId wajib diisi" }, { status: 400 });

    const [targetUser] = await db.select({ id: user.id, name: user.name }).from(user).where(eq(user.id, userId)).limit(1);
    if (!targetUser) return NextResponse.json({ error: "User tidak ditemukan" }, { status: 404 });

    const actor = gate.session!.user;
    const now = new Date();
    await db.insert(userGroup).values({ userId, groupId: id, assignedBy: actor.id, assignedAt: now }).onConflictDoNothing();
    await db.insert(permissionAuditLog).values({
        id: randomUUID(), actorUserId: actor.id, actorName: actor.name,
        action: "user_group.assign", targetUserId: userId, targetGroupId: id,
        detail: { userName: targetUser.name }, createdAt: now,
    });

    return NextResponse.json({ ok: true });
}

export async function DELETE(request: NextRequest, context: Context) {
    const gate = await requirePermission(request, "users.manage");
    if (gate.response) return gate.response;

    const { id } = await context.params;
    const body = await request.json().catch(() => ({}));
    const userId = String(body.userId || "").trim();
    if (!userId) return NextResponse.json({ error: "userId wajib diisi" }, { status: 400 });

    const actor = gate.session!.user;
    const now = new Date();
    await db.delete(userGroup).where(and(eq(userGroup.groupId, id), eq(userGroup.userId, userId)));
    await db.insert(permissionAuditLog).values({
        id: randomUUID(), actorUserId: actor.id, actorName: actor.name,
        action: "user_group.remove", targetUserId: userId, targetGroupId: id,
        detail: {}, createdAt: now,
    });

    return NextResponse.json({ ok: true });
}
