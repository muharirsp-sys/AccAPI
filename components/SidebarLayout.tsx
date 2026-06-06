/*
 * Tujuan: Shell navigasi utama dashboard Smart ERP bergaya warm executive.
 * Responsive: Mobile (< 768px) → floating bottom bar pill, Desktop (md+) → sidebar.
 * Caller: `app/(dashboard)/layout.tsx`.
 * Dependensi: `authClient`, router Next.js, ikon `lucide-react`, helper RBAC.
 * Side Effects: Sign-out Better Auth dan navigasi browser.
 */
"use client";

import { useState, useEffect } from "react";
import { Menu, Home, Database, Server, LogOut, Percent, CalendarCheck2, DollarSign, Wallet, Settings2, FileText, Shield, ClipboardCheck, X, ChevronLeft } from "lucide-react";
import { authClient } from "@/lib/auth-client";
import { useRouter, usePathname } from "next/navigation";
import { canAccessPath, normalizeRole } from "@/lib/rbac";

export default function SidebarLayout({ children, role, permissions }: { children: React.ReactNode; role?: string | null; permissions?: string | null }) {
    const [isSidebarOpen, setIsSidebarOpen] = useState(true);
    const [isMobileDrawerOpen, setIsMobileDrawerOpen] = useState(false);
    const router = useRouter();
    const pathname = usePathname();
    const { data: session } = authClient.useSession();
    const userRole = normalizeRole(role || session?.user?.role);

    useEffect(() => {
        const handleResize = () => {
            const width = window.innerWidth;
            if (width < 1024) {
                setIsSidebarOpen(false);
            } else {
                setIsSidebarOpen(true);
            }
            if (width >= 768) {
                setIsMobileDrawerOpen(false);
            }
        };
        handleResize();
        window.addEventListener("resize", handleResize);
        return () => window.removeEventListener("resize", handleResize);
    }, []);

    const handleSignOut = async () => {
        await authClient.signOut({
            fetchOptions: {
                onSuccess: () => {
                    router.push("/login");
                },
            },
        });
    };

    const allNavItems = [
        { name: "Dashboard", icon: Home, href: "/" },
        { name: "AOL Form Engine", icon: Settings2, href: "/api-wrapper" },
        { name: "Validator Diskon", icon: Percent, href: "/validator" },
        { name: "Summary Promo", icon: CalendarCheck2, href: "/summary" },
        { name: "Finance", icon: DollarSign, href: "/finance" },
        { name: "Pembayaran / SPPD", icon: Wallet, href: "/payments" },
        { name: "Format SPPD", icon: FileText, href: "/payments/sppd" },
        { name: "OFF Program Control", icon: ClipboardCheck, href: "/off-program-control" },
        { name: "Master Principle", icon: Database, href: "/principles" },
        { name: "User & RBAC", icon: Shield, href: "/admin/users" },
    ];
    const navItems = allNavItems.filter((item) => canAccessPath(item.href, userRole, permissions || "{}"));

    const isActive = (href: string) => {
        if (href === "/") return pathname === "/";
        return pathname.startsWith(href);
    };

    const navList = (mobile = false) => (
        <ul className="space-y-1 px-2">
            {navItems.map((item) => {
                const Icon = item.icon;
                const active = isActive(item.href);
                return (
                    <li key={item.name}>
                        <a
                            href={item.href}
                            onClick={() => { if (mobile) setIsMobileDrawerOpen(false); }}
                            className={`flex items-center py-2.5 rounded-xl transition-all duration-200 group ${
                                isSidebarOpen || mobile ? "px-3" : "justify-center px-0"
                            } ${
                                active
                                    ? "bg-gradient-to-r from-[rgba(242,210,138,0.22)] to-[rgba(199,154,63,0.10)] text-[var(--luxury-gold)] border border-[var(--border-strong)]"
                                    : "text-[var(--luxury-muted)] hover:bg-[rgba(242,210,138,0.12)] hover:text-[var(--luxury-text)]"
                            }`}
                            title={!isSidebarOpen && !mobile ? item.name : undefined}
                        >
                            <Icon size={20} className={`min-w-[20px] ${active ? "text-[var(--luxury-gold)]" : ""}`} />
                            {(isSidebarOpen || mobile) && (
                                <span className="ml-3 text-sm font-medium whitespace-nowrap truncate">{item.name}</span>
                            )}
                        </a>
                    </li>
                );
            })}
        </ul>
    );

    return (
        <div className="flex h-[100dvh] overflow-hidden">
            {/* ═══════════════════════════════════════════════════════════════
                DESKTOP/TABLET SIDEBAR (md+)
            ═══════════════════════════════════════════════════════════════ */}
            <aside
                className={`hidden md:flex transition-all duration-300 ease-in-out flex-col z-20 ${
                    isSidebarOpen ? "w-64 2xl:w-72" : "w-[68px]"
                } bg-[var(--surface)] backdrop-blur-2xl border-r border-[var(--border-soft)] shadow-[4px_0_24px_rgba(122,78,32,0.06)]`}
            >
                <div className="h-16 flex items-center justify-between px-3 border-b border-[var(--border-soft)] flex-shrink-0">
                    {isSidebarOpen && (
                        <div className="flex items-center gap-2.5 overflow-hidden">
                            <div className="h-9 w-9 rounded-xl bg-gradient-to-br from-[#f2d28a] to-[#b77a25] flex items-center justify-center shadow-md flex-shrink-0">
                                <Server className="text-[#3d2814]" size={18} />
                            </div>
                            <span className="font-bold text-base text-[var(--luxury-text)] truncate">Smart ERP</span>
                        </div>
                    )}
                    <button
                        onClick={() => setIsSidebarOpen(!isSidebarOpen)}
                        className={`p-2 hover:bg-[var(--surface-2)] rounded-xl transition-colors ${!isSidebarOpen && "mx-auto"}`}
                        aria-label="Toggle sidebar"
                    >
                        {isSidebarOpen ? (
                            <ChevronLeft size={18} className="text-[var(--luxury-subtle)]" />
                        ) : (
                            <Menu size={18} className="text-[var(--luxury-subtle)]" />
                        )}
                    </button>
                </div>
                <nav className="flex-1 overflow-y-auto py-3 overflow-x-hidden scrollbar-thin">
                    {navList()}
                </nav>
                {isSidebarOpen && (
                    <div className="border-t border-[var(--border-soft)] p-3 flex-shrink-0">
                        <div className="flex items-center gap-2.5 px-2">
                            <div className="w-8 h-8 rounded-full bg-gradient-to-br from-[#f2d28a] to-[#c79a3f] flex items-center justify-center text-[#3d2814] text-xs font-bold flex-shrink-0">
                                {session?.user?.name?.charAt(0)?.toUpperCase() || "U"}
                            </div>
                            <div className="flex-1 min-w-0">
                                <p className="text-xs font-medium text-[var(--luxury-text)] truncate">
                                    {session?.user?.name || "User"}
                                </p>
                                <p className="text-[10px] text-[var(--luxury-subtle)] truncate">
                                    {userRole || "user"}
                                </p>
                            </div>
                            <button
                                onClick={handleSignOut}
                                className="p-1.5 rounded-lg hover:bg-red-50 text-[var(--luxury-subtle)] hover:text-red-600 transition-colors"
                                title="Log Out"
                                aria-label="Log Out"
                            >
                                <LogOut size={16} />
                            </button>
                        </div>
                    </div>
                )}
            </aside>

            {/* ═══════════════════════════════════════════════════════════════
                MOBILE FULL-SCREEN DRAWER (< md) — triggered from bottom bar "Lainnya"
            ═══════════════════════════════════════════════════════════════ */}
            {isMobileDrawerOpen && (
                <div className="fixed inset-0 z-50 md:hidden">
                    <div
                        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
                        onClick={() => setIsMobileDrawerOpen(false)}
                        aria-hidden="true"
                    />
                    <aside className="absolute left-0 top-0 h-full w-72 max-w-[85vw] bg-[var(--surface)] border-r border-[var(--border-soft)] flex flex-col shadow-2xl animate-in slide-in-from-left duration-200">
                        <div className="h-14 flex items-center justify-between px-4 border-b border-[var(--border-soft)] flex-shrink-0">
                            <div className="flex items-center gap-2.5">
                                <div className="h-8 w-8 rounded-xl bg-gradient-to-br from-[#f2d28a] to-[#b77a25] flex items-center justify-center shadow-md">
                                    <Server className="text-[#3d2814]" size={16} />
                                </div>
                                <span className="font-bold text-[var(--luxury-text)]">Smart ERP</span>
                            </div>
                            <button
                                onClick={() => setIsMobileDrawerOpen(false)}
                                className="p-2 hover:bg-[var(--surface-2)] rounded-xl transition-colors"
                                aria-label="Tutup menu"
                            >
                                <X size={20} className="text-[var(--luxury-subtle)]" />
                            </button>
                        </div>
                        <nav className="flex-1 overflow-y-auto py-3 overflow-x-hidden">
                            {navList(true)}
                        </nav>
                        <div className="border-t border-[var(--border-soft)] p-3 flex-shrink-0">
                            <div className="flex items-center gap-2.5 px-2">
                                <div className="w-8 h-8 rounded-full bg-gradient-to-br from-[#f2d28a] to-[#c79a3f] flex items-center justify-center text-[#3d2814] text-xs font-bold">
                                    {session?.user?.name?.charAt(0)?.toUpperCase() || "U"}
                                </div>
                                <div className="flex-1 min-w-0">
                                    <p className="text-xs font-medium text-[var(--luxury-text)] truncate">
                                        {session?.user?.name || "User"}
                                    </p>
                                </div>
                                <button
                                    onClick={handleSignOut}
                                    className="p-2 rounded-lg hover:bg-red-50 text-[var(--luxury-subtle)] hover:text-red-600 transition-colors"
                                    aria-label="Log Out"
                                >
                                    <LogOut size={16} />
                                </button>
                            </div>
                        </div>
                    </aside>
                </div>
            )}

            {/* ═══════════════════════════════════════════════════════════════
                MAIN CONTENT AREA
            ═══════════════════════════════════════════════════════════════ */}
            <div className="flex-1 flex flex-col min-w-0">
                {/* Top Header — DESKTOP ONLY */}
                <header className="hidden md:flex h-16 bg-[var(--surface)]/80 backdrop-blur-xl border-b border-[var(--border-soft)] items-center justify-between px-4 md:px-6 z-10 sticky top-0 flex-shrink-0">
                    <span className="text-sm font-medium text-[var(--luxury-subtle)]">
                        Headless Accurate Frontend
                    </span>
                    <div className="flex items-center gap-2">
                        <span className="text-xs text-[var(--luxury-muted)] hidden lg:inline">
                            {session?.user?.name || "User"}
                        </span>
                        <div className="w-8 h-8 rounded-full bg-gradient-to-br from-[#f2d28a] to-[#c79a3f] flex items-center justify-center text-[#3d2814] text-xs font-bold border-2 border-[var(--border-soft)]">
                            {session?.user?.name?.charAt(0)?.toUpperCase() || "U"}
                        </div>
                    </div>
                </header>

                {/* Page Content */}
                <main className="flex-1 overflow-y-auto p-3 sm:p-4 md:p-6 lg:p-8 2xl:p-10 pb-28 md:pb-8 relative">
                    <div className="max-w-[1800px] mx-auto w-full">
                        {children}
                    </div>
                </main>

                {/* ═══════════════════════════════════════════════════════════
                    MOBILE FLOATING BOTTOM BAR — Instagram-style pill
                    Glassmorphism + horizontal scroll + rounded-full
                    ONLY visible on mobile (< md)
                ═══════════════════════════════════════════════════════════ */}
                <div className="md:hidden fixed bottom-0 left-0 right-0 z-40 flex justify-center pointer-events-none safe-area-bottom pb-3">
                    <nav
                        className="pointer-events-auto mx-4 w-[calc(100%-2rem)] max-w-md rounded-full border border-[rgba(242,210,138,0.25)] shadow-[0_8px_32px_rgba(122,78,32,0.15),0_2px_8px_rgba(0,0,0,0.08)]"
                        style={{
                            background: "linear-gradient(135deg, rgba(255,250,235,0.72) 0%, rgba(242,210,138,0.18) 50%, rgba(255,248,225,0.65) 100%)",
                            backdropFilter: "blur(16px) saturate(1.4)",
                            WebkitBackdropFilter: "blur(16px) saturate(1.4)",
                        }}
                    >
                        {/* Scrollable icon container — hide scrollbar */}
                        <div
                            className="flex items-center gap-1 px-2 py-2.5 overflow-x-auto"
                            style={{
                                scrollbarWidth: "none",
                                msOverflowStyle: "none",
                            }}
                        >
                            <style>{`
                                .floating-nav-scroll::-webkit-scrollbar { display: none; }
                            `}</style>
                            <div className="floating-nav-scroll flex items-center gap-1 overflow-x-auto w-full" style={{ scrollbarWidth: "none", msOverflowStyle: "none" }}>
                                {navItems.map((item) => {
                                    const Icon = item.icon;
                                    const active = isActive(item.href);
                                    return (
                                        <a
                                            key={item.name}
                                            href={item.href}
                                            className={`flex-shrink-0 flex flex-col items-center justify-center rounded-full px-3 py-1.5 transition-all duration-200 ${
                                                active
                                                    ? "bg-gradient-to-br from-[#f2d28a]/40 to-[#c79a3f]/25 text-[#7a4e20] scale-105"
                                                    : "text-[#8b7355] hover:text-[#5c3d1e] hover:bg-[rgba(242,210,138,0.15)] active:scale-95"
                                            }`}
                                            title={item.name}
                                        >
                                            <Icon size={20} strokeWidth={active ? 2.5 : 1.8} />
                                            <span className={`text-[9px] leading-tight mt-0.5 whitespace-nowrap ${active ? "font-bold" : "font-medium"}`}>
                                                {item.name.length > 8 ? item.name.split(" ")[0] : item.name}
                                            </span>
                                        </a>
                                    );
                                })}
                                {/* Lainnya / More — opens drawer */}
                                <button
                                    onClick={() => setIsMobileDrawerOpen(true)}
                                    className="flex-shrink-0 flex flex-col items-center justify-center rounded-full px-3 py-1.5 text-[#8b7355] hover:text-[#5c3d1e] hover:bg-[rgba(242,210,138,0.15)] active:scale-95 transition-all duration-200"
                                >
                                    <Menu size={20} strokeWidth={1.8} />
                                    <span className="text-[9px] leading-tight mt-0.5 font-medium">Lainnya</span>
                                </button>
                            </div>
                        </div>
                    </nav>
                </div>
            </div>
        </div>
    );
}
