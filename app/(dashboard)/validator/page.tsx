"use client";

import { useState } from "react";
import { Upload, CheckCircle, AlertTriangle, FileSpreadsheet, Play, Percent } from "lucide-react";

export default function ValidatorPage() {
    const API_BASE = process.env.NEXT_PUBLIC_FASTAPI_BASE_URL || "http://localhost:8000";
    const [salesFile, setSalesFile] = useState<File | null>(null);
    const [promoFile, setPromoFile] = useState<File | null>(null);
    const [channelFile, setChannelFile] = useState<File | null>(null);
    const [internalFile, setInternalFile] = useState<File | null>(null);

    const [isProcessing, setIsProcessing] = useState(false);
    const [jsonResult, setJsonResult] = useState<any>(null);
    const [errorMsg, setErrorMsg] = useState<string>("");

    const handleValidate = async () => {
        if (!salesFile || !promoFile || !channelFile) {
            setErrorMsg("Data Penjualan, Promo Pabrik, dan Data Channel wajib diunggah.");
            return;
        }

        setIsProcessing(true);
        setErrorMsg("");
        setJsonResult(null);

        const fd = new FormData();
        fd.append("sales", salesFile);
        fd.append("promo", promoFile);
        fd.append("channel", channelFile);
        if (internalFile) {
            fd.append("internal", internalFile);
        }

        try {
            const res = await fetch(`${API_BASE}/validate_json`, {
                method: "POST",
                body: fd,
            });
            const data = await res.json();
            
            if (res.ok && data.ok) {
                setJsonResult(data);
            } else {
                setErrorMsg(data.error || "Validasi gagal dari sisi Server Python.");
            }
        } catch (err: any) {
            console.error(err);
            setErrorMsg("Gagal menghubungi server Python FastAPI. Pastikan backend Anda menyala dan NEXT_PUBLIC_FASTAPI_BASE_URL benar.");
        } finally {
            setIsProcessing(false);
        }
    };

    const handleDownload = () => {
        if (!jsonResult?.download_url) return;
        const fullUrl = `${API_BASE}${jsonResult.download_url}`;
        window.open(fullUrl, "_blank");
    };

    return (
        <div className="max-w-5xl mx-auto pb-12">
            <div className="mb-8">
                <h1 className="text-3xl font-bold text-white tracking-tight flex items-center gap-3">
                    <Percent className="text-emerald-500" />
                    Validator Diskon & Promo
                </h1>
                <p className="text-slate-400 mt-2 text-lg">Cocokkan data penjualan GT/MT dengan Master Program dari Pabrik</p>
            </div>

            {errorMsg && (
                <div className="mb-6 p-4 rounded-xl bg-red-500/10 border border-red-500/20 flex items-start gap-3 backdrop-blur-md">
                    <AlertTriangle className="text-red-400 shrink-0" />
                    <p className="text-red-200 text-sm font-medium">{errorMsg}</p>
                </div>
            )}

            {jsonResult && (
                <div className="mb-8 p-6 rounded-2xl bg-emerald-500/10 border border-emerald-500/20 flex flex-col md:flex-row items-center justify-between gap-4 backdrop-blur-md">
                    <div className="flex items-center gap-4">
                        <div className="w-12 h-12 rounded-full bg-emerald-500/20 flex items-center justify-center shrink-0 border border-emerald-500/30">
                            <CheckCircle className="text-emerald-400" size={28} />
                        </div>
                        <div>
                            <h3 className="text-lg font-bold text-emerald-300">Validasi Selesai</h3>
                            <p className="text-sm text-emerald-500/80">Terdeteksi {jsonResult.stats?.promo_rows || 0} baris promo dan {jsonResult.stats?.sales_rows || 0} baris penjualan.</p>
                        </div>
                    </div>
                    {jsonResult.download_url && (
                        <button
                            onClick={handleDownload}
                            className="flex items-center gap-2 bg-emerald-600/90 text-white px-6 py-3 rounded-xl font-bold hover:bg-emerald-500 shadow-sm transition-all whitespace-nowrap"
                        >
                            <FileSpreadsheet size={18} /> Unduh Hasil Excel
                        </button>
                    )}
                </div>
            )}

            <div className="bg-[#1a1c23]/60 backdrop-blur-xl rounded-3xl shadow-xl border border-white/10 overflow-hidden relative group">
                <div className="p-8">
                    <h2 className="text-xl font-extrabold text-white mb-6 flex items-center gap-2">
                        <Upload className="text-blue-400" /> Unggah Dokumen Engine
                    </h2>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                        {/* Sales Data */}
                        <div className="group/item border border-white/5 bg-black/40 hover:bg-blue-500/5 hover:border-blue-500/30 p-5 rounded-2xl transition-colors">
                            <label className="block font-bold text-slate-200 mb-1">Data Penjualan <span className="text-red-400">*</span></label>
                            <p className="text-xs text-slate-500 mb-4">Format .xlsx atau .xls dari sistem kasir/ERP.</p>
                            <input
                                type="file"
                                accept=".xlsx,.xls"
                                onChange={e => setSalesFile(e.target.files?.[0] || null)}
                                className="text-sm block w-full file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-xs file:font-semibold file:bg-blue-500/20 file:text-blue-300 hover:file:bg-blue-500/30 text-slate-400 cursor-pointer transition-colors"
                            />
                        </div>

                        {/* Promo Data */}
                        <div className="group/item border border-white/5 bg-black/40 hover:bg-emerald-500/5 hover:border-emerald-500/30 p-5 rounded-2xl transition-colors">
                            <label className="block font-bold text-slate-200 mb-1">Dataset Diskon Pabrik <span className="text-red-400">*</span></label>
                            <p className="text-xs text-slate-500 mb-4">Master barang promo dari generator (Wajib).</p>
                            <input
                                type="file"
                                accept=".xlsx,.xls"
                                onChange={e => setPromoFile(e.target.files?.[0] || null)}
                                className="text-sm block w-full file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-xs file:font-semibold file:bg-emerald-500/20 file:text-emerald-300 hover:file:bg-emerald-500/30 text-slate-400 cursor-pointer transition-colors"
                            />
                        </div>

                        {/* Channel Data */}
                        <div className="group/item border border-white/5 bg-black/40 hover:bg-purple-500/5 hover:border-purple-500/30 p-5 rounded-2xl transition-colors">
                            <label className="block font-bold text-slate-200 mb-1">Data Channel by SUB <span className="text-red-400">*</span></label>
                            <p className="text-xs text-slate-500 mb-4">Lookup tabel GT/MT berdasarkan SUB toko.</p>
                            <input
                                type="file"
                                accept=".xlsx,.xls"
                                onChange={e => setChannelFile(e.target.files?.[0] || null)}
                                className="text-sm block w-full file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-xs file:font-semibold file:bg-purple-500/20 file:text-purple-300 hover:file:bg-purple-500/30 text-slate-400 cursor-pointer transition-colors"
                            />
                        </div>

                        {/* Internal Data */}
                        <div className="group/item border border-white/5 bg-black/40 hover:bg-orange-500/5 hover:border-orange-500/30 p-5 rounded-2xl transition-colors">
                            <label className="block font-bold text-slate-200 mb-1">Dataset Diskon Internal <span className="text-slate-500 font-normal">(Opsional)</span></label>
                            <p className="text-xs text-slate-500 mb-4">Alokasi diskon internal yang tidak diproses pabrik.</p>
                            <input
                                type="file"
                                accept=".xlsx,.xls"
                                onChange={e => setInternalFile(e.target.files?.[0] || null)}
                                className="text-sm block w-full file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-xs file:font-semibold file:bg-orange-500/20 file:text-orange-300 hover:file:bg-orange-500/30 text-slate-400 cursor-pointer transition-colors"
                            />
                        </div>
                    </div>
                </div>

                <div className="bg-black/60 border-t border-white/5 p-6 flex flex-col md:flex-row items-center justify-between gap-4">
                    <p className="text-xs text-slate-500 max-w-sm">Proses sinkronisasi dan komputasi Validasi Excel dapat memakan waktu sesuai kapasitas jumlah baris di mesin Python.</p>
                    <button
                        onClick={handleValidate}
                        disabled={isProcessing}
                        className="flex items-center justify-center gap-2 bg-indigo-600 text-white px-8 py-3.5 rounded-xl font-bold hover:bg-indigo-500 disabled:opacity-50 transition-all shadow-lg shadow-indigo-600/20 w-full md:w-auto"
                    >
                        <Play size={18} /> {isProcessing ? "Memproses Data..." : "Jalankan Engine Validasi"}
                    </button>
                </div>
            </div>
        </div>
    );
}
