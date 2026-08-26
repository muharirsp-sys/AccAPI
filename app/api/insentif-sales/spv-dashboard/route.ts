/*
 * Tujuan: GET agregat insentif SPV (strata Value, lib/insentif-spv-calc) per periode.
 * Caller: app/(dashboard)/insentif-sales/page.tsx (SpvIncentiveTable, view="spv").
 * Dependensi: lib/insentif-sales (getTargetsForPeriod, computeMtdByPrinciple), lib/insentif-spv-calc,
 *   db/schema (spvSalesAssignment).
 * Main Functions: GET — group baris target per SPV, SUM realisasi per principal lintas sales
 *   bawahan & channel, lalu calculateInsentifSPV.
 *   Nama SPV per salesCode diambil dari spv_sales_assignment (Bagian C) kalau sudah di-assign,
 *   fallback ke sales_targets.spv_name (teks bebas) kalau belum. Assignment table masih additive/
 *   opsional — tidak breaking selama admin belum mengisi Kelola Hierarki.
 *   Support principle per SPV per principal dibaca dari spv_support: yang menutup penuh rate
 *   mengeluarkan principal itu dari hitungan jumlah principal (lihat lib/insentif-spv-calc).
 * Side Effects: DB read only.
 */

import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { spvSalesAssignment, spvSupport } from "@/db/schema";
import { getTargetsForPeriod, computeMtdByPrinciple } from "@/lib/insentif-sales";
import { requirePermission } from "@/lib/rbac/resolve";
import { getScopeForUser } from "@/lib/insentif-hierarchy-scope";
import { calculateInsentifSPV, type SpvSalesRow } from "@/lib/insentif-spv-calc";
import { isOfficeRow } from "@/lib/insentif-sm-calc";
import type { StatusInsentif } from "@/lib/insentif-sales-calc";

export async function GET(req: NextRequest) {
    const gate = await requirePermission(req, "insentif_sales.view");
    if (gate.response) return gate.response;

    const { searchParams } = req.nextUrl;
    const now = new Date();
    const month = parseInt(searchParams.get("month") ?? String(now.getMonth() + 1), 10);
    const year = parseInt(searchParams.get("year") ?? String(now.getFullYear()), 10);

    const [rawTargets, realByPrinciple, assignments, supportRows, scope] = await Promise.all([
        getTargetsForPeriod(month, year),
        computeMtdByPrinciple(month, year),
        db.select().from(spvSalesAssignment),
        db
            .select({ spvName: spvSupport.spvName, principle: spvSupport.principle, amount: spvSupport.supportAmount })
            .from(spvSupport)
            .where(and(eq(spvSupport.periodMonth, month), eq(spvSupport.periodYear, year))),
        getScopeForUser(gate.session.user.id, { month, year }),
    ]);
    // support[spvName][principle] — dipakai calculateInsentifSPV utk mengeluarkan principal
    // yang sudah ditanggung penuh principle.
    const supportBySpv = new Map<string, Map<string, number>>();
    for (const r of supportRows) {
        const inner = supportBySpv.get(r.spvName) ?? new Map<string, number>();
        inner.set(r.principle, r.amount);
        supportBySpv.set(r.spvName, inner);
    }
    const assignedSpvOf = new Map(assignments.map((a) => [a.salesCode, a.spvName]));
    // scope null = tidak ada scoping (default). Non-null = user SPV/SM opt-in — grouping
    // SPV di bawah otomatis cuma berisi timnya sendiri (SPV: 1 grup; SM: SPV bawahannya saja).
    const targets = scope === null ? rawTargets : rawTargets.filter((t) => scope.has(t.salesCode));

    const bySpv = new Map<string, SpvSalesRow[]>();
    for (const t of targets) {
        // Baris _OFFICE bukan salesman — pos target kantor. Kalau ikut, principal bisa nyangkut ke
        // SPV yang tidak membawahinya: MTS1/MTS2_OFFICE (SPV=ANI di file target Juli 2026) membuat
        // MOTASA masuk hitungan ANI padahal 10 salesman MOTASA semuanya di bawah MARTEN.
        if (isOfficeRow(t.salesCode, t.salesName)) continue;
        const spvName = assignedSpvOf.get(t.salesCode) ?? t.spvName;
        if (!spvName) continue;
        const real = realByPrinciple.get(`${t.salesCode}|${t.principle}`);
        const arr = bySpv.get(spvName) ?? [];
        arr.push({
            principle: t.principle,
            targetValue: t.targetValue,
            realisasiValue: real?.realValue ?? 0,
            statusInsentif: t.statusInsentif as StatusInsentif,
        });
        bySpv.set(spvName, arr);
    }

    const rows = [...bySpv.entries()].map(([spvName, spvRows]) => ({
        spvName,
        ...calculateInsentifSPV(spvRows, supportBySpv.get(spvName)),
    }));

    return NextResponse.json({ month, year, rows });
}
