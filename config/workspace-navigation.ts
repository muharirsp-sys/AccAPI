/*
 * Tujuan: Katalog navigasi berkelompok yang sama untuk sidebar dan Beranda.
 * Caller: WorkspaceNavigation, DashboardLanding, pengujian navigasi.
 * Dependensi: lucide-react; caller menyaring href menggunakan RBAC.
 * Main Functions: WORKSPACE_GROUPS, HOME_ITEM, navigationForPermissions.
 * Side Effects: Tidak ada; tidak mengubah hak akses.
 */
import {
    FileSpreadsheet, Home, TrendingUp, Tags, PackageCheck, Wallet, Users, Settings2, ReceiptText, History, CalendarCheck2, Percent, ClipboardCheck, DollarSign, FileText, GitCompareArrows, ClipboardList, Trophy, Send, Database, Shield, ShieldCheck, Smartphone, type LucideIcon } from "lucide-react";

export type WorkspaceItem = { name: string; href: string; icon: LucideIcon };
export type WorkspaceGroup = { id: string; name: string; description: string; icon: LucideIcon; items: WorkspaceItem[] };
export const HOME_ITEM: WorkspaceItem = { name: "Beranda", href: "/", icon: Home };
export const WORKSPACE_GROUPS: WorkspaceGroup[] = [
    { id: "sales", name: "Penjualan", description: "Telusuri faktur dan riwayat transaksi pelanggan.", icon: TrendingUp, items: [
        { name: "Order Masuk", href: "/orders", icon: ClipboardList },
        { name: "Order Principal", href: "/principal-order", icon: FileSpreadsheet },
        // Halaman sales di lapangan; hanya tampil untuk akun berizin `websales.create`.
        { name: "Order Sales", href: "/sales", icon: Smartphone },
        { name: "Faktur Penjualan", href: "/faktur", icon: ReceiptText },
        { name: "Antrean Faktur", href: "/antrean-faktur", icon: Send },
        { name: "History Penjualan", href: "/sales-history", icon: History },
    ] },
    { id: "promo", name: "Promo & Klaim", description: "Susun program, periksa diskon, dan kelola klaim.", icon: Tags, items: [
        { name: "Summary Promo", href: "/summary", icon: CalendarCheck2 },
        { name: "Validator Diskon", href: "/validator", icon: Percent },
        { name: "OFF Program Control", href: "/off-program-control", icon: ClipboardCheck },
        { name: "Claim Workflow", href: "/claim-workflow", icon: ReceiptText },
        { name: "Rekap Promo", href: "/rekap-promo", icon: Percent },
    ] },
    { id: "warehouse", name: "Gudang", description: "Susun rekapan dan siapkan pengambilan barang.", icon: PackageCheck, items: [
        { name: "Rekapan Nota", href: "/rekapan-nota", icon: PackageCheck },
    ] },
    { id: "finance", name: "Keuangan", description: "Kelola pembayaran, perjalanan, dan rekonsiliasi.", icon: Wallet, items: [
        { name: "Finance", href: "/finance", icon: DollarSign },
        { name: "Pembayaran / SPPD", href: "/payments", icon: Wallet },
        { name: "Format SPPD", href: "/payments/sppd", icon: FileText },
        { name: "Rekonsiliasi", href: "/reconciliation", icon: GitCompareArrows },
    ] },
    { id: "operations", name: "Operasional Sales", description: "Pantau aktivitas tim, insentif, dan laporan harian.", icon: Users, items: [
        { name: "Form Kontrol", href: "/form-kontrol", icon: ClipboardList },
        { name: "Insentif Sales", href: "/insentif-sales", icon: Trophy },
        { name: "Laporan Harian", href: "/laporan-harian", icon: Send },
    ] },
    { id: "settings", name: "Pengaturan", description: "Atur integrasi Accurate, master data, dan akses.", icon: Settings2, items: [
        { name: "AOL Form Engine", href: "/api-wrapper", icon: Settings2 },
        { name: "Master Principle", href: "/principles", icon: Database },
        { name: "Mapping Principal", href: "/principal-mapping", icon: Database },
        { name: "User & RBAC", href: "/admin/users", icon: Shield },
        { name: "Kelola Akses Group", href: "/admin/groups", icon: ShieldCheck },
    ] },
];

export function navigationForPermissions(canAccess: (href: string) => boolean): WorkspaceGroup[] {
    return WORKSPACE_GROUPS.map(group => ({ ...group, items: group.items.filter(item => canAccess(item.href)) })).filter(group => group.items.length > 0);
}

export function activeNavigationItem(pathname: string, items: WorkspaceItem[]): WorkspaceItem | undefined {
    return items.filter(item => pathname === item.href || (item.href !== "/" && pathname.startsWith(`${item.href}/`)))
        .sort((a, b) => b.href.length - a.href.length)[0];
}
