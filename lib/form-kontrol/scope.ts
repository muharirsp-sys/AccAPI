/*
 * Tujuan: Enforcement scope server-side untuk Form Kontrol — cegah user akses data salesCode/SPV lain.
 * Caller: semua route app/api/form-kontrol/* yang menerima salesCode/spvName/smName dari klien.
 * Dependensi: getScopeForUser (sales_profile).
 * Catatan: allowedSalesCodes === null = akses global (admin/manager/admin_sales).
 */
import { getScopeForUser } from "./db";

export interface UserScope {
    role: string;
    salesCode?: string;
    salesName?: string;
    spvName?: string | null;
    smName?: string | null;
    allowedSalesCodes: string[] | null; // null = semua (admin)
}

// Replikasi logika my-scope — satu sumber untuk UI scope & enforcement.
export async function resolveScope(session: { user: { id: string; name?: string | null; role?: string | null } }): Promise<UserScope> {
    const role = session.user.role ?? "staff";
    if (role === "admin" || role === "manager" || role === "admin_sales") {
        return { role, allowedSalesCodes: null };
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
