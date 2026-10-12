/*
 * Tujuan: Rute /normalisasi-diskon (Fiori S4a): izin dari server, worklist Normalisasi diskon di dalam FioriScope.
 * Caller: menu Promo & Klaim › Normalisasi Diskon; kartu Tak bertuan di Rekap Promo. Guard halaman: layout (summary.view).
 * Dependensi: resolveRequestPermissionsH, FioriScope, Normalisasi (klien).
 * Main Functions: NormalisasiDiskonPage.
 * Side Effects: Membaca session/permission.
 */
import { resolveRequestPermissionsH } from "@/lib/rbac/resolve";
import { FioriScope } from "@/components/fiori/Scope";
import Normalisasi from "./Normalisasi";

export default async function NormalisasiDiskonPage({ searchParams }: { searchParams: Promise<{ from?: string; to?: string; principal?: string }> }) {
    const [{ perms }, sp] = await Promise.all([resolveRequestPermissionsH(), searchParams]);
    const ymd = (v?: string) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined);
    return <FioriScope><Normalisasi permKeys={[...(perms ?? [])]} awal={{ from: ymd(sp.from), to: ymd(sp.to), principal: sp.principal }} /></FioriScope>;
}
