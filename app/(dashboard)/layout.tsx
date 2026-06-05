/*
 * Tujuan: Guard server untuk seluruh route dashboard berdasarkan session Better Auth dan RBAC per halaman.
 * Caller: Semua route di grup `app/(dashboard)`.
 * Dependensi: Better Auth, Drizzle SQLite user, helper RBAC, middleware header `x-current-path`.
 * Main Functions: DashboardLayout.
 * Side Effects: Redirect login/dashboard bila session atau permission halaman tidak valid.
 */
import SidebarLayout from "@/components/SidebarLayout";
import ServiceWorkerRegistration from "@/components/ServiceWorkerRegistration";
import PWAInstallPrompt from "@/components/PWAInstallPrompt";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { user } from "@/db/schema";
import { canAccessPath, normalizeRole } from "@/lib/rbac";

export default async function DashboardLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    const requestHeaders = await headers();
    const session = await auth.api.getSession({
        headers: requestHeaders
    });

    if (!session) {
        redirect("/login");
    }

    const userId = String(session.user.id || "");
    const [dbUser] = userId
        ? await db.select({ role: user.role, permissions: user.permissions }).from(user).where(eq(user.id, userId)).limit(1)
        : [];
    const role = normalizeRole(dbUser?.role || session.user.role);
    const permissions = dbUser?.permissions || "{}";
    const currentPath = requestHeaders.get("x-current-path") || "/";

    if (!canAccessPath(currentPath, role, permissions)) {
        redirect("/");
    }

    return (
        <SidebarLayout role={role} permissions={permissions}>
            {children}
            <ServiceWorkerRegistration />
            <PWAInstallPrompt />
        </SidebarLayout>
    );
}
