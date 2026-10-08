/*
 * Tujuan: Rute /claim-workflow/[id] (Fiori S4b): izin dari server, Object Page satu klaim di dalam FioriScope.
 * Caller: daftar /claim-workflow, OFF Program Control. Guard halaman: layout dashboard (claim_workflow.view).
 * Dependensi: resolveRequestPermissionsH, FioriScope, ClaimDetail (klien).
 * Main Functions: ClaimDetailPage.
 * Side Effects: Membaca session/permission.
 */
import { resolveRequestPermissionsH } from "@/lib/rbac/resolve";
import { FioriScope } from "@/components/fiori/Scope";
import ClaimDetail from "./ClaimDetail";

export default async function ClaimDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ focus?: string | string[] }> }) {
    const [{ id }, sp, { perms }] = await Promise.all([params, searchParams, resolveRequestPermissionsH()]);
    return <FioriScope><ClaimDetail id={id} focus={typeof sp.focus === "string" ? sp.focus : undefined} permKeys={[...(perms ?? [])]} /></FioriScope>;
}
