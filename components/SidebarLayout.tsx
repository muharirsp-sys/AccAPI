// Tujuan: Shell navigasi utama dashboard Smart ERP dengan filtering RBAC, termasuk Master Barang, dan satu pintu fitur Accurate.
// Caller: `app/(dashboard)/layout.tsx`.
// Dependensi: `authClient`, pathname Next.js, ikon `lucide-react`, helper RBAC, ThemeSwitcher.
// Main Functions: `SidebarLayout`, `handleSignOut`.
// Side Effects: Sign-out Better Auth dan navigasi browser; tidak melakukan DB/file I/O langsung.
"use client";

import { useState } from "react";
import { Menu, Home, Database, Server, LogOut, Percent, CalendarCheck2, DollarSign, Wallet, Settings2, FileText, Shield, ShieldCheck, ClipboardCheck, ReceiptText, Trophy, ClipboardList, History, Send, X, PackageSearch } from "lucide-react";
import { authClient } from "@/lib/auth-client";
import { usePathname } from "next/navigation";
import { canAccessPathWithKeys } from "@/lib/rbac";
import ThemeSwitcher from "@/components/ThemeSwitcher";

export default function SidebarLayout({ children, permKeys }: { children: React.ReactNode; role?: string | null; permKeys: string[] }) {
    // Desktop: sidebar collapse/expand. Mobile: drawer open/close (hamburger).
    const [isSidebarOpen, setIsSidebarOpen] = useState(true);
    const [isMobileOpen, setIsMobileOpen] = useState(false);
    const pathname = usePathname();

    const handleSignOut = async () => {
        await authClient.signOut({
            fetchOptions: {
                onSuccess: () => {
                    window.location.href = "/login";
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
        { name: "Insentif Sales", icon: Trophy, href: "/insentif-sales" },
        { name: "Laporan Harian", icon: Send, href: "/laporan-harian" },
        { name: "Form Kontrol", icon: ClipboardList, href: "/form-kontrol" },
        { name: "Pembayaran / SPPD", icon: Wallet, href: "/payments" },
        { name: "Format SPPD", icon: FileText, href: "/payments/sppd" },
        { name: "OFF Program Control", icon: ClipboardCheck, href: "/off-program-control" },
        { name: "Claim Workflow", icon: ReceiptText, href: "/claim-workflow" },
        { name: "History Penjualan", icon: History, href: "/sales-history" },
        { name: "Master Barang", icon: PackageSearch, href: "/master-barang" },
        { name: "Master Principle", icon: Database, href: "/principles" },
        { name: "User & RBAC", icon: Shield, href: "/admin/users" },
        { name: "Kelola Akses Group", icon: ShieldCheck, href: "/admin/groups" },
    ];
    const navItems = allNavItems.filter((item) => canAccessPathWithKeys(item.href, permKeys));
    const activeHref = navItems
        .filter((item) => pathname === item.href || (item.href !== "/" && pathname.startsWith(item.href)))
        .sort((a, b) => b.href.length - a.href.length)[0]?.href;
    const isActive = (href: string) => href === activeHref;

    const renderNavList = (collapsed: boolean) => (
        <ul className="space-y-1 px-2">
            {navItems.map((item) => {
                const Icon = item.icon;
                const active = isActive(item.href);
                return (
                    <li key={item.name}>
                        <a
                            href={item.href}
                            onClick={() => setIsMobileOpen(false)}
                            aria-current={active ? "page" : undefined}
                            aria-label={collapsed ? item.name : undefined}
                            className={`flex items-center py-2.5 hover:bg-indigo-500/20 hover:text-indigo-300 rounded-lg transition-colors group ${
                                collapsed ? 'justify-center' : 'px-3'
                            } ${active ? "bg-indigo-500/15 text-indigo-300" : "text-slate-300"
                            }`}
                            title={collapsed ? item.name : undefined}
                        >
                            <Icon size={20} className="min-w-[20px]" aria-hidden="true" />
                            {!collapsed && (
                                <span className="ml-3 text-sm font-medium whitespace-nowrap">{item.name}</span>
                            )}
                        </a>
                    </li>
                );
            })}
        </ul>
    );

    return (
        <div className="flex h-dvh overflow-hidden">
            {/* Sidebar desktop (md+) */}
            <aside
                className={`hidden md:flex transition-all duration-300 ease-in-out ${
                    isSidebarOpen ? "w-64" : "w-[60px]"
                } bg-[#1a1c23]/80 backdrop-blur-xl border-r border-white/5 shadow-sm flex-col z-20`}
            >
                <div className="h-16 flex items-center justify-between px-4">
                    {isSidebarOpen && (
                        <div className="flex items-center gap-2 overflow-hidden">
                            <Server className="text-indigo-500" size={24} aria-hidden="true" />
                            <span className="font-bold text-lg text-white truncate">Smart ERP</span>
                        </div>
                    )}
                    <button
                        onClick={() => setIsSidebarOpen(!isSidebarOpen)}
                        className={`p-1 hover:bg-white/10 rounded-md transition-colors ${!isSidebarOpen && 'mx-auto'}`}
                        aria-label="Buka/tutup sidebar"
                        aria-expanded={isSidebarOpen}
                    >
                        <Menu size={20} className="text-slate-300" aria-hidden="true" />
                    </button>
                </div>

                <nav className="flex-1 overflow-y-auto py-4 overflow-x-hidden">
                    {renderNavList(!isSidebarOpen)}
                </nav>
            </aside>

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
                            {renderNavList(false)}
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
