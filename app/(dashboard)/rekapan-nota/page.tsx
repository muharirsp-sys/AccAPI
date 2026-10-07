/*
 * Tujuan: Rute /rekapan-nota (Fiori S2): izin dari server, isi klien di dalam FioriScope.
 * Caller: menu Gudang › Rekapan Nota. Guard halaman: layout dashboard (rekapan_nota.view).
 * Dependensi: resolveRequestPermissionsH, FioriScope, RekapanNota (klien).
 * Main Functions: RekapanNotaPage.
 * Side Effects: Membaca session/permission.
 */
import { resolveRequestPermissionsH } from "@/lib/rbac/resolve";
import { FioriScope } from "@/components/fiori/Scope";
import RekapanNota from "./RekapanNota";

export default async function RekapanNotaPage() {
    const { perms } = await resolveRequestPermissionsH();
    return <FioriScope><RekapanNota permKeys={[...(perms ?? [])]} /></FioriScope>;
}
