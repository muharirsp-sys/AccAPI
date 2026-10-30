/*
 * Tujuan: Rute /finance (Fiori S6b): izin dari server + tanggal bayar bawaan = hari ini WITA (bukan UTC), layar Finance di FioriScope.
 * Caller: menu Keuangan › Finance. Guard halaman: layout dashboard (finance.view).
 * Dependensi: resolveRequestPermissionsH, FioriScope, lib/insentif-payment-date (todayWita), Finance (klien).
 * Main Functions: FinancePage.
 * Side Effects: Membaca session/permission.
 */
import { resolveRequestPermissionsH } from "@/lib/rbac/resolve";
import { FioriScope } from "@/components/fiori/Scope";
import { todayWita } from "@/lib/insentif-payment-date";
import Finance from "./Finance";

export default async function FinancePage() {
    const { perms } = await resolveRequestPermissionsH();
    // Cap waktu server: "hari ini" berikutnya dihitung dari jam server, bukan jam peramban (No 109, tinjauan K2 R-1).
    const kini = new Date();
    return <FioriScope><Finance permKeys={[...(perms ?? [])]} hariIni={todayWita(kini)} jamServerMs={kini.getTime()} /></FioriScope>;
}
