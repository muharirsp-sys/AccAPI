/*
 * Tujuan: Rute /rekap-promo (Fiori S4a): Overview Rekap promo di dalam FioriScope.
 * Caller: menu Promo & Klaim › Rekap Promo. Guard halaman: layout dashboard (summary.view).
 * Dependensi: FioriScope, RekapPromo (klien).
 * Main Functions: RekapPromoPage.
 * Side Effects: Tidak ada.
 */
import { FioriScope } from "@/components/fiori/Scope";
import RekapPromo from "./RekapPromo";

export default function RekapPromoPage() {
    return <FioriScope><RekapPromo /></FioriScope>;
}
