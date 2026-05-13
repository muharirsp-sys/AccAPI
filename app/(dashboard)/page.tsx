// Tujuan: Landing dashboard untuk akses cepat modul operasional Smart ERP, termasuk Seedance 2.0.
// Caller: Route Next.js dashboard `/`.
// Dependensi: `lucide-react`, `next/link`, daftar modul lokal.
// Main Functions: `DashboardLanding`, `MODULES`.
// Side Effects: Navigasi client via link; tidak melakukan DB/HTTP/file I/O.
"use client";

import { Percent, CalendarCheck2, DollarSign, Wallet, Presentation, Database, ArrowRight, Settings2, ShieldCheck, Cpu, FileVideo } from "lucide-react";
import Link from "next/link";

const MODULES = [
    {
        title: "AOL Form Engine",
        desc: "API Injector ke Accurate Online massal. Bypass web forms.",
        icon: Settings2,
        href: "/api-wrapper",
        color: "from-indigo-500/20 to-indigo-600/5",
        iconColor: "text-indigo-400",
        border: "border-indigo-500/20 hover:border-indigo-400/50"
    },
    {
        title: "Validator Diskon",
        desc: "Lakukan validasi data potongan diskon manual secara bulk.",
        icon: Percent,
        href: "/validator",
        color: "from-emerald-500/20 to-emerald-600/5",
        iconColor: "text-emerald-400",
        border: "border-emerald-500/20 hover:border-emerald-400/50"
    },
    {
        title: "Summary Promo",
        desc: "Ekstraksi PDF otomatis dengan regex AI dan kompilasi SPT.",
        icon: CalendarCheck2,
        href: "/summary",
        color: "from-sky-500/20 to-sky-600/5",
        iconColor: "text-sky-400",
        border: "border-sky-500/20 hover:border-sky-400/50"
    },
    {
        title: "Tarikan Finance",
        desc: "Track pencairan dana dan ekspor history jurnal langsung.",
        icon: DollarSign,
        href: "/finance",
        color: "from-purple-500/20 to-purple-600/5",
        iconColor: "text-purple-400",
        border: "border-purple-500/20 hover:border-purple-400/50"
    },
    {
        title: "Pembayaran & SPPD",
        desc: "Manajemen LPB / CBD dan auto-generate draft cart SPPD.",
        icon: Wallet,
        href: "/payments",
        color: "from-rose-500/20 to-rose-600/5",
        iconColor: "text-rose-400",
        border: "border-rose-500/20 hover:border-rose-400/50"
    },
    {
        title: "PowerPoint Maker",
        desc: "Sintesis data menjadi slide PPTX presentasi eksekutif.",
        icon: Presentation,
        href: "/powerpoint-maker",
        color: "from-orange-500/20 to-orange-600/5",
        iconColor: "text-orange-400",
        border: "border-orange-500/20 hover:border-orange-400/50"
    },
    {
        title: "Seedance 2.0",
        desc: "Buat dan pantau task video BytePlus ModelArk.",
        icon: FileVideo,
        href: "/seedance",
        color: "from-amber-500/20 to-amber-600/5",
        iconColor: "text-amber-300",
        border: "border-amber-500/20 hover:border-amber-400/50"
    },
    {
        title: "Master Principle",
        desc: "Konfigurasi kamus data principle untuk PDF Extraction AI.",
        icon: Database,
        href: "/principles",
        color: "from-cyan-500/20 to-cyan-600/5",
        iconColor: "text-cyan-400",
        border: "border-cyan-500/20 hover:border-cyan-400/50"
    }
];

