/*
 * Tujuan: Shell ruang kerja dengan sidebar accordion, favorit, breadcrumb, dan drawer mobile.
 * Caller: app/(dashboard)/layout.tsx.
 * Dependensi: Better Auth, RBAC, WorkspaceNavigation, ThemeSwitcher, katalog navigasi.
 * Main Functions: SidebarLayout, useLocalAuthRole; drawer menutup saat kembali ke desktop.
 * Side Effects: Membaca/menyimpan preferensi sidebar lokal, navigasi, dan sign-out.
 */
"use client";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { Menu, LogOut, PanelLeftClose, PanelLeftOpen, Sun, X } from "lucide-react";
import { authClient } from "@/lib/auth-client";
import { usePathname } from "next/navigation";
import Link from "next/link";
import { canAccessPathWithKeys } from "@/lib/rbac";
import { HOME_ITEM, activeNavigationItem, navigationForPermissions } from "@/config/workspace-navigation";
import WorkspaceNavigation from "@/components/WorkspaceNavigation";
import ThemeSwitcher from "@/components/ThemeSwitcher";

const LocalAuthRoleContext = createContext<string | null>(null);
export function useLocalAuthRole() { return useContext(LocalAuthRoleContext); }
const EXPANDED_KEY = "smart-erp:sidebar-expanded";

export default function SidebarLayout({ children, localAuthRole, permKeys, userName = "Akun", userId = "local" }: {
    children: React.ReactNode; localAuthRole?: string | null; permKeys: string[]; userName?: string; userId?: string;
}) {
    const pathname = usePathname();
    const [expanded, setExpanded] = useState(true);
    const [hydrated, setHydrated] = useState(false);
    const [mobileOpen, setMobileOpen] = useState(false);
    const dialogRef = useRef<HTMLDialogElement>(null);
    const menuRef = useRef<HTMLButtonElement>(null);
    const canAccess = (href: string) => canAccessPathWithKeys(href, permKeys);
    const groups = navigationForPermissions(canAccess);
    const items = groups.flatMap(group => group.items);
    const active = activeNavigationItem(pathname, [HOME_ITEM, ...items]);
    const activeGroup = groups.find(group => group.items.some(item => item.href === active?.href));
    const favoritesKey = `surya:nav-favorites:${userId}`;
    const initials = userName.trim().split(/\s+/).slice(0, 2).map(part => part[0]).join("").toUpperCase();

    useEffect(() => {
        const frame = requestAnimationFrame(() => {
            try { setExpanded(localStorage.getItem(EXPANDED_KEY) !== "false"); } catch { /* Browser privacy mode: expanded default. */ }
            setHydrated(true);
        });
        return () => cancelAnimationFrame(frame);
    }, []);
    useEffect(() => {
        const dialog = dialogRef.current;
        if (mobileOpen && dialog && !dialog.open) dialog.showModal();
        if (!mobileOpen && dialog?.open) dialog.close();
    }, [mobileOpen]);
    useEffect(() => {
        const desktop = window.matchMedia("(min-width: 768px)");
        const closeOnDesktop = () => { if (desktop.matches) setMobileOpen(false); };
        desktop.addEventListener("change", closeOnDesktop);
        return () => desktop.removeEventListener("change", closeOnDesktop);
    }, []);
    const changeExpanded = (value: boolean) => {
        setExpanded(value);
        try { localStorage.setItem(EXPANDED_KEY, String(value)); } catch { /* Session preference still works. */ }
    };
    const closeMobile = () => { setMobileOpen(false); menuRef.current?.focus(); };
    const handleSignOut = async () => {
        await authClient.signOut().catch(() => undefined);
        window.location.href = "/login";
    };
    const brand = <span className="workspace-wordmark"><Sun size={28} strokeWidth={1.6} aria-hidden="true" /><span>surya<small>PERKASA</small></span></span>;
    const navProps = { groups, pathname, homeVisible: canAccess("/"), storageKey: favoritesKey };
    return <div className="workspace-shell" data-sidebar-expanded={expanded}>
        <a className="workspace-skip" href="#workspace-content">Langsung ke konten</a>
        <aside className="workspace-sidebar" aria-label="Sidebar">
            <div className="workspace-brand-row">{expanded ? brand : <Sun size={25} aria-label="Surya Perkasa" />}
                <button type="button" disabled={!hydrated} className="workspace-icon-button" onClick={() => changeExpanded(!expanded)} aria-label="Buka/tutup sidebar" aria-expanded={expanded}>{expanded ? <PanelLeftClose size={17} /> : <PanelLeftOpen size={17} />}</button>
            </div>
            <nav className="workspace-nav" aria-label="Menu ruang kerja"><WorkspaceNavigation {...navProps} collapsed={!expanded} onNavigate={() => {}} onExpand={() => changeExpanded(true)} /></nav>
            <div className="workspace-account"><span className="workspace-avatar">{initials}</span>{expanded && <div><strong>{userName}</strong><span>CV. Surya Perkasa</span></div>}</div>
        </aside>
        <dialog ref={dialogRef} className="workspace-drawer" aria-label="Menu navigasi" onCancel={closeMobile} onClose={() => setMobileOpen(false)} onClick={event => { if (event.target === dialogRef.current) closeMobile(); }}>
            <div className="workspace-drawer-inner"><div className="workspace-brand-row">{brand}<button type="button" className="workspace-icon-button" aria-label="Tutup menu" onClick={closeMobile}><X size={19} /></button></div>
                <nav className="workspace-nav" aria-label="Menu mobile"><WorkspaceNavigation {...navProps} onNavigate={closeMobile} onExpand={() => {}} /></nav>
            </div>
        </dialog>
        <div className="workspace-body">
            <header className="workspace-topbar">
                <div className="workspace-breadcrumb"><button ref={menuRef} type="button" disabled={!hydrated} className="workspace-mobile-menu workspace-icon-button" aria-label="Buka menu navigasi" aria-expanded={mobileOpen} onClick={() => setMobileOpen(true)}><Menu size={21} /></button><span className="workspace-breadcrumb-parent">{activeGroup?.name || "Ruang kerja"}</span><span aria-hidden="true" className="workspace-breadcrumb-parent">/</span><strong>{active?.name || "Ruang kerja"}</strong></div>
                <div className="workspace-top-actions"><span className="workspace-company">CV. Surya Perkasa</span><ThemeSwitcher /><button type="button" className="workspace-icon-button" onClick={handleSignOut} title="Keluar" aria-label="Keluar"><LogOut size={18} /></button></div>
            </header>
            <main id="workspace-content" tabIndex={-1} className="workspace-content"><LocalAuthRoleContext.Provider value={localAuthRole ?? null}>{children}</LocalAuthRoleContext.Provider></main>
            <nav aria-label="Navigasi utama" className="workspace-bottom-nav">
                {[...(canAccess("/") ? [HOME_ITEM] : []), ...["/summary", "/faktur", "/rekapan-nota"].map(href => items.find(item => item.href === href)).filter(item => Boolean(item))].map(item => {
                    if (!item) return null;
                    const Icon = item.icon;
                    return <Link key={item.href} href={item.href} prefetch={false} aria-label={item.name} aria-current={active?.href === item.href ? "page" : undefined}><Icon size={19} /><span>{item.name.split(" ")[0]}</span></Link>;
                })}
                <button type="button" disabled={!hydrated} onClick={() => setMobileOpen(true)} aria-label="Semua menu"><Menu size={20} /><span>Menu</span></button>
            </nav>
        </div>
    </div>;
}
