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

import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { parsePayee } from "@/lib/insentif-payee";
import { user, salesTargets, spvSalesAssignment, smSpvAssignment } from "@/db/schema";

/** Periode yang sedang dilihat. Menyempitkan peta hierarki ke bulan itu saja. */
export interface Period { month: number; year: number }

/** idx_sales_targets_period sudah cocok — tidak perlu index baru. */
function periodWhere(period?: Period) {
    return period
        ? and(eq(salesTargets.periodMonth, period.month), eq(salesTargets.periodYear, period.year))
        : undefined;
}

/**
 * Periode opsional. TANPA periode, peta dibangun dari SELURUH riwayat sales_targets — dan
 * karena tidak ada ORDER BY, salesCode yang pernah pindah SPV antar bulan hasilnya
 * NON-DETERMINISTIK (map.set membiarkan baris terakhir yang dibaca menang, dan urutan
 * seq-scan bisa berubah setelah VACUUM). Gejalanya: SPV kadang melihat kadang tidak melihat
 * salesman lama, berubah antar refresh tanpa ada data yang diubah (audit temuan M2).
 * Pemanggil yang tahu periodenya WAJIB mengirimkannya.
 */
async function effectiveSpvBySalesCode(period?: Period): Promise<Map<string, string>> {
    const [assignments, targets] = await Promise.all([
        db.select().from(spvSalesAssignment),
        db
            .select({ salesCode: salesTargets.salesCode, spvName: salesTargets.spvName })
            .from(salesTargets)
            .where(periodWhere(period)),
    ]);
    const map = new Map<string, string>();
    for (const t of targets) if (t.spvName) map.set(t.salesCode, t.spvName);
    for (const a of assignments) map.set(a.salesCode, a.spvName); // override
    return map;
}

async function effectiveSmBySpvName(period?: Period): Promise<Map<string, string>> {
    const [assignments, targets] = await Promise.all([
        db.select().from(smSpvAssignment),
        db
            .select({ spvName: salesTargets.spvName, smName: salesTargets.smName })
            .from(salesTargets)
            .where(periodWhere(period)),
    ]);
    const map = new Map<string, string>();
    for (const t of targets) if (t.spvName && t.smName) map.set(t.spvName, t.smName);
    for (const a of assignments) map.set(a.spvName, a.smName); // override
    return map;
}

export interface HierarchyIdentity {
    role: "spv" | "sm" | "sales";
    name: string;
}

/** Identitas SPV/SM user sendiri (untuk keputusan eligibility, mis. self-service claim salesman). null = bukan SPV/SM (termasuk hierarchyRole korup/tak dikenal — deny, bukan diam-diam anggap valid). */
export async function getUserHierarchyIdentity(userId: string): Promise<HierarchyIdentity | null> {
    const [row] = await db
        .select({ hierarchyRole: user.hierarchyRole, hierarchyName: user.hierarchyName })
        .from(user)
        .where(eq(user.id, userId))
        .limit(1);
    if ((row?.hierarchyRole === "spv" || row?.hierarchyRole === "sm" || row?.hierarchyRole === "sales") && row.hierarchyName) {
        return { role: row.hierarchyRole, name: row.hierarchyName };
    }
    return null;
}

/**
 * Boleh melihat baris penerima ini? Menangani ketiga bentuk `sales_code` di incentive_payments:
 * kode sales biasa, `SPV:<nama>`, dan `SM:<nama>`. Dipisah jadi helper karena tiga endpoint
 * memerlukannya dan menyalin logikanya berarti tiga kesempatan untuk berbeda.
 */
export function payeeInScope(
    scope: Set<string> | null,
    identity: HierarchyIdentity | null,
    payeeSalesCode: string,
): boolean {
    if (scope === null) return true;
    const { role, name } = parsePayee(payeeSalesCode);
    if (role === "sales") return scope.has(payeeSalesCode);
    // Baris SPV/SM hanya boleh dilihat oleh orangnya sendiri (atau pemegang izin kelola, yang
    // sudah pulang lebih dulu lewat scope === null di atas).
    return !!identity && identity.role === role && identity.name === name;
}

