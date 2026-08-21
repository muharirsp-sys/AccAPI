// Tujuan: Shell navigasi utama dashboard Smart ERP dengan filtering navigasi berdasarkan RBAC dan satu pintu fitur Accurate.
// Caller: `app/(dashboard)/layout.tsx`.
// Dependensi: `authClient`, pathname Next.js, ikon `lucide-react`, helper RBAC, ThemeSwitcher.
// Main Functions: `SidebarLayout`, `handleSignOut`.
// Side Effects: Sign-out Better Auth dan navigasi browser; tidak melakukan DB/file I/O langsung.
"use client";

import { useEffect, useLayoutEffect, useState } from "react";
import { Menu, Home, Database, Server, LogOut, Percent, CalendarCheck2, DollarSign, Wallet, Settings2, FileText, Shield, ShieldCheck, ClipboardCheck, ReceiptText, Trophy, ClipboardList, History, Send, GitCompareArrows, X } from "lucide-react";
import { authClient } from "@/lib/auth-client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { canAccessPathWithKeys } from "@/lib/rbac";
import ThemeSwitcher from "@/components/ThemeSwitcher";

const SIDEBAR_STORAGE_KEY = "smart-erp:sidebar-expanded";
type SidebarTooltip = { label: string; top: number } | null;

export function parseSidebarExpanded(value: string | null): boolean {
    if (value === "true") return true;
    if (value === "false") return false;
    return true;
}

export function persistSidebarExpanded(
    storage: Pick<Storage, "setItem">,
    expanded: boolean,
    hydrated: boolean,
): boolean {
    if (!hydrated) return false;
    try {
        storage.setItem(SIDEBAR_STORAGE_KEY, String(expanded));
        return true;
    } catch {
        return false;
    }
}

export function scheduleSidebarHydration(
    scheduleFrame: (callback: () => void) => number,
    cancelFrame: (frame: number) => void,
    hydrate: () => void,
): () => void {
    const frame = scheduleFrame(hydrate);
    return () => cancelFrame(frame);
}

export function selectSidebarTooltip(hovered: SidebarTooltip, focused: SidebarTooltip): SidebarTooltip {
    return hovered ?? focused;
}

export function getSidebarNavClasses(
    collapsed: boolean,
    isDesktop: boolean,
    active: boolean,
    motionReady = true,
) {
    return {
        link: isDesktop
            ? `relative flex items-center px-3 py-2.5 rounded-lg group transition-[background-color,color,transform] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] hover:bg-indigo-500/20 hover:text-indigo-300 focus-visible:bg-indigo-500/20 focus-visible:text-indigo-300 before:absolute before:left-0 before:top-2 before:bottom-2 before:w-1 before:rounded-r-full before:bg-[var(--luxury-gold)] before:transition-[opacity,transform] before:duration-200 before:ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none motion-reduce:transform-none motion-reduce:before:transition-none motion-reduce:before:transform-none ${
                collapsed ? "" : "hover:translate-x-[3px] focus-visible:translate-x-[3px]"
            } ${active
                ? "bg-indigo-500/20 text-indigo-300 before:scale-y-100 before:opacity-100"
                : "text-slate-300 before:scale-y-50 before:opacity-0"
            }`
            : `flex items-center py-2.5 hover:bg-indigo-500/20 hover:text-indigo-300 rounded-lg transition-colors group ${
                collapsed ? "justify-center" : "px-3"
            } ${active ? "bg-indigo-500/20 text-indigo-300" : "text-slate-300"}`,
        icon: isDesktop
            ? `min-w-[20px] transition-transform duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] group-hover:scale-[1.04] group-focus-visible:scale-[1.04] motion-reduce:transition-none motion-reduce:transform-none ${collapsed && active ? "sidebar-active-icon" : ""}`
            : "min-w-[20px]",
        iconStrokeWidth: isDesktop && collapsed && active ? 2.5 : undefined,
        label: isDesktop
            ? `overflow-hidden whitespace-nowrap text-sm font-medium transition-[margin,max-width,opacity,transform] ${motionReady ? "duration-[280ms]" : "duration-0"} ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none motion-reduce:transform-none ${
                collapsed
                    ? "ml-0 max-w-0 -translate-x-2 opacity-0"
                    : "ml-3 max-w-[180px] translate-x-0 opacity-100"
            }`
            : collapsed ? null : "ml-3 text-sm font-medium whitespace-nowrap",
    };
}

