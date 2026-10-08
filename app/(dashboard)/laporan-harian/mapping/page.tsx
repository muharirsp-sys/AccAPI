/*
 * Tujuan: Rute /laporan-harian/mapping (Fiori S3): List Report Penerima laporan di dalam FioriScope.
 * Caller: Laporan Harian › Penerima laporan; menu Operasional Sales. Guard halaman: layout dashboard (laporan_harian.view); API butuh manage.
 * Dependensi: resolveRequestPermissionsH, FioriScope, Penerima (klien).
 * Main Functions: PenerimaPage.
 * Side Effects: Membaca session/permission.
 */
import { resolveRequestPermissionsH } from "@/lib/rbac/resolve";
import { FioriScope } from "@/components/fiori/Scope";
import Penerima from "./Penerima";

export default async function PenerimaPage() {
    const { perms } = await resolveRequestPermissionsH();
    return <FioriScope><Penerima permKeys={[...(perms ?? [])]} /></FioriScope>;
}
