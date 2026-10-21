/*
 * Tujuan: Kerangka klien /laporan-sales: pilihan bulan + tab (hanya tab yang izinnya dipegang, dari server). Isi tab = tab/<Tab>.tsx (satu slice per tab).
 * Caller: app/(dashboard)/laporan-sales/page.tsx.
 * Dependensi: lib/laporan-sales/kontrak (TAB), komponen tab, Fiori kit.
 * Main Functions: LaporanSales.
 * Side Effects: Tab aktif disimpan di hash URL (#top30 …) agar bisa dibagikan/dimuat ulang.
 */
"use client";

import { useState, useSyncExternalStore, type ComponentType } from "react";
import { FormField } from "@/components/fiori/interactive";
import { TAB, type PropsTab, type TabId } from "@/lib/laporan-sales/kontrak";
import Top30 from "./tab/Top30";
import Harian from "./tab/Harian";
import Target from "./tab/Target";
import DropSize from "./tab/DropSize";
import Coverage from "./tab/Coverage";
import TidakOrder from "./tab/TidakOrder";

const ISI: Record<TabId, ComponentType<PropsTab>> = { top30: Top30, harian: Harian, target: Target, "drop-size": DropSize, coverage: Coverage, "tidak-order": TidakOrder };

const dengarHash = (cb: () => void) => { window.addEventListener("hashchange", cb); return () => window.removeEventListener("hashchange", cb); };

export default function LaporanSales({ tab, bulanAwal }: { tab: TabId[]; bulanAwal: string }) {
    const hash = useSyncExternalStore(dengarHash, () => window.location.hash.slice(1), () => "");
    const aktif: TabId = tab.includes(hash as TabId) ? (hash as TabId) : tab[0];
    const [bulan, setBulan] = useState(bulanAwal);
    const Isi = ISI[aktif];
    const daftar = TAB.filter((t) => tab.includes(t.id));
    return (
        <div className="space-y-4 p-4">
            <div className="flex flex-wrap items-end justify-between gap-3">
                <h1 className="text-xl font-semibold">Laporan Sales</h1>
                <FormField label="Bulan">
                    {(a) => <input {...a} type="month" value={bulan} max={bulanAwal} onChange={(e) => e.target.value && setBulan(e.target.value)} className="rounded border px-2 py-1" />}
                </FormField>
            </div>
            <div role="tablist" aria-label="Jenis laporan" className="flex gap-1 overflow-x-auto border-b">
                {daftar.map((t) => (
                    <a key={t.id} role="tab" href={`#${t.id}`} aria-selected={t.id === aktif} aria-controls="isi-laporan"
                        className={`whitespace-nowrap px-3 py-2 text-sm ${t.id === aktif ? "border-b-2 border-current font-semibold" : "opacity-70"}`}>
                        {t.label}
                    </a>
                ))}
            </div>
            <div id="isi-laporan" role="tabpanel"><Isi bulan={bulan} /></div>
        </div>
    );
}