export default function SidebarLayout({ children, permKeys }: { children: React.ReactNode; role?: string | null; permKeys: string[] }) {
    // Desktop: sidebar collapse/expand. Mobile: drawer open/close (hamburger).
    const [isSidebarOpen, setIsSidebarOpen] = useState(true);
    const [isSidebarHydrated, setIsSidebarHydrated] = useState(false);
    const [isMobileOpen, setIsMobileOpen] = useState(false);
    const [hoveredSidebarTooltip, setHoveredSidebarTooltip] = useState<SidebarTooltip>(null);
    const [focusedSidebarTooltip, setFocusedSidebarTooltip] = useState<SidebarTooltip>(null);
    const pathname = usePathname();
    const visibleSidebarTooltip = !isSidebarOpen
        ? selectSidebarTooltip(hoveredSidebarTooltip, focusedSidebarTooltip)
        : null;

    useLayoutEffect(() => {
        let expanded = true;
        try {
            expanded = parseSidebarExpanded(window.localStorage.getItem(SIDEBAR_STORAGE_KEY));
        } catch {
            // Access ke localStorage dapat ditolak; default tetap expanded.
        }
        // eslint-disable-next-line react-hooks/set-state-in-effect -- Terapkan lebar tersimpan sebelum paint pertama.
        setIsSidebarOpen(expanded);

        return scheduleSidebarHydration(
            (callback) => window.requestAnimationFrame(callback),
            (frame) => window.cancelAnimationFrame(frame),
            () => setIsSidebarHydrated(true),
        );
    }, []);

    useEffect(() => {
        try {
            persistSidebarExpanded(window.localStorage, isSidebarOpen, isSidebarHydrated);
        } catch {
            // Access ke object localStorage sendiri dapat ditolak oleh browser.
        }
    }, [isSidebarHydrated, isSidebarOpen]);

    const handleSignOut = async () => {
        await authClient.signOut({
            fetchOptions: {
                onSuccess: () => {
                    window.location.href = "/login";
                },
            },
        }).catch(() => {
            window.location.href = "/login";
        });
    };

    const allNavItems = [
        { name: "Dashboard", icon: Home, href: "/" },
        { name: "AOL Form Engine", icon: Settings2, href: "/api-wrapper" },
        { name: "Validator Diskon", icon: Percent, href: "/validator" },
        { name: "Summary Promo", icon: CalendarCheck2, href: "/summary" },
        { name: "Finance", icon: DollarSign, href: "/finance" },
        { name: "Insentif Sales", icon: Trophy, href: "/insentif-sales" },
        { name: "Laporan Harian", icon: Send, href: "/laporan-harian" },
        { name: "Form Kontrol", icon: ClipboardList, href: "/form-kontrol" },
        { name: "Pembayaran / SPPD", icon: Wallet, href: "/payments" },
        { name: "Format SPPD", icon: FileText, href: "/payments/sppd" },
        { name: "Rekonsiliasi", icon: GitCompareArrows, href: "/reconciliation" },
        { name: "OFF Program Control", icon: ClipboardCheck, href: "/off-program-control" },
        { name: "Claim Workflow", icon: ReceiptText, href: "/claim-workflow" },
        { name: "Faktur Penjualan", icon: ReceiptText, href: "/faktur" },
        { name: "History Penjualan", icon: History, href: "/sales-history" },
        { name: "Master Principle", icon: Database, href: "/principles" },
        { name: "User & RBAC", icon: Shield, href: "/admin/users" },
        { name: "Kelola Akses Group", icon: ShieldCheck, href: "/admin/groups" },
    ];
    const navItems = allNavItems.filter((item) => canAccessPathWithKeys(item.href, permKeys));
    const activeHref = navItems
        .filter((item) => pathname === item.href || (item.href !== "/" && pathname.startsWith(item.href)))
        .sort((a, b) => b.href.length - a.href.length)[0]?.href;
    const isActive = (href: string) => href === activeHref;

    const getSidebarTooltip = (label: string, element: HTMLElement): Exclude<SidebarTooltip, null> => {
        const rect = element.getBoundingClientRect();
        const top = Math.min(Math.max(rect.top + rect.height / 2, 32), window.innerHeight - 32);
        return { label, top };
    };

    const clearSidebarTooltips = () => {
        setHoveredSidebarTooltip(null);
        setFocusedSidebarTooltip(null);
    };

    const renderNavList = (collapsed: boolean, surface: "desktop" | "mobile") => {
        const isDesktop = surface === "desktop";
        return (
        <ul className="space-y-1 px-2">
            {navItems.map((item) => {
                const Icon = item.icon;
                const active = isActive(item.href);
                const classes = getSidebarNavClasses(collapsed, isDesktop, active, isSidebarHydrated);
                return (
                    <li key={item.name}>
                        <Link
                            href={item.href}
                            onClick={(event) => {
                                setIsMobileOpen(false);
                                if (
                                    isDesktop &&
                                    !event.ctrlKey &&
                                    !event.metaKey &&
                                    !event.shiftKey &&
                                    !event.altKey
                                ) {
                                    clearSidebarTooltips();
                                    if (!collapsed) {
                                        persistSidebarExpanded(window.localStorage, false, true);
                                        setIsSidebarOpen(false);
                                    }
                                }
                            }}
                            aria-current={active ? "page" : undefined}
                            aria-label={collapsed ? item.name : undefined}
                            className={classes.link}
                            {...(isDesktop && collapsed ? {
                                onMouseEnter: (event: React.MouseEvent<HTMLAnchorElement>) => setHoveredSidebarTooltip(getSidebarTooltip(item.name, event.currentTarget)),
                                onMouseLeave: () => setHoveredSidebarTooltip(null),
                                onFocus: (event: React.FocusEvent<HTMLAnchorElement>) => setFocusedSidebarTooltip(getSidebarTooltip(item.name, event.currentTarget)),
                                onBlur: () => setFocusedSidebarTooltip(null),
                            } : {})}
                        >
                            <Icon
                                size={20}
                                strokeWidth={classes.iconStrokeWidth}
                                className={classes.icon}
                                aria-hidden="true"
                            />
                            {classes.label && <span className={classes.label}>{item.name}</span>}
                        </Link>
                    </li>
                );
            })}
        </ul>
        );
    };

    return (
        <div className="flex h-dvh overflow-hidden">
            {/* Sidebar desktop (md+) */}
            <aside
                className={`hidden md:flex transition-[width] ${isSidebarHydrated ? "duration-[280ms]" : "duration-0"} ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none ${
                    isSidebarOpen ? "w-64" : "w-[60px]"
                } bg-[#1a1c23]/80 backdrop-blur-xl border-r border-white/5 shadow-sm flex-col z-20`}
            >
                <div className="relative h-16 flex items-center px-4">
                    <div className={`flex items-center gap-2 overflow-hidden whitespace-nowrap transition-[max-width,opacity,transform] ${isSidebarHydrated ? "duration-[280ms]" : "duration-0"} ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none motion-reduce:transform-none ${
                        isSidebarOpen
                            ? "max-w-[180px] translate-x-0 opacity-100"
                            : "max-w-0 -translate-x-2 opacity-0"
                    }`}>
                            <Server className="text-indigo-500" size={24} aria-hidden="true" />
                            <span className="font-bold text-lg text-white truncate">Smart ERP</span>
                    </div>
                    <button
                        onClick={() => {
                            clearSidebarTooltips();
                            setIsSidebarOpen(!isSidebarOpen);
                        }}
                        className="absolute right-4 p-1 hover:bg-white/10 focus-visible:bg-white/10 rounded-md transition-colors"
                        aria-label="Buka/tutup sidebar"
                        aria-expanded={isSidebarOpen}
                    >
                        <Menu size={20} className="text-slate-300" aria-hidden="true" />
                    </button>
                </div>

                <nav
                    className={`flex-1 overflow-y-auto py-4 overflow-x-hidden ${
                        !isSidebarOpen ? "[scrollbar-width:none] [&::-webkit-scrollbar]:hidden" : ""
                    }`}
                    onScroll={clearSidebarTooltips}
                >
                    {renderNavList(!isSidebarOpen, "desktop")}
                </nav>
            </aside>

            <div
                role="tooltip"
                aria-hidden={!visibleSidebarTooltip}
                style={{ top: visibleSidebarTooltip?.top ?? 0 }}
                className={`pointer-events-none fixed left-[68px] z-[80] hidden -translate-y-1/2 rounded-lg border border-white/10 bg-[#1a1c23]/95 px-3 py-2 text-xs font-semibold text-[#f8fafc] shadow-xl backdrop-blur-md transition-[opacity,transform] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] md:block motion-reduce:transition-none ${
                    visibleSidebarTooltip ? "translate-x-0 opacity-100" : "-translate-x-1 opacity-0"
                }`}
            >
                {visibleSidebarTooltip?.label ?? ""}
            </div>

            {/* Sidebar mobile drawer (< md) */}
            {isMobileOpen && (
                <div className="fixed inset-0 z-[60] md:hidden">
                    <div
                        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
                        onClick={() => setIsMobileOpen(false)}
                        aria-hidden="true"
                    />
                    <aside
                        id="mobile-sidebar"
                        role="dialog"
                        aria-modal="true"
                        aria-label="Menu navigasi"
                        className="absolute left-0 top-0 h-full w-64 bg-[#1a1c23] border-r border-white/5 flex flex-col shadow-xl"
                    >
                        <div className="h-16 flex items-center justify-between px-4">
                            <div className="flex items-center gap-2 overflow-hidden">
                                <Server className="text-indigo-500" size={24} aria-hidden="true" />
                                <span className="font-bold text-lg text-white truncate">Smart ERP</span>
                            </div>
                            <button
                                onClick={() => setIsMobileOpen(false)}
                                className="p-1 hover:bg-white/10 rounded-md transition-colors"
                                aria-label="Tutup menu"
                            >
                                <X size={20} className="text-slate-300" aria-hidden="true" />
                            </button>
                        </div>
                        <nav className="flex-1 overflow-y-auto py-4 overflow-x-hidden">
                            {renderNavList(false, "mobile")}
                        </nav>
                    </aside>
                </div>
            )}

            {/* Main Content Area */}
            <div className="flex-1 flex flex-col min-w-0 bg-black/20">
                {/* Top Header */}
                <header className="h-16 bg-[#1a1c23]/50 backdrop-blur-md border-b border-white/5 flex items-center justify-between px-4 md:px-6 z-50 sticky top-0 shadow-sm">
                    <div className="flex items-center gap-3">
                        <button
                            type="button"
                            onClick={() => setIsMobileOpen(true)}
                            className="rounded-md p-2 text-slate-300 transition-colors hover:bg-white/10 md:hidden"
                            aria-label="Buka menu navigasi"
                            aria-expanded={isMobileOpen}
                            aria-controls="mobile-sidebar"
                        >
                            <Menu size={20} aria-hidden="true" />
                        </button>
                        <span className="text-sm font-medium text-slate-400 hidden sm:inline">Headless Accurate Frontend</span>
                    </div>
                    <div className="flex items-center gap-3">
                        <ThemeSwitcher />
                        <button onClick={handleSignOut} className="text-slate-400 hover:text-red-400 transition-colors" title="Keluar" aria-label="Keluar">
                            <LogOut size={20} aria-hidden="true" />
                        </button>
                        <div className="w-8 h-8 rounded-full bg-indigo-500/20 flex items-center justify-center text-indigo-300 text-sm font-bold shadow-sm">
                            A
                        </div>
                    </div>
                </header>

                {/* Page Content */}
                <main className="flex-1 overflow-y-auto p-4 md:p-6 relative pb-20 md:pb-6">
                    {children}
                </main>

                {/* Mobile floating capsule nav (< md) — swipeable, semua item */}
                <nav aria-label="Navigasi utama" className="md:hidden fixed bottom-5 left-1/2 -translate-x-1/2 z-40 w-[calc(100%-32px)] max-w-sm rounded-2xl bg-[#1a1c23]/90 backdrop-blur-xl border border-white/5 shadow-[0_8px_32px_rgba(0,0,0,0.4)] overflow-hidden">
                    <div className="flex items-center h-14 px-2 overflow-x-auto gap-1" style={{ scrollbarWidth: "none" }}>
                        {navItems.map((item) => {
                            const Icon = item.icon;
                            const active = isActive(item.href);
                            return (
                                <a
                                    key={item.href}
                                    href={item.href}
                                    aria-current={active ? "page" : undefined}
                                    aria-label={item.name}
                                    className={`flex flex-col items-center justify-center gap-0.5 px-3 py-1.5 rounded-xl shrink-0 min-w-[52px] transition-all ${
                                        active ? "text-amber-400" : "text-slate-500 hover:text-slate-300"
                                    }`}
                                >
                                    <Icon size={20} strokeWidth={active ? 2.5 : 2} aria-hidden="true" />
                                    <span className={`text-[10px] leading-tight truncate max-w-[56px] text-center ${active ? "font-semibold" : "font-medium"}`}>
                                        {item.name.split(" ")[0]}
                                    </span>
                                </a>
                            );
                        })}
                    </div>
                </nav>
            </div>
        </div>
    );
}
