"use client";

// Form AO Harian — daftar kunjungan toko (mobile-first).
// Redesign per mockup-jks-final: HUD rute (X/total terkunjungi), kartu tappable
// dengan garis-warna kiri = state, 1 badge dominan, filter chip, sorting
// urgent-first (belum-order naik / selesai turun + dim + durasi).
// State/sort/filter ada di shared.tsx (routeState/compareRoute/visitDurationMin).

import { useCallback, useEffect, useState } from "react";
import { Target, AlertTriangle, Loader2, RefreshCw, Save, Star, StarOff } from "lucide-react";
import Link from "next/link";
import { toast } from "sonner";
import {
    type Scope, type AoRow, type RouteState,
    PRINCIPLES, SectionTitle, routeState, compareRoute, visitDurationMin,
} from "../shared";

const BORDER: Record<RouteState, string> = {
    belum_order: "border-l-rose-500",
    perhatian:   "border-l-amber-500",
    selesai:     "border-l-emerald-500",
    sudah_order: "border-l-emerald-500",
    normal:      "border-l-slate-500",
};

function dominantBadge(st: RouteState, dur: number | null): { label: string; cls: string } {
    switch (st) {
        case "belum_order": return { label: "Belum Order", cls: "bg-rose-500/15 text-rose-300 border-rose-500/40" };
        case "selesai":     return { label: `✓ Selesai · ${dur ?? "—"} min`, cls: "bg-emerald-500/15 text-emerald-300 border-emerald-500/40" };
        case "sudah_order": return { label: "Sudah Order", cls: "bg-emerald-500/15 text-emerald-300 border-emerald-500/40" };
        case "perhatian":   return { label: "Perhatian", cls: "bg-amber-500/15 text-amber-300 border-amber-500/40" };
        default:            return { label: "Belum dikunjungi", cls: "bg-slate-500/15 text-slate-300 border-slate-500/40" };
    }
}

type Chip = "all" | "not_order" | "perhatian";

