import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { isLocalAuthBypassEnabled } from "@/lib/local-dev-auth";
import { rolePermissionPresets } from "@/lib/rbac";
import { getUserPermissions } from "@/lib/rbac/resolve";
import AccessDenied from "@/components/AccessDenied";
import GroupManagement from "./GroupManagement";

export default async function AdminGroupsPage() {
    const requestHeaders = await headers();
    const session = await auth.api.getSession({ headers: requestHeaders });
    const isLocalDev = isLocalAuthBypassEnabled(requestHeaders);
    if (!session && !isLocalDev) redirect("/login");
    const perms = isLocalDev
        ? new Set(Object.entries(rolePermissionPresets.admin).flatMap(([moduleName, actions]) => (actions || []).map((action) => `${moduleName}.${action}`)))
        : await getUserPermissions(session!.user.id);
    if (!perms.has("users.manage")) {
        return <AccessDenied message="Anda butuh izin Kelola Pengguna untuk membuka halaman ini." />;
    }
    return <GroupManagement />;
}
