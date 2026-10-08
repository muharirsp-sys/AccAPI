/*
 * Tujuan: Rute /off-program-control (Fiori S4d): izin dari server, aplikasi OPC (antrean per peran + batch di kolom kedua) di dalam
 *   FioriScope. Menggantikan halaman satu berkas 10.992 baris; isi per peran ada di opc/peran/*.
 * Caller: menu Promo & Klaim › OFF Program Control; tautan Beranda (`?tab=sales|claim|finance`) dan Claim Workflow
 *   (`?tab=claim&claimView=after-finance`). Guard halaman: layout dashboard (off_program_control.view).
 * Dependensi: resolveRequestPermissionsH, FioriScope, OpcApp (klien).
 * Main Functions: OffProgramControlPage.
 * Side Effects: Membaca session/permission.
 */
import { resolveRequestPermissionsH } from "@/lib/rbac/resolve";
import { FioriScope } from "@/components/fiori/Scope";
import OpcApp from "./OpcApp";

export default async function OffProgramControlPage() {
    const { perms } = await resolveRequestPermissionsH();
    return <FioriScope><OpcApp permKeys={[...(perms ?? [])]} /></FioriScope>;
}
