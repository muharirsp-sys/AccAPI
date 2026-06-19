"use client";

import { useEffect, useState } from "react";
import { FileText, AlertTriangle, Loader2, Save, CheckCircle2 } from "lucide-react";
import { toast } from "sonner";
import { type Scope, SectionTitle, SummaryCard } from "../shared";

export default function TabLaporan({ scope }: { scope: Scope }) {
    const [tindakLanjut, setTindakLanjut] = useState("");
    const [saving, setSaving] = useState(false);
    const [loading, setLoading] = useState(true);
    const [submitted, setSubmitted] = useState(false);
    const [summary, setSummary] = useState({ totalJks: 0, order: 0, aktif: 0, notOrder: 0, notVisited: 0 });
    const [selectedDate] = useState(() => new Date().toISOString().slice(0, 10));

    const salesCode = scope.salesCode ?? "";

    useEffect(() => {
        if (!salesCode) { setLoading(false); return; }
        fetch(`/api/form-kontrol/reports?salesCode=${encodeURIComponent(salesCode)}&date=${selectedDate}`)
            .then(r => r.json())
            .then(data => {
                const row = data.rows?.[0];
                if (row) {
                    setSummary({
                        totalJks: (row.totalTokoJks as number) ?? 0,
                        order: (row.totalOrder as number) ?? 0,
                        aktif: (row.totalActive as number) ?? 0,
                        notOrder: (row.totalNotOrder as number) ?? 0,
                        notVisited: (row.totalNotVisited as number) ?? 0,
                    });
                    setTindakLanjut((row.tindakLanjut as string) ?? "");
                    setSubmitted(true);
                }
            })
            .catch(() => {})
            .finally(() => setLoading(false));
    }, [salesCode, selectedDate]);

    async function handleSubmit() {
        if (!tindakLanjut.trim()) { toast.error("Tindak lanjut wajib diisi"); return; }
        if (!salesCode) { toast.error("Sales code tidak ditemukan — pastikan profil salesman sudah terdaftar"); return; }
        setSaving(true);
        try {
            const res = await fetch("/api/form-kontrol/reports", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ salesCode, date: selectedDate, tindakLanjut }),
            });
            if (!res.ok) throw new Error("Gagal submit laporan");
            toast.success("Laporan harian berhasil disubmit ke SPV");
            setSubmitted(true);
            const reload = await fetch(`/api/form-kontrol/reports?salesCode=${encodeURIComponent(salesCode)}&date=${selectedDate}`);
            const reloadData = await reload.json();
            const row = reloadData.rows?.[0];
            if (row) {
                setSummary({
                    totalJks: (row.totalTokoJks as number) ?? 0,
                    order: (row.totalOrder as number) ?? 0,
                    aktif: (row.totalActive as number) ?? 0,
                    notOrder: (row.totalNotOrder as number) ?? 0,
                    notVisited: (row.totalNotVisited as number) ?? 0,
                });
            }
        } catch (err: unknown) {
            toast.error(err instanceof Error ? err.message : "Gagal submit");
        } finally { setSaving(false); }
    }

    if (loading) {
        return (
            <div className="flex items-center justify-center py-16 text-slate-400 gap-2">
                <Loader2 size={18} className="animate-spin" /> Memuat laporan...
            </div>
        );
    }

    return (
        <div className="space-y-4">
            <SectionTitle icon={FileText} no={5} title="Laporan Wajib Salesman"
                desc="Ringkasan sore — angka terisi otomatis dari Form AO, lengkapi tindak lanjut" />

            {submitted && (
                <div className="flex items-center gap-2 bg-emerald-500/10 border border-emerald-500/30 rounded-lg px-4 py-2.5 text-emerald-400 text-sm">
                    <CheckCircle2 size={15} /> Laporan berhasil disubmit. Menunggu acknowledge SPV.
                </div>
            )}

            {!salesCode && (
                <div className="flex items-center gap-2 bg-amber-500/10 border border-amber-500/30 rounded-lg px-4 py-2.5 text-amber-400 text-sm">
                    <AlertTriangle size={15} /> Profil salesman belum terdaftar. Hubungi admin untuk mengisi data.
                </div>
            )}

            <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                <SummaryCard label="Total Toko JKS" value={summary.totalJks} />
                <SummaryCard label="Order" value={summary.order} color="text-emerald-400" />
                <SummaryCard label="Aktif" value={summary.aktif} color="text-blue-400" />
                <SummaryCard label="Tidak Order" value={summary.notOrder} color="text-rose-400" />
                <SummaryCard label="Tidak Dikunjungi" value={summary.notVisited} color="text-slate-400" />
            </div>

            <div className="bg-[#1a1c23]/60 border border-white/10 rounded-xl p-4 space-y-3">
                <h3 className="text-sm font-semibold text-white">Tindak Lanjut</h3>
                <textarea
                    value={tindakLanjut}
                    onChange={e => setTindakLanjut(e.target.value)}
                    placeholder="Uraikan tindak lanjut untuk toko yang belum order, rencana kunjungan ulang, eskalasi ke SPV, dll..."
                    rows={5}
                    className={`w-full bg-black/30 border rounded-lg text-sm text-white px-3 py-2 placeholder-slate-500 resize-none ${!tindakLanjut.trim() ? "border-rose-500/40" : "border-white/10"}`}
                />
                <div className="flex justify-end">
                    <button onClick={handleSubmit} disabled={saving || submitted || !salesCode}
                        className="flex items-center gap-1.5 text-sm bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white px-4 py-2 rounded-lg font-semibold">
                        {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                        {submitted ? "Sudah Disubmit" : "Submit Laporan ke SPV"}
                    </button>
                </div>
            </div>
        </div>
    );
}
