/*
 * Tujuan: Rute /form-kontrol/spv-dashboard (Fiori S5, it05): izin dari server, Overview tim SPV di dalam FioriScope.
 * Caller: tautan "Dashboard SPV" di shell Form Kontrol. Guard halaman: layout dashboard (form_kontrol.view).
 * Dependensi: resolveRequestPermissionsH, FioriScope, DashboardSpv (klien).
 * Main Functions: SpvDashboardPage.
 * Side Effects: Membaca session/permission.
 */
import { resolveRequestPermissionsH } from "@/lib/rbac/resolve";
import { FioriScope } from "@/components/fiori/Scope";
import DashboardSpv from "./DashboardSpv";

export default async function SpvDashboardPage() {
    const { perms } = await resolveRequestPermissionsH();
    return <FioriScope><DashboardSpv permKeys={[...(perms ?? [])]} /></FioriScope>;
}
