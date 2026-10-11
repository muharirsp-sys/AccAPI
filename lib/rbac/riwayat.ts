/*
 * Tujuan: Riwayat otorisasi (pembaca pertama permission_audit_log) per user / per grup, dipaginasi keyset — S7-1.
 * Caller: app/api/admin/users/[id]/history, app/api/admin/groups/[id]/history. Kontrak: docs/handover/S7-KONTRAK-ADMIN-API.md §5.9.
 * Side Effects: DB read-only.
 * Catatan: kursor memakai teks timestamp Postgres presisi mikrodetik (bukan Date JS milidetik) agar baris dengan created_at
 *   ber-mikrodetik (mis. ditulis SQL) tidak terlewat di batas halaman.
 */
import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq, sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { accessGroup, permissionAuditLog, user } from "@/db/schema";
import { resolveRequestPermissions } from "@/lib/rbac/resolve";
import { galat } from "@/lib/rbac/otorisasi";

const TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}$/;

export const kodeKursor = (ts: string, id: string) => Buffer.from(`${ts}|${id}`).toString("base64url");
export function bacaKursor(c: string): { ts: string; id: string } | null {
    const [ts, id, ...lebih] = Buffer.from(c, "base64url").toString("utf8").split("|");
    return TS.test(ts ?? "") && id && lebih.length === 0 ? { ts, id } : null;
}

/** GET riwayat untuk `target` (user atau grup). Izin: users.manage ATAU users.view. */
export async function jawabRiwayat(request: NextRequest, target: { userId: string } | { groupId: string }) {
    const gate = await resolveRequestPermissions(request);
    if (gate.response) return gate.response;
    if (!gate.perms!.has("users.manage") && !gate.perms!.has("users.view")) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const q = request.nextUrl.searchParams;
    const limit = q.get("limit") === null ? 50 : Number(q.get("limit"));
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) return galat(400, "INPUT_TIDAK_VALID", "limit harus 1–200.");
    const c = q.get("cursor");
    const kursor = c ? bacaKursor(c) : null;
    if (c && !kursor) return galat(400, "INPUT_TIDAK_VALID", "cursor tidak valid.");

    const l = permissionAuditLog;
    const syarat: SQL[] = ["userId" in target ? eq(l.targetUserId, target.userId) : eq(l.targetGroupId, target.groupId)];
    if (kursor) syarat.push(sql`(${l.createdAt}, ${l.id}) < (${kursor.ts}::timestamp, ${kursor.id})`);
    const rows = await db
        .select({
            id: l.id, action: l.action, actorUserId: l.actorUserId, actorName: l.actorName,
            targetUserId: l.targetUserId, targetUserName: user.name, targetGroupId: l.targetGroupId, targetGroupName: accessGroup.name,
            detail: l.detail, createdAt: l.createdAt,
            kunci: sql<string>`to_char(${l.createdAt}, 'YYYY-MM-DD"T"HH24:MI:SS.US')`,
        })
        .from(l)
        .leftJoin(user, eq(user.id, l.targetUserId))
        .leftJoin(accessGroup, eq(accessGroup.id, l.targetGroupId))
        .where(and(...syarat))
        .orderBy(desc(l.createdAt), desc(l.id))
        .limit(limit + 1);
    const items = rows.slice(0, limit);
    const akhir = items[items.length - 1];
    return NextResponse.json({
        ok: true,
        items: items.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => k !== "kunci"))),
        nextCursor: rows.length > limit && akhir ? kodeKursor(akhir.kunci, akhir.id) : null,
    });
}
