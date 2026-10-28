/*
 * Tujuan: Umpan balik saat berpindah menu dashboard: kerangka judul, bar saringan, dan tabel bergaya Fiori, bukan layar kosong
 *   yang terbaca "macet". Shell (navigasi) tetap di tempatnya karena milik layout.
 * Caller: Next.js App Router, otomatis membungkus halaman di app/(dashboard) dengan Suspense.
 * Dependensi: FioriScope, kelas fi-* (fi-page, fi-fbar, fi-tablebox, fi-skel).
 * Main Functions: DashboardLoading.
 * Side Effects: Tidak ada. Pemuatan DATA di dalam halaman tetap tanggung jawab halamannya sendiri.
 */
import { FioriScope } from "@/components/fiori/Scope";

const Garis = ({ lebar, tinggi = 12 }: { lebar: string; tinggi?: number }) => <i aria-hidden style={{ width: lebar, height: tinggi }} />;

export default function DashboardLoading() {
    return (
        <FioriScope className="fi-page">
            {/* Satu pengumuman untuk seluruh kerangka; bagian visual di bawahnya aria-hidden. */}
            <div role="status" className="grid gap-4">
                <span className="sr-only">Memuat halaman</span>
                <div className="fi-skel" style={{ padding: 0 }}><Garis lebar="14rem" tinggi={24} /><Garis lebar="22rem" /></div>
                <div className="fi-fbar fi-skel" style={{ borderRadius: "var(--r-lg)" }}><Garis lebar="10rem" tinggi={16} /><Garis lebar="100%" tinggi={32} /></div>
                <div className="fi-tablebox fi-skel" style={{ borderRadius: "var(--r-lg)" }}>
                    {[94, 86, 78, 90, 70, 82].map((w) => <Garis key={w} lebar={`${w}%`} tinggi={16} />)}
                </div>
            </div>
        </FioriScope>
    );
}
