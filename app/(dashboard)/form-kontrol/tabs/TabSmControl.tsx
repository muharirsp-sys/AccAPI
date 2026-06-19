"use client";

import { useState } from "react";
import { BarChart3, Loader2, Save, CheckCircle2, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { type Scope, SectionTitle } from "../shared";

export default function TabSmControl({ scope }: { scope: Scope }) {
    const [spvList, setSpvList] = useState([{ name: "SPV 1", note: "" }, { name: "SPV 2", note: "" }]);
    const [jksChecked, setJksChecked] = useState(false);
    const [fotoChecked, setFotoChecked] = useState(false);
    const [deviasi, setDeviasi] = useState<{ spv: string; catatan: string }[]>([]);
    const [followUp, setFollowUp] = useState("");
    const [saving, setSaving] = useState(false);
    const [selectedDate] = useState(() => new Date().toISOString().slice(0, 10));

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
                <div className="flex flex-wrap gap-4">
                    {[
                        { label: "JKS sudah dicek hari ini", value: jksChecked, set: setJksChecked },
                        { label: "Foto kunjungan sudah dimonitor", value: fotoChecked, set: setFotoChecked },
                    ].map((item, i) => (
                        <label key={i} className="flex items-center gap-2 cursor-pointer">
                            <button type="button" onClick={() => item.set(!item.value)}
                                className={`w-5 h-5 rounded border flex items-center justify-center transition-colors ${item.value ? "bg-emerald-500 border-emerald-500" : "bg-black/30 border-white/20"}`}>
                                {item.value && <CheckCircle2 size={12} className="text-white" />}
                            </button>
                            <span className="text-sm text-slate-300">{item.label}</span>
                        </label>
                    ))}
                </div>
            </div>

            <div className="bg-[#1a1c23]/60 border border-white/10 rounded-xl p-4 space-y-3">
                <h3 className="text-sm font-semibold text-white">Catatan Coaching per SPV</h3>
                <div className="space-y-2">
                    {spvList.map((spv, i) => (
                        <div key={i} className="flex items-center gap-2">
                            <span className="text-sm text-slate-400 w-20 shrink-0">{spv.name}</span>
                            <input value={spv.note}
                                onChange={e => setSpvList(prev => prev.map((s, j) => j === i ? { ...s, note: e.target.value } : s))}
                                placeholder="Catatan coaching (kosongkan jika tidak ada)..."
                                className="flex-1 bg-black/30 border border-white/10 rounded-lg text-xs text-white px-2 py-1.5 placeholder-slate-500" />
                        </div>
                    ))}
                </div>
            </div>

            <div className="bg-[#1a1c23]/60 border border-white/10 rounded-xl p-4 space-y-3">
                <div className="flex items-center justify-between">
                    <h3 className="text-sm font-semibold text-white">Penyimpangan & Keterlambatan</h3>
                    <button onClick={() => setDeviasi(prev => [...prev, { spv: "", catatan: "" }])}
                        className="flex items-center gap-1 text-xs text-indigo-400 hover:text-indigo-300">
                        <Plus size={12} /> Tambah
                    </button>
                </div>
                {deviasi.length === 0 ? (
                    <p className="text-xs text-slate-500">Belum ada penyimpangan dicatat.</p>
                ) : (
                    <div className="space-y-2">
                        {deviasi.map((d, i) => (
                            <div key={i} className="flex gap-2 items-center">
                                <input value={d.spv} onChange={e => setDeviasi(prev => prev.map((x, j) => j === i ? { ...x, spv: e.target.value } : x))}
                                    placeholder="SPV" className="w-24 bg-black/30 border border-white/10 rounded-lg text-xs text-white px-2 py-1.5" />
                                <input value={d.catatan} onChange={e => setDeviasi(prev => prev.map((x, j) => j === i ? { ...x, catatan: e.target.value } : x))}
                                    placeholder="Catatan penyimpangan / keterlambatan..."
                                    className="flex-1 bg-black/30 border border-white/10 rounded-lg text-xs text-white px-2 py-1.5" />
                                <button onClick={() => setDeviasi(prev => prev.filter((_, j) => j !== i))}
                                    className="text-rose-400 hover:text-rose-300"><Trash2 size={14} /></button>
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
