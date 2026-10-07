/*
 * Tujuan: Shell Fiori ruang kerja: shell bar (logo resmi, cari menu Ctrl K, menu profil), navigasi samping dari izin,
 *   drawer + navigasi bawah ponsel per peran.
 * Caller: app/(dashboard)/layout.tsx.
 * Dependensi: Better Auth client, RBAC, katalog workspace-navigation, components/fiori (token, SchemeSwitcher), ChatWidget (Bantuan).
 * Main Functions: SidebarLayout, useLocalAuthRole; drawer menutup saat kembali ke desktop.
 * Side Effects: Navigasi, sign-out, membuka chat bantuan; preferensi mode/density lewat SchemeSwitcher.
 */
"use client";
import { createContext, Fragment, useContext, useEffect, useId, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { LifeBuoy, LogOut, Menu, Search, X } from "lucide-react";
import { authClient } from "@/lib/auth-client";
import { canAccessPathWithKeys } from "@/lib/rbac";
import { HOME_ITEM, activeNavigationItem, navigationForPermissions, roleProfile, roleShortcuts, type WorkspaceGroup, type WorkspaceItem } from "@/config/workspace-navigation";
import { fioriClass } from "@/components/fiori/Scope";
import { SchemeSwitcher } from "@/components/fiori/interactive";
import Dialog from "@/components/ui/Dialog";
import { OPEN_HELP_EVENT } from "@/components/ChatWidget";

const LocalAuthRoleContext = createContext<string | null>(null);
export function useLocalAuthRole() { return useContext(LocalAuthRoleContext); }

type ShellProps = { children: React.ReactNode; localAuthRole?: string | null; permKeys: string[]; userName?: string; userId?: string };

export default function SidebarLayout({ children, localAuthRole, permKeys, userName = "Akun" }: ShellProps) {
    const pathname = usePathname();
    const keys = useMemo(() => new Set(permKeys), [permKeys]);
    const groups = navigationForPermissions(href => canAccessPathWithKeys(href, keys));
    const items = groups.flatMap(group => group.items);
    const home = canAccessPathWithKeys("/", keys) ? [HOME_ITEM] : [];
    const active = activeNavigationItem(pathname, [...home, ...items]);
    const roleLabel = roleProfile(keys)?.label ?? "CV. Surya Perkasa";
    const [drawerOpen, setDrawerOpen] = useState(false);
    // Tutup drawer pada setiap pindah rute (klik tautan, Back, router.push) — disesuaikan saat render, bukan di effect.
    const [drawerPath, setDrawerPath] = useState(pathname);
    if (drawerPath !== pathname) { setDrawerPath(pathname); setDrawerOpen(false); }
    const avatarRef = useRef<HTMLButtonElement>(null);
    const drawerTitle = useId();
    const initials = userName.trim().split(/\s+/).slice(0, 2).map(part => part[0]).join("").toUpperCase();

    useEffect(() => {
        const desktop = window.matchMedia("(min-width: 768px)");
        const closeOnDesktop = () => { if (desktop.matches) setDrawerOpen(false); };
        desktop.addEventListener("change", closeOnDesktop);
        return () => desktop.removeEventListener("change", closeOnDesktop);
    }, []);

    const nav = (label: string, onNavigate?: () => void) => (
        <SideNav label={label} home={home} groups={groups} activeHref={active?.href} userName={userName} roleLabel={roleLabel} onNavigate={onNavigate} />
    );

    return <div className="fi-shell">
        <a className={`${fioriClass} fi-skip`} href="#workspace-content">Langsung ke konten</a>
        <header className={`${fioriClass} fi-shellbar`}>
            <button type="button" className="fi-btn fi-btn--icon fi-shell-menubtn" aria-label="Buka menu navigasi" aria-expanded={drawerOpen} onClick={() => setDrawerOpen(true)}>
                <Menu className="fi-icon" aria-hidden />
            </button>
            <Link href="/" prefetch={false} className="fi-logo" aria-label="CV. Surya Perkasa, ke Beranda" />
            <span className="fi-apptitle">Ruang Kerja</span>
            <button type="button" className="fi-shell-search" popoverTarget="fi-menu-search" aria-keyshortcuts="Control+K">
                <Search className="fi-icon" aria-hidden /><span>Cari menu…</span><kbd className="fi-kbd">Ctrl K</kbd>
            </button>
            <div className="fi-shell-acts">
                <button type="button" className="fi-btn fi-btn--icon fi-shell-searchbtn" popoverTarget="fi-menu-search" aria-label="Cari menu">
                    <Search className="fi-icon" aria-hidden />
                </button>
                <button ref={avatarRef} type="button" className="fi-btn fi-btn--icon fi-btn--avatar" popoverTarget="fi-menu-profile" aria-label={`Menu profil ${userName}`}>
                    <span className="fi-avatar" aria-hidden>{initials}</span>
                </button>
            </div>
            <MenuSearch id="fi-menu-search" groups={groups} home={home} />
            <div id="fi-menu-profile" popover="auto" role="dialog" aria-label="Menu profil" className="fi-menu">
                <div className="fi-menu-prof"><span className="fi-avatar" aria-hidden>{initials}</span><div><b>{userName}</b><small>{roleLabel}</small></div></div>
                <hr />
                <div className="fi-menu-row"><SchemeSwitcher /></div>
                <hr />
                <button type="button" className="fi-menu-item" popoverTarget="fi-menu-profile" popoverTargetAction="hide" onClick={() => window.dispatchEvent(new CustomEvent(OPEN_HELP_EVENT, { detail: { returnFocus: avatarRef.current } }))}>
                    <LifeBuoy className="fi-icon" aria-hidden /><b>Bantuan</b><small>Asisten dan panduan</small>
                </button>
                <button type="button" className="fi-menu-item" onClick={async () => { await authClient.signOut().catch(() => undefined); window.location.href = "/login"; }}>
                    <LogOut className="fi-icon" aria-hidden /><b>Keluar</b><small>Akhiri sesi</small>
                </button>
            </div>
        </header>
        {nav("Menu ruang kerja")}
        <Dialog open={drawerOpen} onClose={() => setDrawerOpen(false)} labelledBy={drawerTitle} className={`${fioriClass} fi-drawer`} closeOnBackdrop>
            <div className="fi-drawer-head">
                <h2 id={drawerTitle} className="fi-title-3">Menu</h2>
                <button type="button" className="fi-btn fi-btn--icon" aria-label="Tutup menu" onClick={() => setDrawerOpen(false)}><X className="fi-icon" aria-hidden /></button>
            </div>
            {drawerOpen && nav("Menu mobile", () => setDrawerOpen(false))}
        </Dialog>
        <main id="workspace-content" tabIndex={-1} className="fi-shell-main">
            <LocalAuthRoleContext.Provider value={localAuthRole ?? null}>{children}</LocalAuthRoleContext.Provider>
        </main>
        <nav className={`${fioriClass} fi-bnav`} aria-label="Navigasi utama">
            {[...home, ...roleShortcuts(keys, items)].map(item => {
                const Icon = item.icon;
                return <Link key={item.href} href={item.href} prefetch={false} title={item.name} aria-current={active?.href === item.href ? "page" : undefined}>
                    <Icon className="fi-icon" aria-hidden /><span>{item.short ?? item.name.split(" ")[0]}</span>
                </Link>;
            })}
            <button type="button" aria-expanded={drawerOpen} onClick={() => setDrawerOpen(true)}><Menu className="fi-icon" aria-hidden /><span>Menu</span></button>
        </nav>
    </div>;
}

function SideNav({ label, home, groups, activeHref, userName, roleLabel, onNavigate }: {
    label: string; home: WorkspaceItem[]; groups: WorkspaceGroup[]; activeHref?: string; userName: string; roleLabel: string; onNavigate?: () => void;
}) {
    const link = (item: WorkspaceItem) => {
        const Icon = item.icon;
        return <Link key={item.href} href={item.href} prefetch={false} onClick={onNavigate} aria-current={activeHref === item.href ? "page" : undefined}>
            <Icon className="fi-icon" aria-hidden />{item.name}
        </Link>;
    };
    return <nav className={`${fioriClass} fi-sidenav`} aria-label={label}>
        {home.map(link)}
        {groups.map(group => <Fragment key={group.id}>
            <p className="fi-sidenav-grp">{group.name}</p>
            {group.items.map(link)}
        </Fragment>)}
        {!home.length && !groups.length && <p className="fi-small fi-subtle">Belum ada modul yang dapat diakses. Hubungi admin.</p>}
        <p className="fi-sidenav-foot"><b>{userName}</b>{roleLabel}</p>
    </nav>;
}

/** Cari menu (Ctrl K). Pencarian nomor dokumen lintas modul menyusul lewat tracker AM; sampai itu hanya katalog menu yang sudah tersaring izin. */
function MenuSearch({ id, groups, home }: { id: string; groups: WorkspaceGroup[]; home: WorkspaceItem[] }) {
    const [query, setQuery] = useState("");
    const ref = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    const listRef = useRef<HTMLUListElement>(null);
    const router = useRouter();
    const entries = [...home.map(item => ({ item, group: "Beranda" })), ...groups.flatMap(group => group.items.map(item => ({ item, group: group.name })))];
    const q = query.trim().toLocaleLowerCase("id-ID");
    const hits = q ? entries.filter(entry => `${entry.group} ${entry.item.name}`.toLocaleLowerCase("id-ID").includes(q)) : entries;

    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            // OPC punya quick jump sendiri (Ctrl K) dan memanggil preventDefault; shell mengalah di sana.
            // Selama dialog modal terbuka, shell bar inert: popover akan tampil tapi tak bisa dipakai.
            if ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === "k" && !event.defaultPrevented && !document.querySelector("dialog:modal")) {
                event.preventDefault();
                ref.current?.showPopover();
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, []);

    const close = () => { ref.current?.hidePopover(); setQuery(""); };
    return <div id={id} ref={ref} popover="auto" role="dialog" aria-label="Cari menu" className="fi-menu fi-menu--search"
        onToggle={(event) => { if ((event.nativeEvent as ToggleEvent).newState === "open") inputRef.current?.focus(); else setQuery(""); }}>
        <div className="fi-menu-q">
            <input ref={inputRef} className="fi-input" type="search" aria-label="Cari menu" aria-controls={hits.length ? `${id}-list` : undefined} placeholder="Ketik nama menu" value={query}
                onChange={event => setQuery(event.target.value)}
                onKeyDown={event => {
                    if (event.key === "Enter" && hits[0]) { event.preventDefault(); close(); router.push(hits[0].item.href); }
                    if (event.key === "ArrowDown") { event.preventDefault(); listRef.current?.querySelector("a")?.focus(); }
                }} />
        </div>
        <h2>Menu</h2>
        {hits.length ? (
            <ul id={`${id}-list`} ref={listRef} onKeyDown={event => {
                if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
                event.preventDefault();
                const links = [...(listRef.current?.querySelectorAll("a") ?? [])];
                const next = links.indexOf(document.activeElement as HTMLAnchorElement) + (event.key === "ArrowDown" ? 1 : -1);
                if (next < 0) inputRef.current?.focus(); else links[Math.min(next, links.length - 1)]?.focus();
            }}>
                {hits.map(({ item, group }) => {
                    const Icon = item.icon;
                    return <li key={item.href}><Link href={item.href} prefetch={false} className="fi-menu-item" onClick={close}><Icon className="fi-icon" aria-hidden /><b>{item.name}</b><small>{group}</small></Link></li>;
                })}
            </ul>
        ) : <p className="fi-menu-row fi-small" role="status">Menu “{query.trim()}” tidak ditemukan.</p>}
        <p className="fi-menu-note">Saat ini mencari nama menu. Pencarian nomor dokumen dan pelanggan menyusul.</p>
    </div>;
}
