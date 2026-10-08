/*
 * Tujuan: Rute /aturan-promo (Fiori S4a): izin dari server, Aturan promo (FCL) di dalam FioriScope.
 * Caller: menu Promo & Klaim › Aturan Promo. Guard halaman: layout dashboard (summary.view).
 * Dependensi: resolveRequestPermissionsH, FioriScope, AturanPromo (klien).
 * Main Functions: AturanPromoPage.
 * Side Effects: Membaca session/permission.
 */
import { resolveRequestPermissionsH } from "@/lib/rbac/resolve";
import { FioriScope } from "@/components/fiori/Scope";
import AturanPromo from "./AturanPromo";

export default async function AturanPromoPage() {
    const { perms } = await resolveRequestPermissionsH();
    return <FioriScope><AturanPromo permKeys={[...(perms ?? [])]} /></FioriScope>;
}
