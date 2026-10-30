/*
 * Tujuan: Rute /summary/program: Summary Program On Faktur jalur Mistral (tiga pembaca + penjaga) di dalam FioriScope.
 * Caller: tombol "Summary Program (Mistral)" di /summary. Guard halaman: layout dashboard (prefix /summary = summary.view).
 * Dependensi: resolveRequestPermissionsH, FioriScope, SummaryProgram (klien).
 * Main Functions: SummaryProgramPage.
 * Side Effects: Membaca session/permission.
 */
import { resolveRequestPermissionsH } from "@/lib/rbac/resolve";
import { FioriScope } from "@/components/fiori/Scope";
import SummaryProgram from "./SummaryProgram";

export default async function SummaryProgramPage() {
    const { perms } = await resolveRequestPermissionsH();
    return <FioriScope><SummaryProgram permKeys={[...(perms ?? [])]} /></FioriScope>;
}
