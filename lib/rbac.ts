/*
 * Tujuan: Definisi role, permission module/action, dan helper akses halaman untuk RBAC internal aktif.
 * Caller: Better Auth admin plugin, dashboard layout/sidebar, admin user management, dan API admin permission.
 * Dependensi: better-auth default access controller.
 * Main Functions: normalizeRole, normalizePermissionMap, permissionMapForUser, canAccess, canAccessPathWithKeys (kunci tunggal atau `anyOf`).
 * Side Effects: Tidak ada; hanya normalisasi data permission in-memory.
 */
import { defaultAc } from "better-auth/plugins/admin/access";
import type { PermissionModule } from "./rbac/registry";

export const appRoles = ["admin", "manager", "finance", "staff", "viewer"] as const;
export type AppRole = (typeof appRoles)[number];

export const roleLabels: Record<AppRole, string> = {
    admin: "Admin",
    manager: "Manager",
    finance: "Finance",
    staff: "Staff",
    viewer: "Viewer",
};

export const appModules = [
    "dashboard",
    "order",
    "api_wrapper",
    "payments",
    "sppd",
    "finance",
    "principles",
    "master_barang",
    "summary",
    "off_program_control",
    "reconciliation",
    "claim_workflow",
    "users",
    "sales_history",
    "laporan_harian",
    "rekapan_nota",
    "insentif_sales",
    // Web Sales: izin TERPISAH dari `order`. Sales tidak boleh dapat `order.create`
    // karena POST /orders internal menerima harga dari klien; jalur sales hanya kirim
    // kode, satuan, jumlah dan uangnya dihitung server.
    "websales",
    // Pelunasan (S6e-2, owner #5 10 Okt 2026): kirim sales-receipt ke Accurate dari wizard; ditegakkan server.
    "pelunasan",
    // Kasir ↔ Incaso (K1a BL-59): setoran per orang per hari lawan pelunasan Accurate; kunci di lib/rbac/registry.ts.
    "kasir",
] as const;
export type AppModule = (typeof appModules)[number];

export const moduleLabels: Record<AppModule, string> = {
    dashboard: "Dashboard",
    order: "Order Masuk",
    api_wrapper: "API Wrapper",
    payments: "Payments",
    sppd: "SPPD",
    finance: "Finance",
    principles: "Principles",
    master_barang: "Master Barang",
    summary: "Summary",
    off_program_control: "OFF Program Control",
    reconciliation: "Rekonsiliasi",
    claim_workflow: "Claim Workflow",
    users: "Users & RBAC",
    sales_history: "History Penjualan",
    laporan_harian: "Laporan Harian",
    rekapan_nota: "Rekapan Nota",
    insentif_sales: "Insentif Sales",
    websales: "Order Sales (Web Sales)",
    pelunasan: "Pelunasan",
    kasir: "Kasir ↔ Incaso",
};

export const permissionActions = [
    "view",
    "create",
    "edit",
    "update",
    "delete",
    "upload",
    "export",
    "submit",
    "execute",
    "edit_settings",
    "upload_excel",
    "generate",
    "download",
    "approve",
    "transfer",
    "upload_proof",
    "post_accurate",
    "retry_post",
    "resolve_unknown",
    "override_duplicate",
    "repost_payment",
    "run",
    "email",
    "send",
    "sync",
    "manage",
    "print",
    "approve_takeout",
    "catat",
    "tutup",
    "buka",
    "view_dashboard",
    "view_all",
    "upload_target",
    "upload_progress",
    "input_support",
    "manage_payment",
    "manage_hierarchy",
    "kirim",
    // NOO toko baru (owner 13 Okt 2026) — label saja (registry form_kontrol; form_kontrol bukan AppModule, preset role lama tidak berubah).
    "noo_setujui", "noo_ktp",
    // Aksi OPC granular (registry off_program_control, alur SPV→SM→Claim→OM→Finance). Hanya untuk LABEL (S7-1): moduleActions
    // legacy OPC tetap 5 aksi, jadi preset role lama tidak berubah.
    "create_batch", "edit_returned_batch", "submit_batch", "sm_approve", "sm_return", "claim_review", "claim_final",
    "om_approve", "om_cancel", "finance_payment", "submit_refund", "audit_read", "audit_export", "audit_correct",
    "period_close", "period_unlock", "discount_view", "discount_manage",
] as const;
export type PermissionAction = (typeof permissionActions)[number];

