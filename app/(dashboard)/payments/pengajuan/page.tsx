/*
 * Tujuan: Rute /payments/pengajuan (Fiori S6a, it08, BL-50): izin dari server, daftar Pengajuan & SPPD di dalam FioriScope.
 *   Sub-halaman Pembayaran (subnavigasi), bukan item menu baru.
 * Caller: subnavigasi Pembayaran, keranjang (langkah 3). Guard halaman: layout dashboard (prefix /payments → payments.view).
 * Dependensi: resolveRequestPermissionsH, FioriScope, Pengajuan (klien).
 * Main Functions: PengajuanPage.
 * Side Effects: Membaca session/permission.
 */
import { resolveRequestPermissionsH } from "@/lib/rbac/resolve";
import { FioriScope } from "@/components/fiori/Scope";
import Pengajuan from "./Pengajuan";

export default async function PengajuanPage() {
    const { perms } = await resolveRequestPermissionsH();
    return <FioriScope><Pengajuan permKeys={[...(perms ?? [])]} /></FioriScope>;
}
