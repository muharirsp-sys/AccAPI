"use client";

import { useCallback, useEffect, useState } from "react";
import {
    BarChart3, RefreshCw, CheckCircle2, XCircle, Clock,
    Loader2, AlertTriangle, TrendingUp, FileText, Users,
} from "lucide-react";
import { toast } from "sonner";

interface VisitRow {
    custCode: string; custName: string; status: string;
    checkinAt: string | null; checkoutAt: string | null;
    durationMinutes: number | null;
    gpsFlag: string | null; durFlag: string | null;
    checkinPhotoUrl: string | null; checkoutPhotoUrl: string | null;
    merchDone: number; merchTotal: number;
    merchStepPhotos: Record<string, string> | null;
}
interface SalesmanRow {
    salesCode: string; salesName: string;
    totalRoute: number; ordered: number; notOrder: number; notVisited: number;
    checkedIn: number; checkedOut: number;
    submittedAt: string | null; tindakLanjut: string | null;
    spvAck?: boolean; spvAckAt?: string | null;
    visits?: VisitRow[]; totalFieldMinutes?: number;
}

function hhmm(iso: string | null) {
    if (!iso) return "—";
    return new Date(iso).toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Jakarta" });
}
function fieldTimeLabel(min?: number) {
    if (!min) return "0m";
    const h = Math.floor(min / 60), m = min % 60;
    return h > 0 ? `${h}j ${m}m` : `${m}m`;
}
const FLAG_LABEL: Record<string, string> = {
    akurasi_rendah: "Akurasi GPS rendah",
    tanpa_lokasi: "Tanpa lokasi",
    durasi_singkat: "Durasi < 5 mnt",
    durasi_lama: "Durasi > 2 jam",
};

function Bar({ value, total, color }: { value: number; total: number; color: string }) {
    const pct = total > 0 ? Math.round((value / total) * 100) : 0;
    return (
        <div className="flex items-center gap-2">
            <div className="flex-1 h-1.5 bg-black/40 rounded-full overflow-hidden">
                <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
            </div>
            <span className="text-xs text-slate-400 w-8 text-right">{pct}%</span>
        </div>
    );
}

