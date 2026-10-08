/*
 * Tujuan: Rute /insentif-sales/saya (Fiori S4c): izin dari server, Insentif saya (salesman, ponsel): capaian, syarat, insentif bulan lalu di dalam FioriScope.
 * Caller: navigasi antarhalaman Insentif Sales (Rangka.tsx). Guard halaman: layout dashboard (insentif_sales.view);
 *   halaman tanpa izin aksinya menampilkan pesan, bukan isi (InsentifRangka).
 * Dependensi: aksesInsentif (izin + peran hierarki), FioriScope, PeranInsentif, Saya (klien).
 * Main Functions: Halaman.
 * Side Effects: Membaca session/permission dan identitas hierarki user.
 */
import { aksesInsentif } from "@/lib/insentif-akses";
import { FioriScope } from "@/components/fiori/Scope";
import { PeranInsentif } from "../Rangka";
import Saya from "../Saya";

export default async function Halaman() {
    const { permKeys, peran } = await aksesInsentif();
    return <FioriScope><PeranInsentif peran={peran}><Saya permKeys={permKeys} /></PeranInsentif></FioriScope>;
}
