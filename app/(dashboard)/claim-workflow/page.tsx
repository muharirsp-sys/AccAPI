/*
 * Tujuan: Rute /claim-workflow (Fiori S4b): izin dari server, List Report klaim di dalam FioriScope.
 * Caller: menu Promo & Klaim › Claim Workflow. Guard halaman: layout dashboard (claim_workflow.view).
 * Dependensi: resolveRequestPermissionsH, FioriScope, ClaimList (klien).
 * Main Functions: ClaimWorkflowPage.
 * Side Effects: Membaca session/permission.
 */
import { resolveRequestPermissionsH } from "@/lib/rbac/resolve";
import { FioriScope } from "@/components/fiori/Scope";
import ClaimList from "./ClaimList";

export default async function ClaimWorkflowPage({ searchParams }: { searchParams: Promise<{ ditutup?: string | string[] }> }) {
    const [sp, { perms }] = await Promise.all([searchParams, resolveRequestPermissionsH()]);
    return <FioriScope><ClaimList permKeys={[...(perms ?? [])]} ditutup={typeof sp.ditutup === "string" ? sp.ditutup : undefined} /></FioriScope>;
}
