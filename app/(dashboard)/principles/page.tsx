"use client";

import { useEffect, useState } from "react";
import { Trash2, Upload, Database, AlertCircle } from "lucide-react";
import { toast } from "sonner";

interface Principle {
    name: string;
    filename: string;
    uploaded_by: string;
    created_at: string;
}

const API_BASE = typeof window !== "undefined" ? `${window.location.protocol}//${window.location.hostname}:8000` : "http://localhost:8000";
const api = {
    get: async (url: string) => {
        const fetchUrl = url.startsWith("http") ? url : `${API_BASE}${url}`;
        const res = await fetch(fetchUrl, { credentials: "include" });
        if (!res.ok) throw new Error("Fetch failed");
        return { data: await res.json(), status: res.status, ok: res.ok };
    },
    post: async (url: string, data?: any) => {
        const fetchUrl = url.startsWith("http") ? url : `${API_BASE}${url}`;
        const isFormData = data instanceof FormData;
        const res = await fetch(fetchUrl, {
            method: "POST",
            credentials: "include",
            body: isFormData ? data : JSON.stringify(data),
            headers: isFormData ? {} : { "Content-Type": "application/json" }
        });
        if (!res.ok) throw new Error("Fetch POST failed");
        return { data: await res.json(), status: res.status, ok: res.ok };
    }
};

