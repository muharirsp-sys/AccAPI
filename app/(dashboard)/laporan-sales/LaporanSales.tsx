/*
 * Tujuan: Kerangka klien /laporan-sales: kepala halaman Fiori (jejak, judul, pilihan bulan) + navigasi jenis laporan (hanya tab yang izinnya
 *   dipegang, dari server). Isi tab = tab/<Tab>.tsx (satu slice per tab).
 * Caller: app/(dashboard)/laporan-sales/page.tsx.
 * Dependensi: lib/laporan-sales/kontrak (TAB), komponen tab, Fiori kit (fi-page, fi-subnav, FormField).
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
        <div className="fi-page">
            <header className="fi-page-head">
                <nav aria-label="Jejak halaman"><ol className="fi-crumb"><li><span>Operasional Sales</span></li><li><span aria-current="page">Laporan Sales</span></li></ol></nav>
                <div className="fi-page-bar">
                    <h1>Laporan Sales</h1>
                    <span className="fi-spacer" />
                    <FormField label="Bulan">
                        {(a) => <input {...a} type="month" value={bulan} max={bulanAwal} onChange={(e) => e.target.value && setBulan(e.target.value)} className="fi-input" />}
                    </FormField>
                </div>
            </header>
            {/* Tautan biasa + aria-current (audit No 118): pola tab ARIA butuh tombol panah dan roving tabindex yang tidak ada di sini. */}
            <nav className="fi-subnav" aria-label="Jenis laporan">
                {daftar.map((t) => (
                    <a key={t.id} href={`#${t.id}`} aria-current={t.id === aktif ? "page" : undefined}>{t.label}</a>
                ))}
            </nav>
            <div id="isi-laporan"><Isi bulan={bulan} /></div>
        </div>
    );
}
