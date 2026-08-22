/*
 * Tujuan: Guard server untuk halaman User & RBAC.
 * Caller: Next.js App Router route `/admin/users`.
 * Dependensi: Better Auth session dan komponen UserManagement.
 * Main Functions: AdminUsersPage.
 * Side Effects: Redirect login/dashboard bila session atau role admin tidak valid.
 */
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { isLocalAuthBypassEnabled } from "@/lib/local-dev-auth";
import AccessDenied from "@/components/AccessDenied";
import UserManagement from "./UserManagement";

export default async function AdminUsersPage() {
    const requestHeaders = await headers();
    const session = await auth.api.getSession({ headers: requestHeaders });
    const isLocalDev = isLocalAuthBypassEnabled(requestHeaders);
    if (!session && !isLocalDev) {
        redirect("/login");
    }

    if (!isLocalDev && session?.user.role !== "admin") {
        return <AccessDenied message="Halaman ini khusus untuk admin." />;
    }

    return <UserManagement />;
}
