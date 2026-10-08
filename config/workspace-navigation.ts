/*
 * Tujuan: Katalog navigasi berkelompok yang sama untuk sidebar dan Beranda.
 * Caller: SidebarLayout (shell Fiori), DashboardLanding, pengujian navigasi.
 * Dependensi: lucide-react; caller menyaring href menggunakan RBAC.
 * Main Functions: WORKSPACE_GROUPS, HOME_ITEM, navigationForPermissions, roleProfile, roleShortcuts.
 * Side Effects: Tidak ada; tidak mengubah hak akses.
 */
import {
    FileSpreadsheet, Home, TrendingUp, Tags, PackageCheck, Wallet, Users, Settings2, ReceiptText, History, CalendarCheck2, Percent, ClipboardCheck, DollarSign, FileText, GitCompareArrows, ClipboardList, Trophy, Send, Database, Shield, ShieldCheck, Smartphone, PackageSearch, type LucideIcon } from "lucide-react";

/** `short` = label navigasi bawah ponsel (≤ 10 huruf); bawaan kata pertama `name`. */
export type WorkspaceItem = { name: string; href: string; icon: LucideIcon; short?: string };
export type WorkspaceGroup = { id: string; name: string; description: string; icon: LucideIcon; items: WorkspaceItem[] };
export const HOME_ITEM: WorkspaceItem = { name: "Beranda", href: "/", icon: Home };
export const WORKSPACE_GROUPS: WorkspaceGroup[] = [
    { id: "sales", name: "Penjualan", description: "Telusuri faktur dan riwayat transaksi pelanggan.", icon: TrendingUp, items: [
        { name: "Order Masuk", href: "/orders", icon: ClipboardList, short: "Masuk" },
        { name: "Order Principal", href: "/principal-order", icon: FileSpreadsheet },
        // Halaman sales di lapangan; hanya tampil untuk akun berizin `websales.create`.
        { name: "Order Sales", href: "/sales", icon: Smartphone, short: "Sales" },
        { name: "Faktur Penjualan", href: "/faktur", icon: ReceiptText },
        { name: "Antrean Faktur", href: "/antrean-faktur", icon: Send },
        { name: "History Penjualan", href: "/sales-history", icon: History },
    ] },
    { id: "promo", name: "Promo & Klaim", description: "Susun program, periksa diskon, dan kelola klaim.", icon: Tags, items: [
        { name: "Summary Promo", href: "/summary", icon: CalendarCheck2 },
        { name: "OFF Program Control", href: "/off-program-control", icon: ClipboardCheck, short: "OPC" },
        { name: "Claim Workflow", href: "/claim-workflow", icon: ReceiptText, short: "Klaim" },
        { name: "Aturan Promo", href: "/aturan-promo", icon: Percent },
        { name: "Rekap Promo", href: "/rekap-promo", icon: Percent },
        { name: "Normalisasi Diskon", href: "/normalisasi-diskon", icon: Percent },
    ] },
    { id: "warehouse", name: "Gudang", description: "Susun rekapan dan siapkan pengambilan barang.", icon: PackageCheck, items: [
        { name: "Rekapan Nota", href: "/rekapan-nota", icon: PackageCheck },
    ] },
    { id: "finance", name: "Keuangan", description: "Kelola pembayaran, perjalanan, dan rekonsiliasi.", icon: Wallet, items: [
        { name: "Finance", href: "/finance", icon: DollarSign },
        { name: "Pembayaran / SPPD", href: "/payments", icon: Wallet, short: "Pembayaran" },
        { name: "Format SPPD", href: "/payments/sppd", icon: FileText },
        { name: "Rekonsiliasi", href: "/reconciliation", icon: GitCompareArrows },
    ] },
    { id: "operations", name: "Operasional Sales", description: "Pantau aktivitas tim, insentif, dan laporan harian.", icon: Users, items: [
        { name: "Form Kontrol", href: "/form-kontrol", icon: ClipboardList, short: "Kontrol" },
        { name: "Insentif Sales", href: "/insentif-sales", icon: Trophy },
        { name: "Laporan Harian", href: "/laporan-harian", icon: Send },
        { name: "Penerima laporan", href: "/laporan-harian/mapping", icon: Users, short: "Penerima" },
    ] },
    { id: "settings", name: "Pengaturan", description: "Atur integrasi Accurate, master data, dan akses.", icon: Settings2, items: [
        { name: "AOL Form Engine", href: "/api-wrapper", icon: Settings2, short: "AOL" },
        { name: "Master Barang", href: "/master-barang", icon: PackageSearch, short: "Barang" },
        { name: "Master Principle", href: "/principles", icon: Database, short: "Master" },
        { name: "Mapping Principal", href: "/principal-mapping", icon: Database },
        { name: "User & RBAC", href: "/admin/users", icon: Shield },
        { name: "Kelola Akses Group", href: "/admin/groups", icon: ShieldCheck, short: "Akses" },
    ] },
];

export function navigationForPermissions(canAccess: (href: string) => boolean): WorkspaceGroup[] {
    return WORKSPACE_GROUPS.map(group => ({ ...group, items: group.items.filter(item => canAccess(item.href)) })).filter(group => group.items.length > 0);
}

// ponytail: grup utama per user (BL-37) belum ada; profil ditebak dari izin, profil pertama yang cocok menang.
// Ganti dengan grup utama saat BL-37 masuk lewat tracker AM.
export const ROLE_PROFILES: Array<{ id: string; label: string; when: string; shortcuts: string[] }> = [
    { id: "admin", label: "Admin", when: "users.manage", shortcuts: ["/admin/groups", "/api-wrapper", "/principles"] },
    { id: "finance", label: "Finance", when: "finance.transfer", shortcuts: ["/finance", "/payments", "/off-program-control"] },
    { id: "salesman", label: "Salesman", when: "websales.create", shortcuts: ["/form-kontrol", "/sales", "/insentif-sales"] },
    { id: "sm", label: "Sales Manager", when: "off_program_control.approve", shortcuts: ["/off-program-control", "/form-kontrol", "/insentif-sales"] },
    { id: "claim", label: "Claim", when: "claim_workflow.create", shortcuts: ["/off-program-control", "/claim-workflow", "/rekap-promo"] },
    { id: "fakturist", label: "Fakturist", when: "order.create", shortcuts: ["/principal-order", "/antrean-faktur", "/faktur"] },
    { id: "gudang", label: "Admin Gudang", when: "rekapan_nota.manage", shortcuts: ["/rekapan-nota"] },
];

export function roleProfile(permKeys: ReadonlySet<string>) {
    return ROLE_PROFILES.find(profile => permKeys.has(profile.when));
}

/** Pintasan peran yang boleh dibuka (bawaan 3 untuk navigasi bawah); kekurangan diisi item lain sesuai urutan katalog. */
export function roleShortcuts(permKeys: ReadonlySet<string>, allowed: WorkspaceItem[], count = 3, profile = roleProfile(permKeys)): WorkspaceItem[] {
    const preferred = (profile?.shortcuts ?? []).map(href => allowed.find(item => item.href === href)).filter((item): item is WorkspaceItem => Boolean(item));
    return [...preferred, ...allowed.filter(item => !preferred.includes(item))].slice(0, count);
}

export function activeNavigationItem(pathname: string, items: WorkspaceItem[]): WorkspaceItem | undefined {
    return items.filter(item => pathname === item.href || (item.href !== "/" && pathname.startsWith(`${item.href}/`)))
        .sort((a, b) => b.href.length - a.href.length)[0];
}
