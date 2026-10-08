/*
 * Tujuan: Rute /insentif-sales/pembayaran (Fiori S4c): izin dari server, Worklist Pembayaran insentif (Finance) di dalam FioriScope.
 * Caller: navigasi antarhalaman Insentif Sales (Rangka.tsx). Guard halaman: layout dashboard (insentif_sales.view);
 *   halaman tanpa izin aksinya menampilkan pesan, bukan isi (InsentifRangka).
 * Dependensi: aksesInsentif (izin + peran hierarki), FioriScope, PeranInsentif, Pembayaran (klien).
 * Main Functions: Halaman.
 * Side Effects: Membaca session/permission dan identitas hierarki user.
 */
import { aksesInsentif } from "@/lib/insentif-akses";
import { FioriScope } from "@/components/fiori/Scope";
import { PeranInsentif } from "../Rangka";
import Pembayaran from "../Pembayaran";

export default async function Halaman() {
    const { permKeys, peran } = await aksesInsentif();
    return <FioriScope><PeranInsentif peran={peran}><Pembayaran permKeys={permKeys} /></PeranInsentif></FioriScope>;
}
