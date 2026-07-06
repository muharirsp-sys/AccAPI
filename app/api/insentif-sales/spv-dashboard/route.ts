/*
 * Tujuan: GET agregat insentif SPV (strata Value, lib/insentif-spv-calc) per periode.
 * Caller: app/(dashboard)/insentif-sales/page.tsx (SpvIncentiveTable, view="spv").
 * Dependensi: lib/insentif-sales (getTargetsForPeriod, computeMtdByPrinciple), lib/insentif-spv-calc.
 * Main Functions: GET — group baris target per SPV (spv_name teks bebas, lihat SYSTEM_MAP
 *   catatan hierarki — belum ada tabel assignment), SUM realisasi per principal lintas sales
 *   bawahan & channel, lalu calculateInsentifSPV.
 * Side Effects: DB read only.
 */

import { NextRequest, NextResponse } from "next/server";
import { getTargetsForPeriod, computeMtdByPrinciple } from "@/lib/insentif-sales";
import { requirePermission } from "@/lib/rbac/resolve";
import { calculateInsentifSPV, type SpvSalesRow } from "@/lib/insentif-spv-calc";
import type { StatusInsentif } from "@/lib/insentif-sales-calc";

export async function GET(req: NextRequest) {
    const gate = await requirePermission(req, "insentif_sales.view");
    if (gate.response) return gate.response;

    const { searchParams } = req.nextUrl;
    const now = new Date();
    const month = parseInt(searchParams.get("month") ?? String(now.getMonth() + 1), 10);
    const year = parseInt(searchParams.get("year") ?? String(now.getFullYear()), 10);

    const [targets, realByPrinciple] = await Promise.all([
        getTargetsForPeriod(month, year),
        computeMtdByPrinciple(month, year),
    ]);

    const bySpv = new Map<string, SpvSalesRow[]>();
    for (const t of targets) {
        if (!t.spvName) continue;
        const real = realByPrinciple.get(`${t.salesCode}|${t.principle}`);
        const arr = bySpv.get(t.spvName) ?? [];
        arr.push({
            principle: t.principle,
            targetValue: t.targetValue,
            realisasiValue: real?.realValue ?? 0,
            statusInsentif: t.statusInsentif as StatusInsentif,
        });
        bySpv.set(t.spvName, arr);
    }

    const rows = [...bySpv.entries()].map(([spvName, spvRows]) => ({
        spvName,
        ...calculateInsentifSPV(spvRows),
    }));

    return NextResponse.json({ month, year, rows });
}
