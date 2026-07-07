/*
 * Tujuan: Admin approve/reject permintaan klaim salesman "rolling" (spv_sales_claim_request).
 * Caller: app/(dashboard)/insentif-sales/page.tsx (HierarchyAssignmentSection — panel admin).
 * Dependensi: db/schema (spvSalesClaimRequest, spvSalesAssignment).
 * Main Functions: GET list pending; POST decide (approve -> tulis spv_sales_assignment, reject -> tandai saja).
 * Side Effects: DB read + write.
 */

import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { spvSalesClaimRequest, spvSalesAssignment } from "@/db/schema";
import { requirePermission } from "@/lib/rbac/resolve";

export async function GET(req: NextRequest) {
    const gate = await requirePermission(req, "insentif_sales.manage_hierarchy");
    if (gate.response) return gate.response;

    const rows = await db.select().from(spvSalesClaimRequest).where(eq(spvSalesClaimRequest.status, "pending"));
    return NextResponse.json({ rows });
}

export async function POST(req: NextRequest) {
    const gate = await requirePermission(req, "insentif_sales.manage_hierarchy");
    if (gate.response) return gate.response;

    let body: { requestId?: string; decision?: "approve" | "reject" };
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }
    if (!body.requestId || (body.decision !== "approve" && body.decision !== "reject")) {
        return NextResponse.json({ error: "requestId dan decision ('approve'|'reject') wajib diisi" }, { status: 400 });
    }

    const [reqRow] = await db
        .select()
        .from(spvSalesClaimRequest)
        .where(eq(spvSalesClaimRequest.id, body.requestId))
        .limit(1);
    if (!reqRow) return NextResponse.json({ error: "Request tidak ditemukan" }, { status: 404 });
    if (reqRow.status !== "pending") return NextResponse.json({ error: `Request sudah ${reqRow.status}` }, { status: 409 });

    const now = new Date();

    if (body.decision === "approve") {
        const [existing] = await db
            .select({ id: spvSalesAssignment.id })
            .from(spvSalesAssignment)
            .where(eq(spvSalesAssignment.salesCode, reqRow.salesCode))
            .limit(1);
        if (existing) {
            await db.update(spvSalesAssignment).set({ spvName: reqRow.requestedBySpvName, updatedAt: now }).where(eq(spvSalesAssignment.id, existing.id));
        } else {
            await db.insert(spvSalesAssignment).values({
                id: randomUUID(), salesCode: reqRow.salesCode, spvName: reqRow.requestedBySpvName, createdAt: now, updatedAt: now,
            });
        }
    }

    await db
        .update(spvSalesClaimRequest)
        .set({ status: body.decision === "approve" ? "approved" : "rejected", decidedAt: now, decidedByUserId: gate.session.user.id })
        .where(eq(spvSalesClaimRequest.id, body.requestId));

    return NextResponse.json({ ok: true, decision: body.decision });
}
