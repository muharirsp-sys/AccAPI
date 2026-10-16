/*
 * Tujuan: Rute /supervisor-review (SR-2): layar ringkasan harian per salesman di dalam FioriScope.
 * Caller: menu Lapangan › Supervisor Review. Guard halaman: layout dashboard (pagePermissions /supervisor-review = supervisor_review.view, dipasang SR-1).
 * Dependensi: FioriScope, todayWita, SupervisorReview (klien).
 * Main Functions: SupervisorReviewPage.
 * Side Effects: Tidak ada. Tanggal bawaan dihitung server (WITA) agar render server dan klien sama.
 */
import { FioriScope } from "@/components/fiori/Scope";
import { todayWita } from "@/lib/insentif-payment-date";
import SupervisorReview from "./SupervisorReview";

export default function SupervisorReviewPage() {
    return <FioriScope><SupervisorReview hariIni={todayWita(new Date())} /></FioriScope>;
}
