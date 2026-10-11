import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { asc, count } from "drizzle-orm";
import { db } from "@/lib/db";
import { accessGroup, groupPermission, userGroup, permissionAuditLog } from "@/db/schema";
import { requirePermission } from "@/lib/rbac/resolve";
import { galat, jawabGalat, transaksiOtorisasi } from "@/lib/rbac/otorisasi";

export async function GET(request: NextRequest) {
    const gate = await requirePermission(request, "users.manage");
    if (gate.response) return gate.response;

    const groups = await db
        .select({ id: accessGroup.id, name: accessGroup.name, description: accessGroup.description, isPreset: accessGroup.isPreset })
        .from(accessGroup)
        .orderBy(asc(accessGroup.name));

    const permCounts = await db.select({ groupId: groupPermission.groupId, cnt: count() }).from(groupPermission).groupBy(groupPermission.groupId);
    const memberCounts = await db.select({ groupId: userGroup.groupId, cnt: count() }).from(userGroup).groupBy(userGroup.groupId);
    const permMap = Object.fromEntries(permCounts.map((r) => [r.groupId, r.cnt]));
    const memberMap = Object.fromEntries(memberCounts.map((r) => [r.groupId, r.cnt]));

    return NextResponse.json({
        groups: groups.map((g) => ({ ...g, permCount: permMap[g.id] ?? 0, memberCount: memberMap[g.id] ?? 0 })),
    });
}

export async function POST(request: NextRequest) {
    const gate = await requirePermission(request, "users.manage");
    if (gate.response) return gate.response;

    const body = await request.json().catch(() => ({}));
    const name = String(body.name || "").trim();
    const description = String(body.description || "").trim();
    if (!name) return galat(400, "INPUT_TIDAK_VALID", "Nama group wajib diisi");

    const id = randomUUID();
    const now = new Date();
    try {
        // Grup + audit satu transaksi; nama bentrok (unik) -> 409 NAMA_GRUP_TERPAKAI.
        await transaksiOtorisasi(gate.session!.user.id, async (tx) => {
            await tx.insert(accessGroup).values({ id, name, description, isPreset: false, createdAt: now, updatedAt: now });
            await tx.insert(permissionAuditLog).values({
                id: randomUUID(), actorUserId: gate.session!.user.id, actorName: gate.session!.user.name,
                action: "group.create", targetGroupId: id, detail: { name, description }, createdAt: now,
            });
        });
    } catch (e) {
        return jawabGalat(e);
    }

    return NextResponse.json({ ok: true, group: { id, name, description, isPreset: false } }, { status: 201 });
}