export const actionLabels: Record<PermissionAction, string> = {
    send: "Kirim Email",
    print: "Cetak",
    approve_takeout: "Setujui Take-out",
    catat: "Catat Setoran & Jelaskan Selisih",
    tutup: "Tutup Hari",
    buka: "Buka Kembali Hari",
    view_dashboard: "Lihat Dashboard",
    view_all: "Lihat Semua Cakupan",
    upload_target: "Unggah Target",
    upload_progress: "Unggah Closing",
    input_support: "Input Support",
    manage_payment: "Kelola Pembayaran",
    manage_hierarchy: "Kelola Hierarki",
    view: "Lihat",
    create: "Buat",
    edit: "Edit",
    update: "Update",
    delete: "Hapus",
    upload: "Upload",
    export: "Export",
    submit: "Ajukan",
    execute: "Eksekusi",
    edit_settings: "Edit Setting",
    upload_excel: "Upload Excel",
    generate: "Generate",
    download: "Download",
    approve: "Approve",
    transfer: "Transfer",
    upload_proof: "Upload Bukti",
    post_accurate: "Post Accurate",
    retry_post: "Retry Post",
    resolve_unknown: "Selesaikan Posting Tidak Pasti",
    override_duplicate: "Override Blok Duplikat",
    repost_payment: "Repost Pembayaran",
    run: "Run",
    email: "Email",
    sync: "Sync",
    manage: "Manage",
    kirim: "Kirim ke Accurate",
    noo_setujui: "Setujui/Tolak NOO",
    noo_ktp: "Lihat KTP NOO",
    create_batch: "Buat Batch",
    edit_returned_batch: "Edit Batch Dikembalikan",
    submit_batch: "Ajukan Batch",
    sm_approve: "Setujui (SM)",
    sm_return: "Kembalikan (SM)",
    claim_review: "Tinjau Klaim",
    claim_final: "Final Klaim",
    om_approve: "Setujui (OM)",
    om_cancel: "Batalkan (OM)",
    finance_payment: "Bayar (Finance)",
    submit_refund: "Ajukan Refund",
    audit_read: "Baca Audit",
    audit_export: "Export Audit",
    audit_correct: "Koreksi Audit",
    period_close: "Tutup Periode",
    period_unlock: "Buka Kunci Periode",
    discount_view: "Lihat Diskon",
    discount_manage: "Kelola Diskon",
};

/** SATU sumber label modul untuk layar grup/izin (S7a): 20 modul registry, termasuk `form_kontrol` yang bukan AppModule. */
export const permissionModuleLabels: Record<PermissionModule, string> = {
    ...moduleLabels,
    form_kontrol: "Form Kontrol",
};

/** Label kunci izin "module.action" -> "Modul · Aksi" (kunci tak dikenal dikembalikan apa adanya). */
export function permissionKeyLabel(key: string): string {
    const [mod, action] = key.split(".");
    const m = (permissionModuleLabels as Record<string, string>)[mod];
    const a = (actionLabels as Record<string, string>)[action];
    return m && a ? `${m} · ${a}` : key;
}

/** Label aksi audit permission_audit_log (riwayat S7-1; kontrak §5.10). */
export const auditActionLabels: Record<string, string> = {
    "user.create": "User dibuat",
    "user.password_set": "Sandi diatur admin",
    "user.deactivate": "User dinonaktifkan",
    "user.activate": "User diaktifkan",
    "user_group.assign": "Ditambahkan ke grup",
    "user_group.remove": "Dikeluarkan dari grup",
    "user_group.star": "Grup utama ditandai",
    "user_group.unstar": "Grup utama dilepas",
    "user_group.set_primary": "Grup diganti (lama)",
    "group.create": "Grup dibuat",
    "group.update": "Grup diubah",
    "group.delete": "Grup dihapus",
    "group_permission.sync": "Izin grup diubah",
    // O1 (owner 12 Okt 2026): tautan akun salesman <-> karyawan salesman Accurate (app/api/admin/users/[id]/salesman).
    "salesman.link": "Salesman Accurate ditautkan",
    "salesman.unlink": "Tautan salesman Accurate dilepas",
};