/** Nama SPV pemilik salesCode saat ini (assignment override, fallback sales_targets.spv_name). null = belum ada yang klaim. */
export async function getCurrentSpvOwner(salesCode: string): Promise<string | null> {
    const spvOf = await effectiveSpvBySalesCode();
    return spvOf.get(salesCode) ?? null;
}

/**
 * Peta salesCode → SPV pemilik, dihitung SEKALI untuk dipakai berulang.
 * Dipakai POST /targets yang memeriksa kepemilikan per baris: memanggil getCurrentSpvOwner
 * di dalam loop membuat 2 full-scan `sales_targets` PER BARIS (upload 88 baris = 176 scan).
 */
export async function getSpvOwnerMap(period?: Period): Promise<Map<string, string>> {
    return effectiveSpvBySalesCode(period);
}

/** null = tidak ada scoping (lihat semua) — default untuk semua user yang belum di-assign. */
/**
 * Izin yang berarti "boleh melihat seluruh perusahaan". Sengaja diturunkan dari izin KELOLA yang
 * sudah dimiliki Admin/Finance, bukan permission baru — menambah key baru berarti tidak ada satu
 * pun group produksi yang memilikinya pada saat deploy, dan semua orang terkunci keluar.
 * `insentif_sales.view_all` ikut diterima supaya bisa diberikan eksplisit nanti tanpa ubah kode.
 */
const LIHAT_SEMUA_KEYS = [
    "insentif_sales.view_all",
    "insentif_sales.manage",
    "insentif_sales.manage_payment",
    "insentif_sales.manage_hierarchy",
];

export function canSeeAllInsentif(perms: Set<string> | null | undefined): boolean {
    return !!perms && LIHAT_SEMUA_KEYS.some((k) => perms.has(k));
}

/**
 * Cakupan baris yang boleh dilihat/disentuh user. `null` = seluruh perusahaan.
 *
 * FAIL-CLOSED (2026-08-29, audit C3): user yang tidak punya izin kelola DAN belum diisi identitas
 * hierarkinya mendapat cakupan KOSONG, bukan "lihat semua". Sebelumnya default `null` berarti satu
 * SPV yang lupa dikonfigurasi menerima target, realisasi, support, dan nominal insentif seluruh
 * perusahaan tanpa error dan tanpa tanda apa pun.
 *
 * `perms` WAJIB (dari `requirePermission(...).perms`, tanpa query tambahan) supaya keputusan
 * "lihat semua" tidak bisa terjadi karena call-site lupa meneruskannya.
 */
export async function getScopeForUser(
    userId: string,
    period: Period | undefined,
    perms: Set<string> | null | undefined,
): Promise<Set<string> | null> {
    if (canSeeAllInsentif(perms)) return null;

    const [row] = await db
        .select({ hierarchyRole: user.hierarchyRole, hierarchyName: user.hierarchyName })
        .from(user)
        .where(eq(user.id, userId))
        .limit(1);
    if (!row?.hierarchyRole || !row.hierarchyName) return null;

    const spvOf = await effectiveSpvBySalesCode(period);

    if (row.hierarchyRole === "spv") {
        const codes = new Set<string>();
        for (const [code, spv] of spvOf) if (spv === row.hierarchyName) codes.add(code);
        return codes;
    }

    // Peran "sales": cakupannya kode sales dirinya sendiri. Sebelumnya tidak ada peran ini sama
    // sekali, jadi seorang salesman yang diberi izin melihat insentifnya SELALU melihat insentif
    // seluruh rekannya — tidak ada cara membatasinya.
    if (row.hierarchyRole === "sales") {
        return new Set([row.hierarchyName]);
    }

    if (row.hierarchyRole === "sm") {
        const smOf = await effectiveSmBySpvName(period);
        const spvNames = new Set<string>();
        for (const [spv, sm] of smOf) if (sm === row.hierarchyName) spvNames.add(spv);
        const codes = new Set<string>();
        for (const [code, spv] of spvOf) if (spvNames.has(spv)) codes.add(code);
        return codes;
    }

    // hierarchyRole terisi tapi nilainya tak dikenal -> fail-closed (lihat komentar header).
    return new Set<string>();
}
