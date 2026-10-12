/*
 * Tujuan: Rute /orders/[id] (Fiori S6d, it06): izin dari server, Object Page satu order internal di dalam FioriScope.
 * Caller: daftar Order Masuk, Order baru (setelah simpan). Guard halaman: layout dashboard (`order.view`).
 * Dependensi: resolveRequestPermissionsH, FioriScope, OrderDetail (klien).
 * Main Functions: OrderDetailPage.
 * Side Effects: Membaca session/permission.
 */
import { resolveRequestPermissionsH } from "@/lib/rbac/resolve";
import { FioriScope } from "@/components/fiori/Scope";
import OrderDetail from "../OrderDetail";

export default async function OrderDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ baru?: string | string[] }> }) {
    const [{ id }, sp, { perms }] = await Promise.all([params, searchParams, resolveRequestPermissionsH()]);
    return <FioriScope><OrderDetail id={id} baru={sp.baru === "1"} permKeys={[...(perms ?? [])]} /></FioriScope>;
}
