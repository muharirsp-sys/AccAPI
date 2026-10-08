/*
 * Tujuan: Rute /sales-history (Fiori S3): izin dari server, List Report History penjualan di dalam FioriScope.
 * Caller: menu Penjualan › History Penjualan. Guard halaman: layout dashboard (sales_history.view).
 * Dependensi: resolveRequestPermissionsH, FioriScope, HistoryPenjualan (klien).
 * Main Functions: SalesHistoryPage.
 * Side Effects: Membaca session/permission.
 */
import { resolveRequestPermissionsH } from "@/lib/rbac/resolve";
import { FioriScope } from "@/components/fiori/Scope";
import HistoryPenjualan from "./HistoryPenjualan";

export default async function SalesHistoryPage() {
    const { perms } = await resolveRequestPermissionsH();
    return <FioriScope><HistoryPenjualan permKeys={[...(perms ?? [])]} /></FioriScope>;
}
