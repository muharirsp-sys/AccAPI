/*
 * Tujuan: Rute /kasir (Fiori K2b, BL-59): izin dari server, layar Kasir ↔ Incaso di dalam FioriScope.
 * Caller: menu Keuangan › Kasir ↔ Incaso. Guard halaman: layout dashboard (pagePermissions /kasir = kasir.view, lib/rbac.ts).
 * Dependensi: resolveRequestPermissionsH, FioriScope, todayWita, Kasir (klien).
 * Main Functions: KasirPage.
 * Side Effects: Membaca session/permission.
 */
import { resolveRequestPermissionsH } from "@/lib/rbac/resolve";
import { FioriScope } from "@/components/fiori/Scope";
import { todayWita } from "@/lib/insentif-payment-date";
import Kasir from "./Kasir";

export default async function KasirPage() {
    const { perms } = await resolveRequestPermissionsH();
    // Hari ini WITA menurut jam SERVER sebagai nilai awal (sama untuk render server/klien); cap waktu server dikirim supaya Kasir menghitung
    // "hari ini" berikutnya dari jam server, bukan jam peramban (No 109, tinjauan K2 R-1).
    const kini = new Date();
    return <FioriScope><Kasir permKeys={[...(perms ?? [])]} hariIni={todayWita(kini)} jamServerMs={kini.getTime()} /></FioriScope>;
}
