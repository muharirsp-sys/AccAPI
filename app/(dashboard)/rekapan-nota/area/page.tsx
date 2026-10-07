/*
 * Tujuan: Rute /rekapan-nota/area (Fiori S2): izin dari server, worklist Mapping area di dalam FioriScope.
 * Caller: Rekapan Nota › Mapping area. Guard halaman: layout dashboard (rekapan_nota.view).
 * Dependensi: resolveRequestPermissionsH, FioriScope, Area (klien).
 * Main Functions: AreaPage.
 * Side Effects: Membaca session/permission.
 */
import { resolveRequestPermissionsH } from "@/lib/rbac/resolve";
import { FioriScope } from "@/components/fiori/Scope";
import Area from "./Area";

export default async function AreaPage() {
    const { perms } = await resolveRequestPermissionsH();
    return <FioriScope><Area permKeys={[...(perms ?? [])]} /></FioriScope>;
}
