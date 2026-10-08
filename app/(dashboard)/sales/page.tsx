/*
 * Tujuan: Rute /sales (Fiori S5): Order Sales + Order saya untuk sales di lapangan, di dalam FioriScope.
 * Caller: navigasi ruang kerja; dibatasi izin `websales.create` (bukan `order.create`) oleh pagePermissions.
 * Dependensi: resolveRequestPermissionsH (id akun untuk draf ponsel per akun), FioriScope, OrderSales (klien).
 * Main Functions: SalesOrderPage.
 * Side Effects: Membaca session.
 */
import { resolveRequestPermissionsH } from "@/lib/rbac/resolve";
import { FioriScope } from "@/components/fiori/Scope";
import OrderSales from "./OrderSales";

export default async function SalesOrderPage() {
    const { session } = await resolveRequestPermissionsH();
    return <FioriScope><OrderSales akunId={session?.user.id ?? ""} /></FioriScope>;
}
