/*
 * Tujuan: CRUD assignment SPV → SM (hierarki pelaporan, Bagian C).
 *         BELUM di-wire ke kalkulasi insentif atau scoping RBAC apapun — murni data admin.
 * Caller: app/(dashboard)/insentif-sales/page.tsx (HierarchyAssignmentSection, AdminView).
 * Dependensi: db/schema (smSpvAssignment).
 * Main Functions: GET list; POST upsert-by-spvName; DELETE by id.
 * Side Effects: DB read + write.
 */

import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { smSpvAssignment } from "@/db/schema";
import { requirePermission } from "@/lib/rbac/resolve";

export async function GET(req: NextRequest) {
    const gate = await requirePermission(req, "insentif_sales.view");
    if (gate.response) return gate.response;

    const rows = await db.select().from(smSpvAssignment);
    return NextResponse.json({ rows });
}

export async function POST(req: NextRequest) {
    const gate = await requirePermission(req, "insentif_sales.manage_hierarchy");
    if (gate.response) return gate.response;

    let body: { spvName?: string; smName?: string };
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }
    const spvName = body.spvName?.trim();
    const smName = body.smName?.trim();
    if (!spvName || !smName) {
        return NextResponse.json({ error: "spvName dan smName wajib diisi" }, { status: 400 });
    }

    const now = new Date();
    const [existing] = await db
        .select({ id: smSpvAssignment.id })
        .from(smSpvAssignment)
        .where(eq(smSpvAssignment.spvName, spvName))
        .limit(1);

    if (existing) {
        await db.update(smSpvAssignment).set({ smName, updatedAt: now }).where(eq(smSpvAssignment.id, existing.id));
        return NextResponse.json({ id: existing.id, action: "updated" });
    }
    const id = randomUUID();
    await db.insert(smSpvAssignment).values({ id, spvName, smName, createdAt: now, updatedAt: now });
    return NextResponse.json({ id, action: "created" }, { status: 201 });
}

export async function DELETE(req: NextRequest) {
    const gate = await requirePermission(req, "insentif_sales.manage_hierarchy");
    if (gate.response) return gate.response;

    const id = req.nextUrl.searchParams.get("id");
    if (!id) return NextResponse.json({ error: "id wajib diisi" }, { status: 400 });

    await db.delete(smSpvAssignment).where(eq(smSpvAssignment.id, id));
    return NextResponse.json({ ok: true });
}
