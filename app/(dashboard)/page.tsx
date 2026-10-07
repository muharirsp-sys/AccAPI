/*
 * Tujuan: Beranda ruang kerja per peran (Fiori Launchpad) — sapaan WITA, lalu Beranda klien yang memuat tile tugas.
 * Caller: Next.js route /.
 * Dependensi: Better Auth, RBAC union, FioriScope, Beranda (klien).
 * Main Functions: DashboardLanding.
 * Side Effects: Membaca session/permission; tidak menampilkan statistik simulasi.
 */
import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { rolePermissionPresets } from "@/lib/rbac";
import { getUserPermissions } from "@/lib/rbac/resolve";
import { isLocalAuthBypassEnabled } from "@/lib/local-dev-auth";
import { FioriScope } from "@/components/fiori/Scope";
import Beranda from "./Beranda";

export default async function DashboardLanding({ searchParams }: { searchParams: Promise<{ peran?: string }> }) {
    const requestHeaders = await headers();
    const session = await auth.api.getSession({ headers: requestHeaders }).catch(() => null);
    const userId = String(session?.user?.id || "");
    const permKeys = isLocalAuthBypassEnabled(requestHeaders)
        ? new Set(Object.entries(rolePermissionPresets.admin).flatMap(([moduleName, actions]) => (actions || []).map(action => `${moduleName}.${action}`)))
        : userId ? await getUserPermissions(userId) : new Set<string>();
    // Sapaan dan tanggal dihitung di server (WITA) supaya tidak berbeda dengan render klien.
    const now = new Date();
    const hour = Number(new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hourCycle: "h23", timeZone: "Asia/Makassar" }).format(now));
    const greeting = hour < 11 ? "Selamat pagi" : hour < 15 ? "Selamat siang" : hour < 19 ? "Selamat sore" : "Selamat malam";
    const dateLabel = `${new Intl.DateTimeFormat("id-ID", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Makassar" }).format(now)} · ${new Intl.DateTimeFormat("id-ID", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Makassar" }).format(now)} WITA`;
    const firstName = (session?.user?.name || "").trim().split(/\s+/)[0] || "Tim";
    // Pratinjau Beranda peran lain hanya di development (izin tetap milik user yang masuk).
    const peran = process.env.NODE_ENV !== "production" ? (await searchParams).peran : undefined;
    return (
        <FioriScope>
            <Beranda permKeys={[...permKeys]} firstName={firstName} greeting={greeting} dateLabel={dateLabel} previewProfile={peran} />
        </FioriScope>
    );
}
