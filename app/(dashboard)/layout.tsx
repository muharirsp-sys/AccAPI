/*
 * Tujuan: Guard server untuk seluruh route dashboard berdasarkan session Better Auth dan RBAC per halaman.
 * Caller: Semua route di grup `app/(dashboard)`.
 * Dependensi: Better Auth, getUserPermissions (union group ∪ legacy) + getPrimaryGroup (profil, S7-3), helper RBAC, middleware header `x-current-path`.
 * Main Functions: DashboardLayout; meneruskan identitas akun untuk preferensi navigasi terisolasi.
 * Side Effects: Membaca session/permission dan redirect login/dashboard bila akses halaman tidak valid.
 */
import SidebarLayout from "@/components/SidebarLayout";
import ServiceWorkerRegistration from "@/components/ServiceWorkerRegistration";
import PWAInstallPrompt from "@/components/PWAInstallPrompt";
import AccessDenied from "@/components/AccessDenied";
import ChatWidget from "@/components/ChatWidget";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { canAccessPathWithKeys, normalizeRole, rolePermissionPresets } from "@/lib/rbac";
import { getPrimaryGroup, getUserPermissions } from "@/lib/rbac/resolve";
import { isLocalAuthBypassEnabled } from "@/lib/local-dev-auth";

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
    }).catch(() => null);
    const isLocalDev = isLocalAuthBypassEnabled(requestHeaders);

    if (!session && !isLocalDev) {
        redirect("/login");
    }

    const userId = String(session?.user.id || "");
    const role = normalizeRole(isLocalDev ? "admin" : session?.user.role);
    // Union group ∪ legacy — resolver yang sama dengan guard API, agar halaman/sidebar/API sepakat.
    // ★ grup utama (S7-3) hanya memilih profil (label + navigasi bawah); paralel dengan izin, bukan berurutan.
    const [keySet, utama] = isLocalDev
        ? [Object.entries(rolePermissionPresets.admin).flatMap(([moduleName, actions]) => (actions || []).map((action) => `${moduleName}.${action}`)), null]
        : userId ? await Promise.all([getUserPermissions(userId), getPrimaryGroup(userId)]) : [[], null];
    const permKeys = [...keySet];
    const currentPath = requestHeaders.get("x-current-path") || "/";

    const allowed = canAccessPathWithKeys(currentPath, permKeys);

    return (
        <>
            <SidebarLayout localAuthRole={isLocalDev ? role : null} permKeys={permKeys} primaryGroup={utama?.name ?? null} userId={userId || "local"} userName={session?.user.name || "Ruang kerja lokal"}>
                {allowed ? children : <AccessDenied />}
            </SidebarLayout>
            {/* Di luar SidebarLayout: gerbang klien mengganti SELURUH children dengan Akses ditolak, jadi pemasangan PWA/SW tidak ikut hilang
                di halaman terlarang (tinjauan susulan S7-sesi). */}
            <ServiceWorkerRegistration />
            <PWAInstallPrompt />
            <ChatWidget />
        </>
    );
}
