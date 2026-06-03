"use client";

import { useState } from "react";
import { Menu, Home, Users, Database, Server, LogOut, Percent, CalendarCheck2, DollarSign, Wallet, Settings2, FileText, Shield, ClipboardCheck, X, ChevronDown } from "lucide-react";
import { authClient } from "@/lib/auth-client";
import { useRouter, usePathname } from "next/navigation";
import { canAccessPath, normalizeRole } from "@/lib/rbac";
import ThemeSwitcher from "@/components/ThemeSwitcher";

export default function SidebarLayout({ children, role, permissions }: { children: React.ReactNode; role?: string | null; permissions?: string | null }) {
    const [isSidebarOpen, setIsSidebarOpen] = useState(true);
    const [isMobileOpen, setIsMobileOpen] = useState(false);
    const router = useRouter();
    const pathname = usePathname();
    const { data: session } = authClient.useSession();
    const userRole = normalizeRole(role || session?.user?.role);
    const userName = session?.user?.name || "User";
    const userInitial = userName.charAt(0).toUpperCase();

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

    const navList = (
        <ul className="space-y-1 px-3">
            {navItems.map((item) => {
                const Icon = item.icon;
                const isActive = pathname === item.href;
                return (
                    <li key={item.name}>
                        <a
                            href={item.href}
                            onClick={() => setIsMobileOpen(false)}
                            className={`relative flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors ${
                                isSidebarOpen ? "" : "justify-center"
                            } ${
                                isActive
                                    ? "bg-brand-50 text-brand-500 dark:bg-brand-500/[0.12] dark:text-brand-400"
                                    : "text-gray-700 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-white/5"
                            }`}
                            title={!isSidebarOpen ? item.name : undefined}
                        >
                            <Icon
                                size={20}
                                className={`min-w-[20px] shrink-0 ${
                                    isActive
                                        ? "text-brand-500 dark:text-brand-400"
                                        : "text-gray-500 dark:text-gray-400"
                                }`}
                            />
                            {isSidebarOpen && (
                                <span className="truncate">{item.name}</span>
                            )}
                        </a>
                    </li>
                );
            })}
        </ul>
    );

    return (
        <div className="flex min-h-screen">
            {/* Sidebar desktop (md+) */}
            <aside
                className={`hidden md:flex transition-all duration-300 ease-in-out ${
                    isSidebarOpen ? "w-[290px]" : "w-[90px]"
                } border-r border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-dark flex-col z-20`}
            >
                <div className="flex h-[72px] items-center justify-between px-5 border-b border-gray-200 dark:border-gray-800">
                    {isSidebarOpen && (
                        <div className="flex items-center gap-3 overflow-hidden">
                            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-brand-500 text-white">
                                <Server size={20} />
                            </div>
                            <span className="font-bold text-lg text-gray-900 dark:text-white truncate">Smart ERP</span>
                        </div>
                    )}
                    <button
                        onClick={() => setIsSidebarOpen(!isSidebarOpen)}
                        className={`flex h-9 w-9 items-center justify-center rounded-lg transition-colors hover:bg-gray-100 dark:hover:bg-white/5 ${!isSidebarOpen && "mx-auto"}`}
                        aria-label="Toggle sidebar"
                    >
                        <ChevronDown
                            size={20}
                            className={`rotate-90 transition-transform duration-300 text-gray-500 dark:text-gray-400 ${isSidebarOpen ? "rotate-90" : "-rotate-90"}`}
                        />
                    </button>
                </div>

                <nav className="flex-1 overflow-y-auto py-4 overflow-x-hidden custom-scrollbar">
                    {navList}
                </nav>
            </aside>

            {/* Mobile drawer */}
            {isMobileOpen && (
                <div className="fixed inset-0 z-40 md:hidden">
                    <div
                        className="absolute inset-0 bg-gray-900/60 backdrop-blur-sm"
                        onClick={() => setIsMobileOpen(false)}
                        aria-hidden="true"
                    />
                    <aside className="absolute left-0 top-0 h-full w-[290px] bg-white dark:bg-gray-dark border-r border-gray-200 dark:border-gray-800 flex flex-col">
                        <div className="flex h-[72px] items-center justify-between px-5 border-b border-gray-200 dark:border-gray-800">
                            <div className="flex items-center gap-3 overflow-hidden">
                                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-brand-500 text-white">
                                    <Server size={20} />
                                </div>
                                <span className="font-bold text-lg text-gray-900 dark:text-white truncate">Smart ERP</span>
                            </div>
                            <button
                                onClick={() => setIsMobileOpen(false)}
                                className="flex h-9 w-9 items-center justify-center rounded-lg hover:bg-gray-100 dark:hover:bg-white/5"
                                aria-label="Tutup menu"
                            >
                                <X size={20} className="text-gray-500 dark:text-gray-400" />
                            </button>
                        </div>
                        <nav className="flex-1 overflow-y-auto py-4 overflow-x-hidden custom-scrollbar">
                            {navList}
                        </nav>
                    </aside>
                </div>
            )}

            {/* Main Content */}
            <div className="flex-1 flex flex-col min-w-0 bg-gray-50 dark:bg-gray-900">
                {/* Top Header */}
                <header className="sticky top-0 z-30 flex h-[72px] items-center justify-between border-b border-gray-200 bg-white px-4 md:px-6 dark:border-gray-800 dark:bg-gray-dark shadow-theme-sm">
                    <div className="flex items-center gap-3">
                        <button
                            onClick={() => setIsMobileOpen(true)}
                            className="flex h-10 w-10 items-center justify-center rounded-lg hover:bg-gray-100 dark:hover:bg-white/5 md:hidden"
                            aria-label="Buka menu"
                        >
                            <Menu size={20} className="text-gray-500 dark:text-gray-400" />
                        </button>
                        <span className="text-sm font-medium text-gray-500 dark:text-gray-400 hidden sm:inline">
                            Headless Accurate Frontend
                        </span>
                    </div>
                    <div className="flex items-center gap-3">
                        <ThemeSwitcher />
                        <button
                            onClick={handleSignOut}
                            className="flex h-10 w-10 items-center justify-center rounded-lg text-gray-500 hover:bg-error-50 hover:text-error-500 transition dark:text-gray-400 dark:hover:bg-error-500/10 dark:hover:text-error-400"
                            title="Log Out"
                            aria-label="Log Out"
                        >
                            <LogOut size={20} />
                        </button>
                        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-brand-500/10 text-brand-500 font-semibold text-sm dark:bg-brand-500/20 dark:text-brand-400">
                            {userInitial}
                        </div>
                    </div>
                </header>

                {/* Page Content */}
                <main className="flex-1 overflow-y-auto p-4 md:p-6 max-w-[1536px] mx-auto w-full">
                    {children}
                </main>
            </div>
        </div>
    );
}