export const moduleActions: Record<AppModule, readonly PermissionAction[]> = {
    dashboard: ["view"],
    // resolve_unknown: kunci kapabilitas S6-0d (lib/rbac/registry.ts) — tidak ada di preset selain admin.
    order: ["view", "create", "edit", "export", "resolve_unknown"],
    api_wrapper: ["view", "execute"],
    payments: ["view", "create", "edit", "update", "delete", "upload", "export", "submit"],
    sppd: ["view", "edit_settings", "upload_excel", "generate", "download"],
    finance: ["view", "approve", "transfer", "upload_proof", "post_accurate", "retry_post", "export", "update", "resolve_unknown", "override_duplicate", "repost_payment"],
    principles: ["view", "upload", "delete"],
    master_barang: ["view", "create", "upload", "edit", "generate", "export", "manage"],
    summary: ["view", "upload", "generate", "email", "export", "edit", "update"],
    // S7-1b: create/update/export dipensiunkan (KUNCI_PENSIUN, lib/rbac/registry.ts); approve sampai S7-3.
    off_program_control: ["view", "approve"],
    reconciliation: ["view", "run", "manage"],
    claim_workflow: ["view", "create", "edit", "update", "submit", "approve", "export"],
    users: ["view", "manage"],
    sales_history: ["view", "export", "manage"],
    laporan_harian: ["view", "upload", "send", "manage"],
    rekapan_nota: ["view", "manage", "print", "approve_takeout"],
    // Sengaja dipecah halus: Finance cuma butuh view + manage_payment + input_support,
    // dan TIDAK boleh dapat view_dashboard/upload_* (permintaan user 2026-08-29).
    insentif_sales: [
        "view", "view_dashboard", "view_all", "manage", "upload_target", "upload_progress",
        "input_support", "manage_payment", "manage_hierarchy",
    ],
    websales: ["view", "create"],
    pelunasan: ["kirim"],
    // buka = kunci kapabilitas (lib/rbac/registry.ts CAPABILITY_KEYS) — hanya preset admin (semua) yang memuatnya.
    kasir: ["view", "catat", "tutup", "buka"],
};

export type PermissionMap = Partial<Record<AppModule, PermissionAction[]>>;
export type PermissionProfile = {
    custom: boolean;
    permissions: PermissionMap;
};

export const roleAccess = {
    admin: defaultAc.newRole({
        user: ["create", "list", "set-role", "ban", "delete", "set-password", "get", "update"],
        session: ["list", "revoke", "delete"],
    }),
    manager: defaultAc.newRole({
        user: [],
        session: [],
    }),
    finance: defaultAc.newRole({
        user: [],
        session: [],
    }),
    staff: defaultAc.newRole({
        user: [],
        session: [],
    }),
    viewer: defaultAc.newRole({
        user: [],
        session: [],
    }),
};

export const defaultRole: AppRole = "viewer";

const appModuleSet = new Set<string>(appModules);
const permissionActionSet = new Set<string>(permissionActions);

function allPermissions(): PermissionMap {
    return Object.fromEntries(
        appModules.map((moduleName) => [moduleName, [...moduleActions[moduleName]]])
    ) as PermissionMap;
}

function pick(module: AppModule, actions: PermissionAction[]): PermissionMap {
    return { [module]: actions };
}

function mergePermissionMaps(...maps: PermissionMap[]): PermissionMap {
    const merged: PermissionMap = {};
    for (const map of maps) {
        for (const moduleName of appModules) {
            const actions = map[moduleName] || [];
            if (!actions.length) continue;
            const current = new Set<PermissionAction>(merged[moduleName] || []);
            for (const action of actions) {
                if (moduleActions[moduleName].includes(action)) current.add(action);
            }
            merged[moduleName] = [...current];
        }
    }
    return merged;
}

