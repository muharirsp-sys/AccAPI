/*
 * Tujuan: Enforcement scope server-side untuk Form Kontrol — cegah user akses data salesCode/SPV lain.
 * Caller: semua route app/api/form-kontrol/* yang menerima salesCode/spvName/smName dari klien.
 * Dependensi: getScopeForUser (sales_profile).
 * Catatan: allowedSalesCodes === null = akses global (admin/manager/admin_sales).
 */
import { getScopeForUser, getSalesCodesForSpv, getSalesCodesForSm, getSpvNamesForSm, kunciNama } from "./db";

export interface UserScope {
    role: string;
    salesCode?: string;
    salesName?: string;
    spvName?: string | null;
    smName?: string | null;
    allowedSalesCodes: string[] | null; // null = semua (admin)
}

// Strip suffix "(SPV)"/"(SM)" dari nama auth user agar cocok dengan spvName/smName di sales_profile.
function stripRoleSuffix(name: string | null | undefined): string {
    return (name ?? "").replace(/\s*\((SPV|SM)\)\s*$/i, "").trim();
}

// Replikasi logika my-scope — satu sumber untuk UI scope & enforcement.
export async function resolveScope(session: { user: { id: string; name?: string | null; role?: string | null } }): Promise<UserScope> {
    const role = session.user.role ?? "staff";
    if (role === "admin" || role === "manager" || role === "admin_sales") {
        return { role, allowedSalesCodes: null };
    }

    // SPV: allowedSalesCodes = semua salesCode anak buah yang spvName-nya cocok.
    if (role === "spv") {
        const spvName = stripRoleSuffix(session.user.name);
        const codes = await getSalesCodesForSpv(spvName);
        return { role: "spv", salesName: spvName, spvName, allowedSalesCodes: codes };
    }

    // SM: allowedSalesCodes = semua salesCode di bawah SM ini.
    if (role === "sm") {
        const smName = stripRoleSuffix(session.user.name);
        const codes = await getSalesCodesForSm(smName);
        return { role: "sm", salesName: smName, smName, allowedSalesCodes: codes };
    }

    const profile = await getScopeForUser(session.user.id);
    if (profile) {
        return {
            role: role === "staff" ? "salesman" : role,
            salesCode: profile.salesCode,
            salesName: profile.salesName,
            spvName: profile.spvName ?? null,
            smName: profile.smName ?? null,
            allowedSalesCodes: [profile.salesCode],
        };
    }
    return { role, allowedSalesCodes: [] };
}

// true bila user boleh baca/tulis data salesCode ini.
export function canAccessSales(scope: UserScope, salesCode: string | null | undefined): boolean {
    if (scope.allowedSalesCodes === null) return true;        // admin/manager
    if (!salesCode) return false;
    return scope.allowedSalesCodes.includes(salesCode);
}

// Untuk route SPV/SM: non-admin dipaksa ke nama dirinya; admin boleh pilih lewat param.
export function effectiveSupervisorName(scope: UserScope, requested: string | null, fallbackName?: string): string | null {
    if (scope.allowedSalesCodes === null) return requested || fallbackName || null; // admin bebas
    return scope.spvName || scope.smName || scope.salesName || fallbackName || null;
}

/**
 * Nama SPV yang boleh dibaca/ditulis briefing-nya (FK-MSM putaran 2) — dari sesi, bukan dari parameter klien. null = semua (admin/manager/
 * admin_sales). SPV: namanya; SM: namanya + SPV di bawahnya; salesman: hanya MEMBACA briefing SPV-nya (profil), tidak menulis.
 */
export async function namaSpvBoleh(scope: UserScope, untuk: "baca" | "tulis"): Promise<string[] | null> {
    if (scope.allowedSalesCodes === null) return null;
    if (scope.role === "spv") return scope.spvName ? [scope.spvName] : [];
    if (scope.role === "sm") return scope.smName ? [scope.smName, ...await getSpvNamesForSm(scope.smName)] : [];
    return untuk === "baca" && scope.spvName ? [scope.spvName] : [];
}

/** Nama SM yang boleh dibaca/ditulis Kontrol SM-nya: null = semua (admin); SM = namanya; peran lain tidak ada. */
export const namaSmBoleh = (scope: UserScope): string[] | null =>
    scope.allowedSalesCodes === null ? null : scope.role === "sm" && scope.smName ? [scope.smName] : [];

/**
 * Nama yang dipakai route: `diminta` harus ada di `boleh` (trim + tanpa beda huruf) — selain itu `tolak`; kosong = nama pertama yang boleh.
 * Admin (`boleh` null) bebas; null = tidak ada nama.
 */
export function namaDalamCakupan(boleh: string[] | null, diminta: unknown): { nama: string | null } | { tolak: true } {
    const d = typeof diminta === "string" ? diminta.trim() : "";
    if (boleh === null) return { nama: d || null };
    if (!d) return boleh[0] ? { nama: boleh[0].trim() } : { tolak: true };
    const cocok = boleh.find((n) => kunciNama(n) === kunciNama(d));
    return cocok ? { nama: cocok.trim() } : { tolak: true };
}
