/*
 * Tujuan: Rute /payments (Fiori S6a, it08): izin dari server, layar Rekaman pembayaran di dalam FioriScope.
 * Caller: menu Keuangan › Pembayaran / SPPD. Guard halaman: layout dashboard (payments.view).
 * Dependensi: resolveRequestPermissionsH, FioriScope, Rekaman (klien).
 * Main Functions: PembayaranPage.
 * Side Effects: Membaca session/permission.
 */
import { resolveRequestPermissionsH } from "@/lib/rbac/resolve";
import { FioriScope } from "@/components/fiori/Scope";
import Rekaman from "./Rekaman";

export default async function PembayaranPage() {
    const { perms } = await resolveRequestPermissionsH();
    return <FioriScope><Rekaman permKeys={[...(perms ?? [])]} /></FioriScope>;
}
