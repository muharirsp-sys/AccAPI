/*
 * Tujuan: Definisi role, permission module/action, dan helper akses halaman untuk RBAC internal aktif.
 * Caller: Better Auth admin plugin, dashboard layout/sidebar, admin user management, dan API admin permission.
 * Dependensi: better-auth default access controller.
 * Main Functions: normalizeRole, normalizePermissionMap, permissionMapForUser, canAccess, canAccessPath.
 * Side Effects: Tidak ada; hanya normalisasi data permission in-memory.
 */
import { defaultAc } from "better-auth/plugins/admin/access";

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
    "api_wrapper",
    "payments",
    "sppd",
    "finance",
    "principles",
    "summary",
    "validator",
    "off_program_control",
    "claim_workflow",
    "users",
] as const;
export type AppModule = (typeof appModules)[number];

export const moduleLabels: Record<AppModule, string> = {
    dashboard: "Dashboard",
    api_wrapper: "API Wrapper",
    payments: "Payments",
    sppd: "SPPD",
    finance: "Finance",
    principles: "Principles",
    summary: "Summary",
    validator: "Validator",
    off_program_control: "OFF Program Control",
    claim_workflow: "Claim Workflow",
    users: "Users & RBAC",
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
    "run",
    "email",
    "sync",
    "manage",
    "create_user",
    "edit_user",
    "delete_user",
    "set_role",
    "set_permission",
] as const;
export type PermissionAction = (typeof permissionActions)[number];

export const actionLabels: Record<PermissionAction, string> = {
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
    run: "Run",
    email: "Email",
    sync: "Sync",
    manage: "Manage",
    create_user: "Buat User",
    edit_user: "Edit User",
    delete_user: "Hapus User",
    set_role: "Set Role",
    set_permission: "Set Permission",
};

export const moduleActions: Record<AppModule, readonly PermissionAction[]> = {
    dashboard: ["view"],
    api_wrapper: ["view", "execute"],
    payments: ["view", "create", "edit", "update", "delete", "upload", "export", "submit"],
    sppd: ["view", "edit_settings", "upload_excel", "generate", "download"],
    finance: ["view", "approve", "transfer", "upload_proof", "post_accurate", "retry_post", "export", "update"],
    principles: ["view", "upload", "delete"],
    summary: ["view", "upload", "generate", "email", "export", "edit", "update"],
    validator: ["view", "upload", "run", "download", "edit"],
    off_program_control: ["view", "create", "update", "approve", "export"],
    claim_workflow: ["view", "create", "edit", "update", "submit", "approve", "export"],
    users: ["view", "create_user", "edit_user", "delete_user", "set_role", "set_permission", "manage"],
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
        pick("api_wrapper", ["view", "execute"]),
        pick("payments", ["view", "export", "submit", "edit", "update"]),
        pick("sppd", ["view", "generate", "download"]),
        pick("finance", ["view", "approve", "export", "update"]),
        pick("principles", ["view"]),
        pick("summary", ["view", "export"]),
        pick("validator", ["view", "download"]),
        pick("off_program_control", ["view", "update", "approve", "export"]),
        pick("claim_workflow", ["view", "approve", "export"])
    ),
    finance: mergePermissionMaps(
        pick("dashboard", ["view"]),
        pick("payments", ["view", "export"]),
        pick("sppd", ["view", "download"]),
        pick("finance", ["view", "approve", "transfer", "upload_proof", "post_accurate", "retry_post", "export", "update"]),
        pick("off_program_control", ["view", "update"]),
        pick("claim_workflow", ["view", "update", "export"]),
        pick("principles", ["view"])
    ),
    staff: mergePermissionMaps(
        pick("dashboard", ["view"]),
        pick("payments", ["view", "create", "edit", "upload", "submit"]),
        pick("sppd", ["view", "generate", "download"]),
        pick("principles", ["view"]),
        pick("summary", ["view", "upload", "generate", "export", "edit", "update"]),
        pick("validator", ["view", "upload", "run", "download", "edit"]),
        pick("off_program_control", ["view", "create", "update"]),
        // Claim Workflow guardrail: staff hanya boleh membaca daftar / detail
        // sebatas yang diizinkan policy. Pembuatan, edit pajak, dan submit
        // ke principal harus tetap eksklusif role admin/claim.
        pick("claim_workflow", ["view"])
    ),
    viewer: mergePermissionMaps(
        pick("dashboard", ["view"]),
        pick("payments", ["view"]),
        pick("sppd", ["view"]),
        pick("finance", ["view"]),
        pick("off_program_control", ["view"]),
        pick("claim_workflow", ["view"]),
        pick("summary", ["view"]),
        pick("validator", ["view"])
    ),
};

export const pagePermissions: Array<{ prefix: string; module: AppModule; action: PermissionAction }> = [
    { prefix: "/admin/groups", module: "users", action: "manage" },
    { prefix: "/admin/users", module: "users", action: "view" },
    { prefix: "/payments/sppd", module: "sppd", action: "view" },
    { prefix: "/payments", module: "payments", action: "view" },
    { prefix: "/finance", module: "finance", action: "view" },
    { prefix: "/principles", module: "principles", action: "view" },
    { prefix: "/summary", module: "summary", action: "view" },
    { prefix: "/validator", module: "validator", action: "view" },
    { prefix: "/api-wrapper", module: "api_wrapper", action: "view" },
    { prefix: "/off-program-control", module: "off_program_control", action: "view" },
    { prefix: "/claim-workflow", module: "claim_workflow", action: "view" },
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

export function serializeCustomPermissions(permissions: PermissionMap): string {
    return JSON.stringify({
        __custom: true,
        permissions: normalizePermissionMap(permissions),
    });
}

export function canAccess(module: AppModule, action: PermissionAction, roleValue?: string | null, rawPermissions?: unknown): boolean {
    const permissions = permissionMapForUser(roleValue, rawPermissions);
    return Boolean(permissions[module]?.includes(action));
}

export function getPagePermission(pathname: string) {
    const path = pathname || "/";
    return pagePermissions.find((item) => path === item.prefix || path.startsWith(`${item.prefix}/`)) || pagePermissions[pagePermissions.length - 1];
}

export function canAccessPath(pathname: string, roleValue?: string | null, rawPermissions?: unknown): boolean {
    const permission = getPagePermission(pathname);
    return canAccess(permission.module, permission.action, roleValue, rawPermissions);
}
