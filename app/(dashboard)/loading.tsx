/*
 * Tujuan: Umpan balik saat berpindah menu dashboard — kerangka judul, saringan, dan tabel, bukan
 *   layar kosong yang terbaca "macet". Sidebar tetap di tempatnya (milik layout, bukan halaman).
 * Caller: Next.js App Router, otomatis membungkus halaman di app/(dashboard) dengan Suspense.
 * Dependensi: components/ui/AsyncState (LoadingState).
 * Main Functions: DashboardLoading.
 * Side Effects: Tidak ada.
 *
 * Bentuknya meniru halaman operasional yang umum (judul, baris saringan, tabel) supaya tidak ada
 * lompatan tata letak besar saat halaman aslinya muncul. Pemuatan DATA di dalam halaman tetap
 * tanggung jawab halamannya sendiri.
 */
import { LoadingState } from "@/components/ui/AsyncState";

export default function DashboardLoading() {
    return (
        <div className="space-y-4 p-6" aria-label="Memuat halaman">
            <LoadingState embedded rows={1} label="Memuat halaman" />
            <LoadingState rows={6} label="Memuat data" />
        </div>
    );
}
