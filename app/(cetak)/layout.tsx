/*
 * Tujuan: Layout khusus halaman cetak gudang — tanpa sidebar, tanpa chat widget, latar putih.
 *         Kertas yang keluar dari printer harus berisi rekapan saja, bukan kerangka aplikasi.
 * Caller: app/(cetak)/** (lembar rekapan & TTF).
 * Dependensi: requirePermissionH (guard sendiri: grup ini di luar (dashboard) yang biasa menjaga).
 * Main Functions: CetakLayout.
 * Side Effects: Membaca session/permission; redirect ke login bila tidak berhak.
 */
import { redirect } from "next/navigation";
import { requirePermissionH } from "@/lib/rbac/resolve";

export const dynamic = "force-dynamic";

export default async function CetakLayout({ children }: { children: React.ReactNode }) {
    const gate = await requirePermissionH("rekapan_nota.print");
    if (gate.response) redirect("/login");

    return (
        <div className="min-h-screen bg-white p-6 text-black print:p-0">
            <style>{`
                @page { size: A4 portrait; margin: 10mm; }
                @media print { .layar-saja { display: none !important; } }
                .cetak table { width: 100%; border-collapse: collapse; font-size: 10px; }
                .cetak th, .cetak td { border: 1px solid #999; padding: 2px 4px; text-align: left; }
                .cetak th { background: #eee; }
                .cetak td.angka { text-align: right; font-variant-numeric: tabular-nums; }
            `}</style>
            {children}
        </div>
    );
}
