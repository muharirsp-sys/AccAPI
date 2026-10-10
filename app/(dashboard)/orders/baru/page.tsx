/*
 * Tujuan: Rute /orders/baru (Fiori S6d, it06): izin dari server, form Order baru di dalam FioriScope.
 * Caller: tombol "Buat order" di Order Masuk. Guard halaman: layout dashboard (`order.view`); simpan butuh `order.create`.
 * Dependensi: resolveRequestPermissionsH, FioriScope, OrderBaru (klien).
 * Main Functions: OrderBaruPage.
 * Side Effects: Membaca session/permission.
 */
import { resolveRequestPermissionsH } from "@/lib/rbac/resolve";
import { FioriScope } from "@/components/fiori/Scope";
import OrderBaru from "../OrderBaru";

export default async function OrderBaruPage() {
    const { perms } = await resolveRequestPermissionsH();
    return <FioriScope><OrderBaru permKeys={[...(perms ?? [])]} /></FioriScope>;
}
