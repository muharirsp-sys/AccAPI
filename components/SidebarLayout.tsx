// Tujuan: Shell navigasi utama dashboard Smart ERP dengan filtering navigasi berdasarkan RBAC dan satu pintu fitur Accurate.
// Caller: `app/(dashboard)/layout.tsx`.
// Dependensi: `authClient`, router Next.js, ikon `lucide-react`, helper RBAC, ThemeSwitcher.
// Main Functions: `SidebarLayout`, `handleSignOut`.
// Side Effects: Sign-out Better Auth dan navigasi browser; tidak melakukan DB/file I/O langsung.
"use client";

import { useState } from "react";
import { Menu, Home, Users, Database, Server, LogOut, Percent, CalendarCheck2, DollarSign, Wallet, Settings2, FileText, Shield, ClipboardCheck, ReceiptText, X } from "lucide-react";
import { authClient } from "@/lib/auth-client";
import { useRouter } from "next/navigation";
import { canAccessPath, normalizeRole } from "@/lib/rbac";
import ThemeSwitcher from "@/components/ThemeSwitcher";

export default function SidebarLayout({ children, role, permissions }: { children: React.ReactNode; role?: string | null; permissions?: string | null }) {
    // Desktop: sidebar collapse/expand. Mobile: drawer open/close (hamburger).
    const [isSidebarOpen, setIsSidebarOpen] = useState(true);
    const [isMobileOpen, setIsMobileOpen] = useState(false);
    const router = useRouter();
    const { data: session } = authClient.useSession();
    const userRole = normalizeRole(role || session?.user?.role);

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
        { name: "Pembayaran / SPPD", icon: Wallet, href: "/payments" },
        { name: "Format SPPD", icon: FileText, href: "/payments/sppd" },
        { name: "OFF Program Control", icon: ClipboardCheck, href: "/off-program-control" },
        { name: "Claim Workflow", icon: ReceiptText, href: "/claim-workflow" },
        { name: "Master Principle", icon: Database, href: "/principles" },
        { name: "User & RBAC", icon: Shield, href: "/admin/users" },
    ];
    const navItems = allNavItems.filter((item) => canAccessPath(item.href, userRole, permissions || "{}"));

    const navList = (
        <ul className="space-y-1 px-2">
            {navItems.map((item) => {
                const Icon = item.icon;
                return (
                    <li key={item.name}>
                        <a
                            href={item.href}
                            onClick={() => setIsMobileOpen(false)}
                            className={`flex items-center py-2.5 text-slate-300 hover:bg-indigo-500/20 hover:text-indigo-300 rounded-lg transition-colors group ${
                                isSidebarOpen ? 'px-3' : 'justify-center'
                            }`}
                            title={!isSidebarOpen ? item.name : undefined}
                        >
                            <Icon size={20} className="min-w-[20px]" />
                            {isSidebarOpen && (
                                <span className="ml-3 text-sm font-medium whitespace-nowrap">{item.name}</span>
                            )}
                        </a>
                    </li>
                );
            })}
        </ul>
    );

    return (
        <div className="flex h-screen overflow-hidden">
            {/* Sidebar desktop (md+) */}
            <aside
                className={`hidden md:flex transition-all duration-300 ease-in-out ${
                    isSidebarOpen ? "w-64" : "w-[60px]"
                } bg-[#1a1c23]/80 backdrop-blur-xl border-r border-white/5 flex-col z-20`}
            >
                <div className="h-16 flex items-center justify-between px-4 border-b border-white/5">
                    {isSidebarOpen && (
                        <div className="flex items-center gap-2 overflow-hidden">
                            <Server className="text-indigo-500" size={24} />
                            <span className="font-bold text-lg text-white truncate">Smart ERP</span>
                        </div>
                    )}
                    <button
                        onClick={() => setIsSidebarOpen(!isSidebarOpen)}
                        className={`p-1 hover:bg-white/10 rounded-md transition-colors ${!isSidebarOpen && 'mx-auto'}`}
                        aria-label="Toggle sidebar"
                    >
                        <Menu size={20} className="text-slate-300" />
                    </button>
                </div>

                <nav className="flex-1 overflow-y-auto py-4 overflow-x-hidden">
                    {navList}
                </nav>
            </aside>

            {/* Sidebar mobile drawer (< md) */}
            {isMobileOpen && (
                <div className="fixed inset-0 z-40 md:hidden">
                    <div
                        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
                        onClick={() => setIsMobileOpen(false)}
                        aria-hidden="true"
                    />
                    <aside className="absolute left-0 top-0 h-full w-64 bg-[#1a1c23] border-r border-white/10 flex flex-col">
                        <div className="h-16 flex items-center justify-between px-4 border-b border-white/5">
                            <div className="flex items-center gap-2 overflow-hidden">
                                <Server className="text-indigo-500" size={24} />
                                <span className="font-bold text-lg text-white truncate">Smart ERP</span>
                            </div>
                            <button
                                onClick={() => setIsMobileOpen(false)}
                                className="p-1 hover:bg-white/10 rounded-md transition-colors"
                                aria-label="Tutup menu"
                            >
                                <X size={20} className="text-slate-300" />
                            </button>
                        </div>
                        <nav className="flex-1 overflow-y-auto py-4 overflow-x-hidden">
                            {navList}
                        </nav>
                    </aside>
                </div>
            )}

            {/* Main Content Area */}
            <div className="flex-1 flex flex-col min-w-0 bg-black/20">
                {/* Top Header */}
                <header className="h-16 bg-[#1a1c23]/50 backdrop-blur-md border-b border-white/5 flex items-center justify-between px-4 md:px-6 z-10 sticky top-0">
                    <div className="flex items-center gap-3">
                        {/* Hamburger hanya tampil di mobile */}
                        <button
                            onClick={() => setIsMobileOpen(true)}
                            className="md:hidden p-1.5 hover:bg-white/10 rounded-md transition-colors"
                            aria-label="Buka menu"
                        >
                            <Menu size={20} className="text-slate-300" />
                        </button>
                        <span className="text-sm font-medium text-slate-400 hidden sm:inline">Headless Accurate Frontend</span>
                    </div>
                    <div className="flex items-center gap-3">
                        <ThemeSwitcher />
                        <button onClick={handleSignOut} className="text-slate-400 hover:text-red-400 transition-colors" title="Log Out" aria-label="Log Out">
                            <LogOut size={20} />
                        </button>
                        <div className="w-8 h-8 rounded-full bg-indigo-500/20 flex items-center justify-center text-indigo-300 border border-indigo-500/30 text-sm font-bold">
                            A
                        </div>
                    </div>
                </header>

                {/* Page Content */}
                <main className="flex-1 overflow-y-auto p-4 md:p-6 relative">
                    {children}
                </main>
            </div>
        </div>
    );
}
