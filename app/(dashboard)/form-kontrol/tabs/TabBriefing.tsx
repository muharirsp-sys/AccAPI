"use client";

import { useEffect, useState } from "react";
import { Users, Loader2, Save, CheckCircle2 } from "lucide-react";
import { toast } from "sonner";
import { type Scope, BRIEFING_AGENDA, SectionTitle } from "../shared";

export default function TabBriefing({ scope }: { scope: Scope }) {
    const [briefingSession, setBriefingSession] = useState<"pagi" | "sore">("pagi");
    const [agenda, setAgenda] = useState<boolean[]>(Array(5).fill(false));
    const [tokoDialas, setTokoDialas] = useState("");
    const [penyebab, setPenyebab] = useState("");
    const [solusi, setSolusi] = useState("");
    const [saving, setSaving] = useState(false);
    const [selectedDate] = useState(() => new Date().toISOString().slice(0, 10));

    useEffect(() => { setAgenda(Array(5).fill(false)); }, [briefingSession]);

    async function handleSave() {
        const spvName = scope.spvName ?? scope.salesName ?? "";
        if (!spvName) { toast.error("Nama SPV tidak ditemukan"); return; }
        setSaving(true);
        try {
            const agendaItems = BRIEFING_AGENDA[briefingSession];
            const res = await fetch("/api/form-kontrol/briefing", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    spvName,
                    date: selectedDate,
                    session: briefingSession,
                    agenda: agendaItems.filter((_, i) => agenda[i]),
                    tokoDialas,
                    penyebab,
                    solusi,
                }),
            });
            if (!res.ok) throw new Error("Gagal simpan briefing");
            toast.success(`Briefing ${briefingSession} berhasil disimpan`);
        } catch (err: unknown) {
            toast.error(err instanceof Error ? err.message : "Gagal simpan");
        } finally { setSaving(false); }
    }

    return (
        <div className="space-y-4">
            <SectionTitle icon={Users} no={6} title="Briefing Wajib SPV"
                desc="Tugas SPV bukan menerima laporan, tetapi mengendalikan lapangan" />

            <div className="inline-flex bg-black/40 border border-white/10 rounded-xl p-1">
                {(["pagi", "sore"] as const).map(s => (
                    <button key={s} onClick={() => setBriefingSession(s)}
                        className={`px-5 py-2 rounded-lg text-sm font-semibold transition-all capitalize ${briefingSession === s ? "bg-indigo-600 text-white" : "text-slate-400 hover:text-white"}`}>
                        {s}
                    </button>
                ))}
            </div>

            <div className="bg-[#1a1c23]/60 border border-white/10 rounded-xl p-4 space-y-4">
                <h3 className="text-sm font-semibold text-white">Agenda Briefing {briefingSession === "pagi" ? "Pagi" : "Sore"}</h3>
                <div className="space-y-2">
                    {BRIEFING_AGENDA[briefingSession].map((item, i) => (
                        <label key={i} className="flex items-center gap-2.5 cursor-pointer group">
                            <button type="button"
                                onClick={() => setAgenda(prev => prev.map((v, j) => j === i ? !v : v))}
                                className={`w-4 h-4 rounded border flex items-center justify-center shrink-0 transition-colors ${agenda[i] ? "bg-emerald-500 border-emerald-500" : "bg-black/30 border-white/20 group-hover:border-white/40"}`}>
                                {agenda[i] && <CheckCircle2 size={10} className="text-white" />}
                            </button>
                            <span className={`text-sm ${agenda[i] ? "text-emerald-400 line-through opacity-60" : "text-slate-300"}`}>{item}</span>
                        </label>
                    ))}
                </div>

                <div className="grid gap-3 pt-2 border-t border-white/10">
                    <div>
                        <label className="text-xs text-slate-400 block mb-1">Toko yang Dibahas</label>
                        <input value={tokoDialas} onChange={e => setTokoDialas(e.target.value)}
                            placeholder="Nama/kode toko yang dibahas..."
                            className="w-full bg-black/30 border border-white/10 rounded-lg text-sm text-white px-3 py-2 placeholder-slate-500" />
                    </div>
                    <div>
                        <label className="text-xs text-slate-400 block mb-1">Penyebab</label>
                        <textarea value={penyebab} onChange={e => setPenyebab(e.target.value)} rows={2}
                            placeholder="Penyebab utama toko tidak order / tidak dikunjungi..."
                            className="w-full bg-black/30 border border-white/10 rounded-lg text-sm text-white px-3 py-2 placeholder-slate-500 resize-none" />
                    </div>
                    <div>
                        <label className="text-xs text-slate-400 block mb-1">Solusi & Tindak Lanjut</label>
                        <textarea value={solusi} onChange={e => setSolusi(e.target.value)} rows={2}
                            placeholder="Solusi yang disepakati dan tindak lanjut konkret..."
                            className="w-full bg-black/30 border border-white/10 rounded-lg text-sm text-white px-3 py-2 placeholder-slate-500 resize-none" />
                    </div>
                </div>

                <div className="flex justify-end">
                    <button onClick={handleSave} disabled={saving}
                        className="flex items-center gap-1.5 text-sm bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white px-4 py-2 rounded-lg font-semibold">
                        {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                        Simpan Briefing {briefingSession === "pagi" ? "Pagi" : "Sore"}
                    </button>
                </div>
            </div>
        </div>
    );
}
