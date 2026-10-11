/*
 * Tujuan: Rute /pelunasan (Fiori S6e-2b): izin dari server, wizard Pelunasan penjualan di dalam FioriScope.
 * Caller: menu Keuangan › Pelunasan; Beranda Admin Incaso. Guard halaman: layout dashboard (pagePermissions /pelunasan = pelunasan.kirim).
 * Dependensi: resolveRequestPermissionsH, FioriScope, Pelunasan (klien).
 * Main Functions: PelunasanPage.
 * Side Effects: Membaca session/permission.
 */
import { resolveRequestPermissionsH } from "@/lib/rbac/resolve";
import { FioriScope } from "@/components/fiori/Scope";
import Pelunasan from "./Pelunasan";

export default async function PelunasanPage() {
    const { perms } = await resolveRequestPermissionsH();
    return <FioriScope><Pelunasan permKeys={[...(perms ?? [])]} /></FioriScope>;
}
