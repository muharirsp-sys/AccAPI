/*
 * Tujuan: Rute /orders/kuota: izin dari server, layar Kuota Promo (budget diskon sell-in per SKU) di dalam FioriScope.
 * Caller: tautan "Kuota promo" di Order Masuk. Guard halaman: layout dashboard (`order.view`); mengatur budget butuh `summary.edit`.
 * Dependensi: resolveRequestPermissionsH, FioriScope, KuotaPromo (klien).
 * Main Functions: KuotaPage.
 * Side Effects: Membaca session/permission.
 */
import { resolveRequestPermissionsH } from "@/lib/rbac/resolve";
import { FioriScope } from "@/components/fiori/Scope";
import KuotaPromo from "../KuotaPromo";

export default async function KuotaPage() {
    const { perms } = await resolveRequestPermissionsH();
    return <FioriScope><KuotaPromo permKeys={[...(perms ?? [])]} /></FioriScope>;
}
