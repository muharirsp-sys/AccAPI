/*
 * Tujuan: Set SATU Access Group primer milik user (ganti seluruh membership lama).
 * Caller: `app/(dashboard)/admin/users/UserManagement.tsx` (dropdown "Access Group").
 * Dependensi: db (Drizzle), schema user/userGroup/accessGroup/permissionAuditLog, RBAC resolve.
 * Main Functions: POST.
 * Side Effects: Replace user_group user ini (hapus semua lalu insert satu); set user.role
 *   (identity, dipakai gate Claim Workflow/Form Kontrol) bila nama group cocok preset dikenal;
 *   kosongkan user.permissions legacy — permission kini murni dari Access Group.
 * Catatan: model single-primary-group. Membership majemuk (jika sengaja dibuat lewat
 *   /admin/groups "Tambah Member") akan direset ke satu group saat dropdown ini dipakai.
 */
import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { accessGroup, userGroup, user, permissionAuditLog } from "@/db/schema";
import { requirePermission } from "@/lib/rbac/resolve";

type Context = { params: Promise<{ id: string }> };

// Nama preset group -> role identity string. Mirror ROLE_TO_GROUP di scripts/seed-rbac-presets.ts
// (arah kebalikan). Group custom (bukan preset ini) tidak mengubah user.role.
const GROUP_NAME_TO_ROLE: Record<string, string> = {
    Admin: "admin", Manager: "manager", Finance: "finance", Staff: "staff", Viewer: "viewer",
    SPV: "spv", SM: "sm", Claim: "claim", OM: "om", Salesman: "salesman", "Admin Sales": "admin_sales",
};

export async function POST(request: NextRequest, context: Context) {
    const gate = await requirePermission(request, "users.manage");
    if (gate.response) return gate.response;

    const { id: userId } = await context.params;
    const [targetUser] = await db.select({ id: user.id, name: user.name }).from(user).where(eq(user.id, userId)).limit(1);
    if (!targetUser) return NextResponse.json({ error: "User tidak ditemukan" }, { status: 404 });

    const body = await request.json().catch(() => ({}));
    const groupId = String(body?.groupId || "").trim();
    if (!groupId) return NextResponse.json({ error: "groupId wajib diisi" }, { status: 400 });

    const [group] = await db.select({ id: accessGroup.id, name: accessGroup.name }).from(accessGroup).where(eq(accessGroup.id, groupId)).limit(1);
    if (!group) return NextResponse.json({ error: "Group tidak ditemukan" }, { status: 404 });

    const actor = gate.session!.user;
    const now = new Date();
    const mappedRole = GROUP_NAME_TO_ROLE[group.name];

    await db.delete(userGroup).where(eq(userGroup.userId, userId));
    await db.insert(userGroup).values({ userId, groupId, assignedBy: actor.id, assignedAt: now });
    await db
        .update(user)
        .set({ permissions: "{}", ...(mappedRole ? { role: mappedRole } : {}), updatedAt: now })
        .where(eq(user.id, userId));
    await db.insert(permissionAuditLog).values({
        id: randomUUID(), actorUserId: actor.id, actorName: actor.name,
        action: "user_group.set_primary", targetUserId: userId, targetGroupId: groupId,
        detail: { userName: targetUser.name, groupName: group.name, mappedRole: mappedRole ?? null }, createdAt: now,
    });

    return NextResponse.json({ ok: true, role: mappedRole ?? null });
}
