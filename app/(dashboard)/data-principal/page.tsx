/*
 * Tujuan: Rute /data-principal (Fiori S7b): izin dari server, layar Data Principal (daftar + Object Page) di dalam FioriScope.
 * Caller: menu Pengaturan › Data Principal. Guard halaman: layout dashboard (pagePermissions /data-principal = principles.view, lib/rbac.ts).
 * Dependensi: resolveRequestPermissionsH, FioriScope, DataPrincipal (klien).
 * Main Functions: DataPrincipalPage.
 * Side Effects: Membaca session/permission. Tombol tulis ditentukan izin (principles.upload / principles.delete); API menegakkannya lagi.
 */
import { resolveRequestPermissionsH } from "@/lib/rbac/resolve";
import { FioriScope } from "@/components/fiori/Scope";
import DataPrincipal from "@/components/principal/DataPrincipal";

export default async function DataPrincipalPage() {
    const { perms } = await resolveRequestPermissionsH();
    return <FioriScope><DataPrincipal permKeys={[...(perms ?? [])]} /></FioriScope>;
}