export default function TabAo({ scope }: { scope: Scope }) {
    const [rows, setRows] = useState<AoRow[]>([]);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [chip, setChip] = useState<Chip>("all");
    const [selectedDate, setSelectedDate] = useState(() => new Date().toISOString().slice(0, 10));
    const [selectedPrinciple, setSelectedPrinciple] = useState(scope.principle ?? PRINCIPLES[0]);
    const [selectedSalesCode, setSelectedSalesCode] = useState(scope.salesCode ?? "");

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
                checkinAt: (r.checkinAt as string) ?? null,
                checkoutAt: (r.checkoutAt as string) ?? null,
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
                if (!res.ok) {
                    const j = await res.json().catch(() => ({}));
                    throw new Error(`${row.custCode}: ${j.error ?? "Gagal menyimpan"}`);
                }
            }
            toast.success("Data AO berhasil disimpan");
        } catch (err: unknown) {
            toast.error(err instanceof Error ? err.message : "Gagal menyimpan");
        } finally { setSaving(false); }
    }

    const cntBelum = rows.filter(r => r.status === "not_order").length;
    const cntPerhatian = rows.filter(r => r.isPriority || r.needsAttention).length;
    const visited = rows.filter(r => r.checkinAt).length;
    const visitedPct = rows.length > 0 ? Math.round((visited / rows.length) * 100) : 0;

    const shown = rows
        .filter(r => chip === "all" ? true : chip === "not_order" ? r.status === "not_order" : (r.isPriority || r.needsAttention))
        .slice()
        .sort(compareRoute);

    const dateLabel = new Date(selectedDate).toLocaleDateString("id-ID", { weekday: "long", day: "numeric", month: "short" });
    const hudSales = selectedSalesCode || scope.salesCode || "—";

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

            {/* Header HUD: progres rute hari ini */}
            <div className="bg-[#1a1c23]/60 border border-white/10 rounded-xl px-4 py-3.5 space-y-2.5">
                <div className="flex items-center justify-between">
                    <div>
                        <p className="text-[11px] uppercase tracking-wider text-slate-500 font-semibold">Rute Hari Ini · {hudSales}</p>
                        <p className="text-sm text-slate-300 capitalize">{dateLabel}</p>
                    </div>
                    <div className="text-right">
                        <p className="text-2xl font-bold text-white leading-none">{visited}<span className="text-slate-500">/{rows.length}</span></p>
                        <p className="text-[11px] text-slate-500 mt-1">terkunjungi</p>
                    </div>
                </div>
                <div className="h-2 bg-black/40 rounded-full overflow-hidden">
                    <div className="h-full bg-indigo-500 rounded-full transition-all" style={{ width: `${visitedPct}%` }} />
                </div>
            </div>

            {/* Filter chip */}
            <div className="flex gap-2">
                {([
                    { k: "not_order" as Chip, label: "Belum Order", n: cntBelum, on: "bg-rose-500/20 text-rose-300 border-rose-500/40" },
                    { k: "perhatian" as Chip, label: "Perhatian", n: cntPerhatian, on: "bg-amber-500/20 text-amber-300 border-amber-500/40" },
                    { k: "all" as Chip, label: "Semua", n: rows.length, on: "bg-indigo-500/20 text-indigo-300 border-indigo-500/40" },
                ]).map(c => (
                    <button key={c.k} onClick={() => setChip(c.k)}
                        className={`flex items-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-lg border transition-colors min-h-[40px] ${
                            chip === c.k ? c.on : "bg-black/30 text-slate-400 border-white/10 hover:border-white/20"}`}>
                        {c.label} <span className="opacity-70">· {c.n}</span>
                    </button>
                ))}
            </div>

            {loading ? (
                <div className="flex items-center justify-center py-12 text-slate-400 gap-2">
                    <Loader2 size={18} className="animate-spin" /> Memuat rute...
                </div>
            ) : shown.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 text-slate-500 gap-2">
                    <Target size={32} className="opacity-30" />
                    <p className="text-sm">{rows.length === 0 ? "Tidak ada rute terjadwal untuk hari & principle ini." : "Tidak ada toko pada filter ini."}</p>
                </div>
            ) : (
                <div className="space-y-2">
                    {shown.map(r => {
                        const st = routeState(r);
                        const dur = visitDurationMin(r);
                        const badge = dominantBadge(st, dur);
                        const done = st === "selesai";
                        return (
                            <div key={r.id}
                                className={`relative rounded-xl border border-white/10 border-l-4 ${BORDER[st]} bg-[#1a1c23]/60 ${done ? "opacity-60" : ""}`}>
                                <Link aria-label={`Buka kunjungan ${r.custName}`}
                                    href={`/form-kontrol/visit/${r.custCode}?salesCode=${r.salesCode}&principle=${encodeURIComponent(selectedPrinciple)}&date=${selectedDate}`}
                                    className="absolute inset-0 rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-500/60" />
                                <div className="relative pointer-events-none flex items-start gap-3 px-4 py-3 min-h-[56px]">
                                    <button onClick={() => togglePriority(r.custCode)} aria-label="Tandai prioritas"
                                        className="pointer-events-auto shrink-0 mt-0.5 w-8 h-8 -ml-1 flex items-center justify-center text-slate-500 hover:text-amber-400 transition-colors">
                                        {r.isPriority ? <Star size={18} className="text-amber-400 fill-amber-400" /> : <StarOff size={18} />}
                                    </button>
                                    <div className="flex-1 min-w-0">
                                        <p className={`text-base font-semibold truncate ${done ? "line-through text-slate-400" : "text-white"}`}>{r.custName}</p>
                                        <p className="text-xs font-mono text-slate-500">{r.custCode}</p>
                                        <p className="text-xs text-slate-400 mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
                                            {r.needsAttention && (
                                                <span className="inline-flex items-center gap-0.5 text-amber-400"><AlertTriangle size={11} /> Perlu perhatian</span>
                                            )}
                                            {r.monthlyOrderCount > 0 && <span>{r.monthlyOrderCount}× kunjungan bln ini</span>}
                                            {!r.checkoutAt && (r.checkinAt
                                                ? <span className="text-indigo-400">· Sedang dikunjungi</span>
                                                : <span>· Belum dikunjungi hari ini</span>)}
                                        </p>
                                    </div>
                                    <span className={`shrink-0 inline-flex items-center px-2.5 py-1 rounded-md text-xs font-semibold border whitespace-nowrap ${badge.cls}`}>
                                        {badge.label}
                                    </span>
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}
