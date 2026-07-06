/*
 * Tujuan: CRUD assignment Sales → SPV (hierarki pelaporan, Bagian C).
 *         BELUM di-wire ke kalkulasi insentif atau scoping RBAC apapun — murni data admin.
 * Caller: app/(dashboard)/insentif-sales/page.tsx (HierarchyAssignmentSection, AdminView).
 * Dependensi: db/schema (spvSalesAssignment).
 * Main Functions: GET list; POST upsert-by-salesCode; DELETE by id.
 * Side Effects: DB read + write.
 */

import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { spvSalesAssignment } from "@/db/schema";
import { requirePermission } from "@/lib/rbac/resolve";

export async function GET(req: NextRequest) {
    const gate = await requirePermission(req, "insentif_sales.view");
    if (gate.response) return gate.response;

    const rows = await db.select().from(spvSalesAssignment);
    return NextResponse.json({ rows });
}

export async function POST(req: NextRequest) {
    const gate = await requirePermission(req, "insentif_sales.manage_hierarchy");
    if (gate.response) return gate.response;

    let body: { salesCode?: string; spvName?: string };
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }
    const salesCode = body.salesCode?.trim();
    const spvName = body.spvName?.trim();
    if (!salesCode || !spvName) {
        return NextResponse.json({ error: "salesCode dan spvName wajib diisi" }, { status: 400 });
    }

    const now = new Date();
    const [existing] = await db
        .select({ id: spvSalesAssignment.id })
        .from(spvSalesAssignment)
        .where(eq(spvSalesAssignment.salesCode, salesCode))
        .limit(1);

    if (existing) {
        await db.update(spvSalesAssignment).set({ spvName, updatedAt: now }).where(eq(spvSalesAssignment.id, existing.id));
        return NextResponse.json({ id: existing.id, action: "updated" });
    }
    const id = randomUUID();
    await db.insert(spvSalesAssignment).values({ id, salesCode, spvName, createdAt: now, updatedAt: now });
    return NextResponse.json({ id, action: "created" }, { status: 201 });
}

export async function DELETE(req: NextRequest) {
    const gate = await requirePermission(req, "insentif_sales.manage_hierarchy");
    if (gate.response) return gate.response;

    const id = req.nextUrl.searchParams.get("id");
    if (!id) return NextResponse.json({ error: "id wajib diisi" }, { status: 400 });

    await db.delete(spvSalesAssignment).where(eq(spvSalesAssignment.id, id));
    return NextResponse.json({ ok: true });
}
