/*
 * Tujuan: API admin untuk membaca daftar user internal + SEMUA Access Group tiap user + grup utama efektif (BL-63, S7-1).
 * Caller: `app/(dashboard)/admin/users/UserManagement.tsx`, `app/(dashboard)/admin/groups/GroupManagement.tsx`, Beranda
 *   (`lib/beranda.ts` tile "User tanpa grup": `groupId` + `banned`).
 * Dependensi: Better Auth session, Drizzle, schema `user`/`userGroup`/`accessGroup`, helper RBAC.
 * Main Functions: GET.
 * Side Effects: DB read-only.
 * Izin: `users.manage` ATAU `users.view` (D-01 §E: users.view = daftar baca-saja). Kontrak: docs/handover/S7-KONTRAK-ADMIN-API.md §5.1.
 * Catatan: `groupId`/`groupName` = field LAMA dipertahankan (grup utama efektif, selain itu grup pertama menurut nama) agar Beranda &
 *   GroupManagement tidak berubah; layar baru memakai `groups[]` + `primaryGroupId`.
 */
import { NextRequest, NextResponse } from "next/server";
import { asc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { user, userGroup, accessGroup } from "@/db/schema";
import { resolveRequestPermissions } from "@/lib/rbac/resolve";
import { pilihUtama } from "@/lib/rbac/otorisasi";

export async function GET(request: NextRequest) {
    const gate = await resolveRequestPermissions(request);
    if (gate.response) return gate.response;
    if (!gate.perms!.has("users.manage") && !gate.perms!.has("users.view")) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const rows = await db
        .select({
            id: user.id,
            name: user.name,
            email: user.email,
            role: user.role,
            permissions: user.permissions,
            emailVerified: user.emailVerified,
            banned: user.banned,
            banReason: user.banReason,
        })
        .from(user)
        .orderBy(asc(user.email));

    const groupRows = await db
        .select({ userId: userGroup.userId, id: userGroup.groupId, name: accessGroup.name, isPreset: accessGroup.isPreset, isPrimary: userGroup.isPrimary })
        .from(userGroup)
        .innerJoin(accessGroup, eq(userGroup.groupId, accessGroup.id))
        .orderBy(asc(accessGroup.name));
    const groupsByUser = new Map<string, Array<{ id: string; name: string; isPreset: boolean; isPrimary: boolean }>>();
    for (const { userId, ...g } of groupRows) groupsByUser.set(userId, [...(groupsByUser.get(userId) ?? []), g]);

    return NextResponse.json({
        users: rows.map((r) => {
            const groups = groupsByUser.get(r.id) ?? [];
            const utama = pilihUtama(groups);
            const lama = utama ?? groups[0] ?? null;
            return {
                ...r, groups,
                primaryGroupId: utama?.id ?? null, primaryGroupName: utama?.name ?? null,
                groupId: lama?.id ?? null, groupName: lama?.name ?? null,
            };
        }),
    });
}
