/*
 * Tujuan: Rute /orders (Fiori S6d, it06): izin dari server, List Report Order Masuk di dalam FioriScope.
 * Caller: menu Penjualan › Order Masuk. Guard halaman: layout dashboard (`order.view`, lib/rbac.ts prefix /orders).
 * Dependensi: resolveRequestPermissionsH, FioriScope, OrderMasuk (klien).
 * Main Functions: OrdersPage.
 * Side Effects: Membaca session/permission.
 */
import { resolveRequestPermissionsH } from "@/lib/rbac/resolve";
import { FioriScope } from "@/components/fiori/Scope";
import OrderMasuk from "./OrderMasuk";

export default async function OrdersPage() {
    const { perms } = await resolveRequestPermissionsH();
    return <FioriScope><OrderMasuk permKeys={[...(perms ?? [])]} /></FioriScope>;
}
