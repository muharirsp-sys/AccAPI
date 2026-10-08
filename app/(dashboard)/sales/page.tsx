/*
 * Tujuan: Rute /sales (Fiori S5): Order Sales + Order saya untuk sales di lapangan, di dalam FioriScope.
 * Caller: navigasi ruang kerja; dibatasi izin `websales.create` (bukan `order.create`) oleh pagePermissions.
 * Dependensi: FioriScope, OrderSales (klien).
 * Main Functions: SalesOrderPage.
 * Side Effects: Tidak ada (rute tipis).
 */
import { FioriScope } from "@/components/fiori/Scope";
import OrderSales from "./OrderSales";

export default function SalesOrderPage() {
    return <FioriScope><OrderSales /></FioriScope>;
}
