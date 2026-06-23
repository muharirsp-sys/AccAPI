"use client";

import { useCallback, useEffect, useState } from "react";
import { Network, Loader2, Save, RefreshCw, ChevronDown, ChevronRight } from "lucide-react";
import { toast } from "sonner";
import { type Scope, SectionTitle } from "../shared";

interface Profile {
    salesCode: string;
    salesName: string;
    principle: string;
    branch: string;
    spvName: string | null;
    smName: string | null;
}

interface EditState { spvName: string; smName: string }

export default function TabHierarki({ scope }: { scope: Scope }) {
    const [profiles, setProfiles] = useState<Profile[]>([]);
    const [loading, setLoading] = useState(true);
    const [edits, setEdits] = useState<Record<string, EditState>>({});
    const [saving, setSaving] = useState<string | null>(null);
    const [expandedSpv, setExpandedSpv] = useState<Record<string, boolean>>({});

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const res = await fetch("/api/form-kontrol/sales-profiles");
            const data = await res.json();
            const rows: Profile[] = data.rows ?? [];
            setProfiles(rows);
            const init: Record<string, EditState> = {};
            rows.forEach(r => { init[r.salesCode] = { spvName: r.spvName ?? "", smName: r.smName ?? "" }; });
            setEdits(init);
            const spvs = [...new Set(rows.map(r => r.spvName ?? "— Belum diatur —"))];
            setExpandedSpv(Object.fromEntries(spvs.map(s => [s, true])));
        } catch { toast.error("Gagal memuat profil sales"); }
        finally { setLoading(false); }
    }, []);

    useEffect(() => { load(); }, [load]);

    async function handleSave(salesCode: string) {
        const edit = edits[salesCode];
        setSaving(salesCode);
        try {
            const res = await fetch("/api/form-kontrol/sales-profiles", {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ salesCode, spvName: edit.spvName || null, smName: edit.smName || null }),
            });
            if (!res.ok) throw new Error("Gagal simpan");
            toast.success("Hierarki berhasil diperbarui");
            await load();
        } catch { toast.error("Gagal menyimpan"); }
        finally { setSaving(null); }
    }

    function isDirty(salesCode: string) {
        const p = profiles.find(r => r.salesCode === salesCode);
        if (!p) return false;
        const e = edits[salesCode];
        return (e?.spvName ?? "") !== (p.spvName ?? "") || (e?.smName ?? "") !== (p.smName ?? "");
    }

    const spvNames = [...new Set(profiles.map(r => r.spvName).filter(Boolean) as string[])].sort();
    const smNames  = [...new Set(profiles.map(r => r.smName).filter(Boolean) as string[])].sort();

    const grouped = profiles.reduce<Record<string, Profile[]>>((acc, p) => {
        const key = p.spvName ?? "— Belum diatur —";
        (acc[key] ??= []).push(p);
        return acc;
    }, {});
    const spvKeys = Object.keys(grouped).sort((a, b) =>
        a === "— Belum diatur —" ? 1 : b === "— Belum diatur —" ? -1 : a.localeCompare(b));

    void scope; // admin-only tab, scope tidak dipakai untuk filter di sini

    return (
        <div className="space-y-4">
            <SectionTitle icon={Network} no={8} title="Hierarki Sales"
                desc="Setting SPV dan SM untuk setiap salesman — menentukan siapa yang bisa melihat data siapa" />

            <div className="flex justify-end">
                <button onClick={load} className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-white px-3 py-1.5 bg-white/5 rounded-lg border border-white/10">
                    <RefreshCw size={12} /> Refresh
                </button>
            </div>

            <datalist id="spv-list">{spvNames.map(n => <option key={n} value={n} />)}</datalist>
            <datalist id="sm-list">{smNames.map(n => <option key={n} value={n} />)}</datalist>

            {loading ? (
                <div className="flex items-center justify-center py-16 text-slate-400 gap-2">
                    <Loader2 size={18} className="animate-spin" /> Memuat...
                </div>
            ) : (
                <div className="space-y-3">
                    {spvKeys.map(spvKey => {
                        const salesUnderSpv = grouped[spvKey];
                        const expanded = expandedSpv[spvKey] ?? true;
                        const smOfGroup = salesUnderSpv[0]?.smName ?? null;
                        return (
                            <div key={spvKey} className="rounded-xl border border-white/10 bg-[#1a1c23]/60 overflow-hidden">
                                <button
                                    onClick={() => setExpandedSpv(p => ({ ...p, [spvKey]: !expanded }))}
                                    className="w-full flex items-center gap-3 px-4 py-3 hover:bg-white/5 transition-colors text-left"
                                >
                                    {expanded ? <ChevronDown size={14} className="text-slate-400 shrink-0" /> : <ChevronRight size={14} className="text-slate-400 shrink-0" />}
                                    <div className="flex-1 min-w-0">
                                        <span className="text-sm font-semibold text-indigo-300">{spvKey}</span>
                                        {smOfGroup && <span className="ml-2 text-xs text-slate-500">· SM: {smOfGroup}</span>}
                                    </div>
                                    <span className="text-xs text-slate-500 shrink-0">{salesUnderSpv.length} salesman</span>
                                </button>

                                {expanded && (
                                    <div className="border-t border-white/10 divide-y divide-white/5">
                                        {salesUnderSpv.map(p => {
                                            const edit = edits[p.salesCode] ?? { spvName: "", smName: "" };
                                            const dirty = isDirty(p.salesCode);
                                            return (
                                                <div key={p.salesCode} className="px-4 py-3 flex flex-wrap items-end gap-3">
                                                    <div className="min-w-[160px] flex-shrink-0">
                                                        <p className="text-sm font-medium text-white">{p.salesName}</p>
                                                        <p className="text-xs text-slate-500 font-mono">{p.salesCode} · {p.principle}</p>
                                                    </div>

                                                    <div className="flex flex-col gap-0.5 flex-1 min-w-[140px]">
                                                        <label className="text-[10px] text-slate-500 uppercase tracking-wide">SPV</label>
                                                        <input
                                                            list="spv-list"
                                                            value={edit.spvName}
                                                            onChange={e => setEdits(prev => ({ ...prev, [p.salesCode]: { ...prev[p.salesCode], spvName: e.target.value } }))}
                                                            placeholder="Nama SPV..."
                                                            className="bg-black/30 border border-white/10 rounded-lg text-sm text-white px-3 py-2 placeholder-slate-500"
                                                        />
                                                    </div>

                                                    <div className="flex flex-col gap-0.5 flex-1 min-w-[140px]">
                                                        <label className="text-[10px] text-slate-500 uppercase tracking-wide">SM</label>
                                                        <input
                                                            list="sm-list"
                                                            value={edit.smName}
                                                            onChange={e => setEdits(prev => ({ ...prev, [p.salesCode]: { ...prev[p.salesCode], smName: e.target.value } }))}
                                                            placeholder="Nama SM..."
                                                            className="bg-black/30 border border-white/10 rounded-lg text-sm text-white px-3 py-2 placeholder-slate-500"
                                                        />
                                                    </div>

                                                    <button
                                                        onClick={() => handleSave(p.salesCode)}
                                                        disabled={!dirty || saving === p.salesCode}
                                                        className="flex items-center gap-1.5 text-xs bg-indigo-600 hover:bg-indigo-500 disabled:opacity-30 disabled:cursor-not-allowed text-white px-3 py-2 rounded-lg font-semibold shrink-0"
                                                    >
                                                        {saving === p.salesCode ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
                                                        Simpan
                                                    </button>
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
        </div>
    );
}