export default function SpvDashboardPage() {
    const [rows, setRows]           = useState<SalesmanRow[]>([]);
    const [loading, setLoading]     = useState(true);
    const [spvName, setSpvName]     = useState("");
    const [date, setDate]           = useState(() => new Date().toISOString().slice(0, 10));
    const [lastRefresh, setLastRefresh] = useState<Date | null>(null);

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const res = await fetch(`/api/form-kontrol/spv-dashboard?date=${date}`);
            const data = await res.json();
            if (!res.ok) throw new Error(data.error ?? "Gagal memuat data");
            setRows(data.rows ?? []);
            setSpvName(data.spvName ?? "");
            setLastRefresh(new Date());
        } catch (e) { toast.error(e instanceof Error ? e.message : "Gagal"); }
        finally { setLoading(false); }
    }, [date]);

    useEffect(() => { load(); }, [load]);

    async function acknowledge(salesCode: string) {
        try {
            const res = await fetch("/api/form-kontrol/reports/ack", {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ salesCode, date }),
            });
            if (!res.ok) { const d = await res.json(); throw new Error(d.error ?? "Gagal acknowledge"); }
            toast.success("Laporan di-acknowledge");
            load();
        } catch (e) { toast.error(e instanceof Error ? e.message : "Gagal"); }
    }

    const totals = {
        route:     rows.reduce((a, r) => a + r.totalRoute, 0),
        ordered:   rows.reduce((a, r) => a + r.ordered, 0),
        notOrder:  rows.reduce((a, r) => a + r.notOrder, 0),
        submitted: rows.filter(r => r.submittedAt).length,
    };
    const allSubmitted = totals.submitted === rows.length && rows.length > 0;
    const aoPct = totals.route > 0 ? Math.round((totals.ordered / totals.route) * 100) : 0;

    return (
        <div className="max-w-[1000px] mx-auto pb-16 px-2 md:px-0">
            {/* Header */}
            <div className="mb-5 pt-2 flex items-start justify-between gap-4 flex-wrap">
                <div>
                    <h1 className="text-xl font-bold text-white flex items-center gap-2">
                        <BarChart3 className="text-indigo-400" size={22} /> Dashboard SPV
                    </h1>
                    <p className="text-slate-400 text-sm mt-0.5">
                        {spvName && <span className="text-indigo-300">{spvName}</span>}
                        {rows.length > 0 && <> · {rows.length} salesman</>}
                    </p>
                </div>
                <div className="flex items-center gap-2">
                    <input type="date" value={date} onChange={e => setDate(e.target.value)}
                        className="bg-black/40 border border-white/10 rounded-lg text-xs text-white px-2 py-1.5" />
                    <button onClick={load} className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-white bg-black/30 border border-white/10 px-3 py-1.5 rounded-lg">
                        <RefreshCw size={12} className={loading ? "animate-spin" : ""} /> Refresh
                    </button>
                </div>
            </div>

            {lastRefresh && (
                <p className="text-xs text-slate-500 mb-3">Diperbarui: {lastRefresh.toLocaleTimeString("id-ID")}</p>
            )}

            {/* Summary cards */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5">
                {[
                    { label: "Total Rute", value: totals.route, color: "text-white" },
                    { label: "ORDER", value: `${totals.ordered} (${aoPct}%)`, color: "text-emerald-400" },
                    { label: "Tidak Order", value: totals.notOrder, color: "text-rose-400" },
                    { label: "Laporan Masuk", value: `${totals.submitted}/${rows.length}`, color: allSubmitted ? "text-emerald-400" : "text-amber-400" },
                ].map(c => (
                    <div key={c.label} className="bg-[#1a1c23]/60 border border-white/10 rounded-xl p-4">
                        <p className="text-xs text-slate-400">{c.label}</p>
                        <p className={`text-2xl font-bold mt-1 ${c.color}`}>{c.value}</p>
                    </div>
                ))}
            </div>

            {allSubmitted && (
                <div className="flex items-center gap-2 bg-emerald-500/10 border border-emerald-500/30 rounded-xl px-4 py-3 mb-4 text-emerald-400 text-sm">
                    <CheckCircle2 size={15} /> Semua salesman sudah submit — data siap untuk briefing sore
                </div>
            )}
            {!loading && !allSubmitted && rows.filter(r => !r.submittedAt).length > 0 && (
                <div className="flex items-center gap-2 bg-amber-500/10 border border-amber-500/30 rounded-xl px-4 py-3 mb-4 text-amber-400 text-sm">
                    <AlertTriangle size={15} />
                    Belum submit: {rows.filter(r => !r.submittedAt).map(r => r.salesName).join(", ")}
                </div>
            )}

            {/* Salesman cards */}
            {loading ? (
                <div className="flex items-center justify-center py-16 text-slate-400 gap-2">
                    <Loader2 size={18} className="animate-spin" /> Memuat...
                </div>
            ) : rows.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 text-slate-500 gap-2 bg-[#1a1c23]/60 border border-white/10 rounded-xl">
                    <Users size={36} className="opacity-30" />
                    <p className="text-sm">Belum ada salesman terdaftar untuk SPV ini.</p>
                    <p className="text-xs text-slate-600">Isi spvName di sales profile untuk menghubungkan salesman.</p>
                </div>
            ) : (
                <div className="space-y-3">
                    {rows.map(r => {
                        const aoPct = r.totalRoute > 0 ? Math.round((r.ordered / r.totalRoute) * 100) : 0;
                        const coverPct = r.totalRoute > 0 ? Math.round(((r.ordered + r.notOrder) / r.totalRoute) * 100) : 0;
                        const barColor = aoPct >= 70 ? "bg-emerald-500" : aoPct >= 50 ? "bg-amber-500" : "bg-rose-500";

                        return (
                            <div key={r.salesCode} className={`bg-[#1a1c23]/60 border rounded-xl p-4 space-y-3 ${r.submittedAt ? "border-emerald-500/20" : "border-white/10"}`}>
                                <div className="flex items-center gap-3 flex-wrap">
                                    <div className="flex-1 min-w-0">
                                        <p className="text-sm font-semibold text-white">{r.salesName}</p>
                                        <p className="text-xs text-slate-500 font-mono">{r.salesCode}</p>
                                    </div>
                                    <div className="flex flex-wrap gap-1.5">
                                        {r.checkedIn > 0 && (
                                            <span className="text-xs bg-blue-500/15 text-blue-400 border border-blue-500/30 px-2 py-0.5 rounded-md">
                                                {r.checkedIn} check-in
                                            </span>
                                        )}
                                        {r.checkedOut > 0 && (
                                            <span className="text-xs bg-indigo-500/15 text-indigo-400 border border-indigo-500/30 px-2 py-0.5 rounded-md">
                                                {r.checkedOut} check-out
                                            </span>
                                        )}
                                        {r.submittedAt ? (
                                            <span className="text-xs bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 px-2 py-0.5 rounded-md flex items-center gap-1">
                                                <CheckCircle2 size={10} /> Submitted
                                            </span>
                                        ) : (
                                            <span className="text-xs bg-amber-500/15 text-amber-400 border border-amber-500/30 px-2 py-0.5 rounded-md flex items-center gap-1">
                                                <Clock size={10} /> Menunggu
                                            </span>
                                        )}
                                        {r.submittedAt && (r.spvAck ? (
                                            <span className="text-xs bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 px-2 py-0.5 rounded-md flex items-center gap-1">
                                                <CheckCircle2 size={10} /> Di-ack SPV
                                            </span>
                                        ) : (
                                            <button onClick={() => acknowledge(r.salesCode)}
                                                className="text-xs bg-indigo-600 hover:bg-indigo-500 text-white px-2.5 py-0.5 rounded-md font-semibold">
                                                Acknowledge
                                            </button>
                                        ))}
                                    </div>
                                </div>

                                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-center">
                                    {[
                                        { label: "Rute", val: r.totalRoute, color: "text-white" },
                                        { label: "Order", val: r.ordered, color: "text-emerald-400" },
                                        { label: "Tdk Order", val: r.notOrder, color: "text-rose-400" },
                                        { label: "Tdk Kunjungi", val: r.notVisited, color: "text-slate-400" },
                                    ].map(s => (
                                        <div key={s.label} className="bg-black/20 rounded-lg p-2">
                                            <p className={`text-lg font-bold ${s.color}`}>{s.val}</p>
                                            <p className="text-xs text-slate-500">{s.label}</p>
                                        </div>
                                    ))}
                                </div>

                                <div className="space-y-1.5">
                                    <div className="flex justify-between text-xs text-slate-500">
                                        <span className="flex items-center gap-1"><TrendingUp size={10} /> AO</span>
                                        <span className={aoPct >= 70 ? "text-emerald-400" : aoPct >= 50 ? "text-amber-400" : "text-rose-400"}>{aoPct}%</span>
                                    </div>
                                    <Bar value={r.ordered} total={r.totalRoute} color={barColor} />
                                    <div className="flex justify-between text-xs text-slate-500 mt-1">
                                        <span>Coverage</span><span>{coverPct}%</span>
                                    </div>
                                    <Bar value={r.ordered + r.notOrder} total={r.totalRoute} color="bg-indigo-500" />
                                </div>

                                {r.tindakLanjut && (
                                    <div className="bg-black/20 rounded-lg px-3 py-2">
                                        <p className="text-xs text-slate-500 flex items-center gap-1 mb-1"><FileText size={10} /> Tindak Lanjut</p>
                                        <p className="text-xs text-slate-300 leading-relaxed">{r.tindakLanjut}</p>
                                    </div>
                                )}

                                {/* Detail kunjungan per toko — satu baris per kunjungan, tanpa overflow-x-auto */}
                                {r.visits && r.visits.length > 0 && (
                                    <div className="bg-black/20 rounded-lg p-2 space-y-0">
                                        <div className="flex items-center justify-between pb-2">
                                            <p className="text-xs text-slate-500 flex items-center gap-1"><Clock size={10} /> Detail Kunjungan</p>
                                            <span className="text-xs text-slate-400">Lapangan: <span className="text-white font-semibold">{fieldTimeLabel(r.totalFieldMinutes)}</span></span>
                                        </div>
                                        {r.visits.map(v => {
                                            const flags = [v.gpsFlag, v.durFlag].filter(Boolean).join(",").split(",").filter(Boolean);
                                            return (
                                                <div key={v.custCode} className="flex items-center gap-2 border-t border-white/5 py-1.5">
                                                    {[v.checkinPhotoUrl, v.checkoutPhotoUrl].filter(Boolean).map((url, i) => (
                                                        // eslint-disable-next-line @next/next/no-img-element
                                                        <a key={i} href={url as string} target="_blank" rel="noreferrer" className="shrink-0">
                                                            <img src={url as string} alt="bukti" className="w-10 h-10 rounded object-cover border border-white/10" />
                                                        </a>
                                                    ))}
                                                    <div className="flex-1 min-w-0">
                                                        <p className="text-sm text-slate-300 truncate">{v.custName}</p>
                                                        <p className="text-xs text-slate-500">
                                                            {hhmm(v.checkinAt)} – {hhmm(v.checkoutAt)} · {v.durationMinutes !== null ? `${v.durationMinutes}m` : "—"}
                                                            {" · "}
                                                            <span className={v.merchDone >= v.merchTotal ? "text-emerald-400" : "text-amber-400"}>Merch {v.merchDone}/{v.merchTotal}</span>
                                                        </p>
                                                    </div>
                                                    <div className="shrink-0">
                                                        {flags.length === 0 ? (
                                                            <span className="text-emerald-500/80 inline-flex items-center gap-0.5 text-xs"><CheckCircle2 size={11} /> OK</span>
                                                        ) : (
                                                            <span className="text-amber-400 inline-flex items-center gap-0.5 text-xs" title={flags.map(f => FLAG_LABEL[f] ?? f).join(", ")}>
                                                                <AlertTriangle size={11} /> {flags.map(f => FLAG_LABEL[f] ?? f)[0]}
                                                            </span>
                                                        )}
                                                    </div>
                                                </div>
                                            );
                                        })}
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>
            )}

            {rows.some(r => r.notOrder > 0) && (
                <div className="mt-5 bg-[#1a1c23]/60 border border-rose-500/20 rounded-xl p-4">
                    <h3 className="text-sm font-semibold text-white flex items-center gap-2 mb-3">
                        <XCircle size={14} className="text-rose-400" /> Bahan Briefing Sore — Toko Tidak Order
                    </h3>
                    {rows.filter(r => r.notOrder > 0).map(r => (
                        <div key={r.salesCode} className="flex justify-between text-sm py-1 border-b border-white/5">
                            <span className="text-slate-300">{r.salesName}</span>
                            <span className="text-rose-400 font-semibold">{r.notOrder} toko</span>
                        </div>
                    ))}
                    <p className="text-xs text-slate-500 mt-3">
                        Total {rows.reduce((a, r) => a + r.notOrder, 0)} toko tidak order — wajib dibahas saat briefing.
                    </p>
                </div>
            )}
        </div>
    );
}
