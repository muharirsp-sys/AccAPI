/*
 * Tujuan: SUMBER TUNGGAL daftar permission key valid untuk Dynamic RBAC (Fase 2/4 — Opsi A).
 * Caller: lib/rbac/resolve.ts (guard route), UI admin RBAC (P6), registry.test.ts (guard test).
 * Dependensi: TIDAK ADA (pure data) — sengaja bebas import agar bisa di-test di mana saja.
 * Catatan: permission baru = tambah action di sini → otomatis terbaca RBAC. Default-deny:
 *   key yang TIDAK ada di registry ditolak; test-guard gagal kalau route pakai key tak terdaftar.
 *   `moduleActions` di lib/rbac.ts tetap ada untuk preset legacy selama transisi.
 */

// module -> daftar action valid. Permission key = `${module}.${action}`.
export const PERMISSION_REGISTRY = {
    dashboard: ["view"],
    api_wrapper: ["view", "execute"],
    payments: ["view", "create", "edit", "update", "delete", "upload", "export", "submit"],
    sppd: ["view", "edit_settings", "upload_excel", "generate", "download"],
    finance: ["view", "approve", "transfer", "upload_proof", "post_accurate", "retry_post", "export", "update"],
    principles: ["view", "upload", "delete"],
    summary: ["view", "upload", "generate", "email", "export", "edit", "update"],
    validator: ["view", "upload", "run", "download", "edit"],
    off_program_control: [
        "view", "create", "update", "approve", "export",
        // workflow granular (mirror OffAction) — chain SPV→SM→Claim→OM→Finance:
        "create_batch", "edit_returned_batch", "submit_batch", "sm_approve", "sm_return",
        "claim_review", "claim_final", "om_approve", "om_cancel", "finance_payment",
        "submit_refund", "audit_read", "audit_export", "audit_correct", "period_close",
        "period_unlock", "discount_view", "discount_manage",
    ],
    claim_workflow: ["view", "create", "edit", "update", "submit", "approve", "export"],
    users: ["view", "create_user", "edit_user", "delete_user", "set_role", "set_permission", "manage"],
    // Modul yang sebelumnya TIDAK terdaftar di RBAC (temuan Fase 3 — page-guard gap):
    form_kontrol: ["view", "submit", "manage"],
    insentif_sales: ["view", "manage", "upload_target", "upload_progress", "input_support", "manage_payment"],
} as const;

export type PermissionModule = keyof typeof PERMISSION_REGISTRY;
export type PermissionKey = string; // "module.action"

export const PERMISSION_MODULES = Object.keys(PERMISSION_REGISTRY) as PermissionModule[];

export function allPermissionKeys(): Set<string> {
    const keys = new Set<string>();
    for (const [moduleName, actions] of Object.entries(PERMISSION_REGISTRY)) {
        for (const action of actions) keys.add(`${moduleName}.${action}`);
    }
    return keys;
}

export function isValidPermissionKey(key: string): boolean {
    return allPermissionKeys().has(key);
}
