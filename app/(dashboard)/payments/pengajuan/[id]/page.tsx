/*
 * Tujuan: Rute /payments/pengajuan/[id] (Fiori S6a, it08, BL-50): izin dari server, Object Page satu pengajuan di dalam FioriScope.
 * Caller: daftar Pengajuan & SPPD, keranjang (Buka pengajuan). Guard halaman: layout dashboard (payments.view).
 * Dependensi: resolveRequestPermissionsH, FioriScope, PengajuanDetail (klien).
 * Main Functions: PengajuanDetailPage.
 * Side Effects: Membaca session/permission.
 */
import { resolveRequestPermissionsH } from "@/lib/rbac/resolve";
import { FioriScope } from "@/components/fiori/Scope";
import PengajuanDetail from "./PengajuanDetail";

export default async function PengajuanDetailPage({ params }: { params: Promise<{ id: string }> }) {
    const [{ id }, { perms }] = await Promise.all([params, resolveRequestPermissionsH()]);
    return <FioriScope><PengajuanDetail id={decodeURIComponent(id)} permKeys={[...(perms ?? [])]} /></FioriScope>;
}
