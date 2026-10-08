/*
 * Tujuan: Rute /insentif-sales (Fiori S4c): Dashboard insentif per peran. Akun tanpa izin Dashboard dan tautan lama `?view=`
 *   dialihkan ke halaman insentif yang boleh dibukanya (lib/insentif-ui.halamanAwal), periode/saringan ikut dibawa.
 * Caller: menu Operasional Sales › Insentif Sales, pintasan peran SM/Salesman. Guard halaman: layout dashboard (insentif_sales.view).
 * Dependensi: aksesInsentif (izin + peran hierarki), FioriScope, PeranInsentif, lib/insentif-ui, Dashboard (klien).
 * Main Functions: InsentifSalesPage.
 * Side Effects: Membaca session/permission dan identitas hierarki user; redirect.
 */
import { redirect } from "next/navigation";
import { aksesInsentif } from "@/lib/insentif-akses";
import { FioriScope } from "@/components/fiori/Scope";
import { HALAMAN, halamanAwal } from "@/lib/insentif-ui";
import { PeranInsentif } from "./Rangka";
import Dashboard from "./Dashboard";

export default async function InsentifSalesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
    const [sp, { permKeys, peran }] = await Promise.all([searchParams, aksesInsentif()]);
    const awal = halamanAwal(new Set(permKeys), typeof sp.view === "string" ? sp.view : null, peran);
    if (awal !== "dashboard" || sp.view !== undefined) {
        const q = new URLSearchParams();
        for (const k of ["month", "year", "principle", "branch", "sm"]) { const v = sp[k]; if (typeof v === "string") q.set(k, v); }
        const href = HALAMAN.find((h) => h.key === awal)!.href;
        redirect(q.size ? `${href}?${q}` : href);
    }
    return <FioriScope><PeranInsentif peran={peran}><Dashboard permKeys={permKeys} /></PeranInsentif></FioriScope>;
}
