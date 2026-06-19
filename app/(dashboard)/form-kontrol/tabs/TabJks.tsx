"use client";

import { useCallback, useEffect, useState } from "react";
import { MapPin, Filter, Upload, Download, AlertTriangle, Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { type Scope, type JksRow, PRINCIPLES, HARI, SectionTitle } from "../shared";

export default function TabJks({ scope }: { scope: Scope }) {
    const [rows, setRows] = useState<JksRow[]>([]);
    const [loading, setLoading] = useState(true);
    const [importing, setImporting] = useState(false);
    const [filterPrinciple, setFilterPrinciple] = useState("");
    const [filterHari, setFilterHari] = useState("");
    const [filterSales, setFilterSales] = useState("");

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const p = new URLSearchParams();
            if (filterPrinciple) p.set("principle", filterPrinciple);
            if (filterHari) p.set("hari", filterHari);
            if (filterSales) p.set("salesCode", filterSales);
            if (scope.allowedSalesCodes) p.set("salesCodes", scope.allowedSalesCodes.join(","));
            const res = await fetch(`/api/form-kontrol/jks?${p}`);
            const data = await res.json();
            setRows(data.rows ?? []);
        } catch { toast.error("Gagal memuat data JKS"); }
        finally { setLoading(false); }
    }, [filterPrinciple, filterHari, filterSales, scope.allowedSalesCodes]);

    useEffect(() => { load(); }, [load]);

    async function handleImport(e: React.ChangeEvent<HTMLInputElement>) {
        const file = e.target.files?.[0];
        if (!file) return;
        setImporting(true);
        try {
            const fd = new FormData();
            fd.append("file", file);
            const res = await fetch("/api/form-kontrol/jks", { method: "POST", body: fd });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error ?? "Gagal import");
            toast.success(`Import berhasil: ${data.imported ?? 0} baris`);
            load();
        } catch (err: unknown) {
            toast.error(err instanceof Error ? err.message : "Gagal import");
        } finally {
            setImporting(false);
            e.target.value = "";
        }
    }

    const missingSchedule = rows.filter(r => !r.hariKunjungan).length;

    return (
        <div className="space-y-4">
            <SectionTitle icon={MapPin} no={1} title="Kontrol JKS"
                desc="Master Jadwal Kunjungan Salesman — single source of truth daftar toko per salesman" />

            {missingSchedule > 0 && (
                <div className="flex items-center gap-2 bg-amber-500/10 border border-amber-500/30 rounded-lg px-4 py-2.5 text-amber-400 text-sm">
                    <AlertTriangle size={15} />
                    {missingSchedule} toko belum memiliki jadwal hari kunjungan — wajib dilengkapi
                </div>
            )}

            <div className="flex flex-wrap items-center gap-2 bg-[#1a1c23]/60 border border-white/10 rounded-xl px-4 py-3">
                <Filter size={14} className="text-slate-400" />
                <select value={filterPrinciple} onChange={e => setFilterPrinciple(e.target.value)}
                    className="bg-black/40 border border-white/10 rounded-lg text-xs text-white px-2 py-1.5">
                    <option value="">Semua Principle</option>
                    {PRINCIPLES.map(p => <option key={p} value={p}>{p}</option>)}
                </select>
                <select value={filterHari} onChange={e => setFilterHari(e.target.value)}
                    className="bg-black/40 border border-white/10 rounded-lg text-xs text-white px-2 py-1.5">
                    <option value="">Semua Hari</option>
                    {HARI.map(h => <option key={h} value={h}>{h}</option>)}
                </select>
                {scope.allowedSalesCodes === null && (
                    <input value={filterSales} onChange={e => setFilterSales(e.target.value)}
                        placeholder="Kode Sales..." className="bg-black/40 border border-white/10 rounded-lg text-xs text-white px-2 py-1.5 w-32" />
                )}
                <button onClick={load} className="ml-auto flex items-center gap-1.5 text-xs text-slate-400 hover:text-white px-2 py-1.5">
                    <RefreshCw size={13} /> Refresh
                </button>
                <label className={`flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg font-semibold cursor-pointer transition-colors ${importing ? "bg-indigo-700 text-indigo-200" : "bg-indigo-600 hover:bg-indigo-500 text-white"}`}>
                    {importing ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} />}
                    Import Excel
                    <input type="file" accept=".xlsx,.xls" className="hidden" onChange={handleImport} disabled={importing} />
                </label>
                <button className="flex items-center gap-1.5 text-xs bg-black/40 border border-white/10 hover:border-white/20 text-slate-300 px-3 py-1.5 rounded-lg">
                    <Download size={13} /> Template
                </button>
            </div>

            <div className="bg-[#1a1c23]/60 border border-white/10 rounded-xl overflow-hidden">
                {loading ? (
                    <div className="flex items-center justify-center py-16 text-slate-400 gap-2">
                        <Loader2 size={18} className="animate-spin" /> Memuat data JKS...
                    </div>
                ) : rows.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-16 text-slate-500 gap-2">
                        <MapPin size={32} className="opacity-30" />
                        <p className="text-sm">Belum ada data JKS. Import dari Excel untuk memulai.</p>
                    </div>
                ) : (
                    <div className="overflow-x-auto">
                        <table className="w-full text-xs">
                            <thead>
                                <tr className="border-b border-white/10 bg-black/20">
                                    {["Kode", "Nama Toko", "Market", "Kota", "Hari", "Pola", "Area", "Rayon", "Principle", "Freq", "Status"].map(h => (
                                        <th key={h} className="text-left px-3 py-2.5 text-slate-400 font-semibold whitespace-nowrap">{h}</th>
                                    ))}
                                </tr>
                            </thead>
                            <tbody>
                                {rows.map(r => (
                                    <tr key={r.id} className="border-b border-white/5 hover:bg-white/5 transition-colors">
                                        <td className="px-3 py-2 text-slate-300 font-mono">{r.custCode}</td>
                                        <td className="px-3 py-2 text-white font-medium">{r.custName}</td>
                                        <td className="px-3 py-2 text-slate-400">{r.market}</td>
                                        <td className="px-3 py-2 text-slate-400">{r.kota}</td>
                                        <td className="px-3 py-2 text-slate-300">{r.hariKunjungan || <span className="text-amber-400">—</span>}</td>
                                        <td className="px-3 py-2 text-slate-400 capitalize">{r.mingguPattern}</td>
                                        <td className="px-3 py-2 text-slate-400">{r.area}</td>
                                        <td className="px-3 py-2 text-slate-400">{r.rayon}</td>
                                        <td className="px-3 py-2 text-slate-300">{r.principle}</td>
                                        <td className="px-3 py-2 text-slate-400">{r.visitFrequency}×</td>
                                        <td className="px-3 py-2">
                                            <span className={`inline-flex px-2 py-0.5 rounded text-xs font-semibold ${r.isActive ? "bg-emerald-500/15 text-emerald-400" : "bg-slate-500/15 text-slate-400"}`}>
                                                {r.isActive ? "Aktif" : "Nonaktif"}
                                            </span>
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
