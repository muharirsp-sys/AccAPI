/*
 * Tujuan: GET agregat insentif SM (strata flat Value, lib/insentif-sm-calc) per periode.
 * Caller: app/(dashboard)/insentif-sales/page.tsx (SmIncentiveTable, view="sm").
 * Dependensi: lib/insentif-sales (getTargetsForPeriod, computeMtdByPrinciple), lib/insentif-sm-calc,
 *   db/schema (spvSalesAssignment, smSpvAssignment).
 * Main Functions: GET — resolve nama SM per baris target, SUM target & realisasi Value seluruh
 *   sales di bawahnya, lalu calculateInsentifSM. Tidak ada support principle utk SM (belum ada
 *   aturannya). SEMUA status principal ikut dihitung (termasuk ENERGIZER/"principle"); yang
 *   dibuang hanya baris _OFFICE — filternya ada di dalam calc supaya ikut ke-test.
 *   Resolusi SM: sm_spv_assignment (via SPV baris itu) → fallback sales_targets.sm_name.
 * Side Effects: DB read only.
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { spvSalesAssignment, smSpvAssignment } from "@/db/schema";
import { getTargetsForPeriod, computeMtdByPrinciple } from "@/lib/insentif-sales";
import { requirePermission } from "@/lib/rbac/resolve";
import { getScopeForUser } from "@/lib/insentif-hierarchy-scope";
import { calculateInsentifSM, type SmSalesRow } from "@/lib/insentif-sm-calc";
import type { StatusInsentif } from "@/lib/insentif-sales-calc";

export async function GET(req: NextRequest) {
    const gate = await requirePermission(req, "insentif_sales.view");
    if (gate.response) return gate.response;

    const { searchParams } = req.nextUrl;
    const now = new Date();
    const month = parseInt(searchParams.get("month") ?? String(now.getMonth() + 1), 10);
    const year = parseInt(searchParams.get("year") ?? String(now.getFullYear()), 10);

    const [rawTargets, realByPrinciple, spvAssignments, smAssignments, scope] = await Promise.all([
        getTargetsForPeriod(month, year),
        computeMtdByPrinciple(month, year),
        db.select().from(spvSalesAssignment),
        db.select().from(smSpvAssignment),
        getScopeForUser(gate.session.user.id),
    ]);

    const assignedSpvOf = new Map(spvAssignments.map((a) => [a.salesCode, a.spvName]));
    const smOfSpv = new Map(smAssignments.map((a) => [a.spvName, a.smName]));
    // scope null = tidak ada scoping (default). Non-null = user SPV/SM opt-in — hanya timnya.
    const targets = scope === null ? rawTargets : rawTargets.filter((t) => scope.has(t.salesCode));

    const bySm = new Map<string, SmSalesRow[]>();
    for (const t of targets) {
        const spvName = assignedSpvOf.get(t.salesCode) ?? t.spvName;
        const smName = (spvName ? smOfSpv.get(spvName) : undefined) ?? t.smName;
        if (!smName) continue;
        const real = realByPrinciple.get(`${t.salesCode}|${t.principle}`);
        const arr = bySm.get(smName) ?? [];
        arr.push({
            salesCode: t.salesCode,
            salesName: t.salesName,
            targetValue: t.targetValue,
            realisasiValue: real?.realValue ?? 0,
            statusInsentif: t.statusInsentif as StatusInsentif,
        });
        bySm.set(smName, arr);
    }

    const rows = [...bySm.entries()].map(([smName, smRows]) => ({
        smName,
        ...calculateInsentifSM(smName, smRows),
    }));

    return NextResponse.json({ month, year, rows });
}
