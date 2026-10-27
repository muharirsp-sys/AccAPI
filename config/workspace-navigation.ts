/*
 * Tujuan: Katalog navigasi berkelompok yang sama untuk sidebar dan Beranda.
 * Caller: SidebarLayout (shell Fiori), DashboardLanding, pengujian navigasi.
 * Dependensi: lucide-react; caller menyaring href menggunakan RBAC.
 * Main Functions: WORKSPACE_GROUPS, HOME_ITEM, navigationForPermissions, ROLE_PROFILES, profileFor (★ grup utama), roleProfile, roleShortcuts.
 * Side Effects: Tidak ada; tidak mengubah hak akses.
 */
import {
    FileSpreadsheet, Home, TrendingUp, Tags, PackageCheck, Wallet, Users, Settings2, ReceiptText, History, CalendarCheck2, Percent, ClipboardCheck, DollarSign, FileText, GitCompareArrows, Trophy, Send, Database, Shield, ShieldCheck, Smartphone, MapPinned, PackageSearch, HandCoins, Banknote, ChartColumn,
    Inbox, FileCheck2, ChartPie, BadgePercent, ListChecks, MessageSquareText, UserRoundCheck, Building2, ArrowLeftRight, FileCog, type LucideIcon } from "lucide-react";

/** `short` = label navigasi bawah ponsel (≤ 10 huruf, unik di katalog); bawaan kata pertama `name`. */
export type WorkspaceItem = { name: string; href: string; icon: LucideIcon; short?: string };
export type WorkspaceGroup = { id: string; name: string; description: string; icon: LucideIcon; items: WorkspaceItem[] };
export const HOME_ITEM: WorkspaceItem = { name: "Beranda", href: "/", icon: Home };
export const WORKSPACE_GROUPS: WorkspaceGroup[] = [
    { id: "sales", name: "Penjualan", description: "Telusuri faktur dan riwayat transaksi pelanggan.", icon: TrendingUp, items: [
        { name: "Order Masuk", href: "/orders", icon: Inbox, short: "Ord. Masuk" },
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
        { name: "Claim Workflow", href: "/claim-workflow", icon: FileCheck2, short: "Klaim" },
        { name: "Aturan Promo", href: "/aturan-promo", icon: Percent },
        { name: "Rekap Promo", href: "/rekap-promo", icon: ChartPie },
        { name: "Normalisasi Diskon", href: "/normalisasi-diskon", icon: BadgePercent },
    ] },
    { id: "warehouse", name: "Gudang", description: "Susun rekapan dan siapkan pengambilan barang.", icon: PackageCheck, items: [
        { name: "Rekapan Nota", href: "/rekapan-nota", icon: PackageCheck },
    ] },
    { id: "finance", name: "Keuangan", description: "Kelola pembayaran, perjalanan, dan rekonsiliasi.", icon: Wallet, items: [
        { name: "Finance", href: "/finance", icon: DollarSign },
        // Wizard Pelunasan (S6e-2): kirim sales-receipt ke Accurate; dibuka pemegang `pelunasan.kirim` (Admin Incaso, Finance).
        { name: "Pelunasan", href: "/pelunasan", icon: HandCoins },
        // Kasir dan Incaso (K2b, BL-59): setoran Kasir per orang per hari lawan pelunasan Incaso; dibuka pemegang `kasir.view` (Kasir, OM, Admin).
        { name: "Kasir dan Incaso", href: "/kasir", icon: Banknote, short: "Kasir" },
        { name: "Pembayaran dan SPPD", href: "/payments", icon: Wallet, short: "Pembayaran" },
        { name: "Format SPPD", href: "/payments/sppd", icon: FileText },
        { name: "Rekonsiliasi", href: "/reconciliation", icon: GitCompareArrows },
    ] },
    { id: "operations", name: "Operasional Sales", description: "Pantau aktivitas tim, insentif, dan laporan harian.", icon: Users, items: [
        { name: "Form Kontrol", href: "/form-kontrol", icon: ListChecks, short: "Kontrol" },
        // Supervisor Review (owner 16 Okt 2026): ringkasan harian per salesman + peta kunjungan; dibuka pemegang `supervisor_review.view`.
        { name: "Supervisor Review", href: "/supervisor-review", icon: MapPinned, short: "Supervisor" },
        // Laporan Sales (owner 20 Okt 2026): Top 30, Monitoring Harian, Target vs Realisasi, Drop Size, Coverage Ganda, Tidak Order.
        { name: "Laporan Sales", href: "/laporan-sales", icon: ChartColumn, short: "Lap. Sales" },
        { name: "Insentif Sales", href: "/insentif-sales", icon: Trophy },
        { name: "Laporan Harian", href: "/laporan-harian", icon: MessageSquareText, short: "Lap. Harian" },
        { name: "Penerima laporan", href: "/laporan-harian/mapping", icon: UserRoundCheck, short: "Penerima" },
    ] },
    { id: "settings", name: "Pengaturan", description: "Atur integrasi Accurate, master data, dan akses.", icon: Settings2, items: [
        { name: "Formulir Accurate (AOL)", href: "/api-wrapper", icon: FileCog, short: "AOL" },
        { name: "Master Barang", href: "/master-barang", icon: PackageSearch, short: "Barang" },
        { name: "Master Principal", href: "/principles", icon: Database, short: "Master" },
        // Data Principal (S7b): daftar resmi principal + varian + alias; dibuka pemegang `principles.view`, tulis `principles.upload`.
        { name: "Data Principal", href: "/data-principal", icon: Building2, short: "Principal" },
        { name: "Mapping Principal", href: "/principal-mapping", icon: ArrowLeftRight },
        { name: "User dan Izin", href: "/admin/users", icon: Shield, short: "User" },
        { name: "Kelola Akses Grup", href: "/admin/groups", icon: ShieldCheck, short: "Akses" },
    ] },
];

