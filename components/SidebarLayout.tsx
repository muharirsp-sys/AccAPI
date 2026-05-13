// Tujuan: Shell navigasi utama dashboard Smart ERP, termasuk akses modul payments/SPPD dan Seedance 2.0.
// Caller: `app/(dashboard)/layout.tsx`.
// Dependensi: `authClient`, router Next.js, ikon `lucide-react`.
// Main Functions: `SidebarLayout`, `handleSignOut`.
// Side Effects: Sign-out Better Auth dan navigasi browser; tidak melakukan DB/file I/O langsung.
"use client";

import { useState } from "react";
import { Menu, Home, Users, ShoppingCart, ShoppingBag, Settings, Database, Server, Box, GitBranch, ArrowLeftRight, LogOut, Percent, CalendarCheck2, DollarSign, Wallet, Presentation, Settings2, FileVideo, FileText, Shield } from "lucide-react";
import { authClient } from "@/lib/auth-client";
import { useRouter } from "next/navigation";

export default function SidebarLayout({ children }: { children: React.ReactNode }) {
    const [isSidebarOpen, setIsSidebarOpen] = useState(true);
    const router = useRouter();
    const { data: session } = authClient.useSession();
    const userRole = session?.user?.role;

    const handleSignOut = async () => {
        await authClient.signOut({
            fetchOptions: {
                onSuccess: () => {
                    router.push("/login");
                },
            },
        });
    };

    // Sidebar navigation structure based on implementation plan
    const navItems = [
        { name: "Dashboard", icon: Home, href: "/" },
        { name: "AOL Form Engine", icon: Settings2, href: "/api-wrapper" },
        { name: "Validator Diskon", icon: Percent, href: "/validator" },
        { name: "Summary Promo", icon: CalendarCheck2, href: "/summary" },
        { name: "Tarikan Finance", icon: DollarSign, href: "/finance" },
        { name: "Pembayaran / SPPD", icon: Wallet, href: "/payments" },
        { name: "Format SPPD", icon: FileText, href: "/payments/sppd" },
        { name: "PowerPoint Maker", icon: Presentation, href: "/powerpoint-maker" },
        { name: "Seedance 2.0", icon: FileVideo, href: "/seedance" },
        { name: "Master Principle", icon: Database, href: "/principles" },
        { name: "Cabang", icon: GitBranch, href: "/master/branch" },
        { name: "Gudang", icon: Box, href: "/master/warehouse" },
        { name: "Pelanggan", icon: Users, href: "/master/customer" },
        { name: "Barang & Jasa", icon: Database, href: "/master/item" },
        { name: "Faktur Penjualan", icon: ShoppingCart, href: "/sales/invoice" },
        { name: "Penerimaan Penjualan", icon: ShoppingBag, href: "/sales/receipt" },
        { name: "Retur Penjualan", icon: ArrowLeftRight, href: "/sales/return" },
        { name: "Pengaturan API", icon: Settings, href: "/settings" },
        ...(userRole === "admin" ? [{ name: "User & RBAC", icon: Shield, href: "/admin/users" }] : []),
    ];

    return (
        <div className="flex h-screen overflow-hidden">
            {/* Sidebar */}
            <aside
                className={`transition-all duration-300 ease-in-out ${
                    isSidebarOpen ? "w-64" : "w-[60px]"
                } bg-[#1a1c23]/80 backdrop-blur-xl border-r border-white/5 flex flex-col z-20`}
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
                    >
                        <Menu size={20} className="text-slate-300" />
                    </button>
                </div>
                
                <nav className="flex-1 overflow-y-auto py-4 overflow-x-hidden">
                    <ul className="space-y-1 px-2">
                        {navItems.map((item) => {
                            const Icon = item.icon;
                            return (
                                <li key={item.name}>
                                    <a
                                        href={item.href}
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
                </nav>
            </aside>

            {/* Main Content Area */}
            <div className="flex-1 flex flex-col min-w-0 bg-black/20">
                {/* Top Header */}
                <header className="h-16 bg-[#1a1c23]/50 backdrop-blur-md border-b border-white/5 flex items-center justify-between px-6 z-10 sticky top-0">
                    <div className="flex items-center gap-4">
                        <span className="text-sm font-medium text-slate-400">Headless Accurate Frontend</span>
                    </div>
                    <div className="flex items-center gap-3">
                        <button onClick={handleSignOut} className="text-slate-400 hover:text-red-400 transition-colors" title="Log Out">
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
