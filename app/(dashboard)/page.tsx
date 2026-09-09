/*
 * Tujuan: Beranda ruang kerja Surya dengan alur operasional dan katalog modul berdasarkan izin.
 * Caller: Next.js route /.
 * Dependensi: Better Auth, RBAC union, workspace-navigation, Next Link, lucide-react.
 * Main Functions: DashboardLanding.
 * Side Effects: Membaca session/permission; tidak menampilkan statistik simulasi.
 */
import Link from "next/link";
import { headers } from "next/headers";
import { ArrowRight, CalendarDays, Tags, ShoppingCart, PackageCheck, ChartNoAxesCombined } from "lucide-react";
import { auth } from "@/lib/auth";
import { canAccessPathWithKeys, rolePermissionPresets } from "@/lib/rbac";
import { getUserPermissions } from "@/lib/rbac/resolve";
import { isLocalAuthBypassEnabled } from "@/lib/local-dev-auth";
import { navigationForPermissions } from "@/config/workspace-navigation";

export default async function DashboardLanding() {
    const requestHeaders = await headers();
    const session = await auth.api.getSession({ headers: requestHeaders }).catch(() => null);
    const userId = String(session?.user?.id || "");
    const permKeys = isLocalAuthBypassEnabled(requestHeaders)
        ? new Set(Object.entries(rolePermissionPresets.admin).flatMap(([moduleName, actions]) => (actions || []).map(action => `${moduleName}.${action}`)))
        : userId ? await getUserPermissions(userId) : new Set<string>();
    const groups = navigationForPermissions(href => canAccessPathWithKeys(href, permKeys));
    const allItems = groups.flatMap(group => group.items);
    const quick = ["/summary", "/faktur", "/rekapan-nota"].map(href => allItems.find(item => item.href === href)).filter(item => Boolean(item));
    const date = new Intl.DateTimeFormat("id-ID", { weekday: "long", day: "numeric", month: "long", timeZone: "Asia/Makassar" }).format(new Date());
    return <div className="workspace-home">
        <div className="workspace-home-heading"><div><p className="workspace-eyebrow">Ruang kerja</p><h1>Selamat bekerja.</h1><p>Semua pekerjaan, dalam satu alur.</p></div><span className="workspace-date"><CalendarDays size={16} aria-hidden="true" />{date}</span></div>
        <div className="workspace-overview">
            <section className="workspace-flow" aria-labelledby="workflow-title"><h2 id="workflow-title">Dari program hingga pengiriman.</h2><p>Kelola promo, pantau penjualan, dan siapkan gudang.</p><ol>{[
                { label: "Program", icon: Tags, href: "/summary" }, { label: "Penjualan", icon: ShoppingCart, href: "/faktur" },
                { label: "Gudang", icon: PackageCheck, href: "/rekapan-nota" }, { label: "Laporan", icon: ChartNoAxesCombined, href: "/laporan-harian" },
            ].map(step => <li key={step.label}>{canAccessPathWithKeys(step.href, permKeys) ? <Link prefetch={false} href={step.href}><span className="workspace-flow-icon"><step.icon size={25} strokeWidth={1.5} /></span><strong>{step.label}</strong><ArrowRight size={14} /></Link> : <span className="workspace-flow-unavailable"><span className="workspace-flow-icon"><step.icon size={25} strokeWidth={1.5} /></span><strong>{step.label}</strong></span>}</li>)}</ol></section>
            <section className="workspace-quick" aria-labelledby="quick-title"><h2 id="quick-title">Akses cepat</h2>{quick.length ? quick.map(item => item && <Link key={item.href} prefetch={false} href={item.href}><item.icon size={19} strokeWidth={1.6} /><span>{item.name}</span><ArrowRight size={17} /></Link>) : <p>Modul yang tersedia tercantum di bawah.</p>}</section>
        </div>
        <div className="workspace-directory-heading"><h2>Jelajahi ruang kerja</h2><span>{groups.length} kelompok</span></div>
        <div className="workspace-directory">{groups.map(group => <section key={group.id} className="workspace-directory-group"><span className="workspace-directory-icon"><group.icon size={25} strokeWidth={1.5} /></span><div><h3>{group.name}</h3><p>{group.description}</p><div className="workspace-directory-links">{group.items.map(item => <Link key={item.href} prefetch={false} href={item.href}>{item.name}<ArrowRight size={12} /></Link>)}</div></div></section>)}</div>
        {!groups.length && <p role="status" className="workspace-empty">Belum ada modul yang dapat diakses. Hubungi admin untuk mengatur akses Anda.</p>}
        <footer className="workspace-home-footer">CV. Surya Perkasa<span>Ruang kerja operasional</span></footer>
    </div>;
}
