/*
 * Tujuan: Guard server untuk halaman User & RBAC.
 * Caller: Next.js App Router route `/admin/users`.
 * Dependensi: Better Auth session, izin efektif grup (getUserPermissions), komponen UserManagement.
 * Main Functions: AdminUsersPage.
 * Side Effects: Redirect login bila tanpa sesi; AccessDenied bila tanpa `users.manage` efektif.
 * Catatan S7-1 (BL-62): gerbang = kunci grup `users.manage` (sama dengan API /api/admin/**), bukan peran lama `role === "admin"`.
 */
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { isLocalAuthBypassEnabled } from "@/lib/local-dev-auth";
import { getUserPermissions } from "@/lib/rbac/resolve";
import AccessDenied from "@/components/AccessDenied";
import UserManagement from "./UserManagement";

export default async function AdminUsersPage() {
    const requestHeaders = await headers();
    const isLocalDev = isLocalAuthBypassEnabled(requestHeaders);
    if (isLocalDev) return <UserManagement />;

    const session = await auth.api.getSession({ headers: requestHeaders });
    if (!session) redirect("/login");

    if (!(await getUserPermissions(session.user.id)).has("users.manage")) {
        return <AccessDenied message="Halaman ini butuh izin kelola user (users.manage)." />;
    }

    return <UserManagement />;
}
