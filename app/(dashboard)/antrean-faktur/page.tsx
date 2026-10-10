/*
 * Tujuan: Rute /antrean-faktur (Fiori S6c, it02): izin dari server, lalu worklist Antrean Faktur di dalam FioriScope. Menggantikan
 *   halaman satu berkas lama (window.confirm untuk Kirim/Buang, tanpa jalan keluar untuk baris tidak pasti).
 * Caller: menu Penjualan › Antrean Faktur; kartu Beranda (lib/beranda.ts). Guard halaman: layout dashboard (order.view, lib/rbac.ts).
 * Dependensi: resolveRequestPermissionsH, FioriScope, AntreanFaktur (klien).
 * Main Functions: AntreanFakturPage.
 * Side Effects: Membaca session/permission.
 */
import { resolveRequestPermissionsH } from "@/lib/rbac/resolve";
import { FioriScope } from "@/components/fiori/Scope";
import AntreanFaktur from "./AntreanFaktur";

export default async function AntreanFakturPage() {
    const { perms } = await resolveRequestPermissionsH();
    return <FioriScope><AntreanFaktur permKeys={[...(perms ?? [])]} /></FioriScope>;
}
