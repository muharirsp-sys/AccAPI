"use client";

import { useCallback, useEffect, useState } from "react";
import { ShoppingBag, Filter, Loader2, RefreshCw, Save, CheckCircle2, Camera } from "lucide-react";
import { toast } from "sonner";
import { type Scope, type MerchItem, PRINCIPLES, MERCH_KEYS, SectionTitle } from "../shared";

export default function TabMerchandising({ scope }: { scope: Scope }) {
    const [items, setItems] = useState<MerchItem[]>([]);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState<string | null>(null);
    const [selectedDate, setSelectedDate] = useState(() => new Date().toISOString().slice(0, 10));
    const [selectedPrinciple, setSelectedPrinciple] = useState(PRINCIPLES[0]);
    const [selectedSalesCode, setSelectedSalesCode] = useState(scope.salesCode ?? "");

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const p = new URLSearchParams({ date: selectedDate, principle: selectedPrinciple });
            if (selectedSalesCode) p.set("salesCode", selectedSalesCode);

            const [routeRes, merchRes] = await Promise.all([
                fetch(`/api/form-kontrol/ao-control?${p}`),
                fetch(`/api/form-kontrol/merchandising?${p}`),
            ]);
            const [routeData, merchData] = await Promise.all([routeRes.json(), merchRes.json()]);

            const existingMap = new Map(
                (merchData.rows ?? []).map((r: Record<string, unknown>) => [r.custCode as string, r])
            );

            const newItems: MerchItem[] = (routeData.rows ?? []).map((r: Record<string, unknown>) => {
                const ex = existingMap.get(r.custCode as string) as Record<string, unknown> | undefined;
                return {
                    custCode: r.custCode as string,
                    custName: r.custName as string,
                    produkJelas: (ex?.produkJelas as boolean) ?? false,
                    displayRapi: (ex?.displayRapi as boolean) ?? false,
                    dibersihkan: (ex?.dibersihkan as boolean) ?? false,
                    ditataulang: (ex?.ditataulang as boolean) ?? false,
                    posisiMudah: (ex?.posisiMudah as boolean) ?? false,
                    semuaSku: (ex?.semuaSku as boolean) ?? false,
                    photoUrl: ex?.photoUrl as string | undefined,
                    catatan: (ex?.note as string) ?? "",
                };
            });
            setItems(newItems);
        } catch { toast.error("Gagal memuat data merchandising"); }
        finally { setLoading(false); }
    }, [selectedDate, selectedPrinciple, selectedSalesCode]);

    useEffect(() => { load(); }, [load]);

    function toggleCheck(custCode: string, key: keyof MerchItem) {
        setItems(prev => prev.map(item => item.custCode === custCode ? { ...item, [key]: !item[key as keyof MerchItem] } : item));
    }

    async function handleSave(custCode: string) {
        const item = items.find(i => i.custCode === custCode);
        if (!item) return;
        setSaving(custCode);
        try {
            const res = await fetch("/api/form-kontrol/merchandising", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    salesCode: selectedSalesCode,
                    custCode: item.custCode,
                    principle: selectedPrinciple,
                    date: selectedDate,
                    produkJelas: item.produkJelas,
                    displayRapi: item.displayRapi,
                    dibersihkan: item.dibersihkan,
                    ditataulang: item.ditataulang,
                    posisiMudah: item.posisiMudah,
                    semuaSku: item.semuaSku,
                    photoUrl: item.photoUrl ?? null,
                    note: item.catatan,
                }),
            });
            if (!res.ok) throw new Error("Gagal menyimpan");
            toast.success("Merchandising berhasil disimpan");
        } catch (err: unknown) {
            toast.error(err instanceof Error ? err.message : "Gagal menyimpan");
        } finally { setSaving(null); }
    }

    function checkedCount(item: MerchItem) {
        return MERCH_KEYS.filter(({ key }) => item[key] as boolean).length;
    }

    return (
        <div className="space-y-4">
            <SectionTitle icon={ShoppingBag} no={4} title="Merchandising Wajib"
                desc="Barang masuk menciptakan order hari ini; barang keluar menciptakan repeat order bulan depan" />

            <div className="flex flex-wrap items-center gap-2 bg-[#1a1c23]/60 border border-white/10 rounded-xl px-4 py-3">
                <Filter size={14} className="text-slate-400" />
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
                <button onClick={load} className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-white px-2 py-1.5 ml-auto">
                    <RefreshCw size={13} /> Refresh
                </button>
            </div>

            {loading ? (
                <div className="flex items-center justify-center py-12 text-slate-400 gap-2">
                    <Loader2 size={18} className="animate-spin" /> Memuat...
                </div>
            ) : items.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 text-slate-500 gap-2 bg-[#1a1c23]/60 border border-white/10 rounded-xl">
                    <ShoppingBag size={32} className="opacity-30" />
                    <p className="text-sm">Belum ada toko dikunjungi hari ini.</p>
                </div>
            ) : (
                <div className="space-y-3">
                    {items.map(item => {
                        const count = checkedCount(item);
                        const barColor = count === 6 ? "bg-emerald-500" : count >= 4 ? "bg-amber-500" : "bg-rose-500";
                        const badgeColor = count === 6 ? "bg-emerald-500/15 text-emerald-400 border-emerald-500/30" : count >= 4 ? "bg-amber-500/15 text-amber-400 border-amber-500/30" : "bg-rose-500/15 text-rose-400 border-rose-500/30";
                        return (
                            <div key={item.custCode} className="bg-[#1a1c23]/60 border border-white/10 rounded-xl p-4 space-y-3">
                                <div className="flex items-center justify-between">
                                    <div>
                                        <p className="text-sm font-semibold text-white">{item.custName}</p>
                                        <p className="text-xs text-slate-500 font-mono">{item.custCode}</p>
                                    </div>
                                    <span className={`text-xs font-bold px-2 py-0.5 rounded-md border ${badgeColor}`}>{count}/6</span>
                                </div>
                                <div className="h-1.5 bg-black/40 rounded-full overflow-hidden">
                                    <div className={`h-full rounded-full transition-all ${barColor}`} style={{ width: `${(count / 6) * 100}%` }} />
                                </div>
                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                                    {MERCH_KEYS.map(({ key, label }) => (
                                        <label key={key} className="flex items-center gap-2 cursor-pointer group">
                                            <button type="button" onClick={() => toggleCheck(item.custCode, key)}
                                                className={`w-4 h-4 rounded border flex items-center justify-center shrink-0 transition-colors ${item[key] ? "bg-emerald-500 border-emerald-500" : "bg-black/30 border-white/20 group-hover:border-white/40"}`}>
                                                {item[key] && <CheckCircle2 size={10} className="text-white" />}
                                            </button>
                                            <span className={`text-xs ${item[key] ? "text-emerald-400" : "text-slate-400"}`}>{label}</span>
                                        </label>
                                    ))}
                                </div>
                                <div className="flex flex-wrap gap-2">
                                    <label className="flex items-center gap-1.5 text-xs bg-black/30 border border-white/10 hover:border-white/20 text-slate-300 px-3 py-1.5 rounded-lg cursor-pointer">
                                        <Camera size={12} /> Upload Foto
                                        <input type="file" accept="image/*" capture="environment" className="hidden" />
                                    </label>
                                    <input
                                        value={item.catatan}
                                        onChange={e => setItems(prev => prev.map(i => i.custCode === item.custCode ? { ...i, catatan: e.target.value } : i))}
                                        placeholder="Catatan merchandising..."
                                        className="flex-1 min-w-[200px] bg-black/30 border border-white/10 rounded-lg text-xs text-white px-2 py-1.5"
                                    />
                                    <button onClick={() => handleSave(item.custCode)} disabled={saving === item.custCode}
                                        className="flex items-center gap-1 text-xs bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white px-3 py-1.5 rounded-lg font-semibold">
                                        {saving === item.custCode ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />} Simpan
                                    </button>
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}
