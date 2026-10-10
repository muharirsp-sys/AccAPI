/*
 * Tujuan: Rute /principal-order (Fiori S6d): izin dari server, wizard Order Principal di dalam FioriScope.
 * Caller: menu Penjualan › Order Principal; Beranda (Batch perlu tinjau); Antrean Faktur (Buka batch). Guard halaman: layout dashboard (order.view).
 * Dependensi: resolveRequestPermissionsH, FioriScope, OrderPrincipal (klien).
 * Main Functions: PrincipalOrderPage.
 * Side Effects: Membaca session/permission.
 */
import { resolveRequestPermissionsH } from "@/lib/rbac/resolve";
import { FioriScope } from "@/components/fiori/Scope";
import OrderPrincipal from "./OrderPrincipal";

export default async function PrincipalOrderPage() {
    const { perms } = await resolveRequestPermissionsH();
    return <FioriScope><OrderPrincipal permKeys={[...(perms ?? [])]} /></FioriScope>;
}
