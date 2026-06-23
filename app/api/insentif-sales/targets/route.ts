/*
 * Tujuan: CRUD targets bulanan Insentif Sales.
 * Caller: app/(dashboard)/insentif-sales/page.tsx admin panel.
 * Dependensi: lib/insentif-sales, db/schema (salesTargets).
 * Main Functions: GET list targets per periode; POST upsert batch targets.
 * Side Effects: DB read + write (upsert by salesCode+periodMonth+periodYear).
 */

import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { salesTargets } from "@/db/schema";
import { getTargetsForPeriod } from "@/lib/insentif-sales";
import { requirePermission } from "@/lib/rbac/resolve";
import { normalizeStatus, normalizeTipe } from "@/lib/insentif-sales-calc";

export async function GET(req: NextRequest) {
    const gate = await requirePermission(req, "insentif_sales.view");
    if (gate.response) return gate.response;

    const { searchParams } = req.nextUrl;
    const now = new Date();
    const month = parseInt(searchParams.get("month") ?? String(now.getMonth() + 1), 10);
    const year = parseInt(searchParams.get("year") ?? String(now.getFullYear()), 10);
    const principle = searchParams.get("principle") ?? undefined;
    const branch = searchParams.get("branch") ?? undefined;

    const rows = await getTargetsForPeriod(month, year, principle, branch);
    return NextResponse.json({ month, year, rows });
}

interface TargetInput {
    salesCode: string;
    salesName: string;
    principle: string;
    branch: string;
    channel?: string;
    spvName?: string;
    smName?: string;
    periodMonth: number;
    periodYear: number;
    targetValue: number;
    targetEc: number;
    targetAo: number;
    targetIa: number;
    splmValue?: number;
    tipeSales?: string;
    statusInsentif?: string;
}

export async function POST(req: NextRequest) {
    const gate = await requirePermission(req, "insentif_sales.upload_target");
    if (gate.response) return gate.response;

    let body: TargetInput[];
    try {
        const raw = await req.json();
        body = Array.isArray(raw) ? raw : [raw];
    } catch {
        return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const now = new Date();
    let upserted = 0;

    for (const t of body) {
        if (!t.salesCode || !t.periodMonth || !t.periodYear) continue;

        // Validasi nilai kolom Excel (trust boundary). Nilai aneh → 400.
        let tipeSales: string, statusInsentif: string;
        try {
            tipeSales = normalizeTipe(t.tipeSales ?? "exclusive");
            statusInsentif = normalizeStatus(t.statusInsentif ?? "distributor_principle");
        } catch (e) {
            const msg = e instanceof Error ? e.message : "Nilai tidak valid";
            return NextResponse.json({ error: `Baris ${t.salesCode}/${t.principle}: ${msg}` }, { status: 400 });
        }

        // Kunci unik = salesCode + principle + periode (mix → 1 baris per principle).
        const [existing] = await db
            .select({ id: salesTargets.id })
            .from(salesTargets)
            .where(
                and(
                    eq(salesTargets.salesCode, t.salesCode),
                    eq(salesTargets.principle, t.principle),
                    eq(salesTargets.periodMonth, t.periodMonth),
                    eq(salesTargets.periodYear, t.periodYear),
                ),
            )
            .limit(1);

        if (existing) {
            await db
                .update(salesTargets)
                .set({
                    salesName: t.salesName,
                    branch: t.branch,
                    channel: t.channel ?? "TT",
                    spvName: t.spvName ?? null,
                    smName: t.smName ?? null,
                    targetValue: t.targetValue,
                    targetEc: t.targetEc,
                    targetAo: t.targetAo,
                    targetIa: t.targetIa,
                    splmValue: t.splmValue ?? 0,
                    tipeSales,
                    statusInsentif,
                    updatedAt: now,
                })
                .where(eq(salesTargets.id, existing.id));
        } else {
            await db.insert(salesTargets).values({
                id: randomUUID(),
                salesCode: t.salesCode,
                salesName: t.salesName,
                principle: t.principle,
                branch: t.branch,
                channel: t.channel ?? "TT",
                spvName: t.spvName ?? null,
                smName: t.smName ?? null,
                periodMonth: t.periodMonth,
                periodYear: t.periodYear,
                targetValue: t.targetValue,
                targetEc: t.targetEc,
                targetAo: t.targetAo,
                targetIa: t.targetIa,
                splmValue: t.splmValue ?? 0,
                tipeSales,
                statusInsentif,
                createdAt: now,
                updatedAt: now,
            });
        }
        upserted++;
    }

    return NextResponse.json({ upserted });
}
