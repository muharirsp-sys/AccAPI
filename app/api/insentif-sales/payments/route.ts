/*
 * Tujuan: GET list + POST create payment records Insentif Sales.
 * Caller: app/(dashboard)/insentif-sales/page.tsx untuk tabel insentif.
 * Dependensi: db/schema (incentivePayments), lib/insentif-sales (requireSalesSession).
 * Main Functions: GET list payments per periode; POST create/update payment record.
 * Side Effects: DB read + write.
 */

import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { incentivePayments } from "@/db/schema";
import { requireSalesSession } from "@/lib/insentif-sales";

export async function GET(req: NextRequest) {
    const actor = await requireSalesSession();
    if (!actor) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { searchParams } = req.nextUrl;
    const now = new Date();
    const month = parseInt(searchParams.get("month") ?? String(now.getMonth() + 1), 10);
    const year = parseInt(searchParams.get("year") ?? String(now.getFullYear()), 10);
    const principle = searchParams.get("principle") ?? undefined;
    const branch = searchParams.get("branch") ?? undefined;

    const conditions = [
        eq(incentivePayments.periodMonth, month),
        eq(incentivePayments.periodYear, year),
    ];
    if (principle) conditions.push(eq(incentivePayments.principle, principle));
    if (branch) conditions.push(eq(incentivePayments.branch, branch));

    const rows = await db
        .select()
        .from(incentivePayments)
        .where(and(...conditions));

    return NextResponse.json({ month, year, rows });
}

interface PaymentInput {
    salesCode: string;
    salesName: string;
    principle: string;
    branch: string;
    periodMonth: number;
    periodYear: number;
    totalIncentive: number;
    paymentStatus?: "belum" | "lunas" | "tunggakan";
    paymentProofUrl?: string;
}

export async function POST(req: NextRequest) {
    const actor = await requireSalesSession();
    if (!actor) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (!["admin", "super_admin", "finance"].includes(actor.role)) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    let body: PaymentInput;
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    if (!body.salesCode || !body.periodMonth || !body.periodYear) {
        return NextResponse.json({ error: "salesCode, periodMonth, periodYear required" }, { status: 400 });
    }

    const now = new Date();

    // Kunci = salesCode + principle + period (mix → 1 payment per principle).
    const [existing] = await db
        .select({ id: incentivePayments.id })
        .from(incentivePayments)
        .where(
            and(
                eq(incentivePayments.salesCode, body.salesCode),
                eq(incentivePayments.principle, body.principle),
                eq(incentivePayments.periodMonth, body.periodMonth),
                eq(incentivePayments.periodYear, body.periodYear),
            ),
        )
        .limit(1);

    if (existing) {
        await db
            .update(incentivePayments)
            .set({
                salesName: body.salesName,
                totalIncentive: body.totalIncentive,
                paymentStatus: body.paymentStatus ?? "belum",
                paymentProofUrl: body.paymentProofUrl ?? null,
                updatedAt: now,
            })
            .where(eq(incentivePayments.id, existing.id));
        return NextResponse.json({ id: existing.id, action: "updated" });
    }

    const id = randomUUID();
    await db.insert(incentivePayments).values({
        id,
        salesCode: body.salesCode,
        salesName: body.salesName,
        principle: body.principle,
        branch: body.branch,
        periodMonth: body.periodMonth,
        periodYear: body.periodYear,
        totalIncentive: body.totalIncentive,
        paymentStatus: body.paymentStatus ?? "belum",
        paymentProofUrl: body.paymentProofUrl ?? null,
        paymentDate: null,
        paidBy: null,
        paidByName: null,
        createdAt: now,
        updatedAt: now,
    });

    return NextResponse.json({ id, action: "created" }, { status: 201 });
}
