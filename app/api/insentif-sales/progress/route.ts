/*
 * Tujuan: GET MTD aggregated progress + POST bulk daily progress records.
 * Caller: app/(dashboard)/insentif-sales/page.tsx dan admin upload form.
 * Dependensi: lib/insentif-sales, db/schema (salesDailyProgress).
 * Main Functions: GET aggregate MTD; POST insert daily progress rows.
 * Side Effects: DB read + write.
 */

import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { salesDailyProgress } from "@/db/schema";
import { requireSalesSession, computeMtdProgress } from "@/lib/insentif-sales";

export async function GET(req: NextRequest) {
    const actor = await requireSalesSession();
    if (!actor) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { searchParams } = req.nextUrl;
    const now = new Date();
    const month = parseInt(searchParams.get("month") ?? String(now.getMonth() + 1), 10);
    const year = parseInt(searchParams.get("year") ?? String(now.getFullYear()), 10);
    const principle = searchParams.get("principle") ?? undefined;
    const branch = searchParams.get("branch") ?? undefined;

    const rows = await computeMtdProgress(month, year, principle, branch);
    return NextResponse.json({ month, year, rows });
}

interface ProgressInput {
    salesCode: string;
    principle: string;
    branch: string;
    date: string; // YYYY-MM-DD
    periodMonth: number;
    periodYear: number;
    invoiceNumber?: string;
    achievedValueDpp: number;
    achievedEc: number;
    achievedAo: number;
    achievedIa: number;
}

export async function POST(req: NextRequest) {
    const actor = await requireSalesSession();
    if (!actor) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (!["admin", "super_admin", "manager", "spv"].includes(actor.role)) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    let body: ProgressInput[];
    try {
        const raw = await req.json();
        body = Array.isArray(raw) ? raw : [raw];
    } catch {
        return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const now = new Date();
    let inserted = 0;

    for (const p of body) {
        if (!p.salesCode || !p.date || !p.periodMonth || !p.periodYear) continue;

        // Deduplicate by invoiceNumber per salesman per period
        if (p.invoiceNumber) {
            const [dup] = await db
                .select({ id: salesDailyProgress.id })
                .from(salesDailyProgress)
                .where(
                    and(
                        eq(salesDailyProgress.salesCode, p.salesCode),
                        eq(salesDailyProgress.invoiceNumber, p.invoiceNumber),
                        eq(salesDailyProgress.periodMonth, p.periodMonth),
                        eq(salesDailyProgress.periodYear, p.periodYear),
                    ),
                )
                .limit(1);
            if (dup) continue;
        }

        await db.insert(salesDailyProgress).values({
            id: randomUUID(),
            salesCode: p.salesCode,
            principle: p.principle,
            branch: p.branch,
            date: p.date,
            periodMonth: p.periodMonth,
            periodYear: p.periodYear,
            invoiceNumber: p.invoiceNumber ?? null,
            achievedValueDpp: p.achievedValueDpp,
            achievedEc: p.achievedEc,
            achievedAo: p.achievedAo,
            achievedIa: p.achievedIa,
            uploadedBy: actor.id,
            createdAt: now,
        });
        inserted++;
    }

    return NextResponse.json({ inserted });
}
