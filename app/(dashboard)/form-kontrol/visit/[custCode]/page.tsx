/*
 * Tujuan: Rute /form-kontrol/visit/[custCode] (Fiori S5): parameter kunjungan + izin dari server, wizard Kunjungan di dalam FioriScope.
 * Caller: Rute hari ini (TabAo) — tautan per toko dengan ?salesCode&principle&date.
 * Dependensi: resolveRequestPermissionsH, FioriScope, lib/beranda (witaToday), Kunjungan (klien).
 * Main Functions: KunjunganPage.
 * Side Effects: Membaca session/permission.
 *
 * Tanggal tanpa parameter = hari ini WITA menurut jam server (bukan UTC). Tulis kunjungan butuh izin form_kontrol.submit; aturan
 * penguncian tombol = alasanIzinFk (../../shared, sama dengan tab Form Kontrol); server tetap yang menolak.
 */
import { resolveRequestPermissionsH } from "@/lib/rbac/resolve";
import { FioriScope } from "@/components/fiori/Scope";
import { witaToday } from "@/lib/beranda";
import Kunjungan from "./Kunjungan";

type SP = Record<string, string | string[] | undefined>;

export default async function KunjunganPage({ params, searchParams }: { params: Promise<{ custCode: string }>; searchParams: Promise<SP> }) {
    const [{ custCode }, sp, { perms }] = await Promise.all([params, searchParams, resolveRequestPermissionsH()]);
    const ambil = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : "");
    let kode = custCode;
    try { kode = decodeURIComponent(custCode); } catch { /* sudah terurai */ }
    return (
        <FioriScope>
            <Kunjungan custCode={kode} salesCode={ambil("salesCode")} principle={ambil("principle")} date={ambil("date") || witaToday()}
                izinFk={[...(perms ?? [])].filter((k) => k.startsWith("form_kontrol."))} />
        </FioriScope>
    );
}
