/*
 * Tujuan: Rute /admin/users (Fiori S7a): gerbang server + layar User (FCL) di dalam FioriScope.
 * Caller: menu Pengaturan › User. Guard: layout dashboard (pagePermissions /admin/users) + gerbang klien SidebarLayout + halaman ini.
 * Dependensi: resolveRequestPermissionsH, FioriScope, AccessDenied, Pengguna (klien).
 * Main Functions: AdminUsersPage.
 * Side Effects: Membaca session/permission; redirect /login tanpa sesi.
 * Gerbang (owner S7-1 11 Okt): `users.view` ATAU `users.manage`; `users.view` = baca-saja (tulis = users.manage, ditegakkan API).
 *   Layout/SidebarLayout memakai `pagePermissions` `/admin/users` (users.view, anyOf users.manage) — kunci yang sama dengan cek di sini.
 */
import { redirect } from "next/navigation";
import { resolveRequestPermissionsH } from "@/lib/rbac/resolve";
import { FioriScope } from "@/components/fiori/Scope";
import AccessDenied from "@/components/AccessDenied";
import Pengguna from "./Pengguna";

export default async function AdminUsersPage() {
    const { session, perms } = await resolveRequestPermissionsH();
    if (!session || !perms) redirect("/login");
    if (!perms.has("users.view") && !perms.has("users.manage")) {
        return <AccessDenied message="Halaman ini butuh izin Lihat user (users.view) atau Kelola user (users.manage)." />;
    }
    return <FioriScope><Pengguna permKeys={[...perms]} aktorId={session.user.id} /></FioriScope>;
}
