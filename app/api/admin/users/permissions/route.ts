/*
 * Tujuan: API admin untuk membaca daftar user internal + Access Group primer masing-masing.
 * Caller: `app/(dashboard)/admin/users/UserManagement.tsx`, `app/(dashboard)/admin/groups/GroupManagement.tsx`.
 * Dependensi: Better Auth session, Drizzle SQLite, schema `user`/`userGroup`/`accessGroup`, helper RBAC.
 * Main Functions: GET.
 * Side Effects: DB read-only.
 * Catatan: penulisan permission per-user (legacy) dihapus — satu pintu via
 *   app/api/admin/users/[id]/group/route.ts (set Access Group) atau /api/admin/groups (edit group).
 */
import { NextRequest, NextResponse } from "next/server";
import { asc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { user, userGroup, accessGroup } from "@/db/schema";
import { requirePermission } from "@/lib/rbac/resolve";

export async function GET(request: NextRequest) {
    const gate = await requirePermission(request, "users.manage");
    if (gate.response) return gate.response;

    const rows = await db
        .select({
            id: user.id,
            name: user.name,
            email: user.email,
            role: user.role,
            permissions: user.permissions,
            emailVerified: user.emailVerified,
            banned: user.banned,
        })
        .from(user)
        .orderBy(asc(user.email));

    // Group primer per user (model single-primary-group untuk dropdown Access Group).
    const groupRows = await db
        .select({ userId: userGroup.userId, groupId: userGroup.groupId, groupName: accessGroup.name })
        .from(userGroup)
        .innerJoin(accessGroup, eq(userGroup.groupId, accessGroup.id))
        .orderBy(asc(accessGroup.name));
    const groupByUser = new Map<string, { groupId: string; groupName: string }>();
    for (const r of groupRows) if (!groupByUser.has(r.userId)) groupByUser.set(r.userId, { groupId: r.groupId, groupName: r.groupName });

    return NextResponse.json({
        users: rows.map((r) => ({ ...r, groupId: groupByUser.get(r.id)?.groupId ?? null, groupName: groupByUser.get(r.id)?.groupName ?? null })),
    });
}
