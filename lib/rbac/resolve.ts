/*
 * Tujuan: Resolver akses tunggal — akses user = UNION permission semua Access Group-nya
 *   ∪ legacy (user.role preset / user.permissions custom) selama transisi.
 * Caller: requirePermission() (guard route, dipakai mulai P5) + UI admin RBAC (P6).
 * Dependensi: db (Drizzle), schema user/userGroup/groupPermission, legacy permissionMapForUser.
 * Side Effects: DB read-only.
 */
import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { auth } from "@/lib/auth";
import { user, userGroup, groupPermission } from "@/db/schema";
import { permissionMapForUser } from "@/lib/rbac";

/** Permission key efektif user (Set "module.action"). UNION group + legacy. */
export async function getUserPermissions(userId: string): Promise<Set<string>> {
    const keys = new Set<string>();

    // 1. Sistem baru: union semua group user.
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
    }

    // 2. Legacy override (transisi): user.role preset / user.permissions custom.
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
