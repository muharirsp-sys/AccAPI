/*
 * Tujuan: Rute /payments/sppd (Fiori S6a, it08): izin dari server, Object Page Format SPPD Bank Panin di dalam FioriScope.
 * Caller: menu Keuangan › Format SPPD, subnavigasi Pembayaran. Guard halaman: layout dashboard (sppd.view).
 * Dependensi: resolveRequestPermissionsH, FioriScope, FormatSppd (klien).
 * Main Functions: FormatSppdPage.
 * Side Effects: Membaca session/permission.
 */
import { resolveRequestPermissionsH } from "@/lib/rbac/resolve";
import { FioriScope } from "@/components/fiori/Scope";
import FormatSppd from "../FormatSppd";

export default async function FormatSppdPage() {
    const { perms } = await resolveRequestPermissionsH();
    return <FioriScope><FormatSppd permKeys={[...(perms ?? [])]} /></FioriScope>;
}