export default function PrincipleManagementPage() {
    const [loading, setLoading] = useState(true);
    const [principles, setPrinciples] = useState<Record<string, Principle>>({});
    
    // Upload Form States
    const [isUploading, setIsUploading] = useState(false);
    const [newPrincipleName, setNewPrincipleName] = useState("");
    const [file, setFile] = useState<File | null>(null);

    useEffect(() => {
        fetchPrinciples();
    }, []);

    const fetchPrinciples = async () => {
        setLoading(true);
        try {
            const res = await api.get("/api/principles");
            if (res.data.ok) setPrinciples(res.data.principles);
        } catch (err) {
            toast.error("Gagal memuat Master Principles. Pastikan Python backend menyala.");
        } finally {
            setLoading(false);
        }
    };

    const handleUpload = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!file || !newPrincipleName) return toast.error("Pilih file Excel dan masukkan nama Principle!");

        setIsUploading(true);
        const fd = new FormData();
        fd.append("name", newPrincipleName);
        fd.append("file", file);

        try {
            const res = await api.post("/api/principles/add", fd);
            if (res.data.ok) {
                setNewPrincipleName("");
                setFile(null);
                toast.success("Berhasil mengunggah Data Master.");
                fetchPrinciples();
            } else toast.error("Gagal mengunggah: " + res.data.error);
        } catch (err) { toast.error("Error jaringan saat upload Master."); } 
        finally { setIsUploading(false); }
    };

    const handleDelete = async (pid: string) => {
        if (!confirm("Yakin ingin menghapus Data Master ini secara permanen?")) return;
        try {
            const res = await api.post(`/api/principles/${pid}/delete`);
            if (res.data.ok) {
                toast.success("Principle Master berhasil dihapus.");
                fetchPrinciples();
            } else toast.error("Gagal menghapus: " + res.data.error);
        } catch (e: any) { toast.error("Error jaringan saat menghapus Master."); }
    };

    return (
        <div className="max-w-[1200px] mx-auto pb-12">
            <div className="mb-8">
                <h1 className="text-3xl font-bold text-white tracking-tight flex items-center gap-3">
                    <Database className="text-blue-500" />
                    Manajemen Master Principle
                </h1>
                <p className="text-slate-400 mt-2 text-lg">Unggah dan kelola data master excel rujukan per Principle (Dibutuhkan untuk Summary Promo AI Regex).</p>
            </div>

            <div className="grid lg:grid-cols-3 gap-6">
                
                {/* Upload Section */}
                <div className="lg:col-span-1 bg-[#1a1c23]/60 backdrop-blur-xl p-6 rounded-2xl shadow-xl border border-white/10 relative overflow-hidden h-fit">
                    <div className="absolute top-0 right-0 w-32 h-32 bg-blue-500/10 rounded-full blur-3xl -mr-16 -mt-16"></div>
                    <div className="flex items-center gap-3 mb-6 relative">
                        <Upload className="text-blue-400" size={24} />
                        <h2 className="text-lg font-bold text-white">Tambah Baru</h2>
                    </div>

                    <form onSubmit={handleUpload} className="space-y-5 relative">
                        <div>
                            <label className="block text-sm font-medium text-slate-300 mb-2">Nama Principle / Perusahaan</label>
                            <input
                                type="text"
                                required
                                value={newPrincipleName}
                                onChange={e => setNewPrincipleName(e.target.value)}
                                placeholder="Cth: PT. Unilever"
                                className="w-full bg-black/40 border border-white/10 rounded-xl px-4 py-3 text-slate-300 outline-none focus:ring-1 focus:ring-blue-500/50"
                            />
                        </div>

                        <div>
                            <label className="block text-sm font-medium text-slate-300 mb-2">File Excel Master</label>
                            <input
                                type="file"
                                required
                                accept=".xlsx,.xls"
                                onChange={e => setFile(e.target.files?.[0] || null)}
                                className="text-sm block w-full file:mr-4 file:py-2.5 file:px-4 file:rounded-xl file:border-0 file:text-sm file:font-bold file:bg-blue-600 file:text-white file:cursor-pointer hover:file:bg-blue-500 text-slate-400 border border-white/10 rounded-xl bg-black/40 overflow-hidden"
                            />
                        </div>

                        <button
                            type="submit"
                            disabled={isUploading}
                            className="w-full bg-blue-600 text-white font-bold py-3 rounded-xl hover:bg-blue-500 disabled:opacity-50 transition-all shadow-lg shadow-blue-600/20"
                        >
                            {isUploading ? "Mengunggah..." : "Simpan Master"}
                        </button>
                    </form>
                </div>

                {/* List Grid */}
                <div className="lg:col-span-2 bg-[#1a1c23]/60 backdrop-blur-xl p-6 rounded-2xl shadow-xl border border-white/10">
                    <div className="flex items-center gap-3 mb-6">
                        <Database className="text-slate-400" size={24} />
                        <h2 className="text-lg font-bold text-white">Daftar Master Principle Aktif</h2>
                    </div>

                    {loading ? (
                        <div className="text-center py-12 text-slate-500 animate-pulse">Memuat list principle dari node backend...</div>
                    ) : Object.keys(principles).length === 0 ? (
                        <div className="text-center py-12 border border-dashed border-white/10 rounded-xl bg-black/20 flex flex-col items-center justify-center gap-2 text-slate-500">
                            <AlertCircle size={24} />
                            <p className="text-sm">Belum ada Principle yang diunggah di Sistem.</p>
                        </div>
                    ) : (
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            {Object.entries(principles).map(([id, p]) => (
                                <div key={id} className="bg-black/40 border border-white/10 rounded-xl p-5 hover:border-blue-500/50 transition-colors group relative">
                                    <h3 className="font-bold text-white mb-1.5">{p.name}</h3>
                                    <p className="text-xs font-mono text-slate-400 mb-4 bg-white/5 py-1 px-2 rounded inline-block truncate max-w-full">
                                        {p.filename}
                                    </p>

                                    <div className="flex justify-between items-center text-[10px] text-slate-500 pt-3 border-t border-white/5">
                                        <span className="truncate max-w-[100px]">By: {p.uploaded_by || "Sistem"}</span>
                                        <span>{p.created_at}</span>
                                    </div>

                                    <button
                                        onClick={() => handleDelete(id)}
                                        className="absolute top-4 right-4 text-slate-500 hover:text-red-400 hover:bg-red-500/10 p-1.5 rounded-md transition-colors"
                                        title="Hapus Master Principle"
                                    >
                                        <Trash2 size={16} />
                                    </button>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
