/*
 * Tujuan: Helper kalkulasi & akses data untuk modul Insentif Sales.
 * Caller: API routes app/api/insentif-sales/**.
 * Dependensi: Better Auth, Drizzle SQLite, db/schema.
 * Main Functions: requireSalesSession, getWorkdayProgress, lookupTierFromDb, computeMtdProgress,
 *   getTargetsForPeriod, getMergeMap.
 * Side Effects: DB read only dari helper; write dilakukan di route handler.
 */

import { headers } from "next/headers";
import { and, eq, sql } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { incentiveTiers, salesCodeMerge, salesDailyProgress, salesTargets } from "@/db/schema";
import { applyMergeMap } from "./sales-code-merge";

export type KpiType = "value" | "ec" | "ao" | "ia";

export async function requireSalesSession() {
    const session = await auth.api.getSession({ headers: await headers() });
    if (!session) return null;
    return {
        id: session.user.id,
        name: session.user.name || session.user.email || "Unknown",
        role: (session.user as { role?: string }).role ?? "viewer",
    };
}

export function getWorkdayProgress(ref: Date) {
    const year = ref.getFullYear();
    const month = ref.getMonth();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    let total = 0, passed = 0;
    for (let d = 1; d <= daysInMonth; d++) {
        const day = new Date(year, month, d).getDay();
        if (day === 0 || day === 6) continue;
        total++;
        if (d <= ref.getDate()) passed++;
    }
    return { passed, total, pct: total > 0 ? Math.round((passed / total) * 100) : 0 };
}

export function pct(real: number, target: number): number {
    if (!target) return 0;
    return Math.round((real / target) * 1000) / 10;
}

export function itemSuper(ia: number, ao: number): number {
    if (!ao) return 0;
    return Math.round((ia / ao) * 100) / 100;
}

/** Lookup nominal insentif dari DB tiers. Priority: exact match > principle match > ALL. */
export async function lookupTierFromDb(
    kpiType: KpiType,
    achievementPct: number,
    principle = "ALL",
    branch = "ALL",
): Promise<number> {
    const rows = await db
        .select()
        .from(incentiveTiers)
        .where(
            and(
                eq(incentiveTiers.kpiType, kpiType),
                sql`${incentiveTiers.minPercentage} <= ${achievementPct}`,
                sql`${incentiveTiers.maxPercentage} > ${achievementPct}`,
            ),
        );

    const exact = rows.find((r) => r.principle === principle && r.branch === branch);
    if (exact) return exact.incentiveAmount;
    const byPrinciple = rows.find((r) => r.principle === principle && r.branch === "ALL");
    if (byPrinciple) return byPrinciple.incentiveAmount;
    const fallback = rows.find((r) => r.principle === "ALL" && r.branch === "ALL");
    return fallback?.incentiveAmount ?? 0;
}

/**
 * Peta penggabungan kode sales yang sudah dikonfirmasi user utk satu periode (from → to).
 * Dipakai agar pencapaian orang yang digantikan di tengah bulan terhitung pada kode penggantinya.
 */
export async function getMergeMap(month: number, year: number): Promise<Map<string, string>> {
    const rows = await db
        .select({ from: salesCodeMerge.fromSalesCode, to: salesCodeMerge.toSalesCode })
        .from(salesCodeMerge)
        .where(
            and(
                eq(salesCodeMerge.periodMonth, month),
                eq(salesCodeMerge.periodYear, year),
                eq(salesCodeMerge.decision, "merge"),
            ),
        );
    return new Map(rows.filter((r) => r.to).map((r) => [r.from, r.to as string]));
}

/** Gabungkan baris hasil agregasi yang kode-nya dilipat oleh mergeMap. */
function foldMerged<T extends { salesCode: string }>(
    rows: T[],
    mergeMap: Map<string, string>,
    keyOf: (r: T) => string,
    add: (into: T, from: T) => void,
): T[] {
    if (mergeMap.size === 0) return rows;
    const out = new Map<string, T>();
    for (const r of rows) {
        const merged = { ...r, salesCode: applyMergeMap(r.salesCode, mergeMap) };
        const k = keyOf(merged);
        const existing = out.get(k);
        if (existing) add(existing, merged);
        else out.set(k, merged);
    }
    return [...out.values()];
}

export interface MtdProgress {
    salesCode: string;
    realValue: number;
    realEc: number;
    realAo: number;
    realIa: number;
}

