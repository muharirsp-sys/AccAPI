import { defaultAc } from "better-auth/plugins/admin/access";

export const appRoles = ["admin", "manager", "staff", "viewer"] as const;
export type AppRole = (typeof appRoles)[number];

export const roleLabels: Record<AppRole, string> = {
    admin: "Admin",
    manager: "Manager",
    staff: "Staff",
    viewer: "Viewer",
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

export function isAppRole(value: string): value is AppRole {
    return appRoles.includes(value as AppRole);
}

export function normalizeRole(value?: string | null): AppRole {
    return value && isAppRole(value) ? value : defaultRole;
}
