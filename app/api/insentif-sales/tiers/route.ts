/*
 * Tujuan: CRUD strata insentif (tier ranges per KPI type).
 * Caller: Admin panel GET /api/insentif-sales/tiers (list), POST (upsert).
 * Dependensi: db/schema (incentiveTiers), lib/insentif-sales (requireSalesSession).
 * Main Functions: GET semua tiers; POST upsert tier ranges.
 * Side Effects: DB read + write.
 */

import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { incentiveTiers } from "@/db/schema";
import { requirePermission } from "@/lib/rbac/resolve";

export async function GET(req: NextRequest) {
    const gate = await requirePermission(req, "insentif_sales.view");
    if (gate.response) return gate.response;

    const { searchParams } = req.nextUrl;
    const principle = searchParams.get("principle") ?? undefined;
    const kpiType = searchParams.get("kpiType") ?? undefined;

    let query = db.select().from(incentiveTiers).$dynamic();
    const conditions = [];
    if (principle) conditions.push(eq(incentiveTiers.principle, principle));
    if (kpiType) conditions.push(eq(incentiveTiers.kpiType, kpiType));
    if (conditions.length) query = query.where(and(...conditions));

    const rows = await query;
    return NextResponse.json({ rows });
}

interface TierInput {
    id?: string;
    principle?: string;
    branch?: string;
    kpiType: string;
    minPercentage: number;
    maxPercentage: number;
    incentiveAmount: number;
}

export async function POST(req: NextRequest) {
    const gate = await requirePermission(req, "insentif_sales.manage");
    if (gate.response) return gate.response;

    let body: TierInput[];
    try {
        const raw = await req.json();
        body = Array.isArray(raw) ? raw : [raw];
    } catch {
        return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const now = new Date();
    let upserted = 0;

    for (const t of body) {
        if (!t.kpiType) continue;

        const principle = t.principle ?? "ALL";
        const branch = t.branch ?? "ALL";

        if (t.id) {
            await db
                .update(incentiveTiers)
                .set({
                    principle,
                    branch,
                    kpiType: t.kpiType,
                    minPercentage: t.minPercentage,
                    maxPercentage: t.maxPercentage,
                    incentiveAmount: t.incentiveAmount,
                    updatedAt: now,
                })
                .where(eq(incentiveTiers.id, t.id));
        } else {
            await db.insert(incentiveTiers).values({
                id: randomUUID(),
                principle,
                branch,
                kpiType: t.kpiType,
                minPercentage: t.minPercentage,
                maxPercentage: t.maxPercentage,
                incentiveAmount: t.incentiveAmount,
                createdAt: now,
                updatedAt: now,
            });
        }
        upserted++;
    }

    return NextResponse.json({ upserted });
}