/** Aggregate daily_progress MTD untuk satu periode. AO/IA diambil MAX (snapshot harian, bukan kumulatif). */
export async function computeMtdProgress(
    month: number,
    year: number,
    filterPrinciple?: string,
    filterBranch?: string,
): Promise<MtdProgress[]> {
    const conditions = [
        eq(salesDailyProgress.periodMonth, month),
        eq(salesDailyProgress.periodYear, year),
    ];
    if (filterPrinciple && filterPrinciple !== "ALL") {
        conditions.push(eq(salesDailyProgress.principle, filterPrinciple));
    }
    if (filterBranch && filterBranch !== "ALL") {
        conditions.push(eq(salesDailyProgress.branch, filterBranch));
    }

    const rows = await db
        .select({
            salesCode: salesDailyProgress.salesCode,
            realValue: sql<number>`SUM(${salesDailyProgress.achievedValueDpp})`,
            realEc: sql<number>`SUM(${salesDailyProgress.achievedEc})`,
            realAo: sql<number>`MAX(${salesDailyProgress.achievedAo})`,
            realIa: sql<number>`MAX(${salesDailyProgress.achievedIa})`,
        })
        .from(salesDailyProgress)
        .where(and(...conditions))
        .groupBy(salesDailyProgress.salesCode);

    const mapped = rows.map((r) => ({
        salesCode: r.salesCode,
        realValue: r.realValue ?? 0,
        realEc: r.realEc ?? 0,
        realAo: r.realAo ?? 0,
        realIa: r.realIa ?? 0,
    }));

    // Lipat kode sales yang sudah dikonfirmasi user sebagai pergantian orang.
    return foldMerged(
        mapped,
        await getMergeMap(month, year),
        (r) => r.salesCode,
        (into, from) => {
            into.realValue += from.realValue;
            into.realEc += from.realEc;
            into.realAo += from.realAo;
            into.realIa += from.realIa;
        },
    );
}

/** Aggregate MTD per salesCode+principle. Untuk insentif GT (AO per principle). Key: `${salesCode}|${principle}`. */
export async function computeMtdByPrinciple(
    month: number,
    year: number,
): Promise<Map<string, MtdProgress & { principle: string }>> {
    const rows = await db
        .select({
            salesCode: salesDailyProgress.salesCode,
            principle: salesDailyProgress.principle,
            realValue: sql<number>`SUM(${salesDailyProgress.achievedValueDpp})`,
            realEc: sql<number>`SUM(${salesDailyProgress.achievedEc})`,
            realAo: sql<number>`MAX(${salesDailyProgress.achievedAo})`,
            realIa: sql<number>`MAX(${salesDailyProgress.achievedIa})`,
        })
        .from(salesDailyProgress)
        .where(and(eq(salesDailyProgress.periodMonth, month), eq(salesDailyProgress.periodYear, year)))
        .groupBy(salesDailyProgress.salesCode, salesDailyProgress.principle);

    const mapped = rows.map((r) => ({
        salesCode: r.salesCode, principle: r.principle,
        realValue: r.realValue ?? 0, realEc: r.realEc ?? 0, realAo: r.realAo ?? 0, realIa: r.realIa ?? 0,
    }));

    // Lipat per (kode-setelah-merge, principle) — penggabungan tidak melintasi principal.
    const folded = foldMerged(
        mapped,
        await getMergeMap(month, year),
        (r) => `${r.salesCode}|${r.principle}`,
        (into, from) => {
            into.realValue += from.realValue;
            into.realEc += from.realEc;
            into.realAo += from.realAo;
            into.realIa += from.realIa;
        },
    );

    return new Map(folded.map((r) => [`${r.salesCode}|${r.principle}`, r]));
}

/** Ambil targets untuk satu periode + filter opsional. */
export async function getTargetsForPeriod(
    month: number,
    year: number,
    filterPrinciple?: string,
    filterBranch?: string,
) {
    const conditions = [
        eq(salesTargets.periodMonth, month),
        eq(salesTargets.periodYear, year),
    ];
    if (filterPrinciple && filterPrinciple !== "ALL") {
        conditions.push(eq(salesTargets.principle, filterPrinciple));
    }
    if (filterBranch && filterBranch !== "ALL") {
        conditions.push(eq(salesTargets.branch, filterBranch));
    }
    return db.select().from(salesTargets).where(and(...conditions));
}
