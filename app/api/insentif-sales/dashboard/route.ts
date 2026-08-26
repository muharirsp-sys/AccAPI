/*
 * Tujuan: GET aggregated dashboard data Insentif Sales per periode.
 * Caller: app/(dashboard)/insentif-sales/page.tsx via fetch("/api/insentif-sales/dashboard").
 * Dependensi: lib/insentif-sales, lib/insentif-sales-calc, db/schema (incentivePayments, incentiveSupport).
 * Main Functions: GET — join targets (per principle) + MTD per principle + insentif,
 *   serta status feed progress yang belum/cocok dengan target.
 *   - channel GT: model konstanta-bobot (lib/insentif-sales-calc); mix dihitung per salesman, value dialokasikan proporsional.
 *   - channel MT: model 4 KPI bobot nominal (lib/insentif-mt-calc), penyebut = target baris.
 *   Pencapaian/achievement 4-KPI ditampilkan untuk semua channel.
 * Side Effects: DB read only.
 * Catatan perf: status pembayaran di-load 1 query grouped per periode (paymentMap),
 *   bukan 1 query per baris target (hindari N+1) — ikut pola supportMap.
 */

import { NextRequest, NextResponse } from "next/server";
import { eq, and } from "drizzle-orm";
import { db } from "@/lib/db";
import { incentivePayments, incentiveSupport } from "@/db/schema";
import {
    getWorkdayProgress,
    pct,
    itemSuper,
    computeMtdByPrinciple,
    getTargetsForPeriod,
} from "@/lib/insentif-sales";
import { requirePermission } from "@/lib/rbac/resolve";
import { getScopeForUser } from "@/lib/insentif-hierarchy-scope";
import { isOfficeRow } from "@/lib/insentif-sm-calc";
import {
    computeExclusive,
    computeMix,
    type StatusInsentif,
    type MixPrincipalInput,
    type MixLineDetail,
} from "@/lib/insentif-sales-calc";
import { computeMt, computeMtMix, type MtMixLineDetail, type MtMixPrincipalInput } from "@/lib/insentif-mt-calc";