export default function DashboardLanding() {
    return (
        <div className="max-w-7xl mx-auto pb-12 pt-4 selection:bg-indigo-500/30">
            {/* Hero Section */}
            <div className="relative rounded-3xl overflow-hidden bg-gradient-to-br from-[#1a1c23] to-[#0f1115] border border-white/10 p-8 md:p-14 mb-10 shadow-2xl">
                <div className="absolute top-0 right-0 w-[500px] h-[500px] bg-indigo-500/10 rounded-full blur-[100px] -mr-48 -mt-48 pointer-events-none"></div>
                <div className="absolute bottom-0 left-0 w-[400px] h-[400px] bg-emerald-500/5 rounded-full blur-[80px] -ml-32 -mb-32 pointer-events-none"></div>
                
                <div className="relative z-10 flex flex-col md:flex-row items-center justify-between gap-10">
                    <div className="flex-1 space-y-6">
                        <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full border border-indigo-500/30 bg-indigo-500/10 text-indigo-300 text-xs font-bold tracking-widest uppercase">
                            <ShieldCheck size={14} /> ERP Sistem Terpusat
                        </div>
                        <h1 className="text-4xl md:text-5xl font-black text-white tracking-tight leading-tight">
                            Portal Internal <br className="hidden md:block"/>
                            <span className="text-transparent bg-clip-text bg-gradient-to-r from-indigo-400 to-emerald-400">
                                CV. Surya Perkasa
                            </span>
                        </h1>
                        <p className="text-lg text-slate-400 max-w-xl leading-relaxed">
                            Akses seluruh modul operasional, finansial, injeksi Accurate, hingga generator AI PPT/PDF dalam satu dashboard terpadu.
                        </p>
                    </div>
                    
                    <div className="hidden lg:flex shrink-0 w-64 h-64 bg-black/40 border border-white/10 rounded-2xl shadow-xl items-center justify-center relative overflow-hidden group">
                        <div className="absolute inset-0 bg-gradient-to-b from-indigo-500/10 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500"></div>
                        <Cpu size={80} className="text-indigo-500/40 group-hover:text-indigo-400 transition-colors duration-500 group-hover:scale-110" />
                    </div>
                </div>
            </div>

            {/* Modules Grid */}
            <div className="mb-4">
                <h2 className="text-xl font-bold text-white tracking-tight flex items-center gap-2 mb-6 px-2">
                    <span className="w-1.5 h-6 rounded-full bg-indigo-500 block"></span> Modul Operasional
                </h2>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                    {MODULES.map((mod, i) => {
                        const Icon = mod.icon;
                        return (
                            <Link 
                                href={mod.href} 
                                key={i}
                                className={`group flex flex-col justify-between p-6 rounded-2xl bg-[#1a1c23] bg-gradient-to-br ${mod.color} border ${mod.border} backdrop-blur-xl transition-all duration-300 hover:shadow-xl hover:-translate-y-1`}
                                style={{ boxShadow: 'inset 0 1px 1px rgba(255,255,255,0.05)' }}
                            >
                                <div>
                                    <div className={`w-12 h-12 rounded-xl bg-black/40 flex items-center justify-center mb-5 border border-white/5 group-hover:scale-110 transition-transform`}>
                                        <Icon className={`${mod.iconColor}`} size={24} />
                                    </div>
                                    <h3 className="text-lg font-bold text-white mb-2">{mod.title}</h3>
                                    <p className="text-sm text-slate-400 leading-relaxed mb-6 line-clamp-2">
                                        {mod.desc}
                                    </p>
                                </div>
                                <div className="mt-auto flex items-center justify-between border-t border-white/5 pt-4">
                                    <span className={`text-[11px] font-bold uppercase tracking-wider ${mod.iconColor}`}>Akses Modul</span>
                                    <ArrowRight size={16} className={`${mod.iconColor} opacity-50 group-hover:opacity-100 group-hover:translate-x-1 transition-all`} />
                                </div>
                            </Link>
                        );
                    })}
                </div>
            </div>
            
            <div className="text-center mt-12 py-6 border-t border-white/5">
                <p className="text-sm text-slate-500">V1.0.0 &copy; 2026 Core ERP Infrastructure - PT. Surya Perkasa</p>
            </div>
        </div>
    );
}
