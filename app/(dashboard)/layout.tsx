/*
 * Tujuan: Guard server untuk seluruh route dashboard berdasarkan session Better Auth dan RBAC per halaman.
 * Caller: Semua route di grup `app/(dashboard)`.
 * Dependensi: Better Auth, getUserPermissions (union group ∪ legacy), helper RBAC, middleware header `x-current-path`.
 * Main Functions: DashboardLayout.
 * Side Effects: Membaca session/permission dan redirect login/dashboard bila akses halaman tidak valid.
 */
import SidebarLayout from "@/components/SidebarLayout";
import ServiceWorkerRegistration from "@/components/ServiceWorkerRegistration";
import PWAInstallPrompt from "@/components/PWAInstallPrompt";
import AccessDenied from "@/components/AccessDenied";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { canAccessPathWithKeys, normalizeRole } from "@/lib/rbac";
import { getUserPermissions } from "@/lib/rbac/resolve";

// Session dan RBAC selalu bergantung pada header request; route dashboard tidak boleh diprerender statis.
export const dynamic = "force-dynamic";

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
    const role = normalizeRole(session.user.role);
    // Union group ∪ legacy — resolver yang sama dengan guard API, agar halaman/sidebar/API sepakat.
    const permKeys = userId ? [...await getUserPermissions(userId)] : [];
    const currentPath = requestHeaders.get("x-current-path") || "/";

    const allowed = canAccessPathWithKeys(currentPath, permKeys);

    return (
        <SidebarLayout role={role} permKeys={permKeys}>
            {allowed ? children : <AccessDenied />}
            <ServiceWorkerRegistration />
            <PWAInstallPrompt />
        </SidebarLayout>
    );
}
