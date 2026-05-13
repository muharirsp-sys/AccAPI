import SidebarLayout from "@/components/SidebarLayout";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";

export default async function DashboardLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    const session = await auth.api.getSession({
        headers: await headers()
    });

    if (!session) {
        redirect("/login");
    }

    return (
        <SidebarLayout>
            {children}
            <script
                dangerouslySetInnerHTML={{
                    __html: `if ('serviceWorker' in navigator) { window.addEventListener('load', function() { navigator.serviceWorker.register('/sw.js'); }); }`,
                }}
            />
        </SidebarLayout>
    );
}
