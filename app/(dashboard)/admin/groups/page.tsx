/*
 * Tujuan: Rute /admin/groups (Fiori S7a): gerbang server + layar Akses Group (FCL) di dalam FioriScope.
 * Caller: menu Pengaturan › Akses Group; tautan dari layar User. Guard: layout dashboard (pagePermissions /admin/groups = users.manage) + halaman ini.
 * Dependensi: resolveRequestPermissionsH, FioriScope, AccessDenied, AksesGrup (klien).
 * Main Functions: AdminGroupsPage.
 * Side Effects: Membaca session/permission; redirect /login tanpa sesi.
 * Catatan: tetap `users.manage` — GET /api/admin/groups dan /groups/[id] (kontrak S7-1 §5.8) hanya menerima users.manage.
 */
import { redirect } from "next/navigation";
import { resolveRequestPermissionsH } from "@/lib/rbac/resolve";
import { FioriScope } from "@/components/fiori/Scope";
import AccessDenied from "@/components/AccessDenied";
import AksesGrup from "./AksesGrup";

export default async function AdminGroupsPage() {
    const { session, perms } = await resolveRequestPermissionsH();
    if (!session || !perms) redirect("/login");
    if (!perms.has("users.manage")) {
        return <AccessDenied message="Halaman ini butuh izin Kelola user (users.manage)." />;
    }
    return <FioriScope><AksesGrup aktorId={session.user.id} /></FioriScope>;
}
