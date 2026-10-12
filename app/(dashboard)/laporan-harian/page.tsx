/*
 * Tujuan: Rute /laporan-harian (Fiori S3): izin dari server, wizard Laporan Harian di dalam FioriScope.
 * Caller: menu Operasional Sales › Laporan Harian. Guard halaman: layout dashboard (laporan_harian.view).
 * Dependensi: resolveRequestPermissionsH, FioriScope, LaporanHarian (klien).
 * Main Functions: LaporanHarianPage.
 * Side Effects: Membaca session/permission.
 */
import { resolveRequestPermissionsH } from "@/lib/rbac/resolve";
import { FioriScope } from "@/components/fiori/Scope";
import LaporanHarian from "./LaporanHarian";

export default async function LaporanHarianPage() {
    const { perms } = await resolveRequestPermissionsH();
    return <FioriScope><LaporanHarian permKeys={[...(perms ?? [])]} /></FioriScope>;
}
