/*
 * Tujuan: Rute /form-kontrol/visit/[custCode]/order (owner 14 Nov 2026): halaman order kunjungan, dibuka otomatis sesudah hasil kunjungan
 *   ORDER disimpan. Parameter kunjungan + izin + id akun (draf order per akun) dari server, isi di OrderKunjungan (klien).
 * Caller: ../Kunjungan.tsx (langkah Status/Order, router.push).
 * Dependensi: resolveRequestPermissionsH, FioriScope, lib/beranda (witaToday), ./OrderKunjungan.
 * Main Functions: OrderKunjunganPage.
 * Side Effects: Membaca session/permission.
 */
import { resolveRequestPermissionsH } from "@/lib/rbac/resolve";
import { FioriScope } from "@/components/fiori/Scope";
import { witaToday } from "@/lib/beranda";
import OrderKunjungan from "./OrderKunjungan";

type SP = Record<string, string | string[] | undefined>;

export default async function OrderKunjunganPage({ params, searchParams }: { params: Promise<{ custCode: string }>; searchParams: Promise<SP> }) {
    const [{ custCode }, sp, { perms, session }] = await Promise.all([params, searchParams, resolveRequestPermissionsH()]);
    const ambil = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : "");
    let kode = custCode;
    try { kode = decodeURIComponent(custCode); } catch { /* sudah terurai */ }
    return (
        <FioriScope>
            <OrderKunjungan custCode={kode} salesCode={ambil("salesCode")} principle={ambil("principle")} date={ambil("date") || witaToday()}
                akunId={session?.user.id ?? ""} izinFk={[...(perms ?? [])].filter((k) => k.startsWith("form_kontrol."))} />
        </FioriScope>
    );
}
