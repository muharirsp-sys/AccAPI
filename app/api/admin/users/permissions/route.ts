/*
 * Tujuan: API admin untuk membaca user internal dan menyimpan permission RBAC per user.
 * Caller: `app/(dashboard)/admin/users/UserManagement.tsx`.
 * Dependensi: Better Auth session, Drizzle SQLite, schema `user`, helper RBAC.
 * Main Functions: GET, POST.
 * Side Effects: DB read/write kolom `user.permissions`.
 */
import { NextRequest, NextResponse } from "next/server";
import { asc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { normalizePermissionMap, serializeCustomPermissions } from "@/lib/rbac";
import { user } from "@/db/schema";
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

    return NextResponse.json({ users: rows });
}

export async function POST(request: NextRequest) {
    const gate = await requirePermission(request, "users.manage");
    if (gate.response) return gate.response;

    const body = await request.json().catch(() => null);
    const userId = String(body?.userId || "").trim();
    if (!userId) {
        return NextResponse.json({ error: "userId wajib diisi" }, { status: 400 });
    }

    const permissions = body?.useRolePreset === true
        ? "{}"
        : serializeCustomPermissions(normalizePermissionMap(body?.permissions || {}));

    await db
        .update(user)
        .set({ permissions, updatedAt: new Date() })
        .where(eq(user.id, userId));

    return NextResponse.json({ ok: true, permissions });
}
