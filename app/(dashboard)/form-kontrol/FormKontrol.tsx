/*
 * Tujuan: Shell klien Form Kontrol (Fiori S5, it05): memuat cakupan pengguna (my-scope) fail-closed, kepala halaman, navigasi tab
 *   per peran (TABS × scope.role, sama dengan hari ini; `?tab=` di URL), tautan Dashboard SPV, lalu merender tab aktif dengan
 *   kontrak `({ scope })`. Izin akun diteruskan ke tab lewat IzinFkCtx.
 * Caller: app/(dashboard)/form-kontrol/page.tsx.
 * Dependensi: ./shared (TABS, Scope, IzinFkCtx, ambilFk), ./tabs/* (dimuat saat dipakai), components/fiori/{core,interactive}.
 * Main Functions: FormKontrol (default).
 * Side Effects: GET /api/form-kontrol/my-scope; navigasi tab = router.replace lewat <Link replace>.
 */
"use client";

import { useCallback, useMemo, type ComponentType } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { usePathname, useSearchParams } from "next/navigation";
import { BarChart3 } from "lucide-react";
import { EmptyState, ErrorState, MessageStrip, Skeleton, StatusBadge } from "@/components/fiori/core";
import { useLoad, type Load } from "@/components/fiori/interactive";
import { IzinFkCtx, TABS, ambilFk, type Scope, type TabKey } from "./shared";

const MemuatTab = () => <Skeleton rows={4} label="Memuat modul" />;
// next/dynamic mewajibkan objek opsi literal per panggilan. Tab L (ao, no-order, laporan) dan tab T dirender dengan kontrak yang sama: default export `({ scope }: { scope: Scope })`.
const TAB: Record<TabKey, ComponentType<{ scope: Scope }>> = {
    jks: dynamic(() => import("./tabs/TabJks"), { ssr: false, loading: MemuatTab }),
    ao: dynamic(() => import("./tabs/TabAo"), { ssr: false, loading: MemuatTab }),
    "no-order": dynamic(() => import("./tabs/TabNoOrder"), { ssr: false, loading: MemuatTab }),
    laporan: dynamic(() => import("./tabs/TabLaporan"), { ssr: false, loading: MemuatTab }),
    briefing: dynamic(() => import("./tabs/TabBriefing"), { ssr: false, loading: MemuatTab }),
    "sm-control": dynamic(() => import("./tabs/TabSmControl"), { ssr: false, loading: MemuatTab }),
    frekuensi: dynamic(() => import("./tabs/TabFrekuensi"), { ssr: false, loading: MemuatTab }),
    hierarki: dynamic(() => import("./tabs/TabHierarki"), { ssr: false, loading: MemuatTab }),
};

const LABEL_PERAN: Record<string, string> = {
    salesman: "Salesman", spv: "SPV", sm: "SM", admin: "Admin", manager: "Manager", admin_sales: "Admin Sales", staff: "Staf",
};
/** Peran yang melihat tautan Dashboard SPV (sama dengan hari ini). */
const PERAN_DASHBOARD_SPV = ["spv", "sm", "admin", "manager", "admin_sales"];
const GAGAL_AKSES = "Akses Form Kontrol belum dapat diverifikasi.";

export default function FormKontrol({ permKeys }: { permKeys: string[] }) {
    const izin = useMemo(() => new Set(permKeys), [permKeys]);
    const pathname = usePathname();
    const sp = useSearchParams();

    const [load, muatUlang] = useLoad(useCallback(async (): Promise<Load<Scope>> => {
        const r = await ambilFk("/api/form-kontrol/my-scope", (j) => j as unknown as Scope, GAGAL_AKSES);
        // Fail-closed: tanpa peran yang terbaca, tidak ada modul yang dibuka (tidak menebak peran).
        if (r.status === "siap" && typeof r.data?.role !== "string") return { status: "galat", error: GAGAL_AKSES };
        return r;
    }, []));
    const scope = load.status === "siap" ? load.data : undefined;

    const visibleTabs = scope ? TABS.filter((t) => t.roles.includes(scope.role)) : [];
    // Tab yang diminta tidak tersedia untuk peran ini (mis. ?tab=merchandising lama) → tab pertama yang terlihat.
    const requested = sp.get("tab");
    const aktif = visibleTabs.find((t) => t.key === requested) ?? visibleTabs[0];
    const hrefTab = (key: TabKey) => {
        const p = new URLSearchParams(sp.toString());
        p.set("tab", key);
        return `${pathname}?${p}`;
    };
    const Tab = aktif ? TAB[aktif.key] : null;

    const kepala = (
        <header className="fi-page-head">
            <nav aria-label="Jejak halaman"><ol className="fi-crumb"><li><span>Operasional Sales</span></li><li><span aria-current="page">Form Kontrol</span></li></ol></nav>
            <div className="fi-page-bar">
                <h1>Form Kontrol</h1>
                {scope && <StatusBadge tone="neu">{LABEL_PERAN[scope.role] ?? scope.role}</StatusBadge>}
                <span className="fi-spacer" />
                {scope && PERAN_DASHBOARD_SPV.includes(scope.role) && (
                    <Link href="/form-kontrol/spv-dashboard" className="fi-btn fi-btn--secondary">
                        <BarChart3 className="fi-icon" aria-hidden />Dashboard SPV
                    </Link>
                )}
            </div>
            <p>Sistem Kontrol SUPER — AO 240 bukan untuk ditawar, AO 240 untuk dicapai.</p>
            {scope?.allowedSalesCodes && scope.allowedSalesCodes.length > 0 && (
                <p>Tampilan terkunci ke data Anda{scope.salesName || scope.salesCode ? ` (${scope.salesName ?? scope.salesCode})` : ""}.</p>
            )}
        </header>
    );

    if (!scope) {
        return (
            <div className="fi-page">
                {kepala}
                {load.status === "galat"
                    ? <ErrorState title={GAGAL_AKSES} message={`${(load.error ?? "").replace(GAGAL_AKSES, "").trim()} Tidak ada modul yang dibuka sampai akses berhasil diverifikasi.`.trim()} onRetry={muatUlang} />
                    : <Skeleton rows={4} label="Memuat Form Kontrol" />}
            </div>
        );
    }

    return (
        <IzinFkCtx.Provider value={izin}>
            <div className="fi-page">
                {kepala}
                {scope.allowedSalesCodes && scope.allowedSalesCodes.length === 0 && (
                    <MessageStrip tone="warn" title="Belum ada data sales yang tertaut ke akun Anda.">
                        Rute, laporan, dan tim tidak akan tampil sampai admin mengisi profil Anda di Hierarki Sales.
                    </MessageStrip>
                )}
                {visibleTabs.length > 1 && (
                    <nav className="fi-subnav" aria-label="Modul Form Kontrol">
                        {visibleTabs.map((t) => (
                            <Link key={t.key} href={hrefTab(t.key)} replace scroll={false} aria-current={t.key === aktif?.key ? "page" : undefined}>{t.label}</Link>
                        ))}
                    </nav>
                )}
                {Tab ? (
                    <section id="form-kontrol-panel" aria-label={aktif!.label} className="grid gap-4 min-w-0">
                        <Tab key={aktif!.key} scope={scope} />
                    </section>
                ) : (
                    <EmptyState title="Belum ada modul Form Kontrol untuk peran Anda" message="Hubungi admin bila ini keliru." />
                )}
            </div>
        </IzinFkCtx.Provider>
    );
}