export const rolePermissionPresets: Record<AppRole, PermissionMap> = {
    admin: allPermissions(),
    manager: mergePermissionMaps(
        pick("dashboard", ["view"]),
        pick("order", ["view", "create", "edit", "export"]),
        pick("api_wrapper", ["view", "execute"]),
        pick("payments", ["view", "export", "submit", "edit", "update"]),
        pick("sppd", ["view", "generate", "download"]),
        pick("finance", ["view", "approve", "export", "update"]),
        pick("principles", ["view"]),
        pick("summary", ["view", "export"]),
        pick("off_program_control", ["view", "approve"]),
        pick("reconciliation", ["view"]),
        pick("claim_workflow", ["view", "approve", "export"]),
        pick("sales_history", ["view", "export", "manage"]),
        pick("rekapan_nota", ["view", "manage", "print", "approve_takeout"])
    ),
    finance: mergePermissionMaps(
        pick("dashboard", ["view"]),
        pick("payments", ["view", "export"]),
        pick("sppd", ["view", "download"]),
        pick("finance", ["view", "approve", "transfer", "upload_proof", "post_accurate", "retry_post", "export", "update", "resolve_unknown", "override_duplicate", "repost_payment"]),
        pick("off_program_control", ["view"]),
        pick("claim_workflow", ["view", "update", "export"]),
        pick("principles", ["view"]),
        pick("sales_history", ["view", "export"])
    ),
    staff: mergePermissionMaps(
        pick("dashboard", ["view"]),
        pick("order", ["view", "create"]),
        pick("payments", ["view", "create", "edit", "upload", "submit"]),
        pick("sppd", ["view", "generate", "download"]),
        pick("principles", ["view"]),
        pick("summary", ["view", "upload", "generate", "export", "edit", "update"]),
        pick("off_program_control", ["view"]),
        pick("reconciliation", ["view", "run"]),
        // Claim Workflow guardrail: staff hanya boleh membaca daftar / detail
        // sebatas yang diizinkan policy. Pembuatan, edit pajak, dan submit
        // ke principal harus tetap eksklusif role admin/claim.
        pick("claim_workflow", ["view"]),
        pick("sales_history", ["view"])
    ),
    viewer: mergePermissionMaps(
        pick("dashboard", ["view"]),
        pick("order", ["view"]),
        pick("payments", ["view"]),
        pick("sppd", ["view"]),
        pick("finance", ["view"]),
        pick("off_program_control", ["view"]),
        pick("claim_workflow", ["view"]),
        pick("summary", ["view"]),
        pick("sales_history", ["view"])
    ),
};

/**
 * Halaman Sesi Accurate (owner D-01 Q2, 11 Okt): masuk Accurate + pilih database tanpa Konsol. Dibuka pemegang SALAH SATU kunci ini;
 * route sesi (/api/auth/accurate-session, db-list, open-db, accurate-login, callback) cukup sesi app — tidak ada route tulis yang dibuka.
 */
export const SESI_ACCURATE_KEYS = ["api_wrapper.view", "order.edit", "pelunasan.kirim", "finance.update", "finance.resolve_unknown"] as const;

/** `anyOf` = kunci alternatif: halaman terbuka bila `module.action` ATAU salah satu kunci ini dipegang. */
export const pagePermissions: Array<{ prefix: string; module: AppModule; action: PermissionAction; anyOf?: readonly string[] }> = [
    { prefix: "/admin/groups", module: "users", action: "manage" },
    // S7a (owner S7 10 Okt): halaman User dibuka users.view (baca-saja) ATAU users.manage (tulis, ditegakkan API); pemegang users.manage
    // saja lolos layout dan gerbang klien SidebarLayout. /admin/groups tetap users.manage (GET grup hanya menerima users.manage).
    { prefix: "/admin/users", module: "users", action: "view", anyOf: ["users.manage"] },
    { prefix: "/payments/sppd", module: "sppd", action: "view" },
    { prefix: "/payments", module: "payments", action: "view" },
    { prefix: "/finance", module: "finance", action: "view" },
    // Wizard Pelunasan (S6e-2b): halaman = kirim sales-receipt; kunci yang sama dengan penegakan server (owner #5).
    { prefix: "/pelunasan", module: "pelunasan", action: "kirim" },
    // Kasir ↔ Incaso (K1a BL-59; halaman = K2). Tanpa entri ini /kasir jatuh ke "/" = dashboard.view.
    { prefix: "/kasir", module: "kasir", action: "view" },
    { prefix: "/principal-mapping", module: "principles", action: "view" },
    { prefix: "/master-barang", module: "master_barang", action: "view" },
    { prefix: "/principles", module: "principles", action: "view" },
    // /sales sebelum /orders TIDAK relevan (prefix beda), tapi urutannya tetap dijaga:
    // pencocokan memakai prefix terpanjang.
    { prefix: "/sales", module: "websales", action: "create" },
    { prefix: "/principal-order", module: "order", action: "view" },
    { prefix: "/antrean-faktur", module: "order", action: "view" },
    { prefix: "/orders", module: "order", action: "view" },
    { prefix: "/aturan-promo", module: "summary", action: "view" },
    { prefix: "/rekap-promo", module: "summary", action: "view" },
    { prefix: "/normalisasi-diskon", module: "summary", action: "view" },
    { prefix: "/summary", module: "summary", action: "view" },
    { prefix: "/api-wrapper", module: "api_wrapper", action: "view" },
    { prefix: "/sesi-accurate", module: "api_wrapper", action: "view", anyOf: SESI_ACCURATE_KEYS },
    { prefix: "/off-program-control", module: "off_program_control", action: "view" },
    { prefix: "/reconciliation", module: "reconciliation", action: "view" },
    { prefix: "/claim-workflow", module: "claim_workflow", action: "view" },
    { prefix: "/faktur", module: "sales_history", action: "view" },
    { prefix: "/sales-history", module: "sales_history", action: "view" },
    { prefix: "/laporan-harian", module: "laporan_harian", action: "view" },
    { prefix: "/rekapan-nota", module: "rekapan_nota", action: "view" },
    { prefix: "/insentif-sales", module: "insentif_sales", action: "view" },
    { prefix: "/", module: "dashboard", action: "view" },
];

