/*
 * Tujuan: Rute /payments/cart/[draftId] (Fiori S6a, it08): izin dari server, wizard keranjang pengajuan di dalam FioriScope.
 * Caller: Rekaman pembayaran › Buat keranjang. Guard halaman: layout dashboard (payments.view).
 * Dependensi: resolveRequestPermissionsH, FioriScope, Keranjang (klien).
 * Main Functions: KeranjangPage.
 * Side Effects: Membaca session/permission.
 */
import { resolveRequestPermissionsH } from "@/lib/rbac/resolve";
import { FioriScope } from "@/components/fiori/Scope";
import Keranjang from "./Keranjang";

export default async function KeranjangPage({ params }: { params: Promise<{ draftId: string }> }) {
    const [{ draftId }, { perms }] = await Promise.all([params, resolveRequestPermissionsH()]);
    return <FioriScope><Keranjang draftId={decodeURIComponent(draftId)} permKeys={[...(perms ?? [])]} /></FioriScope>;
}
