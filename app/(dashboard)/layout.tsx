/*
 * Tujuan: Guard server untuk seluruh route dashboard berdasarkan session Better Auth dan RBAC per halaman.
 * Caller: Semua route di grup `app/(dashboard)`.
 * Dependensi: Better Auth, getUserPermissions (union group ∪ legacy) + getPrimaryGroup (profil, S7-3), helper RBAC, middleware header `x-current-path`,
 *   sonner (toaster bergaya token Fiori).
 * Main Functions: DashboardLayout; meneruskan identitas akun untuk preferensi navigasi terisolasi; generateMetadata (judul tab = menu aktif).
 * Side Effects: Membaca session/permission dan redirect login/dashboard bila akses halaman tidak valid; memasang toaster global dashboard.
 */
import type { CSSProperties } from "react";
import type { Metadata } from "next";
import { Toaster } from "sonner";
import { HOME_ITEM, WORKSPACE_GROUPS, activeNavigationItem } from "@/config/workspace-navigation";
import SidebarLayout from "@/components/SidebarLayout";
import ServiceWorkerRegistration from "@/components/ServiceWorkerRegistration";
import PWAInstallPrompt from "@/components/PWAInstallPrompt";
import AccessDenied from "@/components/AccessDenied";
import ChatWidget from "@/components/ChatWidget";
import { fioriClass } from "@/components/fiori/Scope";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { canAccessPathWithKeys, normalizeRole, rolePermissionPresets } from "@/lib/rbac";
import { getPrimaryGroup, getUserPermissions } from "@/lib/rbac/resolve";
import { isLocalAuthBypassEnabled } from "@/lib/local-dev-auth";

// Session dan RBAC selalu bergantung pada header request; route dashboard tidak boleh diprerender statis.
export const dynamic = "force-dynamic";

// Warna sonner (richColors) diarahkan ke token Fiori; nilainya mengikuti mode terang/gelap dari pembungkus .fiori.
const TOAST_TOKEN = {
    "--normal-bg": "var(--surface)", "--normal-text": "var(--ink)", "--normal-border": "var(--line-strong)",
    "--success-bg": "var(--pos-bg)", "--success-text": "var(--pos)", "--success-border": "var(--pos-bg)",
    "--error-bg": "var(--neg-bg)", "--error-text": "var(--neg)", "--error-border": "var(--neg-bg)",
    "--warning-bg": "var(--warn-bg)", "--warning-text": "var(--warn)", "--warning-border": "var(--warn-bg)",
    // ponytail: nama --info-bg dipakai sonner DAN token Fiori; var(--info-bg) di sini merujuk dirinya sendiri (nilai kosong), jadi diturunkan dari --info.
    "--info-bg": "color-mix(in srgb, var(--info) 10%, var(--surface))", "--info-text": "var(--info)", "--info-border": "color-mix(in srgb, var(--info) 10%, var(--surface))",
    fontFamily: "var(--font-sans)", // sonner memasang font sistem sendiri pada toaster
} as CSSProperties;

// Judul tab dari menu aktif ("Antrean Faktur · Ruang Kerja SP") supaya banyak tab bisa dibedakan, tanpa metadata per halaman.
// Dinilai ulang tiap navigasi (metadata seluruh pohon rute di-resolve per permintaan); hanya label menu, bukan cek izin.
export async function generateMetadata(): Promise<Metadata> {
    const path = (await headers()).get("x-current-path") || "/";
    const item = activeNavigationItem(path, [HOME_ITEM, ...WORKSPACE_GROUPS.flatMap((group) => group.items)]);
    return { title: item ? `${item.name} · Ruang Kerja SP` : "Ruang Kerja SP" };
}

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
            {/* permKeys hanya menyaring tautan bantuan yang ditampilkan; izin tetap diperiksa server. */}
            <ChatWidget permKeys={permKeys} />
            {/* display:contents: pembungkus hanya mewariskan token dan font Fiori ke toaster, tanpa kotak sendiri. */}
            <div className={`${fioriClass} contents`}>
                <Toaster position="top-right" richColors style={TOAST_TOKEN} />
            </div>
        </>
    );
}
