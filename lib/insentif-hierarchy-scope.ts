/*
 * Tujuan: Hitung scope salesCode yang boleh dilihat user dengan identitas SPV/SM
 *         (user.hierarchyRole/hierarchyName, opt-in per-user — lihat db/schema.ts).
 * Caller: app/api/insentif-sales/dashboard, app/api/insentif-sales/spv-dashboard (GET).
 * Dependensi: db/schema (user, salesTargets, spvSalesAssignment, smSpvAssignment).
 * Main Functions: getScopeForUser(userId).
 * Side Effects: DB read-only.
 *
 * Kontrak: getScopeForUser mengembalikan:
 *   - null        -> TIDAK ADA scoping. User lihat semua row (perilaku default/existing,
 *                    berlaku untuk semua user yang belum di-set hierarchyRole — termasuk
 *                    Admin/OM/Finance sekarang, tanpa perlu permission baru apapun).
 *   - Set<string> -> scoped. Hanya salesCode di dalam Set ini yang boleh tampil (Set kosong
 *                    = scoped tapi belum ada bawahan sama sekali, bukan "lihat semua").
 *   hierarchyRole diisi TAPI bukan "spv"/"sm" yang valid -> fail-CLOSED (Set kosong), bukan
 *   fail-open ke null. Sengaja: state korup harus terlihat sebagai "0 data", bukan diam-diam
 *   balik ke "lihat semua" (itu kebalikan dari tujuan fitur ini).
 *
 * Resolusi nama SPV/SM per salesCode/spvName: spv_sales_assignment/sm_spv_assignment
 * (Bagian C) meng-override sales_targets.spv_name/sm_name kalau ada — sama pola dgn
 * spv-dashboard/route.ts, supaya konsisten begitu admin mulai isi Kelola Hierarki.
 */

import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { user, salesTargets, spvSalesAssignment, smSpvAssignment } from "@/db/schema";

async function effectiveSpvBySalesCode(): Promise<Map<string, string>> {
    const [assignments, targets] = await Promise.all([
        db.select().from(spvSalesAssignment),
        db.select({ salesCode: salesTargets.salesCode, spvName: salesTargets.spvName }).from(salesTargets),
    ]);
    const map = new Map<string, string>();
    for (const t of targets) if (t.spvName) map.set(t.salesCode, t.spvName);
    for (const a of assignments) map.set(a.salesCode, a.spvName); // override
    return map;
}

async function effectiveSmBySpvName(): Promise<Map<string, string>> {
    const [assignments, targets] = await Promise.all([
        db.select().from(smSpvAssignment),
        db.select({ spvName: salesTargets.spvName, smName: salesTargets.smName }).from(salesTargets),
    ]);
    const map = new Map<string, string>();
    for (const t of targets) if (t.spvName && t.smName) map.set(t.spvName, t.smName);
    for (const a of assignments) map.set(a.spvName, a.smName); // override
    return map;
}

export interface HierarchyIdentity {
    role: "spv" | "sm";
    name: string;
}

/** Identitas SPV/SM user sendiri (untuk keputusan eligibility, mis. self-service claim salesman). null = bukan SPV/SM (termasuk hierarchyRole korup/tak dikenal — deny, bukan diam-diam anggap valid). */
export async function getUserHierarchyIdentity(userId: string): Promise<HierarchyIdentity | null> {
    const [row] = await db
        .select({ hierarchyRole: user.hierarchyRole, hierarchyName: user.hierarchyName })
        .from(user)
        .where(eq(user.id, userId))
        .limit(1);
    if ((row?.hierarchyRole === "spv" || row?.hierarchyRole === "sm") && row.hierarchyName) {
        return { role: row.hierarchyRole, name: row.hierarchyName };
    }
    return null;
}

/** Nama SPV pemilik salesCode saat ini (assignment override, fallback sales_targets.spv_name). null = belum ada yang klaim. */
export async function getCurrentSpvOwner(salesCode: string): Promise<string | null> {
    const spvOf = await effectiveSpvBySalesCode();
    return spvOf.get(salesCode) ?? null;
}

/** null = tidak ada scoping (lihat semua) — default untuk semua user yang belum di-assign. */
export async function getScopeForUser(userId: string): Promise<Set<string> | null> {
    const [row] = await db
        .select({ hierarchyRole: user.hierarchyRole, hierarchyName: user.hierarchyName })
        .from(user)
        .where(eq(user.id, userId))
        .limit(1);
    if (!row?.hierarchyRole || !row.hierarchyName) return null;

    const spvOf = await effectiveSpvBySalesCode();

    if (row.hierarchyRole === "spv") {
        const codes = new Set<string>();
        for (const [code, spv] of spvOf) if (spv === row.hierarchyName) codes.add(code);
        return codes;
    }

    if (row.hierarchyRole === "sm") {
        const smOf = await effectiveSmBySpvName();
        const spvNames = new Set<string>();
        for (const [spv, sm] of smOf) if (sm === row.hierarchyName) spvNames.add(spv);
        const codes = new Set<string>();
        for (const [code, spv] of spvOf) if (spvNames.has(spv)) codes.add(code);
        return codes;
    }

    // hierarchyRole terisi tapi nilainya tak dikenal -> fail-closed (lihat komentar header).
    return new Set<string>();
}
