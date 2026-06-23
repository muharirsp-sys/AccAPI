"use client";

import { useEffect, useState } from "react";
import { ClipboardList, BarChart3, Loader2 } from "lucide-react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { type Scope, type TabKey, TABS } from "./shared";

const TabJks           = dynamic(() => import("./tabs/TabJks"),          { ssr: false });
const TabAo            = dynamic(() => import("./tabs/TabAo"),           { ssr: false });
const TabNoOrder       = dynamic(() => import("./tabs/TabNoOrder"),      { ssr: false });
const TabMerchandising = dynamic(() => import("./tabs/TabMerchandising"), { ssr: false });
const TabLaporan       = dynamic(() => import("./tabs/TabLaporan"),      { ssr: false });
const TabBriefing      = dynamic(() => import("./tabs/TabBriefing"),     { ssr: false });
const TabSmControl     = dynamic(() => import("./tabs/TabSmControl"),    { ssr: false });
const TabFrekuensi     = dynamic(() => import("./tabs/TabFrekuensi"),    { ssr: false });
const TabHierarki      = dynamic(() => import("./tabs/TabHierarki"),     { ssr: false });

export default function FormKontrolPage() {
    const [scope, setScope] = useState<Scope | null>(null);
    const [activeTab, setActiveTab] = useState<TabKey>("jks");
    const [scopeLoading, setScopeLoading] = useState(true);

    useEffect(() => {
        fetch("/api/form-kontrol/my-scope")
            .then(r => r.json())
            .then((data: Scope) => { setScope(data); setScopeLoading(false); })
            .catch(() => { setScope({ role: "admin", allowedSalesCodes: null }); setScopeLoading(false); });
    }, []);

    const visibleTabs = scope ? TABS.filter(t => t.roles.includes(scope.role)) : [];
    // Derive effective tab during render — avoids setState-in-effect cascade.
    // Falls back to first visible tab when the selected one isn't allowed for this scope.
    const effectiveTab = visibleTabs.some(t => t.key === activeTab) ? activeTab : visibleTabs[0]?.key;

    if (scopeLoading) {
        return (
            <div className="flex items-center justify-center min-h-[60vh] text-slate-400 gap-2">
                <Loader2 size={20} className="animate-spin" /> Memuat Form Kontrol...
            </div>
        );
    }

    return (
        <div className="max-w-[1200px] mx-auto pb-16 px-2 md:px-0">
            <div className="mb-6 pt-2">
                <h1 className="text-2xl font-bold text-white tracking-tight flex items-center gap-3">
                    <ClipboardList className="text-indigo-400" size={26} />
                    Form Kontrol SUPER
                </h1>
                <p className="text-slate-400 mt-1 text-sm">
                    Sistem Kontrol SUPER —{" "}
                    <span className="text-indigo-300 italic">AO 240 bukan untuk ditawar, AO 240 untuk dicapai</span>
                </p>
                <div className="mt-2 flex items-center gap-3 flex-wrap">
                    {scope?.allowedSalesCodes && (
                        <div className="flex items-center gap-1.5 text-xs text-slate-500">
                            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0" />
                            Tampilan terkunci ke data Anda ({scope.salesName ?? scope.salesCode})
                        </div>
                    )}
                    {scope && ["spv", "sm", "admin", "manager", "admin_sales"].includes(scope.role) && (
                        <Link
                            href="/form-kontrol/spv-dashboard"
                            className="flex items-center gap-1.5 text-xs bg-indigo-600/20 hover:bg-indigo-600/40 text-indigo-300 border border-indigo-500/30 px-3 py-1 rounded-lg transition-colors"
                        >
                            <BarChart3 size={12} /> Dashboard SPV
                        </Link>
                    )}
                </div>
            </div>

            {/* Tab bar */}
            <div className="mb-5 overflow-x-auto">
                <div className="flex gap-1 bg-[#1a1c23]/60 border border-white/10 rounded-xl p-1.5 min-w-max">
                    {visibleTabs.map(tab => {
                        const Icon = tab.icon;
                        return (
                            <button key={tab.key} onClick={() => setActiveTab(tab.key)}
                                className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold transition-all whitespace-nowrap ${effectiveTab === tab.key ? "bg-indigo-600 text-white shadow-lg shadow-indigo-500/20" : "text-slate-400 hover:text-white hover:bg-white/5"}`}>
                                <Icon size={13} />
                                {tab.label}
                            </button>
                        );
                    })}
                </div>
            </div>

            {/* Active tab content */}
            <div className="bg-[#1a1c23]/40 border border-white/10 rounded-xl p-4 md:p-6">
                {effectiveTab === "jks"           && <TabJks scope={scope!} />}
                {effectiveTab === "ao"            && <TabAo scope={scope!} />}
                {effectiveTab === "no-order"      && <TabNoOrder scope={scope!} />}
                {effectiveTab === "merchandising" && <TabMerchandising scope={scope!} />}
                {effectiveTab === "laporan"       && <TabLaporan scope={scope!} />}
                {effectiveTab === "briefing"      && <TabBriefing scope={scope!} />}
                {effectiveTab === "sm-control"    && <TabSmControl scope={scope!} />}
                {effectiveTab === "frekuensi"     && <TabFrekuensi scope={scope!} />}
                {effectiveTab === "hierarki"      && <TabHierarki scope={scope!} />}
            </div>
        </div>
    );
}
