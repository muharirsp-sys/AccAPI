/*
 * Tujuan: GET aggregated dashboard data Insentif Sales per periode.
 * Caller: app/(dashboard)/insentif-sales/page.tsx via fetch("/api/insentif-sales/dashboard").
 * Dependensi: lib/insentif-sales, lib/insentif-sales-calc, db/schema (incentivePayments, incentiveSupport).
 * Main Functions: GET — join targets (per principle) + MTD per principle + insentif.
 *   - channel GT: model konstanta-bobot (lib/insentif-sales-calc); mix dihitung per salesman, value dialokasikan proporsional.
 *   - channel non-GT: tetap strata-DB (lookupTierFromDb), 4 KPI.
 *   Pencapaian/achievement 4-KPI ditampilkan untuk semua channel.
 * Side Effects: DB read only.
 */

import { NextRequest, NextResponse } from "next/server";
import { eq, and } from "drizzle-orm";
import { db } from "@/lib/db";
import { incentivePayments, incentiveSupport } from "@/db/schema";
import {
    requireSalesSession,
    getWorkdayProgress,
    pct,
    itemSuper,
    computeMtdByPrinciple,
    getTargetsForPeriod,
} from "@/lib/insentif-sales";
import {
    computeExclusive,
    computeMix,
    type StatusInsentif,
    type MixPrincipalInput,
    type MixLineDetail,
} from "@/lib/insentif-sales-calc";

export async function GET(req: NextRequest) {
    const actor = await requireSalesSession();
    if (!actor) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { searchParams } = req.nextUrl;
    const now = new Date();
    const month = parseInt(searchParams.get("month") ?? String(now.getMonth() + 1), 10);
    const year = parseInt(searchParams.get("year") ?? String(now.getFullYear()), 10);
    const principle = searchParams.get("principle") ?? undefined;
    const branch = searchParams.get("branch") ?? undefined;

    const [targets, realByPrinciple, supportRows] = await Promise.all([
        getTargetsForPeriod(month, year, principle, branch),
        computeMtdByPrinciple(month, year),
        db
            .select()
            .from(incentiveSupport)
            .where(and(eq(incentiveSupport.periodMonth, month), eq(incentiveSupport.periodYear, year))),
    ]);

    // Skema insentif konstanta-bobot berlaku untuk GT/TT (sinonim). MT: belum ada aturan → 0.
    const isSchemeChannel = (ch: string) => ch === "GT" || ch === "TT";
    const key = (salesCode: string, prin: string) => `${salesCode}|${prin}`;
    const supportMap = new Map(supportRows.map((s) => [key(s.salesCode, s.principle), s.supportAmount]));
    const realOf = (salesCode: string, prin: string) =>
        realByPrinciple.get(key(salesCode, prin)) ?? { realValue: 0, realEc: 0, realAo: 0, realIa: 0 };

    // Pra-hitung insentif GT-mix per salesman (value global → alokasi per principle).
    const mixLineMap = new Map<string, MixLineDetail>();
    const mixGroups = new Map<string, MixPrincipalInput[]>();
    for (const t of targets) {
        if (!isSchemeChannel(t.channel) || t.tipeSales !== "mix") continue;
        const r = realOf(t.salesCode, t.principle);
        const arr = mixGroups.get(t.salesCode) ?? [];
        arr.push({
            nama: t.principle,
            status: t.statusInsentif as StatusInsentif,
            target_value: t.targetValue,
            realisasi_value: r.realValue,
            realisasi_ao: r.realAo,
            nilai_support_principal: supportMap.get(key(t.salesCode, t.principle)) ?? 0,
        });
        mixGroups.set(t.salesCode, arr);
    }
    for (const [salesCode, arr] of mixGroups) {
        for (const line of computeMix(arr).rincian) mixLineMap.set(key(salesCode, line.nama), line);
    }

    const timeGone = getWorkdayProgress(new Date());

    const rows = await Promise.all(
        targets.map(async (t) => {
            const real = realOf(t.salesCode, t.principle);

            const pVal = pct(real.realValue, t.targetValue);
            const pEc = pct(real.realEc, t.targetEc);
            const pAo = pct(real.realAo, t.targetAo);
            const isqReal = itemSuper(real.realIa, real.realAo);
            const isqTgt = itemSuper(t.targetIa, t.targetAo);
            const pIsq = pct(isqReal, isqTgt);
            const totalAchieve = Math.round(((pVal + pEc + pAo + pIsq) / 4) * 10) / 10;

            let incentive: { value: number; ec: number; ao: number; isq: number; total: number };

            if (isSchemeChannel(t.channel)) {
                if (t.tipeSales === "mix") {
                    const line = mixLineMap.get(key(t.salesCode, t.principle));
                    incentive = { value: line?.insentif_value ?? 0, ec: 0, ao: line?.insentif_ao ?? 0, isq: 0, total: line?.total ?? 0 };
                } else {
                    const ex = computeExclusive({
                        status: t.statusInsentif as StatusInsentif,
                        target_value: t.targetValue,
                        realisasi_value: real.realValue,
                        realisasi_ao: real.realAo,
                        nilai_support_principal: supportMap.get(key(t.salesCode, t.principle)) ?? 0,
                    });
                    incentive = { value: ex.insentif_value, ec: 0, ao: ex.insentif_ao, isq: 0, total: ex.total };
                }
            } else {
                // MT (dan channel lain): belum ada aturan insentif → 0.
                incentive = { value: 0, ec: 0, ao: 0, isq: 0, total: 0 };
            }

            const [payment] = await db
                .select({ status: incentivePayments.paymentStatus })
                .from(incentivePayments)
                .where(
                    and(
                        eq(incentivePayments.salesCode, t.salesCode),
                        eq(incentivePayments.principle, t.principle),
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
                tipeSales: t.tipeSales,
                statusInsentif: t.statusInsentif,
                spvName: t.spvName,
                smName: t.smName,
                support: supportMap.get(key(t.salesCode, t.principle)) ?? 0,
                target: { value: t.targetValue, ec: t.targetEc, ao: t.targetAo, ia: t.targetIa, isq: isqTgt, splm: t.splmValue },
                real: { value: real.realValue, ec: real.realEc, ao: real.realAo, ia: real.realIa, isq: isqReal },
                pct: { value: pVal, ec: pEc, ao: pAo, isq: pIsq, total: totalAchieve },
                incentive,
                paymentStatus: payment?.status ?? "belum",
            };
        }),
    );

    return NextResponse.json({ month, year, timeGone, rows });
}
