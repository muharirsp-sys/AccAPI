/*
 * Tujuan: Rute /faktur (Fiori S6d, it06 #16–#21): izin dari server, Faktur Penjualan (daftar + Object Page dua kolom) di dalam FioriScope.
 * Caller: menu Penjualan › Faktur Penjualan; tautan Order Masuk (`?q=<nomor faktur>`) dan Realisasi Summary (`?invoiceId=&databaseId=`).
 *   Guard halaman: layout dashboard (sales_history.view).
 * Dependensi: resolveRequestPermissionsH, FioriScope, FakturPenjualan (klien).
 * Main Functions: FakturPage.
 * Side Effects: Membaca session/permission.
 */
import { resolveRequestPermissionsH } from "@/lib/rbac/resolve";
import { FioriScope } from "@/components/fiori/Scope";
import FakturPenjualan from "./FakturPenjualan";

export default async function FakturPage() {
    const { perms } = await resolveRequestPermissionsH();
    return <FioriScope><FakturPenjualan permKeys={[...(perms ?? [])]} /></FioriScope>;
}
