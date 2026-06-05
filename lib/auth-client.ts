/*
 * Tujuan: Client Better Auth untuk login/session/admin RBAC dari React client pages.
 * Caller: Halaman auth, SidebarLayout, dan admin user management.
 * Dependensi: better-auth/react, admin client plugin, roleAccess RBAC.
 * Main Functions: `authClient`.
 * Side Effects: HTTP request browser ke route `/api/auth/*` origin aktif; tidak ada DB/file I/O langsung.
 */
import { createAuthClient } from "better-auth/react";
import { adminClient } from "better-auth/client/plugins";
import { roleAccess } from "./rbac";

export const authClient = createAuthClient({
    baseURL: typeof window !== "undefined" ? window.location.origin : process.env.NEXT_PUBLIC_APP_URL || process.env.BETTER_AUTH_URL || "http://localhost:3000",
    plugins: [
        adminClient({
            roles: roleAccess,
        }),
    ],
});
