/*
 * Tujuan: Rute /summary (Fiori S4a): izin dari server, Object Page Summary promo di dalam FioriScope.
 * Caller: menu Promo & Klaim › Summary Promo. Guard halaman: layout dashboard (summary.view).
 * Dependensi: resolveRequestPermissionsH, FioriScope, Summary (klien).
 * Main Functions: SummaryPage.
 * Side Effects: Membaca session/permission.
 */
import { resolveRequestPermissionsH } from "@/lib/rbac/resolve";
import { FioriScope } from "@/components/fiori/Scope";
import Summary from "./Summary";

export default async function SummaryPage() {
    const { perms } = await resolveRequestPermissionsH();
    return <FioriScope><Summary permKeys={[...(perms ?? [])]} /></FioriScope>;
}
