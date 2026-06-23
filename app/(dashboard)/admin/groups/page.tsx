import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { getUserPermissions } from "@/lib/rbac/resolve";
import GroupManagement from "./GroupManagement";

export default async function AdminGroupsPage() {
    const session = await auth.api.getSession({ headers: await headers() });
    if (!session) redirect("/login");
    const perms = await getUserPermissions(session.user.id);
    if (!perms.has("users.manage")) redirect("/");
    return <GroupManagement />;
}
