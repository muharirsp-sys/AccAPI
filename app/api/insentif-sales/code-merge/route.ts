/*
 * Tujuan: Daftar kandidat penggabungan kode sales (prefiks rute sama ATAU nama orang sama,
 *   kode beda) + simpan keputusan user (merge / pisah).
 * Caller: app/(dashboard)/insentif-sales/page.tsx → CodeMergeSection.
 * Dependensi: lib/sales-code-merge (pure), db/schema (salesDailyProgress, salesTargets, salesCodeMerge).
 * Main Functions: GET kandidat yang belum diputuskan; POST simpan keputusan per kode.
 * Side Effects: POST menulis sales_code_merge. Agregasi MTD (lib/insentif-sales) membaca
 *   keputusan ini untuk melipat pencapaian.
 *
 * Penggabungan TIDAK PERNAH otomatis — prefiks sama belum tentu orang yang sama
 * (mis. FS1_GITO channel GT vs FS1_MT_SYAHRUL channel MT), dan nama sama bisa homonim.
 * User yang memutuskan.
 */

import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { salesCodeMerge, salesDailyProgress, salesTargets } from "@/db/schema";
import { requirePermission } from "@/lib/rbac/resolve";
import { mergeCandidates, type CodeNamePair } from "@/lib/sales-code-merge";
import { getScopeForUser } from "@/lib/insentif-hierarchy-scope";

export async function GET(req: NextRequest) {
    const gate = await requirePermission(req, "insentif_sales.view");
    if (gate.response) return gate.response;

    const { searchParams } = req.nextUrl;
    const now = new Date();
    const month = parseInt(searchParams.get("month") ?? String(now.getMonth() + 1), 10);
    const year = parseInt(searchParams.get("year") ?? String(now.getFullYear()), 10);

    // Nama salesman diambil dari targets (sumber nama paling rapi). Kode yang hanya ada di
    // progress (belum punya target) tetap disertakan supaya pergantian orang tak terlewat.
    const [targetRows, progressCodes, decided, scope] = await Promise.all([
        db
            .selectDistinct({ salesCode: salesTargets.salesCode, salesName: salesTargets.salesName })
            .from(salesTargets)
            .where(and(eq(salesTargets.periodMonth, month), eq(salesTargets.periodYear, year))),
        db
            .selectDistinct({ salesCode: salesDailyProgress.salesCode, salesName: salesDailyProgress.salesName })
            .from(salesDailyProgress)
            .where(and(eq(salesDailyProgress.periodMonth, month), eq(salesDailyProgress.periodYear, year))),
        db
            .select({ from: salesCodeMerge.fromSalesCode, to: salesCodeMerge.toSalesCode, decision: salesCodeMerge.decision })
            .from(salesCodeMerge)
            .where(and(eq(salesCodeMerge.periodMonth, month), eq(salesCodeMerge.periodYear, year))),
        getScopeForUser(gate.session.user.id, { month, year }, gate.perms),
    ]);

    // scope null = lihat semua (default). Non-null = user SPV/SM opt-in — tanpa filter ini,
    // dua endpoint ini membocorkan SELURUH kode sales + nama SPV/SM se-perusahaan ke user
    // yang secara desain hanya boleh melihat timnya sendiri (audit temuan M5).
    const inScope = (salesCode: string) => scope === null || scope.has(salesCode);

    const nameByCode = new Map(targetRows.filter((r) => inScope(r.salesCode)).map((r) => [r.salesCode, r.salesName]));
    // Nama dari progress dipakai untuk kode yang BELUM punya target. Justru di situlah pasangan
    // satu-orang-dua-rute muncul: M-BSR2 (FRN5_BASRI YUSUF) hanya ada di closing, targetnya
    // terlanjur ditulis di M-BSR (M2_1_BASRI YUSUF). Tanpa nama ini, kandidatnya tidak pernah
    // bisa dibentuk. Nama target tetap menang — itu sumber ejaan yang paling rapi.
    const namaProgress = new Map<string, string>();
    for (const p of progressCodes) {
        if (!p.salesName || !inScope(p.salesCode) || nameByCode.has(p.salesCode)) continue;
        if (!namaProgress.has(p.salesCode)) namaProgress.set(p.salesCode, p.salesName);
    }
    const pairs: CodeNamePair[] = [
        ...[...nameByCode].map(([salesCode, salesName]) => ({ salesCode, salesName })),
        ...[...namaProgress].map(([salesCode, salesName]) => ({ salesCode, salesName })),
    ];
    // Sisanya: ada di closing, tanpa target DAN tanpa nama (closing lama yang diunggah sebelum
    // kolom sales_name ada). Namanya tak terbaca → dilaporkan terpisah, bukan sebagai kandidat.
    const orphanCodes = progressCodes
        .map((p) => p.salesCode)
        .filter((c) => inScope(c) && !nameByCode.has(c) && !namaProgress.has(c));

    const decidedFrom = new Set(decided.map((d) => d.from));
    const groups = mergeCandidates(pairs)
        // Kelompok yang SEMUA anggotanya sudah diputuskan tidak perlu ditanya lagi.
        .map((g) => ({ ...g, members: g.members.filter((m) => !decidedFrom.has(m.salesCode)) }))
        .filter((g) => g.members.length > 1);

    return NextResponse.json({
        month, year,
        count: groups.length,
        groups,
        orphanCodes,
        decided: decided.filter((d) => inScope(d.from)),
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

    // PASS 1: validasi seluruh payload sebelum menulis. Keputusan merge mengubah cara
    // pencapaian dilipat saat agregasi MTD — separuh keputusan tersimpan berarti sebagian
    // sales dilipat dan sebagian tidak, tanpa ada yang tahu.
    const prepared: Array<{ d: MergeDecisionInput; to: string | null }> = [];
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
        prepared.push({ d, to });
    }

    // PASS 2: satu transaksi.
    let saved = 0;
    await db.transaction(async (tx) => {
      for (const { d, to } of prepared) {
        // uq_sales_code_merge_from sudah ada di produksi sejak 2026-08-21.
        await tx.insert(salesCodeMerge)
            .values({
                id: randomUUID(),
                periodMonth: d.periodMonth, periodYear: d.periodYear,
                prefix: d.prefix, fromSalesCode: d.fromSalesCode, toSalesCode: to,
                decision: d.decision, decidedBy: gate.session.user.id,
                createdAt: now, updatedAt: now,
            })
            .onConflictDoUpdate({
                target: [salesCodeMerge.periodMonth, salesCodeMerge.periodYear, salesCodeMerge.fromSalesCode],
                set: { toSalesCode: to, decision: d.decision, prefix: d.prefix, decidedBy: gate.session.user.id, updatedAt: now },
            });
        saved++;
      }
    });

    return NextResponse.json({ saved });
}
