/*
 * Tujuan: CRUD support principle per salesman (insentif GT). Diisi Finance saat payout.
 * Caller: app/(dashboard)/insentif-sales/page.tsx Finance panel.
 * Dependensi: lib/insentif-sales (session), db/schema (incentiveSupport).
 * Main Functions: GET list support per periode; POST upsert batch (key: salesCode+principle+period).
 * Side Effects: DB read + write.
 */

import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { incentiveSupport } from "@/db/schema";
import { requireSalesSession } from "@/lib/insentif-sales";

export async function GET(req: NextRequest) {
    const actor = await requireSalesSession();
    if (!actor) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { searchParams } = req.nextUrl;
    const now = new Date();
    const month = parseInt(searchParams.get("month") ?? String(now.getMonth() + 1), 10);
    const year = parseInt(searchParams.get("year") ?? String(now.getFullYear()), 10);

    const rows = await db
        .select()
        .from(incentiveSupport)
        .where(and(eq(incentiveSupport.periodMonth, month), eq(incentiveSupport.periodYear, year)));
    return NextResponse.json({ month, year, rows });
}

interface SupportInput {
    salesCode: string;
    principle: string;
    periodMonth: number;
    periodYear: number;
    supportAmount: number;
}

export async function POST(req: NextRequest) {
    const actor = await requireSalesSession();
    if (!actor) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (!["admin", "super_admin", "finance"].includes(actor.role)) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    let body: SupportInput[];
    try {
        const raw = await req.json();
        body = Array.isArray(raw) ? raw : [raw];
    } catch {
        return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const now = new Date();
    let upserted = 0;

    for (const s of body) {
        if (!s.salesCode || !s.principle || !s.periodMonth || !s.periodYear) continue;
        const amount = Number(s.supportAmount) || 0;
        if (amount < 0) return NextResponse.json({ error: `Support negatif: ${s.salesCode}/${s.principle}` }, { status: 400 });

        const [existing] = await db
            .select({ id: incentiveSupport.id })
            .from(incentiveSupport)
            .where(
                and(
                    eq(incentiveSupport.salesCode, s.salesCode),
                    eq(incentiveSupport.principle, s.principle),
                    eq(incentiveSupport.periodMonth, s.periodMonth),
                    eq(incentiveSupport.periodYear, s.periodYear),
                ),
            )
            .limit(1);

        if (existing) {
            await db
                .update(incentiveSupport)
                .set({ supportAmount: amount, inputBy: actor.name, updatedAt: now })
                .where(eq(incentiveSupport.id, existing.id));
        } else {
            await db.insert(incentiveSupport).values({
                id: randomUUID(),
                salesCode: s.salesCode,
                principle: s.principle,
                periodMonth: s.periodMonth,
                periodYear: s.periodYear,
                supportAmount: amount,
                inputBy: actor.name,
                createdAt: now,
                updatedAt: now,
            });
        }
        upserted++;
    }

    return NextResponse.json({ upserted });
}
