/*
 * Tujuan: Rute /insentif-sales/pengaturan (Fiori S4c): izin dari server, Object Page Pengaturan insentif: konstanta, setelan, hierarki, tautan akun di dalam FioriScope.
 * Caller: navigasi antarhalaman Insentif Sales (Rangka.tsx). Guard halaman: layout dashboard (insentif_sales.view);
 *   halaman tanpa izin aksinya menampilkan pesan, bukan isi (InsentifRangka).
 * Dependensi: aksesInsentif (izin + peran hierarki), FioriScope, PeranInsentif, Pengaturan (klien).
 * Main Functions: Halaman.
 * Side Effects: Membaca session/permission dan identitas hierarki user.
 */
import { aksesInsentif } from "@/lib/insentif-akses";
import { FioriScope } from "@/components/fiori/Scope";
import { PeranInsentif } from "../Rangka";
import Pengaturan from "../Pengaturan";

export default async function Halaman() {
    const { permKeys, peran } = await aksesInsentif();
    return <FioriScope><PeranInsentif peran={peran}><Pengaturan permKeys={permKeys} /></PeranInsentif></FioriScope>;
}
