/*
 * Tujuan: Rute /off-program-control/latihan: mode latihan OPC (owner 3 Nov 2026). Halaman dan jalur sendiri: satu pengajuan contoh
 *   dijalankan dari Supervisor sampai selesai di browser saja, dipandu tur. Tidak memanggil API apa pun dan tidak menyimpan data.
 * Caller: tombol "Mode latihan" di OFF Program Control (opc/Pemandu.tsx). Guard halaman: layout dashboard (off_program_control.view,
 *   prefix /off-program-control di lib/rbac.ts).
 * Dependensi: FioriScope, Latihan (klien).
 * Main Functions: LatihanOpcPage.
 * Side Effects: Tidak ada.
 */
import { FioriScope } from "@/components/fiori/Scope";
import Latihan from "./Latihan";

export default function LatihanOpcPage() {
    return <FioriScope><Latihan /></FioriScope>;
}
