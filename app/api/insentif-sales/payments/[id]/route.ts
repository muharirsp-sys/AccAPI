/*
 * Tujuan: PATCH update payment status & proof untuk satu record insentif.
 * Caller: Admin finance panel PATCH /api/insentif-sales/payments/{id}.
 * Dependensi: db/schema (incentivePayments), lib/insentif-sales (requireSalesSession).
 * Main Functions: PATCH update paymentStatus, paymentDate, paidBy, paymentProofUrl.
 * Side Effects: DB write.
 */

import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { incentivePayments } from "@/db/schema";
import { requireSalesSession } from "@/lib/insentif-sales";

export async function PATCH(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> },
) {
    const actor = await requireSalesSession();
    if (!actor) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (!["admin", "super_admin", "finance"].includes(actor.role)) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const { id } = await params;

    const [existing] = await db
        .select({ id: incentivePayments.id })
        .from(incentivePayments)
        .where(eq(incentivePayments.id, id))
        .limit(1);

    if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

    let body: {
        paymentStatus?: "belum" | "lunas" | "tunggakan";
        paymentProofUrl?: string;
        paymentDate?: string; // ISO string
    };
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const now = new Date();
    const updateSet: Record<string, unknown> = { updatedAt: now };

    if (body.paymentStatus) updateSet.paymentStatus = body.paymentStatus;
    if (body.paymentProofUrl) updateSet.paymentProofUrl = body.paymentProofUrl;
    if (body.paymentStatus === "lunas") {
        updateSet.paymentDate = body.paymentDate ? new Date(body.paymentDate) : now;
        updateSet.paidBy = actor.id;
        updateSet.paidByName = actor.name;
    }

    await db
        .update(incentivePayments)
        .set(updateSet)
        .where(eq(incentivePayments.id, id));

    return NextResponse.json({ id, updated: true });
}
