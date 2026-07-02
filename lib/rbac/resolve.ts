/*
 * Tujuan: Resolver akses tunggal — group Access Group eksplisit = SATU-SATUNYA sumber
 *   permission user. Legacy (user.role preset / user.permissions custom) hanya fallback
 *   untuk user yang BELUM PERNAH dimasukkan ke group apa pun (belum dimigrasi).
 * Caller: requirePermission() (guard route, dipakai mulai P5) + UI admin RBAC (P6).
 * Dependensi: db (Drizzle), schema user/userGroup/groupPermission, legacy permissionMapForUser.
 * Side Effects: DB read-only.
 * Catatan: sebelumnya legacy role preset DI-UNION dengan group meski user sudah punya group,
 *   menyebabkan role lama (mis. "staff") menyelundupkan akses ekstra di luar group custom yang
 *   sengaja dibatasi admin (bug: group "Return" 3 permission tapi user tetap lihat modul lain).
 *   Begitu user punya >=1 group, legacy diabaikan total — group jadi otoritatif.
 */
import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { auth } from "@/lib/auth";
import { user, userGroup, groupPermission } from "@/db/schema";
import { permissionMapForUser } from "@/lib/rbac";

/** Permission key efektif user (Set "module.action"). Group jika ada; legacy hanya jika belum punya group. */
export async function getUserPermissions(userId: string): Promise<Set<string>> {
    const keys = new Set<string>();

    const groups = await db
        .select({ groupId: userGroup.groupId })
        .from(userGroup)
        .where(eq(userGroup.userId, userId));

    if (groups.length) {
        const rows = await db
            .select({ key: groupPermission.permissionKey })
            .from(groupPermission)
            .where(inArray(groupPermission.groupId, groups.map((g) => g.groupId)));
        for (const r of rows) keys.add(r.key);
        return keys;
    }

    // Belum punya group sama sekali -> fallback legacy role/permissions.
    const [u] = await db
        .select({ role: user.role, permissions: user.permissions })
        .from(user)
        .where(eq(user.id, userId))
        .limit(1);
    if (u) {
        const map = permissionMapForUser(u.role, u.permissions);
        for (const moduleName of Object.keys(map)) {
            for (const action of map[moduleName as keyof typeof map] ?? []) {
                keys.add(`${moduleName}.${action}`);
            }
        }
    }

    return keys;
}

/**
 * Guard route default-deny: sesi wajib + permission key wajib.
 * Pakai: `const gate = await requirePermission(request, "off_program_control.sm_approve");
 *         if (gate.response) return gate.response;`
 */
export async function requirePermission(request: Request, key: string) {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session) {
        return { response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }), session: null, perms: null };
    }
    const perms = await getUserPermissions(session.user.id);
    if (!perms.has(key)) {
        return { response: NextResponse.json({ error: "Forbidden" }, { status: 403 }), session: null, perms: null };
    }
    return { response: null, session, perms };
}

/**
 * Varian headers-based untuk route yang pakai next/headers (handler tanpa param Request),
 * mis. modul Form Kontrol. Sama semantik dengan requirePermission.
 */
export async function requirePermissionH(key: string) {
    return requirePermission({ headers: await headers() } as unknown as Request, key);
}

/**
 * Resolusi sesi + permission TANPA meng-enforce satu key tertentu. Untuk route dengan
 * otorisasi majemuk (mis. ownership-baris OR permission), pakai `perms.has(key)` manual.
 * Tetap default-deny: 401 bila tanpa sesi.
 */
export async function resolveRequestPermissions(request: Request) {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session) {
        return { response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }), session: null, perms: null as Set<string> | null };
    }
    const perms = await getUserPermissions(session.user.id);
    return { response: null, session, perms };
}

export async function resolveRequestPermissionsH() {
    return resolveRequestPermissions({ headers: await headers() } as unknown as Request);
}
