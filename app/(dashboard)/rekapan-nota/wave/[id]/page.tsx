/*
 * Tujuan: Rute /rekapan-nota/wave/[id] (Fiori S2): izin dari server, Object Page wave di dalam FioriScope.
 * Caller: daftar wave /rekapan-nota. Guard halaman: layout dashboard (rekapan_nota.view).
 * Dependensi: resolveRequestPermissionsH, FioriScope, WaveDetail (klien).
 * Main Functions: WavePage.
 * Side Effects: Membaca session/permission.
 */
import { resolveRequestPermissionsH } from "@/lib/rbac/resolve";
import { FioriScope } from "@/components/fiori/Scope";
import WaveDetail from "./WaveDetail";

export default async function WavePage({ params }: { params: Promise<{ id: string }> }) {
    const [{ id }, { perms }] = await Promise.all([params, resolveRequestPermissionsH()]);
    return <FioriScope><WaveDetail id={id} permKeys={[...(perms ?? [])]} /></FioriScope>;
}
