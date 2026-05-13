"use client";

import { useState } from "react";
import { Presentation, Shield, Download, Plus, Trash2, FileOutput } from "lucide-react";
import { toast } from "sonner";

interface ProgramItem {
    title: string;
    details: string;
    items: string[];
}

export default function PowerPointMakerPage() {
    const [title, setTitle] = useState("Marketing Update 2026");
    const [subtitle, setSubtitle] = useState("Sales & Promotion Strategy");
    const [promoGroup, setPromoGroup] = useState("GT / MT");
    const [periode, setPeriode] = useState("Februari 2026");
    const [designTemplate, setDesignTemplate] = useState("corporate");

    const [programs, setPrograms] = useState<ProgramItem[]>([
        { title: "Program Diskon Spesial", details: "Diskon 10% untuk semua varian ABC", items: ["Item X", "Item Y"] }
    ]);

    const [isGenerating, setIsGenerating] = useState(false);
    const [downloadId, setDownloadId] = useState<string | null>(null);

    const addProgram = () => setPrograms([...programs, { title: "", details: "", items: [""] }]);
    const updateProgram = (index: number, field: keyof ProgramItem, value: string) => {
        const newProgs = [...programs];
        newProgs[index] = { ...newProgs[index], [field]: value };
        setPrograms(newProgs);
    };
    const updateProgramItem = (progIndex: number, itemIndex: number, value: string) => {
        const newProgs = [...programs];
        newProgs[progIndex].items[itemIndex] = value;
        setPrograms(newProgs);
    };
    const addProgramItem = (progIndex: number) => {
        const newProgs = [...programs];
        newProgs[progIndex].items.push("");
        setPrograms(newProgs);
    };
    const removeProgram = (index: number) => {
        const newProgs = [...programs];
        newProgs.splice(index, 1);
        setPrograms(newProgs);
    };

    const handleGenerate = async (e: React.FormEvent) => {
        e.preventDefault();
        setIsGenerating(true);
        setDownloadId(null);

        try {
            const payload = { title, subtitle, promoGroup, periode, designTemplate, programs };

            const req = await fetch("http://localhost:8000/api/powerpoint/generate", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload)
            });

            const res = await req.json();

            if (res.ok && res.file_id) {
                setDownloadId(res.file_id);
                toast.success("PowerPoint berhasil dibuat dan di-render oleh Python!");
            } else toast.error(res.error || "Gagal membuat presentasi PPTX.");
        } catch (err: any) { toast.error("Koneksi ke server Python generator gagal."); } 
        finally { setIsGenerating(false); }
    };

    return (
        <div className="max-w-[1000px] mx-auto pb-12">
            <div className="mb-8">
                <h1 className="text-3xl font-bold text-white tracking-tight flex items-center gap-3">
                    <Presentation className="text-rose-500" />
                    PowerPoint Maker (PPTX)
                </h1>
                <p className="text-slate-400 mt-2 text-lg">Generator otomatis slide bahan presentasi eksekutif dan program promo via backend Python.</p>
            </div>

            <div className="bg-[#1a1c23]/60 backdrop-blur-xl p-8 rounded-2xl shadow-xl border border-white/10 relative overflow-hidden">
                <div className="absolute top-0 right-0 w-64 h-64 bg-rose-500/10 rounded-full blur-3xl -mr-32 -mt-32"></div>

                {downloadId && (
                    <div className="mb-8 p-6 rounded-xl bg-gradient-to-r from-emerald-900/40 to-[#1a1c23] border border-emerald-500/20 flex flex-col md:flex-row items-center justify-between gap-4">
                        <div className="flex items-center gap-3">
                            <div className="bg-emerald-500/20 p-2 rounded-lg"><Shield className="text-emerald-400" size={24} /></div>
                            <div>
                                <h3 className="text-emerald-400 font-bold text-lg">Rendering Selesai</h3>
                                <p className="text-sm text-slate-400">File presentasi siap untuk diunduh ({downloadId.slice(0, 8)}...)</p>
                            </div>
                        </div>
                        <a
                            href={`http://localhost:8000/api/powerpoint/download/${downloadId}`}
                            target="_blank" rel="noreferrer"
                            className="px-6 py-3 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl text-sm font-bold flex items-center gap-2 shadow-lg shadow-emerald-600/20 transition-all w-full md:w-auto justify-center"
                        >
                            <Download size={18} /> Unduh PowerPoint
                        </a>
                    </div>
                )}

                <form onSubmit={handleGenerate} className="space-y-8 relative">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                        <div>
                            <label className="block text-[11px] font-bold text-slate-500 uppercase tracking-wider mb-2">Tema Warna Dasar</label>
                            <select
                                value={designTemplate}
                                onChange={e => setDesignTemplate(e.target.value)}
                                className="w-full border border-white/10 rounded-xl px-4 py-3 bg-black/40 text-slate-300 focus:ring-2 focus:ring-rose-500 outline-none transition-all cursor-pointer"
                            >
                                <option value="corporate">🔴 Corporate Standard (Merah)</option>
                                <option value="modern">🔵 Modern Blue (Biru)</option>
                                <option value="minimalist">⚪ Minimalist Clean (Putih)</option>
                            </select>
                        </div>
                        
                        <div className="space-y-5">
                            <div>
                                <label className="block text-[11px] font-bold text-slate-500 uppercase tracking-wider mb-2">Judul Utama Slide</label>
                                <input type="text" required value={title} onChange={(e) => setTitle(e.target.value)} className="w-full bg-black/40 border border-white/10 rounded-xl px-4 py-3 text-white outline-none focus:border-rose-500/50 transition-colors" />
                            </div>
                            <div>
                                <label className="block text-[11px] font-bold text-slate-500 uppercase tracking-wider mb-2">Sub Judul Deskripsi</label>
                                <input type="text" required value={subtitle} onChange={(e) => setSubtitle(e.target.value)} className="w-full bg-black/40 border border-white/10 rounded-xl px-4 py-3 text-white outline-none focus:border-rose-500/50 transition-colors" />
                            </div>
                            
                            <div className="grid grid-cols-2 gap-4">
                                <div>
                                    <label className="block text-[11px] font-bold text-slate-500 uppercase tracking-wider mb-2">Target Filter Channel</label>
                                    <input type="text" required value={promoGroup} onChange={(e) => setPromoGroup(e.target.value)} className="w-full bg-black/40 border border-white/10 rounded-xl px-4 py-3 text-white outline-none focus:border-rose-500/50 transition-colors" />
                                </div>
                                <div>
                                    <label className="block text-[11px] font-bold text-slate-500 uppercase tracking-wider mb-2">Bulan Eksekusi</label>
                                    <input type="text" required value={periode} onChange={(e) => setPeriode(e.target.value)} className="w-full bg-black/40 border border-white/10 rounded-xl px-4 py-3 text-white outline-none focus:border-rose-500/50 transition-colors" />
                                </div>
                            </div>
                        </div>
                    </div>

                    <hr className="border-white/5" />

                    <div>
                        <div className="flex items-center justify-between mb-6">
                            <h3 className="text-sm font-bold text-slate-300 uppercase tracking-widest flex items-center gap-2">
                                <FileOutput size={16} className="text-slate-500" /> Konten Dinamis Salindia
                            </h3>
                            <button type="button" onClick={addProgram} className="text-xs font-bold text-rose-400 bg-rose-500/10 px-4 py-2 rounded-lg border border-rose-500/20 hover:bg-rose-500/20 flex items-center gap-2 transition-colors">
                                <Plus size={14} /> Tambah Salindia (Slide)
                            </button>
                        </div>

                        <div className="space-y-6">
                            {programs.map((prog, pIndex) => (
                                <div key={pIndex} className="p-6 border border-white/10 rounded-xl bg-black/30 relative group">
                                    <h4 className="absolute -top-3 left-4 bg-[#1a1c23] px-2 text-[10px] font-bold text-slate-500 tracking-wider">SLIDE #0{pIndex + 1}</h4>
                                    
                                    <button type="button" onClick={() => removeProgram(pIndex)} className="absolute top-4 right-4 text-slate-600 hover:text-red-400 bg-[#1a1c23] p-1.5 rounded-md hover:bg-red-500/10 transition-colors">
                                        <Trash2 size={16} />
                                    </button>

                                    <div className="grid grid-cols-1 md:grid-cols-2 gap-5 mb-5 pr-8">
                                        <div>
                                            <input type="text" required value={prog.title} onChange={e => updateProgram(pIndex, 'title', e.target.value)} className="w-full bg-transparent border-b border-white/10 focus:border-rose-500/50 px-2 py-2 text-white font-bold outline-none placeholder:text-slate-600 transition-colors" placeholder="Judul Topik Slide..." />
                                        </div>
                                        <div>
                                            <input type="text" required value={prog.details} onChange={e => updateProgram(pIndex, 'details', e.target.value)} className="w-full bg-transparent border-b border-white/10 focus:border-rose-500/50 px-2 py-2 text-slate-300 outline-none placeholder:text-slate-600 transition-colors" placeholder="Deskripsi pendek pendukung..." />
                                        </div>
                                    </div>

                                    <div className="space-y-3 pl-2 border-l-2 border-slate-800">
                                        <label className="block text-[10px] font-bold text-slate-500 uppercase ml-2 mb-1">Poin Diskusi (List)</label>
                                        {prog.items.map((item, iIndex) => (
                                            <div key={iIndex} className="flex items-center gap-2">
                                                <div className="w-1.5 h-1.5 rounded-full bg-rose-500/50 ml-2"></div>
                                                <input type="text" value={item} onChange={e => updateProgramItem(pIndex, iIndex, e.target.value)} className="flex-1 bg-black/40 border border-white/5 rounded-lg px-3 py-2 text-sm text-slate-300 outline-none focus:border-rose-500/30 transition-colors" placeholder={`Bullet Point ${iIndex + 1}`} />
                                            </div>
                                        ))}
                                        <button type="button" onClick={() => addProgramItem(pIndex)} className="text-[11px] font-bold text-slate-500 hover:text-rose-400 italic ml-6 px-2 py-1 transition-colors">
                                            + Tambah anak point
                                        </button>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>

                    <div className="pt-6 border-t border-white/5">
                        <button
                            type="submit"
                            disabled={isGenerating || programs.length === 0}
                            className="w-full py-4 bg-rose-600 hover:bg-rose-500 text-white rounded-xl font-bold shadow-lg shadow-rose-600/20 flex items-center justify-center gap-2 disabled:opacity-50 transition-all"
                        >
                            {isGenerating ? "Merender Kompilasi Python..." : <><FileOutput size={20} /> Generate PPTX</>}
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
}