export function navigationForPermissions(canAccess: (href: string) => boolean): WorkspaceGroup[] {
    return WORKSPACE_GROUPS.map(group => ({ ...group, items: group.items.filter(item => canAccess(item.href)) })).filter(group => group.items.length > 0);
}

// Profil Beranda. `when` = tebakan dari izin (fallback, profil pertama yang cocok menang); profil tanpa `when` hanya lewat ★ grup utama.
// S7-3 (owner 17 Okt): `when` sm = sm_approve (kunci approve OPC lama dipensiunkan); spv/om/kasir baru, hanya lewat grup utama.
export const ROLE_PROFILES: Array<{ id: string; label: string; when?: string; shortcuts: string[] }> = [
    { id: "admin", label: "Admin", when: "users.manage", shortcuts: ["/admin/groups", "/api-wrapper", "/principles"] },
    { id: "finance", label: "Finance", when: "finance.transfer", shortcuts: ["/finance", "/payments", "/off-program-control"] },
    { id: "salesman", label: "Salesman", when: "websales.create", shortcuts: ["/form-kontrol", "/sales", "/insentif-sales"] },
    { id: "sm", label: "Sales Manager", when: "off_program_control.sm_approve", shortcuts: ["/off-program-control", "/form-kontrol", "/insentif-sales", "/supervisor-review"] },
    { id: "claim", label: "Claim", when: "claim_workflow.create", shortcuts: ["/off-program-control", "/claim-workflow", "/rekap-promo"] },
    { id: "fakturist", label: "Fakturist", when: "order.create", shortcuts: ["/principal-order", "/antrean-faktur", "/faktur"] },
    { id: "gudang", label: "Admin Gudang", when: "rekapan_nota.manage", shortcuts: ["/rekapan-nota"] },
    // TERAKHIR (susulan S6e, tinjauan 2b): pelunasan.kirim juga diberikan ke Finance (owner #1) dan bisa ke peran lain; profil
    // utama mereka menang, Admin Incaso hanya bila tidak ada peran lain yang cocok.
    { id: "incaso", label: "Admin Incaso", when: "pelunasan.kirim", shortcuts: ["/pelunasan"] },
    { id: "spv", label: "Supervisor", shortcuts: ["/supervisor-review", "/form-kontrol", "/insentif-sales"] },
    { id: "om", label: "Operational Manager", shortcuts: ["/kasir", "/pelunasan", "/finance"] },
    { id: "kasir", label: "Kasir", shortcuts: ["/kasir"] },
];

export function roleProfile(permKeys: ReadonlySet<string>) {
    return ROLE_PROFILES.find(profile => profile.when && permKeys.has(profile.when));
}

/** Nama grup preset (huruf kecil, tanpa spasi) -> profil (owner 17 Okt). Staff, Viewer, grup custom: tidak ada = tebakan kunci. */
const PROFIL_GRUP: Record<string, string> = {
    admin: "admin", finance: "finance", salesman: "salesman", sm: "sm", manager: "sm", spv: "spv", om: "om", kasir: "kasir", claim: "claim",
    fakturist: "fakturist", adminsales: "fakturist", admingudang: "gudang", adminincaso: "incaso",
};

/** BL-63 (owner 11 Okt): ★ grup utama menentukan Beranda; tanpa grup utama / grup di luar peta = tebakan dari izin. */
export function profileFor(primaryGroup: string | null | undefined, permKeys: ReadonlySet<string>) {
    const id = PROFIL_GRUP[(primaryGroup ?? "").replace(/\s+/g, "").toLowerCase()];
    return ROLE_PROFILES.find(profile => profile.id === id) ?? roleProfile(permKeys);
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