export async function GET(req: NextRequest) {
    const gate = await requirePermission(req, "insentif_sales.view");
    if (gate.response) return gate.response;

    const { searchParams } = req.nextUrl;
    const now = new Date();
    const month = parseInt(searchParams.get("month") ?? String(now.getMonth() + 1), 10);
    const year = parseInt(searchParams.get("year") ?? String(now.getFullYear()), 10);
    const principle = searchParams.get("principle") ?? undefined;
    const branch = searchParams.get("branch") ?? undefined;

    const [rawTargets, realByPrinciple, supportRows, paymentRows, scope] = await Promise.all([
        getTargetsForPeriod(month, year),
        computeMtdByPrinciple(month, year),
        db
            .select()
            .from(incentiveSupport)
            .where(and(eq(incentiveSupport.periodMonth, month), eq(incentiveSupport.periodYear, year))),
        db
            .select({
                salesCode: incentivePayments.salesCode,
                principle: incentivePayments.principle,
                status: incentivePayments.paymentStatus,
            })
            .from(incentivePayments)
            .where(and(eq(incentivePayments.periodMonth, month), eq(incentivePayments.periodYear, year))),
        getScopeForUser(gate.session.user.id, { month, year }),
    ]);
    // scope null = tidak ada scoping (perilaku existing/default). Non-null = user SPV/SM
    // opt-in (lib/insentif-hierarchy-scope) — cuma lihat salesCode bawahannya sendiri.
    const scopedTargets = scope === null ? rawTargets : rawTargets.filter((t) => scope.has(t.salesCode));
    const targets = scopedTargets.filter((target) =>
        // Baris _OFFICE bukan salesman — pos target kantor, bukan orang. Tanpa filter ini,
        // baris itu ikut dihitung insentif dan bisa ditandai Lunas di tab Finance
        // (audit 2026-08-24, docs/handover/AUDIT_INSENTIF_SALES_2026-08-24.md, temuan C3).
        !isOfficeRow(target.salesCode, target.salesName)
        && (!principle || principle === "ALL" || target.principle === principle)
        && (!branch || branch === "ALL" || target.branch === branch),
    );
    const visibleProgress = [...realByPrinciple.values()].filter((row) => scope === null || scope.has(row.salesCode));
    const targetKeys = new Set(scopedTargets.map((row) => `${row.salesCode}|${row.principle}`));
    const matchedProgressKeys = visibleProgress.reduce(
        (count, row) => count + (targetKeys.has(`${row.salesCode}|${row.principle}`) ? 1 : 0),
        0,
    );
    const progressFeed = {
        progressKeys: visibleProgress.length,
        targetKeys: targetKeys.size,
        matchedKeys: matchedProgressKeys,
        unmatchedKeys: visibleProgress.length - matchedProgressKeys,
        ready: targetKeys.size > 0 && matchedProgressKeys > 0,
    };

    // Skema konstanta-bobot 2-KPI berlaku untuk GT/TT (sinonim); MT punya skema 4-KPI sendiri.
    const isSchemeChannel = (ch: string) => ch === "GT" || ch === "TT";
    const isMtChannel = (ch: string) => ch === "MT";
    const key = (salesCode: string, prin: string) => `${salesCode}|${prin}`;
    const supportMap = new Map(supportRows.map((s) => [key(s.salesCode, s.principle), s.supportAmount]));
    const paymentMap = new Map(paymentRows.map((p) => [key(p.salesCode, p.principle), p.status]));
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

    // Pra-hitung insentif MT-mix per salesman (pool dibagi rata per principle valid).
    const mtMixLineMap = new Map<string, MtMixLineDetail>();
    const mtMixGroups = new Map<string, MtMixPrincipalInput[]>();
    for (const t of targets) {
        if (!isMtChannel(t.channel) || t.tipeSales !== "mix") continue;
        const r = realOf(t.salesCode, t.principle);
        const arr = mtMixGroups.get(t.salesCode) ?? [];
        arr.push({
            nama: t.principle,
            status: t.statusInsentif as StatusInsentif,
            target_value: t.targetValue,
            target_ec: t.targetEc,
            target_ao: t.targetAo,
            target_ia: t.targetIa,
            realisasi_value: r.realValue,
            realisasi_ec: r.realEc,
            realisasi_ao: r.realAo,
            realisasi_ia: r.realIa,
            nilai_support_principal: supportMap.get(key(t.salesCode, t.principle)) ?? 0,
        });
        mtMixGroups.set(t.salesCode, arr);
    }
    for (const [salesCode, arr] of mtMixGroups) {
        for (const line of computeMtMix(arr).rincian) mtMixLineMap.set(key(salesCode, line.nama), line);
    }

    const timeGone = getWorkdayProgress(new Date());

    const rows = targets.map((t) => {
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
            } else if (isMtChannel(t.channel)) {
                // MT: 4 KPI bobot nominal (Value 350rb, EC 150rb, OA 150rb, IA 350rb).
                const mt = t.tipeSales === "mix"
                    ? mtMixLineMap.get(key(t.salesCode, t.principle))
                    : computeMt({
                        status: t.statusInsentif as StatusInsentif,
                        target_value: t.targetValue,
                        target_ec: t.targetEc,
                        target_ao: t.targetAo,
                        target_ia: t.targetIa,
                        realisasi_value: real.realValue,
                        realisasi_ec: real.realEc,
                        realisasi_ao: real.realAo,
                        realisasi_ia: real.realIa,
                        nilai_support_principal: supportMap.get(key(t.salesCode, t.principle)) ?? 0,
                    });
                incentive = {
                    value: mt?.insentif_value ?? 0,
                    ec: mt?.insentif_ec ?? 0,
                    ao: mt?.insentif_ao ?? 0,
                    isq: mt?.insentif_ia ?? 0,
                    total: mt?.total ?? 0,
                };
            } else {
                // Channel lain (belum didefinisikan) → 0.
                incentive = { value: 0, ec: 0, ao: 0, isq: 0, total: 0 };
            }

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
                paymentStatus: paymentMap.get(key(t.salesCode, t.principle)) ?? "belum",
            };
    });

    return NextResponse.json({ month, year, timeGone, rows, progressFeed });
}
