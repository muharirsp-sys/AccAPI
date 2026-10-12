/*
 * Tujuan: Rute /rekapan-nota/kanvas (Fiori S2): izin dari server, worklist Nota kanvas di dalam FioriScope.
 * Caller: Rekapan Nota › Nota kanvas. Guard halaman: layout dashboard (rekapan_nota.view).
 * Dependensi: resolveRequestPermissionsH, FioriScope, Kanvas (klien).
 * Main Functions: KanvasPage.
 * Side Effects: Membaca session/permission.
 */
import { resolveRequestPermissionsH } from "@/lib/rbac/resolve";
import { FioriScope } from "@/components/fiori/Scope";
import Kanvas from "./Kanvas";

export default async function KanvasPage() {
    const { perms } = await resolveRequestPermissionsH();
    return <FioriScope><Kanvas permKeys={[...(perms ?? [])]} /></FioriScope>;
}
