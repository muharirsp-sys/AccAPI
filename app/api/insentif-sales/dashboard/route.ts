/*
 * Tujuan: GET aggregated dashboard data Insentif Sales per periode.
 * Caller: app/(dashboard)/insentif-sales/page.tsx via fetch("/api/insentif-sales/dashboard").
 * Dependensi: lib/insentif-sales, db/schema (incentivePayments).
 * Main Functions: GET handler — join targets + MTD progress + tier lookup + payment status.
 * Side Effects: DB read only.
 */

import { NextRequest, NextResponse } from "next/server";
import { eq, and } from "drizzle-orm";
import { db } from "@/lib/db";
import { incentivePayments } from "@/db/schema";
import {
    requireSalesSession,
    getWorkdayProgress,
    pct,
    itemSuper,
    lookupTierFromDb,
    computeMtdProgress,
    getTargetsForPeriod,
    type KpiType,
} from "@/lib/insentif-sales";

export async function GET(req: NextRequest) {
    const actor = await requireSalesSession();
    if (!actor) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { searchParams } = req.nextUrl;
    const now = new Date();
    const month = parseInt(searchParams.get("month") ?? String(now.getMonth() + 1), 10);
    const year = parseInt(searchParams.get("year") ?? String(now.getFullYear()), 10);
    const principle = searchParams.get("principle") ?? undefined;
    const branch = searchParams.get("branch") ?? undefined;

    const [targets, mtd] = await Promise.all([
        getTargetsForPeriod(month, year, principle, branch),
        computeMtdProgress(month, year, principle, branch),
    ]);

    const mtdMap = new Map(mtd.map((r) => [r.salesCode, r]));
    const timeGone = getWorkdayProgress(new Date());

    const rows = await Promise.all(
        targets.map(async (t) => {
            const real = mtdMap.get(t.salesCode) ?? { realValue: 0, realEc: 0, realAo: 0, realIa: 0 };

            const pVal = pct(real.realValue, t.targetValue);
            const pEc = pct(real.realEc, t.targetEc);
            const pAo = pct(real.realAo, t.targetAo);
            const isqReal = itemSuper(real.realIa, real.realAo);
            const isqTgt = itemSuper(t.targetIa, t.targetAo);
            const pIsq = pct(isqReal, isqTgt);
            const totalAchieve = Math.round(((pVal + pEc + pAo + pIsq) / 4) * 10) / 10;

            const [ivVal, ivEc, ivAo, ivIsq] = await Promise.all([
                lookupTierFromDb("value" as KpiType, pVal, t.principle, t.branch),
                lookupTierFromDb("ec" as KpiType, pEc, t.principle, t.branch),
                lookupTierFromDb("ao" as KpiType, pAo, t.principle, t.branch),
                lookupTierFromDb("ia" as KpiType, pIsq, t.principle, t.branch),
            ]);
            const totalIncentive = ivVal + ivEc + ivAo + ivIsq;

            const [payment] = await db
                .select({ status: incentivePayments.paymentStatus })
                .from(incentivePayments)
                .where(
                    and(
                        eq(incentivePayments.salesCode, t.salesCode),
                        eq(incentivePayments.periodMonth, month),
                        eq(incentivePayments.periodYear, year),
                    ),
                )
                .limit(1);

            return {
                salesCode: t.salesCode,
                salesName: t.salesName,
                principle: t.principle,
                branch: t.branch,
                channel: t.channel,
                spvName: t.spvName,
                smName: t.smName,
                target: {
                    value: t.targetValue,
                    ec: t.targetEc,
                    ao: t.targetAo,
                    ia: t.targetIa,
                    isq: isqTgt,
                    splm: t.splmValue,
                },
                real: {
                    value: real.realValue,
                    ec: real.realEc,
                    ao: real.realAo,
                    ia: real.realIa,
                    isq: isqReal,
                },
                pct: { value: pVal, ec: pEc, ao: pAo, isq: pIsq, total: totalAchieve },
                incentive: { value: ivVal, ec: ivEc, ao: ivAo, isq: ivIsq, total: totalIncentive },
                paymentStatus: payment?.status ?? "belum",
            };
        }),
    );

    return NextResponse.json({ month, year, timeGone, rows });
}
