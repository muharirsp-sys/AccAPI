"use client";

import { useCallback, useEffect, useState } from "react";
import { RotateCcw, Filter, AlertTriangle, Loader2, RefreshCw, CheckCircle2 } from "lucide-react";
import { toast } from "sonner";
import { type Scope, type FreqRow, PRINCIPLES, SectionTitle, SummaryCard } from "../shared";

export default function TabFrekuensi({ scope }: { scope: Scope }) {
    const [rows, setRows] = useState<FreqRow[]>([]);
    const [loading, setLoading] = useState(true);
    const [filterPrinciple, setFilterPrinciple] = useState("");
    const [selectedSalesCode, setSelectedSalesCode] = useState(scope.salesCode ?? "");
    const today = new Date();
    const [selectedMonth, setSelectedMonth] = useState(today.getMonth() + 1);
    const [selectedYear] = useState(today.getFullYear());
    const [simulation, setSimulation] = useState<{
        totalSlots: number; capacity1x: number; capacity2x: number; capacity4x: number;
    } | null>(null);

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const p = new URLSearchParams({ month: String(selectedMonth), year: String(selectedYear) });
            if (selectedSalesCode) p.set("salesCode", selectedSalesCode);
            if (filterPrinciple) p.set("principle", filterPrinciple);
            const res = await fetch(`/api/form-kontrol/frequency?${p}`);
            const data = await res.json();
            setRows(data.rows ?? []);
            setSimulation(data.simulation ?? null);
        } catch { toast.error("Gagal memuat data frekuensi"); }
        finally { setLoading(false); }
    }, [selectedSalesCode, filterPrinciple, selectedMonth, selectedYear]);

    useEffect(() => { load(); }, [load]);

    const overVisitCount = rows.filter(r => r.overVisit).length;
    const totalSlots = simulation?.totalSlots ?? 480;

    return (
        <div className="space-y-4">
            <SectionTitle icon={RotateCcw} no={8} title="Kontrol Frekuensi Kunjungan"
                desc="Optimalkan coverage — hindari over-visit agar waktu salesman tidak terbuang" />

            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <SummaryCard label="Hari Kerja / Bulan" value={simulation ? Math.floor(totalSlots / 20) : 24} sub="estimasi" />
                <SummaryCard label="Kunjungan / Hari" value={20} sub="kapasitas" />
                <SummaryCard label="Total Slot" value={totalSlots} sub={`${Math.floor(totalSlots / 20)} × 20`} color="text-indigo-400" />
                <SummaryCard label="Over-Visit" value={overVisitCount} color={overVisitCount > 0 ? "text-amber-400" : "text-emerald-400"} />
            </div>

            <div className="bg-[#1a1c23]/60 border border-white/10 rounded-xl p-3 text-xs text-slate-400 space-y-1">
                <p>
                    Simulasi: <span className="text-white">{totalSlots} slot ÷ 1×/bulan = {simulation?.capacity1x ?? totalSlots} toko</span>
                    {" · "}<span className="text-white">÷ 2× = {simulation?.capacity2x ?? Math.floor(totalSlots / 2)} toko</span>
                    {" · "}<span className="text-white">÷ 4× = {simulation?.capacity4x ?? Math.floor(totalSlots / 4)} toko</span>
                </p>
                <p className="text-amber-400 flex items-center gap-1">
                    <AlertTriangle size={11} /> Toko 1×/bulan yang dikunjungi 2× = over-visit — coverage toko lain berkurang
                </p>
            </div>

            <div className="flex flex-wrap items-center gap-2 bg-[#1a1c23]/60 border border-white/10 rounded-xl px-4 py-3">
                <Filter size={14} className="text-slate-400" />
                <select value={filterPrinciple} onChange={e => setFilterPrinciple(e.target.value)}
                    className="bg-black/40 border border-white/10 rounded-lg text-xs text-white px-2 py-1.5">
                    <option value="">Semua Principle</option>
                    {PRINCIPLES.map(p => <option key={p} value={p}>{p}</option>)}
                </select>
                <select value={selectedMonth} onChange={e => setSelectedMonth(Number(e.target.value))}
                    className="bg-black/40 border border-white/10 rounded-lg text-xs text-white px-2 py-1.5">
                    {Array.from({ length: 12 }, (_, i) => i + 1).map(m => (
                        <option key={m} value={m}>{m.toString().padStart(2, "0")}/{selectedYear}</option>
                    ))}
                </select>
                {scope.allowedSalesCodes === null && (
                    <input value={selectedSalesCode} onChange={e => setSelectedSalesCode(e.target.value)}
                        placeholder="Kode Sales..." className="bg-black/40 border border-white/10 rounded-lg text-xs text-white px-2 py-1.5 w-32" />
                )}
                <button onClick={load} className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-white px-2 py-1.5 ml-auto">
                    <RefreshCw size={13} /> Refresh
                </button>
            </div>

            <div className="bg-[#1a1c23]/60 border border-white/10 rounded-xl overflow-hidden">
                {loading ? (
                    <div className="flex items-center justify-center py-12 text-slate-400 gap-2">
                        <Loader2 size={18} className="animate-spin" /> Memuat...
                    </div>
                ) : rows.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-12 text-slate-500 gap-2">
                        <RotateCcw size={32} className="opacity-30" />
                        <p className="text-sm">Belum ada data. Pastikan JKS sudah diimport dan sales code diisi.</p>
                    </div>
                ) : (
                    <div className="overflow-x-auto">
                        <table className="w-full text-xs">
                            <thead>
                                <tr className="border-b border-white/10 bg-black/20">
                                    {["Kode", "Nama Toko", "Pola Minggu", "Frekuensi", "Aktual", "Status"].map(h => (
                                        <th key={h} className="text-left px-3 py-2.5 text-slate-400 font-semibold whitespace-nowrap">{h}</th>
                                    ))}
                                </tr>
                            </thead>
                            <tbody>
                                {rows.map(r => (
                                    <tr key={r.custCode} className={`border-b border-white/5 transition-colors ${r.overVisit ? "bg-amber-500/5 hover:bg-amber-500/10" : "hover:bg-white/5"}`}>
                                        <td className="px-3 py-2 text-slate-300 font-mono">{r.custCode}</td>
                                        <td className="px-3 py-2 text-white">{r.custName}</td>
                                        <td className="px-3 py-2 text-slate-400 capitalize">{r.mingguPattern}</td>
                                        <td className="px-3 py-2 text-slate-300">{r.visitFrequency}×/bulan</td>
                                        <td className={`px-3 py-2 font-semibold ${r.overVisit ? "text-amber-400" : "text-white"}`}>{r.actualVisits}×</td>
                                        <td className="px-3 py-2">
                                            {r.overVisit ? (
                                                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-semibold bg-amber-500/15 text-amber-400 border border-amber-500/30">
                                                    <AlertTriangle size={10} /> Over-visit
                                                </span>
                                            ) : (
                                                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-semibold bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">
                                                    <CheckCircle2 size={10} /> Normal
                                                </span>
                                            )}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>
        </div>
    );
}
