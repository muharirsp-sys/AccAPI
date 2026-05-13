import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import UserManagement from "./UserManagement";

export default async function AdminUsersPage() {
    const session = await auth.api.getSession({ headers: await headers() });
    if (!session) {
        redirect("/login");
    }

    if (session.user.role !== "admin") {
        redirect("/");
    }

    return <UserManagement />;
}
