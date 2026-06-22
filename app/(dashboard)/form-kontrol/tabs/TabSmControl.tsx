"use client";

// Kontrol Wajib SM — coaching notes: label di atas input (bukan w-20 inline).
// Deviasi: grid 2-kolom (SPV | catatan) + tombol hapus, input min-h-[44px].

import { useState, useEffect } from "react";
import { BarChart3, Loader2, Save, CheckCircle2, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { type Scope, SectionTitle } from "../shared";

interface SpvBriefing { session: string; penyebab: string | null; solusi: string | null }
interface SpvBriefingRow { spvName: string; briefings: SpvBriefing[] }

export default function TabSmControl({ scope }: { scope: Scope }) {
    const [spvList, setSpvList] = useState<{ name: string; note: string }[]>([]);
    const [briefings, setBriefings] = useState<SpvBriefingRow[]>([]);
    const [jksChecked, setJksChecked] = useState(false);
    const [fotoChecked, setFotoChecked] = useState(false);
    const [deviasi, setDeviasi] = useState<{ spv: string; catatan: string }[]>([]);
    const [followUp, setFollowUp] = useState("");
    const [saving, setSaving] = useState(false);
    const [selectedDate] = useState(() => new Date().toISOString().slice(0, 10));

    // Briefing SPV nyata di bawah SM ini (ganti hardcode SPV 1/2).
    useEffect(() => {
        fetch(`/api/form-kontrol/sm-briefings?date=${selectedDate}`)
            .then(r => r.json())
            .then(d => {
                const rows: SpvBriefingRow[] = d.rows ?? [];
                setBriefings(rows);
                setSpvList(rows.map(r => ({ name: r.spvName, note: "" })));
            })
            .catch(() => {});
    }, [selectedDate]);

    async function handleSave() {
        const smName = scope.smName ?? scope.spvName ?? scope.salesName ?? "";
        if (!smName) { toast.error("Nama SM tidak ditemukan"); return; }
        setSaving(true);
        try {
            const coachingNote = spvList
                .filter(s => s.note.trim())
                .map(s => `${s.name}: ${s.note}`)
                .join("\n");
            const res = await fetch("/api/form-kontrol/sm-control", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    smName,
                    date: selectedDate,
                    spvChecked: spvList,
                    jksChecked,
                    fotoChecked,
                    coachingNote,
                    deviations: deviasi,
                    followUp,
                }),
            });
            if (!res.ok) throw new Error("Gagal simpan");
            toast.success("Kontrol SM berhasil disimpan");
        } catch (err: unknown) {
            toast.error(err instanceof Error ? err.message : "Gagal simpan");
        } finally { setSaving(false); }
    }

    return (
        <div className="space-y-4">
            <SectionTitle icon={BarChart3} no={7} title="Kontrol Wajib SM"
                desc="Tugas SM bukan mengontrol salesman langsung, tetapi memastikan SPV benar-benar mengontrol salesmannya" />

            <div className="bg-[#1a1c23]/60 border border-white/10 rounded-xl p-4 space-y-3">
                <h3 className="text-sm font-semibold text-white">Kontrol Harian</h3>
                <div className="flex flex-col gap-3">
                    {[
                        { label: "JKS sudah dicek hari ini", value: jksChecked, set: setJksChecked },
                        { label: "Foto kunjungan sudah dimonitor", value: fotoChecked, set: setFotoChecked },
                    ].map((item, i) => (
                        <label key={i} className="flex items-center gap-3 cursor-pointer min-h-[40px]">
                            <button type="button" onClick={() => item.set(!item.value)}
                                className={`w-5 h-5 rounded border flex items-center justify-center shrink-0 transition-colors ${item.value ? "bg-emerald-500 border-emerald-500" : "bg-black/30 border-white/20"}`}>
                                {item.value && <CheckCircle2 size={12} className="text-white" />}
                            </button>
                            <span className="text-sm text-slate-200">{item.label}</span>
                        </label>
                    ))}
                </div>
            </div>

            <div className="bg-[#1a1c23]/60 border border-white/10 rounded-xl p-4 space-y-3">
                <h3 className="text-sm font-semibold text-white">Catatan Coaching per SPV</h3>
                <div className="space-y-3">
                    {spvList.length === 0 && (
                        <p className="text-sm text-slate-500">Belum ada SPV terhubung ke SM ini (isi <span className="font-mono">smName</span> di sales profile SPV).</p>
                    )}
                    {spvList.map((spv, i) => {
                        const br = briefings.find(b => b.spvName === spv.name);
                        const pagi = br?.briefings.find(x => x.session === "pagi");
                        const sore = br?.briefings.find(x => x.session === "sore");
                        return (
                            <div key={i} className="space-y-1">
                                <div className="flex items-center gap-2 flex-wrap">
                                    <p className="text-xs text-slate-400 font-medium">{spv.name}</p>
                                    <span className={`text-[10px] px-1.5 py-0 rounded border ${pagi ? "bg-emerald-500/15 text-emerald-400 border-emerald-500/30" : "bg-slate-500/15 text-slate-400 border-slate-500/30"}`}>briefing pagi {pagi ? "✓" : "—"}</span>
                                    <span className={`text-[10px] px-1.5 py-0 rounded border ${sore ? "bg-emerald-500/15 text-emerald-400 border-emerald-500/30" : "bg-slate-500/15 text-slate-400 border-slate-500/30"}`}>sore {sore ? "✓" : "—"}</span>
                                </div>
                                {(pagi?.penyebab || pagi?.solusi || sore?.penyebab || sore?.solusi) && (
                                    <div className="bg-black/20 rounded-lg px-2.5 py-1.5 text-xs text-slate-400 space-y-0.5">
                                        {(sore?.penyebab || pagi?.penyebab) && <p><span className="text-slate-500">Penyebab:</span> {sore?.penyebab || pagi?.penyebab}</p>}
                                        {(sore?.solusi || pagi?.solusi) && <p><span className="text-slate-500">Solusi:</span> {sore?.solusi || pagi?.solusi}</p>}
                                    </div>
                                )}
                                <input value={spv.note}
                                    onChange={e => setSpvList(prev => prev.map((s, j) => j === i ? { ...s, note: e.target.value } : s))}
                                    placeholder="Catatan coaching (kosongkan jika tidak ada)..."
                                    className="w-full bg-black/30 border border-white/10 rounded-lg text-sm text-white px-3 py-2.5 min-h-[44px] placeholder-slate-500" />
                            </div>
                        );
                    })}
                </div>
            </div>

            <div className="bg-[#1a1c23]/60 border border-white/10 rounded-xl p-4 space-y-3">
                <div className="flex items-center justify-between">
                    <h3 className="text-sm font-semibold text-white">Penyimpangan & Keterlambatan</h3>
                    <button onClick={() => setDeviasi(prev => [...prev, { spv: "", catatan: "" }])}
                        className="flex items-center gap-1 text-xs text-indigo-400 hover:text-indigo-300 px-2 py-1">
                        <Plus size={12} /> Tambah
                    </button>
                </div>
                {deviasi.length === 0 ? (
                    <p className="text-sm text-slate-500">Belum ada penyimpangan dicatat.</p>
                ) : (
                    <div className="space-y-2">
                        {deviasi.map((d, i) => (
                            <div key={i} className="grid grid-cols-[1fr_2fr_auto] gap-2 items-center">
                                <input value={d.spv}
                                    onChange={e => setDeviasi(prev => prev.map((x, j) => j === i ? { ...x, spv: e.target.value } : x))}
                                    placeholder="SPV"
                                    className="bg-black/30 border border-white/10 rounded-lg text-sm text-white px-3 py-2.5 min-h-[44px] placeholder-slate-500" />
                                <input value={d.catatan}
                                    onChange={e => setDeviasi(prev => prev.map((x, j) => j === i ? { ...x, catatan: e.target.value } : x))}
                                    placeholder="Catatan penyimpangan / keterlambatan..."
                                    className="bg-black/30 border border-white/10 rounded-lg text-sm text-white px-3 py-2.5 min-h-[44px] placeholder-slate-500" />
                                <button onClick={() => setDeviasi(prev => prev.filter((_, j) => j !== i))}
                                    className="p-2.5 text-rose-400 hover:text-rose-300 min-h-[44px] flex items-center">
                                    <Trash2 size={16} />
                                </button>
                            </div>
                        ))}
                    </div>
                )}
            </div>

            <div className="bg-[#1a1c23]/60 border border-white/10 rounded-xl p-4 space-y-3">
                <h3 className="text-sm font-semibold text-white">Follow-up SM</h3>
                <textarea value={followUp} onChange={e => setFollowUp(e.target.value)} rows={3}
                    placeholder="Tindak lanjut SM terhadap kondisi lapangan hari ini..."
                    className="w-full bg-black/30 border border-white/10 rounded-lg text-sm text-white px-3 py-2 placeholder-slate-500 resize-none" />
                <div className="flex justify-end">
                    <button onClick={handleSave} disabled={saving}
                        className="flex items-center gap-1.5 text-sm bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white px-4 py-2 rounded-lg font-semibold">
                        {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} Simpan Kontrol SM
                    </button>
                </div>
            </div>
        </div>
    );
}
