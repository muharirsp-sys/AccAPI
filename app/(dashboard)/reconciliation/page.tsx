/*
 * Tujuan: Rute /reconciliation (Fiori S3): izin dari server, wizard Rekonsiliasi di dalam FioriScope.
 * Caller: menu Keuangan › Rekonsiliasi. Guard halaman: layout dashboard (reconciliation.view).
 * Dependensi: resolveRequestPermissionsH, FioriScope, Rekonsiliasi (klien).
 * Main Functions: ReconciliationPage.
 * Side Effects: Membaca session/permission.
 */
import { resolveRequestPermissionsH } from "@/lib/rbac/resolve";
import { FioriScope } from "@/components/fiori/Scope";
import Rekonsiliasi from "./Rekonsiliasi";

export default async function ReconciliationPage() {
    const { perms } = await resolveRequestPermissionsH();
    return <FioriScope><Rekonsiliasi permKeys={[...(perms ?? [])]} /></FioriScope>;
}
