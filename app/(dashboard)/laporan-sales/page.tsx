/*
 * Tujuan: Rute /laporan-sales: gerbang server + kerangka tab Laporan Sales (6 laporan padanan EskaLink, lib/laporan-sales/kontrak.ts).
 * Caller: menu Operasional Sales › Laporan Sales. Guard: layout dashboard (pagePermissions /laporan-sales = salah satu IZIN_HALAMAN) + halaman ini.
 * Dependensi: resolveRequestPermissionsH, FioriScope, AccessDenied, tabTerlihat, LaporanSales (klien).
 * Main Functions: LaporanSalesPage.
 * Side Effects: Membaca session/permission; redirect /login tanpa sesi. Bulan bawaan dihitung server (WITA).
 */
import { redirect } from "next/navigation";
import { resolveRequestPermissionsH } from "@/lib/rbac/resolve";
import { FioriScope } from "@/components/fiori/Scope";
import AccessDenied from "@/components/AccessDenied";
import { todayWita } from "@/lib/insentif-payment-date";
import { tabTerlihat } from "@/lib/laporan-sales/kontrak";
import LaporanSales from "./LaporanSales";

export default async function LaporanSalesPage() {
    const { session, perms } = await resolveRequestPermissionsH();
    if (!session || !perms) redirect("/login");
    const tab = tabTerlihat(perms).map((t) => t.id);
    if (tab.length === 0) return <AccessDenied message="Laporan Sales butuh izin History Penjualan, Supervisor Review, atau Insentif (lihat semua)." />;
    return <FioriScope><LaporanSales tab={tab} bulanAwal={todayWita(new Date()).slice(0, 7)} /></FioriScope>;
}
