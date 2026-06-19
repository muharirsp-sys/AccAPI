import { and, asc, eq, inArray, or, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import {
    jksMaster, aoControlDaily, noOrderReason,
    merchandisingCheck, salesmanDailyReport,
    spvBriefing, smControl, kontrolAuditLog, salesProfile,
} from "@/db/schema";
import { DAY_TO_HARI, NO_ORDER_REASONS } from "./constants";
import type { AoStatus, TodayRouteRow } from "./types";

// ── Week parity ──────────────────────────────────────────────────────────────
function getISOWeekNumber(date: Date): number {
    const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    return Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
}

function getWeekParity(date: Date): "ganjil" | "genap" {
    return getISOWeekNumber(date) % 2 === 1 ? "ganjil" : "genap";
}

export function parseDateString(dateStr: string): Date {
    const [y, m, d] = dateStr.split("-").map(Number);
    return new Date(y, m - 1, d);
}

// ── JKS ─────────────────────────────────────────────────────────────────────

export async function getJksList(filters: {
    salesCode?: string;
    principle?: string;
    hariKunjungan?: string;
    isActive?: boolean;
} = {}, limit = 100, offset = 0) {
    const conditions = [];
    if (filters.salesCode)     conditions.push(eq(jksMaster.salesCode, filters.salesCode));
    if (filters.principle)     conditions.push(eq(jksMaster.principle, filters.principle));
    if (filters.hariKunjungan) conditions.push(eq(jksMaster.hariKunjungan, filters.hariKunjungan));
    if (filters.isActive !== undefined) conditions.push(eq(jksMaster.isActive, filters.isActive));

    const [rows, countResult] = await Promise.all([
        db.select().from(jksMaster)
            .where(conditions.length ? and(...conditions) : undefined)
            .orderBy(asc(jksMaster.salesCode), asc(jksMaster.custCode))
            .limit(limit).offset(offset),
        db.select({ count: sql<number>`count(*)` }).from(jksMaster)
            .where(conditions.length ? and(...conditions) : undefined),
    ]);
    return { rows, total: countResult[0]?.count ?? 0 };
}

export async function upsertJksRows(rows: {
    salesCode: string; salesName: string; custCode: string; custName: string;
    market?: string; alamat?: string; kota?: string; hariKunjungan?: string;
    mingguPattern?: string; area?: string; rayon?: string; principle: string;
    channel?: string; visitFrequency?: number;
}[]) {
    const now = new Date();
    let imported = 0, skipped = 0;
    for (const r of rows) {
        if (!r.salesCode || !r.custCode || !r.principle) { skipped++; continue; }
        const pattern = (r.mingguPattern ?? "all") as "ganjil" | "genap" | "all";
        const freq = r.visitFrequency ?? (pattern === "all" ? 4 : 2);
        await db.insert(jksMaster).values({
            id: randomUUID(), salesCode: r.salesCode, salesName: r.salesName,
            custCode: r.custCode, custName: r.custName, market: r.market ?? null,
            alamat: r.alamat ?? null, kota: r.kota ?? null,
            hariKunjungan: r.hariKunjungan ?? null, mingguPattern: pattern,
            area: r.area ?? null, rayon: r.rayon ?? null, principle: r.principle,
            channel: r.channel ?? "TT", visitFrequency: freq,
            isActive: true, createdAt: now, updatedAt: now,
        }).onConflictDoUpdate({
            target: [jksMaster.salesCode, jksMaster.custCode, jksMaster.principle],
            set: {
                salesName: r.salesName, custName: r.custName, market: r.market ?? null,
                alamat: r.alamat ?? null, kota: r.kota ?? null,
                hariKunjungan: r.hariKunjungan ?? null, mingguPattern: pattern,
                area: r.area ?? null, rayon: r.rayon ?? null, channel: r.channel ?? "TT",
                visitFrequency: freq, isActive: true, updatedAt: now,
            },
        });
        imported++;
    }
    return { imported, skipped };
}

// ── Today's route with AO status ──────────────────────────────────────────

export async function getTodayRoute(salesCode: string, principle: string, dateStr: string): Promise<TodayRouteRow[]> {
    const date = parseDateString(dateStr);
    const dayName = DAY_TO_HARI[date.getDay()];
    if (!dayName) return [];

    const parity = getWeekParity(date);

    const jksRows = await db.select().from(jksMaster).where(
        and(
            eq(jksMaster.salesCode, salesCode),
            eq(jksMaster.principle, principle),
            eq(jksMaster.hariKunjungan, dayName),
            or(eq(jksMaster.mingguPattern, "all"), eq(jksMaster.mingguPattern, parity)),
            eq(jksMaster.isActive, true),
        )
    );

    if (jksRows.length === 0) return [];

    const custCodes = jksRows.map(r => r.custCode);
    const aoRows = await db.select().from(aoControlDaily).where(
        and(
            eq(aoControlDaily.salesCode, salesCode),
            eq(aoControlDaily.principle, principle),
            eq(aoControlDaily.date, dateStr),
            inArray(aoControlDaily.custCode, custCodes),
        )
    );

    const aoMap = new Map(aoRows.map(r => [r.custCode, r]));

    // Monthly order counts for each store
    const monthlyAo = await db.select({
        custCode: aoControlDaily.custCode,
        count: sql<number>`count(*)`,
    }).from(aoControlDaily).where(
        and(
            eq(aoControlDaily.salesCode, salesCode),
            eq(aoControlDaily.principle, principle),
            eq(aoControlDaily.periodMonth, date.getMonth() + 1),
            eq(aoControlDaily.periodYear, date.getFullYear()),
            inArray(aoControlDaily.status, ["ordered", "active"]),
            inArray(aoControlDaily.custCode, custCodes),
        )
    ).groupBy(aoControlDaily.custCode);
    const monthlyMap = new Map(monthlyAo.map(r => [r.custCode, r.count]));

    // Stores not_order >= 2 times this month need attention
    const notOrderCounts = await db.select({
        custCode: aoControlDaily.custCode,
        count: sql<number>`count(*)`,
    }).from(aoControlDaily).where(
        and(
            eq(aoControlDaily.salesCode, salesCode),
            eq(aoControlDaily.principle, principle),
            eq(aoControlDaily.periodMonth, date.getMonth() + 1),
            eq(aoControlDaily.periodYear, date.getFullYear()),
            eq(aoControlDaily.status, "not_order"),
            inArray(aoControlDaily.custCode, custCodes),
        )
    ).groupBy(aoControlDaily.custCode);
    const attentionSet = new Set(notOrderCounts.filter(r => r.count >= 2).map(r => r.custCode));

    return jksRows.map(j => {
        const ao = aoMap.get(j.custCode);
        return {
            ...j,
            mingguPattern: j.mingguPattern as "ganjil" | "genap" | "all",
            aoStatus: (ao?.status as AoStatus | undefined) ?? null,
            noOrderReasonCode: ao?.noOrderReasonCode ?? null,
            noOrderNote: ao?.noOrderNote ?? null,
            isVisited: ao?.isVisited ?? null,
            checkinAt: ao?.checkinAt ?? null,
            checkinPhotoUrl: ao?.checkinPhotoUrl ?? null,
            checkoutAt: ao?.checkoutAt ?? null,
            checkoutPhotoUrl: ao?.checkoutPhotoUrl ?? null,
            monthlyOrderCount: monthlyMap.get(j.custCode) ?? 0,
            needsAttention: attentionSet.has(j.custCode),
        };
    });
}

// ── AO Control ───────────────────────────────────────────────────────────────

export async function upsertAoControl(data: {
    salesCode: string; custCode: string; principle: string; date: string;
    status: AoStatus; isVisited?: boolean; noOrderReasonCode?: string | null;
    noOrderNote?: string | null; createdBy?: string;
}) {
    const now = new Date();
    const [, m, y] = data.date.split("-").map(Number);
    const [yearStr] = data.date.split("-");
    const periodYear = parseInt(yearStr, 10);
    const periodMonth = parseInt(data.date.split("-")[1], 10);

    const existing = await db.select({ id: aoControlDaily.id })
        .from(aoControlDaily)
        .where(and(
            eq(aoControlDaily.salesCode, data.salesCode),
            eq(aoControlDaily.custCode, data.custCode),
            eq(aoControlDaily.principle, data.principle),
            eq(aoControlDaily.date, data.date),
        )).limit(1);

    if (existing.length > 0) {
        await db.update(aoControlDaily).set({
            status: data.status,
            isVisited: data.isVisited ?? null,
            noOrderReasonCode: data.noOrderReasonCode ?? null,
            noOrderNote: data.noOrderNote ?? null,
            updatedAt: now,
        }).where(eq(aoControlDaily.id, existing[0].id));
        return existing[0].id;
    }

    const id = randomUUID();
    await db.insert(aoControlDaily).values({
        id, salesCode: data.salesCode, custCode: data.custCode,
        principle: data.principle, date: data.date,
        periodMonth, periodYear,
        status: data.status, isVisited: data.isVisited ?? null,
        noOrderReasonCode: data.noOrderReasonCode ?? null,
        noOrderNote: data.noOrderNote ?? null,
        autoMatched: false, source: "manual",
        createdBy: data.createdBy ?? null,
        createdAt: now, updatedAt: now,
    });
    return id;
    void m; void y;
}

export async function getAoForDate(salesCode: string, principle: string, dateStr: string) {
    return db.select().from(aoControlDaily).where(
        and(
            eq(aoControlDaily.salesCode, salesCode),
            eq(aoControlDaily.principle, principle),
            eq(aoControlDaily.date, dateStr),
        )
    );
}

// ── Reasons ──────────────────────────────────────────────────────────────────

export async function getReasons() {
    const rows = await db.select().from(noOrderReason)
        .where(eq(noOrderReason.isActive, true))
        .orderBy(asc(noOrderReason.sortOrder));
    return rows.length > 0 ? rows : [...NO_ORDER_REASONS];
}

// ── Merchandising ─────────────────────────────────────────────────────────────

export async function saveMerchandising(data: {
    salesCode: string; custCode: string; principle: string; date: string;
    produkJelas: boolean; displayRapi: boolean; dibersihkan: boolean;
    ditataulang: boolean; posisiMudah: boolean; semuaSku: boolean;
    photoUrl?: string | null; stepPhotos?: Record<string, string> | null; note?: string | null;
}) {
    const existing = await db.select({ id: merchandisingCheck.id })
        .from(merchandisingCheck)
        .where(and(
            eq(merchandisingCheck.salesCode, data.salesCode),
            eq(merchandisingCheck.custCode, data.custCode),
            eq(merchandisingCheck.principle, data.principle),
            eq(merchandisingCheck.date, data.date),
        )).limit(1);

    const values = {
        produkJelas: data.produkJelas, displayRapi: data.displayRapi,
        dibersihkan: data.dibersihkan, ditataulang: data.ditataulang,
        posisiMudah: data.posisiMudah, semuaSku: data.semuaSku,
        photoUrl: data.photoUrl ?? null,
        stepPhotos: data.stepPhotos ?? null,
        note: data.note ?? null,
    };

    if (existing.length > 0) {
        await db.update(merchandisingCheck).set(values)
            .where(eq(merchandisingCheck.id, existing[0].id));
        return existing[0].id;
    }

    const id = randomUUID();
    await db.insert(merchandisingCheck).values({
        id, salesCode: data.salesCode, custCode: data.custCode,
        principle: data.principle, date: data.date,
        ...values, createdAt: new Date(),
    });
    return id;
}

export async function getMerchandisingForDate(salesCode: string, principle: string, dateStr: string) {
    return db.select().from(merchandisingCheck).where(
        and(
            eq(merchandisingCheck.salesCode, salesCode),
            eq(merchandisingCheck.principle, principle),
            eq(merchandisingCheck.date, dateStr),
        )
    );
}

// ── Salesman Daily Report ────────────────────────────────────────────────────

export async function saveReport(data: {
    salesCode: string; date: string; tindakLanjut: string;
}) {
    const periodYear = parseInt(data.date.split("-")[0], 10);
    const periodMonth = parseInt(data.date.split("-")[1], 10);
    const now = new Date();

    const aoRows = await db.select().from(aoControlDaily).where(
        and(
            eq(aoControlDaily.salesCode, data.salesCode),
            eq(aoControlDaily.date, data.date),
        )
    );

    const totalOrder      = aoRows.filter(r => r.status === "ordered" || r.status === "active").length;
    const totalNotOrder   = aoRows.filter(r => r.status === "not_order").length;
    const totalNotVisited = aoRows.filter(r => r.status === "not_visited").length;
    const totalPriority   = aoRows.filter(r => r.status === "priority").length;

    const reasonSummary: Record<string, number> = {};
    for (const r of aoRows) {
        if (r.noOrderReasonCode) {
            reasonSummary[r.noOrderReasonCode] = (reasonSummary[r.noOrderReasonCode] ?? 0) + 1;
        }
    }

    const date = parseDateString(data.date);
    const dayName = DAY_TO_HARI[date.getDay()];
    let totalTokoJks = aoRows.length;
    if (dayName) {
        const parity = getWeekParity(date);
        const cnt = await db.select({ count: sql<number>`count(*)` }).from(jksMaster).where(
            and(
                eq(jksMaster.salesCode, data.salesCode),
                eq(jksMaster.hariKunjungan, dayName),
                or(eq(jksMaster.mingguPattern, "all"), eq(jksMaster.mingguPattern, parity)),
                eq(jksMaster.isActive, true),
            )
        );
        totalTokoJks = cnt[0]?.count ?? aoRows.length;
    }

    const existing = await db.select({ id: salesmanDailyReport.id })
        .from(salesmanDailyReport)
        .where(and(eq(salesmanDailyReport.salesCode, data.salesCode), eq(salesmanDailyReport.date, data.date)))
        .limit(1);

    if (existing.length > 0) {
        await db.update(salesmanDailyReport).set({
            totalTokoJks, totalOrder, totalActive: totalPriority,
            totalNotOrder, totalNotVisited,
            reasonSummary, tindakLanjut: data.tindakLanjut, submittedAt: now,
        }).where(eq(salesmanDailyReport.id, existing[0].id));
        return existing[0].id;
    }

    const id = randomUUID();
    await db.insert(salesmanDailyReport).values({
        id, salesCode: data.salesCode, date: data.date,
        periodMonth, periodYear,
        totalTokoJks, totalOrder, totalActive: totalPriority,
        totalNotOrder, totalNotVisited,
        reasonSummary, tindakLanjut: data.tindakLanjut, submittedAt: now,
    });
    return id;
}

export async function getReport(salesCode: string, dateStr: string) {
    return db.select().from(salesmanDailyReport).where(
        and(eq(salesmanDailyReport.salesCode, salesCode), eq(salesmanDailyReport.date, dateStr))
    ).limit(1);
}

// ── Briefing ─────────────────────────────────────────────────────────────────

export async function saveBriefing(data: {
    spvName: string; date: string; session: "pagi" | "sore";
    agenda?: unknown; tokoDialas?: unknown; penyebab?: string; solusi?: string;
    createdBy?: string;
}) {
    const id = randomUUID();
    await db.insert(spvBriefing).values({
        id, spvName: data.spvName, date: data.date, session: data.session,
        agenda: data.agenda ?? null, tokoDialas: data.tokoDialas ?? null,
        penyebab: data.penyebab ?? null, solusi: data.solusi ?? null,
        createdBy: data.createdBy ?? null, createdAt: new Date(),
    });
    return id;
}

export async function getBriefings(spvName: string, dateStr: string) {
    return db.select().from(spvBriefing).where(
        and(eq(spvBriefing.spvName, spvName), eq(spvBriefing.date, dateStr))
    );
}

// ── SM Control ────────────────────────────────────────────────────────────────

export async function saveSmControl(data: {
    smName: string; date: string; spvChecked?: unknown;
    jksChecked?: boolean; fotoChecked?: boolean;
    coachingNote?: string; deviations?: unknown; followUp?: string; createdBy?: string;
}) {
    const id = randomUUID();
    await db.insert(smControl).values({
        id, smName: data.smName, date: data.date,
        spvChecked: data.spvChecked ?? null,
        jksChecked: data.jksChecked ?? false,
        fotoChecked: data.fotoChecked ?? false,
        coachingNote: data.coachingNote ?? null,
        deviations: data.deviations ?? null,
        followUp: data.followUp ?? null,
        createdBy: data.createdBy ?? null,
        createdAt: new Date(),
    });
    return id;
}

export async function getSmControl(smName: string, dateStr: string) {
    return db.select().from(smControl).where(
        and(eq(smControl.smName, smName), eq(smControl.date, dateStr))
    ).limit(1);
}

// ── Frequency ────────────────────────────────────────────────────────────────

export async function getFrequencyData(salesCode: string, principle: string, periodMonth: number, periodYear: number) {
    const jksRows = await db.select().from(jksMaster).where(
        and(
            eq(jksMaster.salesCode, salesCode),
            eq(jksMaster.principle, principle),
            eq(jksMaster.isActive, true),
        )
    );

    if (jksRows.length === 0) return { rows: [], simulation: null };

    const custCodes = jksRows.map(r => r.custCode);
    const aoRows = await db.select({
        custCode: aoControlDaily.custCode,
        count: sql<number>`count(*)`,
    }).from(aoControlDaily).where(
        and(
            eq(aoControlDaily.salesCode, salesCode),
            eq(aoControlDaily.principle, principle),
            eq(aoControlDaily.periodMonth, periodMonth),
            eq(aoControlDaily.periodYear, periodYear),
            inArray(aoControlDaily.custCode, custCodes),
        )
    ).groupBy(aoControlDaily.custCode);

    const visitMap = new Map(aoRows.map(r => [r.custCode, r.count]));

    const rows = jksRows.map(j => ({
        ...j,
        actualVisits: visitMap.get(j.custCode) ?? 0,
        overVisit: (visitMap.get(j.custCode) ?? 0) > j.visitFrequency,
    }));

    const WORK_DAYS = 24, VISITS_PER_DAY = 20;
    const totalSlots = WORK_DAYS * VISITS_PER_DAY;
    const simulation = {
        workDays: WORK_DAYS, visitsPerDay: VISITS_PER_DAY, totalSlots,
        capacity1x: totalSlots,
        capacity2x: Math.floor(totalSlots / 2),
        capacity4x: Math.floor(totalSlots / 4),
    };

    return { rows, simulation };
}

// ── Scope ─────────────────────────────────────────────────────────────────────

export async function getScopeForUser(userId: string) {
    const profile = await db.select().from(salesProfile)
        .where(eq(salesProfile.userId, userId)).limit(1);
    return profile[0] ?? null;
}

// ── Check-in / Check-out ──────────────────────────────────────────────────────

export async function saveCheckin(data: {
    salesCode: string; custCode: string; principle: string; date: string;
    photoUrl: string; createdBy?: string;
}) {
    const now = new Date();
    const periodYear = parseInt(data.date.split("-")[0], 10);
    const periodMonth = parseInt(data.date.split("-")[1], 10);

    const existing = await db.select({ id: aoControlDaily.id })
        .from(aoControlDaily)
        .where(and(
            eq(aoControlDaily.salesCode, data.salesCode),
            eq(aoControlDaily.custCode, data.custCode),
            eq(aoControlDaily.principle, data.principle),
            eq(aoControlDaily.date, data.date),
        )).limit(1);

    if (existing.length > 0) {
        await db.update(aoControlDaily).set({
            checkinAt: now, checkinPhotoUrl: data.photoUrl,
            isVisited: true, updatedAt: now,
        }).where(eq(aoControlDaily.id, existing[0].id));
        return existing[0].id;
    }

    const id = randomUUID();
    await db.insert(aoControlDaily).values({
        id, salesCode: data.salesCode, custCode: data.custCode,
        principle: data.principle, date: data.date,
        periodMonth, periodYear,
        status: "not_visited", isVisited: true,
        checkinAt: now, checkinPhotoUrl: data.photoUrl,
        noOrderReasonCode: null, noOrderNote: null,
        checkoutAt: null, checkoutPhotoUrl: null,
        autoMatched: false, source: "manual",
        createdBy: data.createdBy ?? null, createdAt: now, updatedAt: now,
    });
    return id;
}

export async function saveCheckout(data: {
    salesCode: string; custCode: string; principle: string; date: string;
    photoUrl: string;
}) {
    const now = new Date();
    await db.update(aoControlDaily).set({
        checkoutAt: now, checkoutPhotoUrl: data.photoUrl, updatedAt: now,
    }).where(and(
        eq(aoControlDaily.salesCode, data.salesCode),
        eq(aoControlDaily.custCode, data.custCode),
        eq(aoControlDaily.principle, data.principle),
        eq(aoControlDaily.date, data.date),
    ));
}

// ── Visit detail ──────────────────────────────────────────────────────────────

export async function getVisitDetail(
    salesCode: string, custCode: string, principle: string, dateStr: string
) {
    const [storeRows, aoRows, merchRows] = await Promise.all([
        db.select().from(jksMaster).where(
            and(
                eq(jksMaster.salesCode, salesCode),
                eq(jksMaster.custCode, custCode),
                eq(jksMaster.principle, principle),
            )
        ).limit(1),
        db.select().from(aoControlDaily).where(
            and(
                eq(aoControlDaily.salesCode, salesCode),
                eq(aoControlDaily.custCode, custCode),
                eq(aoControlDaily.principle, principle),
                eq(aoControlDaily.date, dateStr),
            )
        ).limit(1),
        db.select().from(merchandisingCheck).where(
            and(
                eq(merchandisingCheck.salesCode, salesCode),
                eq(merchandisingCheck.custCode, custCode),
                eq(merchandisingCheck.principle, principle),
                eq(merchandisingCheck.date, dateStr),
            )
        ).limit(1),
    ]);

    if (!storeRows[0]) return null;
    return {
        store: storeRows[0],
        ao: aoRows[0] ?? null,
        merch: merchRows[0] ?? null,
    };
}

// ── SPV Dashboard ─────────────────────────────────────────────────────────────

export async function getSpvDashboard(spvName: string, dateStr: string) {
    const profiles = await db.select().from(salesProfile)
        .where(eq(salesProfile.spvName, spvName));

    if (profiles.length === 0) return [];

    const salesCodes = profiles.map(p => p.salesCode);
    const periodYear  = parseInt(dateStr.split("-")[0], 10);
    const periodMonth = parseInt(dateStr.split("-")[1], 10);

    const [aoRows, reportRows] = await Promise.all([
        db.select({
            salesCode: aoControlDaily.salesCode,
            status: aoControlDaily.status,
            checkinAt: aoControlDaily.checkinAt,
            checkoutAt: aoControlDaily.checkoutAt,
        }).from(aoControlDaily).where(
            and(
                eq(aoControlDaily.date, dateStr),
                inArray(aoControlDaily.salesCode, salesCodes),
            )
        ),
        db.select().from(salesmanDailyReport).where(
            and(
                eq(salesmanDailyReport.date, dateStr),
                inArray(salesmanDailyReport.salesCode, salesCodes),
            )
        ),
    ]);

    const reportMap = new Map(reportRows.map(r => [r.salesCode, r]));

    return profiles.map(p => {
        const rows = aoRows.filter(r => r.salesCode === p.salesCode);
        const report = reportMap.get(p.salesCode);
        const totalRoute = rows.length;

        // Also count JKS total for today
        const ordered    = rows.filter(r => r.status === "ordered" || r.status === "active").length;
        const notOrder   = rows.filter(r => r.status === "not_order").length;
        const notVisited = rows.filter(r => r.status === "not_visited").length;
        const checkedIn  = rows.filter(r => r.checkinAt !== null).length;
        const checkedOut = rows.filter(r => r.checkoutAt !== null).length;

        return {
            salesCode: p.salesCode,
            salesName: p.salesName,
            totalRoute,
            ordered,
            notOrder,
            notVisited,
            checkedIn,
            checkedOut,
            submittedAt: report?.submittedAt ?? null,
            tindakLanjut: report?.tindakLanjut ?? null,
            // Additional month context
            periodMonth,
            periodYear,
        };
    });
}

// ── Audit log ─────────────────────────────────────────────────────────────────

export async function writeKontrolAudit(
    entity: string, entityId: string, action: string,
    actorId: string | null, actorName: string | null, payload?: unknown
) {
    await db.insert(kontrolAuditLog).values({
        id: randomUUID(), entity, entityId, action,
        actorId, actorName, payload: payload ?? null,
        createdAt: new Date(),
    });
}
