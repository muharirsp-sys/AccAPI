/*
 * Tujuan: Rute /off-program-control/pantau: Pantau Pengajuan Promo (owner 3 Nov 2026). Salesman melihat progres pengajuan OPC principal yang
 *   ia tangani (sudah diajukan, sudah dibayar, bukti bayar). Baca saja.
 * Caller: menu Promo & Klaim › Pantau Pengajuan. Guard halaman: layout dashboard (pagePermissions /off-program-control/pantau =
 *   off_program_control.pantau_sales, lib/rbac.ts; entri itu berada SEBELUM /off-program-control karena pencocokan = entri pertama).
 * Dependensi: FioriScope, Pantau (klien).
 * Main Functions: PantauPengajuanPage.
 * Side Effects: Tidak ada (data dimuat klien dari GET /api/off-program-control/pantau).
 */
import { FioriScope } from "@/components/fiori/Scope";
import Pantau from "./Pantau";

export default function PantauPengajuanPage() {
    return <FioriScope><Pantau /></FioriScope>;
}
