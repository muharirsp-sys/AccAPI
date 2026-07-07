/*
 * Tujuan: CRUD assignment Sales → SPV (hierarki pelaporan, Bagian C).
 * Caller: app/(dashboard)/insentif-sales/page.tsx (HierarchyAssignmentSection, AdminView).
 * Dependensi: db/schema (spvSalesAssignment, spvSalesClaimRequest), lib/insentif-hierarchy-scope.
 * Main Functions: GET list; POST upsert-by-salesCode; DELETE by id.
 *   POST punya 2 jalur:
 *   - Admin (insentif_sales.manage_hierarchy): tulis langsung, boleh assign ke SPV manapun.
 *   - SPV self-service (user.hierarchyRole='spv'): HANYA boleh assign ke DIRINYA SENDIRI.
 *     salesCode belum diklaim siapapun -> tulis langsung. Sudah dipegang SPV LAIN (rolling)
 *     -> tidak ditulis, dibuat spv_sales_claim_request (pending), tunggu admin approve
 *     lewat /api/insentif-sales/hierarchy/spv-sales/requests.
 * Side Effects: DB read + write.
 */

import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { spvSalesAssignment, spvSalesClaimRequest } from "@/db/schema";
import { requirePermission, resolveRequestPermissions } from "@/lib/rbac/resolve";
import { getUserHierarchyIdentity, getCurrentSpvOwner } from "@/lib/insentif-hierarchy-scope";

export async function GET(req: NextRequest) {
    const gate = await requirePermission(req, "insentif_sales.view");
    if (gate.response) return gate.response;

    const rows = await db.select().from(spvSalesAssignment);
    return NextResponse.json({ rows });
}

export async function POST(req: NextRequest) {
    const gate = await resolveRequestPermissions(req);
    if (gate.response) return gate.response;

    const isAdmin = gate.perms.has("insentif_sales.manage_hierarchy");
    const identity = isAdmin ? null : await getUserHierarchyIdentity(gate.session.user.id);
    if (!isAdmin && identity?.role !== "spv") {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    let body: { salesCode?: string; spvName?: string };
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }
    const salesCode = body.salesCode?.trim();
    if (!salesCode) return NextResponse.json({ error: "salesCode wajib diisi" }, { status: 400 });

    // SPV self-service: hanya boleh assign ke diri sendiri, ignore spvName dari body kalau ada.
    const spvName = isAdmin ? body.spvName?.trim() : identity!.name;
    if (!spvName) return NextResponse.json({ error: "spvName wajib diisi" }, { status: 400 });

    if (!isAdmin) {
        const currentOwner = await getCurrentSpvOwner(salesCode);
        if (currentOwner && currentOwner !== spvName) {
            // Rolling — sudah dipegang SPV lain. Jangan tulis langsung, buat pending request
            // (dedup: kalau sudah ada permintaan pending yang sama, jangan duplikat).
            const [existingRequest] = await db
                .select({ id: spvSalesClaimRequest.id })
                .from(spvSalesClaimRequest)
                .where(
                    and(
                        eq(spvSalesClaimRequest.salesCode, salesCode),
                        eq(spvSalesClaimRequest.requestedBySpvName, spvName),
                        eq(spvSalesClaimRequest.status, "pending"),
                    ),
                )
                .limit(1);
            if (existingRequest) {
                return NextResponse.json({ action: "pending_approval", requestId: existingRequest.id }, { status: 202 });
            }
            const id = randomUUID();
            await db.insert(spvSalesClaimRequest).values({
                id, salesCode,
                requestedBySpvName: spvName,
                requestedByUserId: gate.session.user.id,
                previousSpvName: currentOwner,
                status: "pending",
                createdAt: new Date(),
            });
            return NextResponse.json({ action: "pending_approval", requestId: id }, { status: 202 });
        }
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
