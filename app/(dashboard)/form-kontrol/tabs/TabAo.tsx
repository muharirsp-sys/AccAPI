"use client";

import { useCallback, useEffect, useState } from "react";
import { Target, AlertTriangle, Loader2, RefreshCw, Save, Star, StarOff, Clock, TrendingUp } from "lucide-react";
import Link from "next/link";
import { toast } from "sonner";
import { type Scope, type AoRow, PRINCIPLES, SectionTitle, SummaryCard, StatusBadge } from "../shared";

export default function TabAo({ scope }: { scope: Scope }) {
    const [rows, setRows] = useState<AoRow[]>([]);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [selectedDate, setSelectedDate] = useState(() => new Date().toISOString().slice(0, 10));
    const [selectedPrinciple, setSelectedPrinciple] = useState(PRINCIPLES[0]);
    const [selectedSalesCode, setSelectedSalesCode] = useState(scope.salesCode ?? "");

    const summary = {
        total: rows.length,
        ordered: rows.filter(r => r.status === "ordered" || r.status === "active").length,
        notOrder: rows.filter(r => r.status === "not_order").length,
        priority: rows.filter(r => r.isPriority).length,
    };

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const p = new URLSearchParams({ date: selectedDate, principle: selectedPrinciple });
            if (selectedSalesCode) p.set("salesCode", selectedSalesCode);
            const res = await fetch(`/api/form-kontrol/ao-control?${p}`);
            const data = await res.json();
            const normalized: AoRow[] = (data.rows ?? []).map((r: Record<string, unknown>) => ({
                id: r.id as string,
                salesCode: r.salesCode as string,
                custCode: r.custCode as string,
                custName: r.custName as string,
                principle: (r.principle as string) ?? selectedPrinciple,
                status: ((r.aoStatus ?? "not_visited") as AoRow["status"]),
                orderValueDpp: 0,
                isPriority: r.aoStatus === "priority",
                noOrderReasonCode: r.noOrderReasonCode as string | undefined,
                noOrderNote: r.noOrderNote as string | undefined,
                monthlyOrderCount: (r.monthlyOrderCount as number) ?? 0,
                needsAttention: (r.needsAttention as boolean) ?? false,
            }));
            setRows(normalized);
        } catch { toast.error("Gagal memuat data AO"); }
        finally { setLoading(false); }
    }, [selectedDate, selectedPrinciple, selectedSalesCode]);

    useEffect(() => { load(); }, [load]);

    function togglePriority(custCode: string) {
        setRows(prev => prev.map(r =>
            r.custCode === custCode
                ? { ...r, isPriority: !r.isPriority, status: (!r.isPriority ? "priority" : r.status === "priority" ? "not_order" : r.status) as AoRow["status"] }
                : r
        ));
    }

    async function handleSubmit() {
        if (rows.length === 0) return;
        setSaving(true);
        try {
            for (const row of rows) {
                const res = await fetch("/api/form-kontrol/ao-control", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        salesCode: row.salesCode,
                        custCode: row.custCode,
                        principle: selectedPrinciple,
                        date: selectedDate,
                        status: row.status,
                        noOrderReasonCode: row.noOrderReasonCode ?? null,
                        noOrderNote: row.noOrderNote ?? null,
                    }),
                });
                if (!res.ok) throw new Error("Gagal menyimpan");
            }
            toast.success("Data AO berhasil disimpan");
        } catch (err: unknown) {
            toast.error(err instanceof Error ? err.message : "Gagal menyimpan");
        } finally { setSaving(false); }
    }

    const dayOfMonth = new Date().getDate();
    const workdayPct = Math.min(100, Math.round((dayOfMonth / 22) * 100));
    const aoPct = summary.total > 0 ? Math.round((summary.ordered / summary.total) * 100) : 0;
    const paceColor = aoPct >= workdayPct ? "bg-emerald-500" : aoPct >= workdayPct - 10 ? "bg-amber-500" : "bg-rose-500";
    const paceTextColor = aoPct >= workdayPct ? "text-emerald-400" : aoPct >= workdayPct - 10 ? "text-amber-400" : "text-rose-400";

    return (
        <div className="space-y-4">
            <SectionTitle icon={Target} no={2} title="Form Kontrol AO Harian"
                desc="Kontrol order per toko — harian, bukan menunggu akhir bulan" />

            <div className="flex flex-wrap gap-2 bg-[#1a1c23]/60 border border-white/10 rounded-xl px-4 py-3">
                <input type="date" value={selectedDate} onChange={e => setSelectedDate(e.target.value)}
                    className="bg-black/40 border border-white/10 rounded-lg text-xs text-white px-2 py-1.5" />
                <select value={selectedPrinciple} onChange={e => setSelectedPrinciple(e.target.value)}
                    className="bg-black/40 border border-white/10 rounded-lg text-xs text-white px-2 py-1.5">
                    {PRINCIPLES.map(p => <option key={p} value={p}>{p}</option>)}
                </select>
                {scope.allowedSalesCodes === null && (
                    <input value={selectedSalesCode} onChange={e => setSelectedSalesCode(e.target.value)}
                        placeholder="Kode Sales..." className="bg-black/40 border border-white/10 rounded-lg text-xs text-white px-2 py-1.5 w-32" />
                )}
                <button onClick={load} className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-white px-2 py-1.5">
                    <RefreshCw size={13} /> Muat Rute
                </button>
                <button onClick={handleSubmit} disabled={saving || rows.length === 0}
                    className="ml-auto flex items-center gap-1.5 text-xs bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white px-3 py-1.5 rounded-lg font-semibold">
                    {saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />} Submit AO
                </button>
            </div>

            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <SummaryCard label="Rute Hari Ini" value={summary.total} />
                <SummaryCard label="Sudah Order" value={summary.ordered} color="text-emerald-400" />
                <SummaryCard label="Belum Order" value={summary.notOrder} color="text-rose-400" />
                <SummaryCard label="Prioritas" value={summary.priority} color="text-amber-400" />
            </div>

            <div className="bg-[#1a1c23]/60 border border-white/10 rounded-xl p-4 space-y-2">
                <div className="flex items-center justify-between text-xs text-slate-400">
                    <span className="flex items-center gap-1"><Clock size={12} /> Time Gone</span>
                    <span>{workdayPct}% hari kerja berlalu</span>
                </div>
                <div className="h-2 bg-black/40 rounded-full overflow-hidden">
                    <div className="h-full bg-slate-500 rounded-full" style={{ width: `${workdayPct}%` }} />
                </div>
                <div className="flex items-center justify-between text-xs text-slate-400">
                    <span className="flex items-center gap-1"><TrendingUp size={12} /> Progres AO</span>
                    <span className={paceTextColor}>{aoPct}%</span>
                </div>
                <div className="h-2 bg-black/40 rounded-full overflow-hidden">
                    <div className={`h-full rounded-full ${paceColor}`} style={{ width: `${aoPct}%` }} />
                </div>
            </div>

            <div className="bg-[#1a1c23]/60 border border-white/10 rounded-xl overflow-hidden">
                {loading ? (
                    <div className="flex items-center justify-center py-12 text-slate-400 gap-2">
                        <Loader2 size={18} className="animate-spin" /> Memuat rute...
                    </div>
                ) : rows.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-12 text-slate-500 gap-2">
                        <Target size={32} className="opacity-30" />
                        <p className="text-sm">Tidak ada rute terjadwal untuk hari & principle ini.</p>
                    </div>
                ) : (
                    <div className="divide-y divide-white/5">
                        {rows.map(r => (
                            <div key={r.id} className="flex items-center gap-3 px-4 py-3 hover:bg-white/5 transition-colors">
                                <button onClick={() => togglePriority(r.custCode)} className="shrink-0 text-slate-500 hover:text-amber-400 transition-colors">
                                    {r.isPriority ? <Star size={16} className="text-amber-400 fill-amber-400" /> : <StarOff size={16} />}
                                </button>
                                <Link
                                    href={`/form-kontrol/visit/${r.custCode}?salesCode=${r.salesCode}&principle=${encodeURIComponent(selectedPrinciple)}&date=${selectedDate}`}
                                    className="flex-1 min-w-0 group"
                                >
                                    <p className="text-sm font-medium text-white truncate group-hover:text-indigo-300 transition-colors">{r.custName}</p>
                                    <div className="flex items-center gap-1.5 mt-0.5">
                                        <p className="text-xs text-slate-500 font-mono">{r.custCode}</p>
                                        {r.monthlyOrderCount > 0 && (
                                            <span className="text-[10px] bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 px-1.5 py-0 rounded-md">
                                                {r.monthlyOrderCount}× bulan ini
                                            </span>
                                        )}
                                        {r.needsAttention && (
                                            <span className="flex items-center gap-0.5 text-[10px] bg-amber-500/15 text-amber-400 border border-amber-500/30 px-1.5 py-0 rounded-md">
                                                <AlertTriangle size={9} /> perlu perhatian
                                            </span>
                                        )}
                                    </div>
                                </Link>
                                <StatusBadge status={r.status} />
                                {r.orderValueDpp > 0 && (
                                    <span className="text-xs text-emerald-400 font-mono whitespace-nowrap">
                                        Rp {r.orderValueDpp.toLocaleString("id-ID")}
                                    </span>
                                )}
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}
