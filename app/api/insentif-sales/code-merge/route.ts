/*
 * Tujuan: Daftar kandidat penggabungan kode sales (prefiks rute sama, kode beda — biasanya
 *   pergantian orang di tengah bulan) + simpan keputusan user (merge / pisah).
 * Caller: app/(dashboard)/insentif-sales/page.tsx → CodeMergeSection.
 * Dependensi: lib/sales-code-merge (pure), db/schema (salesDailyProgress, salesTargets, salesCodeMerge).
 * Main Functions: GET kandidat yang belum diputuskan; POST simpan keputusan per kode.
 * Side Effects: POST menulis sales_code_merge. Agregasi MTD (lib/insentif-sales) membaca
 *   keputusan ini untuk melipat pencapaian.
 *
 * Penggabungan TIDAK PERNAH otomatis — prefiks sama belum tentu orang yang sama
 * (mis. FS1_GITO channel GT vs FS1_MT_SYAHRUL channel MT). User yang memutuskan.
 */

import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { salesCodeMerge, salesDailyProgress, salesTargets } from "@/db/schema";
import { requirePermission } from "@/lib/rbac/resolve";
import { groupByPrefix, type CodeNamePair } from "@/lib/sales-code-merge";

export async function GET(req: NextRequest) {
    const gate = await requirePermission(req, "insentif_sales.view");
    if (gate.response) return gate.response;

    const { searchParams } = req.nextUrl;
    const now = new Date();
    const month = parseInt(searchParams.get("month") ?? String(now.getMonth() + 1), 10);
    const year = parseInt(searchParams.get("year") ?? String(now.getFullYear()), 10);

    // Nama salesman diambil dari targets (sumber nama paling rapi). Kode yang hanya ada di
    // progress (belum punya target) tetap disertakan supaya pergantian orang tak terlewat.
    const [targetRows, progressCodes, decided] = await Promise.all([
        db
            .selectDistinct({ salesCode: salesTargets.salesCode, salesName: salesTargets.salesName })
            .from(salesTargets)
            .where(and(eq(salesTargets.periodMonth, month), eq(salesTargets.periodYear, year))),
        db
            .selectDistinct({ salesCode: salesDailyProgress.salesCode })
            .from(salesDailyProgress)
            .where(and(eq(salesDailyProgress.periodMonth, month), eq(salesDailyProgress.periodYear, year))),
        db
            .select({ from: salesCodeMerge.fromSalesCode, to: salesCodeMerge.toSalesCode, decision: salesCodeMerge.decision })
            .from(salesCodeMerge)
            .where(and(eq(salesCodeMerge.periodMonth, month), eq(salesCodeMerge.periodYear, year))),
    ]);

    const nameByCode = new Map(targetRows.map((r) => [r.salesCode, r.salesName]));
    const pairs: CodeNamePair[] = [...nameByCode].map(([salesCode, salesName]) => ({ salesCode, salesName }));
    // Kode di progress tanpa target: tanpa nama, prefiks tak bisa dibaca → dilaporkan terpisah.
    const orphanCodes = progressCodes.map((p) => p.salesCode).filter((c) => !nameByCode.has(c));

    const decidedFrom = new Set(decided.map((d) => d.from));
    const groups = groupByPrefix(pairs)
        // Kelompok yang SEMUA anggotanya sudah diputuskan tidak perlu ditanya lagi.
        .map((g) => ({ ...g, members: g.members.filter((m) => !decidedFrom.has(m.salesCode)) }))
        .filter((g) => g.members.length > 1);

    return NextResponse.json({
        month, year,
        count: groups.length,
        groups,
        orphanCodes,
        decided,
    });
}

interface MergeDecisionInput {
    periodMonth: number;
    periodYear: number;
    prefix: string;
    fromSalesCode: string;
    toSalesCode?: string | null; // wajib kalau decision = "merge"
    decision: "merge" | "separate";
}

export async function POST(req: NextRequest) {
    const gate = await requirePermission(req, "insentif_sales.manage_hierarchy");
    if (gate.response) return gate.response;

    let body: MergeDecisionInput[];
    try {
        const raw = await req.json();
        body = Array.isArray(raw) ? raw : [raw];
    } catch {
        return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const now = new Date();
    let saved = 0;

    for (const d of body) {
        if (!d.fromSalesCode || !d.prefix || !d.periodMonth || !d.periodYear) continue;
        if (d.decision !== "merge" && d.decision !== "separate") {
            return NextResponse.json({ error: `Keputusan tidak dikenal: "${d.decision}"` }, { status: 400 });
        }
        const to = d.decision === "merge" ? (d.toSalesCode ?? "").trim() : null;
        if (d.decision === "merge") {
            if (!to) {
                return NextResponse.json({ error: `${d.fromSalesCode}: tujuan merge wajib diisi` }, { status: 400 });
            }
            if (to === d.fromSalesCode) {
                return NextResponse.json({ error: `${d.fromSalesCode}: tujuan merge tidak boleh kode itu sendiri` }, { status: 400 });
            }
        }

        const [existing] = await db
            .select({ id: salesCodeMerge.id })
            .from(salesCodeMerge)
            .where(
                and(
                    eq(salesCodeMerge.periodMonth, d.periodMonth),
                    eq(salesCodeMerge.periodYear, d.periodYear),
                    eq(salesCodeMerge.fromSalesCode, d.fromSalesCode),
                ),
            )
            .limit(1);

        if (existing) {
            await db.update(salesCodeMerge)
                .set({ toSalesCode: to, decision: d.decision, prefix: d.prefix, decidedBy: gate.session.user.id, updatedAt: now })
                .where(eq(salesCodeMerge.id, existing.id));
        } else {
            await db.insert(salesCodeMerge).values({
                id: randomUUID(),
                periodMonth: d.periodMonth, periodYear: d.periodYear,
                prefix: d.prefix, fromSalesCode: d.fromSalesCode, toSalesCode: to,
                decision: d.decision, decidedBy: gate.session.user.id,
                createdAt: now, updatedAt: now,
            });
        }
        saved++;
    }

    return NextResponse.json({ saved });
}
