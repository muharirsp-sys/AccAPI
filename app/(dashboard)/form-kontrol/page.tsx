/*
 * Tujuan: Shell Form Kontrol SUPER yang memuat scope pengguna secara fail-closed dan menampilkan tab sesuai RBAC.
 * Caller: Next.js App Router route `/form-kontrol`.
 * Dependensi: API `/api/form-kontrol/my-scope`, dynamic tab modules, Next navigation/Link, `AsyncState`, lucide-react.
 * Main Functions: `FormKontrolPage`, `loadScope`, `selectTab`, `handleTabKeyDown`, semantic cockpit layout dan feedback async.
 * Side Effects: HTTP read scope pengguna dan sinkronisasi tab ke query URL; kegagalan verifikasi akses ditampilkan dengan retry tanpa fallback role.
 */

"use client";

import { useCallback, useEffect, useState, type KeyboardEvent } from "react";
import { ClipboardList, BarChart3 } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import dynamic from "next/dynamic";
import { type Scope, type TabKey, TABS } from "./shared";
import { ErrorState, LoadingState } from "@/components/ui/AsyncState";

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
    const [scopeLoading, setScopeLoading] = useState(true);
    const [scopeError, setScopeError] = useState("");
    const pathname = usePathname();
    const router = useRouter();
    const searchParams = useSearchParams();

    const loadScope = useCallback(async () => {
        setScopeLoading(true);
        setScopeError("");
        try {
            const response = await fetch("/api/form-kontrol/my-scope");
            const data = await response.json().catch(() => null) as Scope | null;
            if (!response.ok || !data || typeof data.role !== "string") {
                throw new Error("Akses Form Kontrol belum dapat diverifikasi.");
            }
            setScope(data);
        } catch (error) {
            setScope(null);
            setScopeError(
                error instanceof Error
                    ? error.message
                    : "Akses Form Kontrol belum dapat diverifikasi.",
            );
        } finally {
            setScopeLoading(false);
        }
    }, []);

    useEffect(() => {
        void loadScope();
    }, [loadScope]);

    const visibleTabs = scope ? TABS.filter(t => t.roles.includes(scope.role)) : [];
    // Derive effective tab during render — avoids setState-in-effect cascade.
    // Falls back to first visible tab when the selected one isn't allowed for this scope.
    const requestedTab = searchParams.get("tab") as TabKey | null;
    const effectiveTab = visibleTabs.some(t => t.key === requestedTab) ? requestedTab : visibleTabs[0]?.key;

    const selectTab = useCallback((tab: TabKey) => {
        const params = new URLSearchParams(searchParams.toString());
        params.set("tab", tab);
        router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    }, [pathname, router, searchParams]);

    const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
        let nextIndex = index;
        if (event.key === "ArrowRight") nextIndex = (index + 1) % visibleTabs.length;
        else if (event.key === "ArrowLeft") nextIndex = (index - 1 + visibleTabs.length) % visibleTabs.length;
        else if (event.key === "Home") nextIndex = 0;
        else if (event.key === "End") nextIndex = visibleTabs.length - 1;
        else return;

        event.preventDefault();
        const nextTab = visibleTabs[nextIndex];
        if (!nextTab) return;
        selectTab(nextTab.key);
        requestAnimationFrame(() => document.getElementById(`form-kontrol-tab-${nextTab.key}`)?.focus());
    };

    if (scopeLoading) {
        return (
            <div className="ui-page-shell">
                <LoadingState label="Memuat Form Kontrol" rows={3} />
            </div>
        );
    }

    if (scopeError) {
        return (
            <div className="ui-page-shell">
                <ErrorState
                    title={scopeError}
                    message="Tidak ada modul yang dibuka sampai akses berhasil diverifikasi."
                    onAction={() => void loadScope()}
                />
            </div>
        );
    }

    return (
        <div className="ui-page-shell">
            <div className="ui-page-header">
                <div className="ui-page-heading">
                <h1 className="ui-page-title">
                    <ClipboardList className="text-indigo-400" size={26} />
                    Form Kontrol SUPER
                </h1>
                <p className="ui-page-description">
                    Sistem Kontrol SUPER. {" "}
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
                            className="ui-button-secondary"
                        >
                            <BarChart3 size={12} /> Dashboard SPV
                        </Link>
                    )}
                </div>
                </div>
            </div>

            {/* Tab bar */}
            <div className="ui-tab-scroll">
                <div role="tablist" aria-label="Modul Form Kontrol" className="ui-tab-strip">
                    {visibleTabs.map((tab, index) => {
                        const Icon = tab.icon;
                        return (
                            <button key={tab.key} id={`form-kontrol-tab-${tab.key}`} type="button" role="tab"
                                aria-selected={effectiveTab === tab.key}
                                aria-controls="form-kontrol-panel"
                                tabIndex={effectiveTab === tab.key ? 0 : -1}
                                data-state={effectiveTab === tab.key ? "active" : "inactive"}
                                onKeyDown={(event) => handleTabKeyDown(event, index)}
                                onClick={() => selectTab(tab.key)}
                                className="ui-tab-button">
                                <Icon size={13} />
                                {tab.label}
                            </button>
                        );
                    })}
                </div>
            </div>

            {/* Active tab content */}
            <div id="form-kontrol-panel" role="tabpanel" aria-labelledby={effectiveTab ? `form-kontrol-tab-${effectiveTab}` : undefined} tabIndex={0} className="ui-surface-panel ui-panel-padding">
                {visibleTabs.length === 0 && (
                    <p className="text-sm text-slate-400 text-center py-10">
                        Belum ada modul Form Kontrol yang tersedia untuk peran Anda. Hubungi admin bila ini keliru.
                    </p>
                )}
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