export function isAppRole(value: string): value is AppRole {
    return appRoles.includes(value as AppRole);
}

// ponytail: synthetic roles (spv/salesman/sm) disimpan di DB tapi bukan AppRole —
// map ke AppRole terdekat agar dashboard auth guard tidak loop.
const syntheticRoleMap: Record<string, AppRole> = { salesman: "staff", spv: "staff", sm: "manager" };
export function normalizeRole(value?: string | null): AppRole {
    if (value && syntheticRoleMap[value]) return syntheticRoleMap[value];
    return value && isAppRole(value) ? value : defaultRole;
}

export function normalizePermissionMap(raw: unknown): PermissionMap {
    const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
    const permissions: PermissionMap = {};
    for (const [moduleKey, value] of Object.entries(source)) {
        if (!appModuleSet.has(moduleKey)) continue;
        const moduleName = moduleKey as AppModule;
        const rawActions = Array.isArray(value)
            ? value
            : typeof value === "string"
                ? value.split(/[,\s]+/)
                : [];
        const actions = new Set<PermissionAction>();
        for (const item of rawActions) {
            const action = String(item || "").trim() as PermissionAction;
            if (permissionActionSet.has(action) && moduleActions[moduleName].includes(action)) {
                actions.add(action);
            }
        }
        if (actions.size) permissions[moduleName] = [...actions];
    }
    return permissions;
}

export function parsePermissionProfile(raw: unknown): PermissionProfile {
    if (!raw) return { custom: false, permissions: {} };
    let parsed = raw;
    if (typeof raw === "string") {
        const text = raw.trim();
        if (!text) return { custom: false, permissions: {} };
        try {
            parsed = JSON.parse(text);
        } catch {
            return { custom: false, permissions: {} };
        }
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { custom: false, permissions: {} };
    }
    const record = parsed as Record<string, unknown>;
    if (record.__custom === true) {
        return {
            custom: true,
            permissions: normalizePermissionMap(record.permissions),
        };
    }
    const map = normalizePermissionMap(record);
    return Object.keys(map).length
        ? { custom: true, permissions: map }
        : { custom: false, permissions: {} };
}

export function permissionMapForUser(roleValue?: string | null, rawPermissions?: unknown): PermissionMap {
    const profile = parsePermissionProfile(rawPermissions);
    if (profile.custom) return profile.permissions;
    return rolePermissionPresets[normalizeRole(roleValue)];
}

export function canAccess(module: AppModule, action: PermissionAction, roleValue?: string | null, rawPermissions?: unknown): boolean {
    const permissions = permissionMapForUser(roleValue, rawPermissions);
    return Boolean(permissions[module]?.includes(action));
}

export function getPagePermission(pathname: string) {
    const path = pathname || "/";
    return pagePermissions.find((item) => path === item.prefix || path.startsWith(`${item.prefix}/`)) || pagePermissions[pagePermissions.length - 1];
}

/**
 * Varian key-based: cek akses halaman dari Set/array permission key efektif
 * hasil getUserPermissions() (union group ∪ legacy). Dipakai layout/sidebar/landing
 * agar keputusan akses halaman konsisten dengan guard API.
 */
export function canAccessPathWithKeys(pathname: string, keys: ReadonlySet<string> | readonly string[]): boolean {
    const permission = getPagePermission(pathname);
    const set = keys instanceof Set ? keys : new Set(keys);
    return set.has(`${permission.module}.${permission.action}`) || Boolean(permission.anyOf?.some((key) => set.has(key)));
}
