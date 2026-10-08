/*
 * Tujuan: Rute /form-kontrol (Fiori S5, it05): izin dari server, shell Form Kontrol (navigasi tab per peran) di dalam FioriScope.
 * Caller: menu Operasional Sales › Form Kontrol; pintasan peran Salesman/SM. Guard halaman: layout dashboard (form_kontrol.view).
 * Dependensi: resolveRequestPermissionsH, FioriScope, FormKontrol (klien).
 * Main Functions: FormKontrolPage.
 * Side Effects: Membaca session/permission.
 */
import { resolveRequestPermissionsH } from "@/lib/rbac/resolve";
import { FioriScope } from "@/components/fiori/Scope";
import FormKontrol from "./FormKontrol";

export default async function FormKontrolPage() {
    const { perms } = await resolveRequestPermissionsH();
    return <FioriScope><FormKontrol permKeys={[...(perms ?? [])]} /></FioriScope>;
}
