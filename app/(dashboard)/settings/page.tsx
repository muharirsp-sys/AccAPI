"use client";

import { useState, useEffect } from "react";
import { Save, RefreshCw, Key, Database, Settings } from "lucide-react";
import { toast } from "sonner";


export default function SettingsPage() {
    const [apiKey, setApiKey] = useState("");
    const [sessionHost, setSessionHost] = useState("");
    const [sessionId, setSessionId] = useState("");
    const [syncStates, setSyncStates] = useState<any[]>([]);
    const [isTriggering, setIsTriggering] = useState(false);

    useEffect(() => {
        // Load API configs from LocalStorage
        setApiKey(localStorage.getItem("accurate_api_key") || "");
        setSessionHost(localStorage.getItem("accurate_session_host") || "");
        setSessionId(localStorage.getItem("accurate_session_id") || "");
        
        // Initial Fetch
        fetchSyncStatus();

        // Polling sync status every 3 seconds
        const id = setInterval(fetchSyncStatus, 3000);
        return () => clearInterval(id);
    }, []);

    const fetchSyncStatus = async () => {
        try {
            const res = await fetch("/api/sync/status");
            const data = await res.json();
            if (data.ok) {
                setSyncStates(data.states);
            }
        } catch (e) {
            console.error("Failed to fetch sync status", e);
        }
    };

    const handleSaveConfig = () => {
        localStorage.setItem("accurate_api_key", apiKey);
        localStorage.setItem("accurate_session_host", sessionHost);
        localStorage.setItem("accurate_session_id", sessionId);
        toast.success("Konfigurasi API Accurate disimpan secara lokal");
    };

    const triggerSync = async (moduleName: string, endpoint: string) => {
        if (!apiKey || !sessionHost || !sessionId) {
            toast.error("Mohon lengkapi dan simpan Konfigurasi Akses API Accurate terlebih dahulu!");
            return;
        }

        setIsTriggering(true);
        try {
            const res = await fetch("/api/sync/trigger", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    moduleName,
                    endpoint,
                    sessionHost,
                    sessionId,
                    apiKey
                })
            });

            const data = await res.json();
            if (res.ok) {
                toast.success(data.message || `Memulai proses tarik data ${moduleName}...`);
                fetchSyncStatus();
            } else {
                toast.error(data.error || "Gagal memulai sinkronisasi.");
            }
        } catch (error) {
            toast.error("Terjadi kesalahan jaringan.");
        } finally {
            setIsTriggering(false);
        }
    };

    const formatTimestamp = (ts: string | number | null) => {
        if (!ts) return "Belum pernah sinkronisasi";
        const date = new Date(ts);
        return date.toLocaleString('id-ID');
    };

    const getModuleState = (modName: string) => {
        return syncStates.find(s => s.module === modName);
    };

    return (
        <div className="max-w-5xl mx-auto pb-12">
            <div className="mb-8">
                <h1 className="text-3xl font-bold text-white tracking-tight flex items-center gap-3">
                    <Settings className="text-indigo-500" />
                    Pengaturan Sistem
                </h1>
                <p className="text-slate-400 mt-2 text-lg">Konfigurasi jembatan API dan sinkronisasi mesin lokal</p>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
                {/* Panel Konfigurasi API */}
                <div className="bg-[#1a1c23]/60 backdrop-blur-xl rounded-2xl p-6 border border-white/10 shadow-xl overflow-hidden relative group">
                    <div className="absolute top-0 right-0 w-32 h-32 bg-blue-500/10 rounded-full blur-3xl -mr-10 -mt-10 transition-all group-hover:bg-blue-500/20"></div>
                    <div className="flex items-center gap-3 mb-6 relative">
                        <div className="p-3 bg-blue-500/20 rounded-xl text-blue-400">
                            <Key size={24} />
                        </div>
                        <div>
                            <h2 className="text-xl font-bold text-white">Kredensial API Accurate</h2>
                            <p className="text-sm text-slate-400">Hubungkan sistem Headless ini dengan database Cloud Accurate.</p>
                        </div>
                    </div>

                    <div className="space-y-4 relative">
                        <div>
                            <label className="block text-sm font-medium text-slate-300 mb-1.5">Session Host URL</label>
                            <input
                                type="text"
                                className="w-full bg-black/40 border border-white/10 rounded-xl px-4 py-3 text-white focus:ring-2 focus:ring-blue-500/50 outline-none transition-all placeholder:text-slate-600"
                                value={sessionHost}
                                onChange={(e) => setSessionHost(e.target.value)}
                                placeholder="https://zeus.accurate.id"
                            />
                        </div>
                        <div>
                            <label className="block text-sm font-medium text-slate-300 mb-1.5">Session ID (X-Session-ID)</label>
                            <input
                                type="text"
                                className="w-full bg-black/40 border border-white/10 rounded-xl px-4 py-3 text-white focus:ring-2 focus:ring-blue-500/50 outline-none transition-all font-mono text-sm placeholder:text-slate-600"
                                value={sessionId}
                                onChange={(e) => setSessionId(e.target.value)}
                                placeholder="8b1cd5..."
                            />
                        </div>
                        <div>
                            <label className="block text-sm font-medium text-slate-300 mb-1.5">Authorization Bearer Token / API Key</label>
                            <input
                                type="password"
                                className="w-full bg-black/40 border border-white/10 rounded-xl px-4 py-3 text-white focus:ring-2 focus:ring-blue-500/50 outline-none transition-all font-mono text-sm placeholder:text-slate-600"
                                value={apiKey}
                                onChange={(e) => setApiKey(e.target.value)}
                                placeholder="Mjg4ZjY..."
                            />
                        </div>
                        
                        <button
                            onClick={handleSaveConfig}
                            className="w-full mt-4 flex items-center justify-center gap-2 py-3 px-4 bg-blue-600 hover:bg-blue-500 text-white rounded-xl font-medium transition-all shadow-lg shadow-blue-500/20"
                        >
                            <Save size={18} />
                            Simpan Konfigurasi
                        </button>
                    </div>
                </div>

                {/* Panel Sinkronisasi Engine */}
                <div className="bg-[#1a1c23]/60 backdrop-blur-xl rounded-2xl p-6 border border-white/10 shadow-xl overflow-hidden relative group">
                    <div className="absolute top-0 right-0 w-32 h-32 bg-emerald-500/10 rounded-full blur-3xl -mr-10 -mt-10 transition-all group-hover:bg-emerald-500/20"></div>
                    <div className="flex items-center gap-3 mb-6 relative">
                        <div className="p-3 bg-emerald-500/20 rounded-xl text-emerald-400">
                            <Database size={24} />
                        </div>
                        <div>
                            <h2 className="text-xl font-bold text-white">Local Database Mirroring</h2>
                            <p className="text-sm text-slate-400">Tarik dari API Accurate ke SQLite secara Background.</p>
                        </div>
                    </div>

                    <div className="space-y-4 relative">
                        {/* Modul: Master Barang */}
                        <div className="p-4 bg-black/30 border border-white/5 rounded-xl flex items-center justify-between">
                            <div>
                                <h3 className="font-semibold text-white">Master Barang & Jasa (Item)</h3>
                                <div className="text-xs mt-1 text-slate-400 flex flex-col gap-0.5">
                                    <span>Status: <strong className={`font-medium ${getModuleState('item')?.status === 'syncing' ? 'text-amber-400 animate-pulse' : getModuleState('item')?.status === 'error' ? 'text-red-400' : 'text-emerald-400'}`}>
                                        {getModuleState('item')?.status?.toUpperCase() || 'BELUM PERNAH'}
                                    </strong></span>
                                    <span>Last Sync: {formatTimestamp(getModuleState('item')?.updatedAt)}</span>
                                    <span>Paginator: Halaman {getModuleState('item')?.lastPage || 1}</span>
                                </div>
                            </div>
                            <button
                                onClick={() => triggerSync('item', '/item/list.do')}
                                disabled={isTriggering || getModuleState('item')?.status === 'syncing'}
                                className="flex items-center gap-2 px-4 py-2 bg-slate-800 hover:bg-emerald-600/20 hover:text-emerald-400 text-slate-300 border border-slate-700 hover:border-emerald-500/50 rounded-lg text-sm font-medium transition-all disabled:opacity-50"
                            >
                                <RefreshCw size={16} className={getModuleState('item')?.status === 'syncing' ? 'animate-spin' : ''} />
                                {getModuleState('item')?.status === 'syncing' ? 'Menarik...' : 'Sinkron'}
                            </button>
                        </div>

                        {/* Modul: Master Pelanggan */}
                        <div className="p-4 bg-black/30 border border-white/5 rounded-xl flex items-center justify-between">
                            <div>
                                <h3 className="font-semibold text-white">Master Pelanggan (Customer)</h3>
                                <div className="text-xs mt-1 text-slate-400 flex flex-col gap-0.5">
                                    <span>Status: <strong className={`font-medium ${getModuleState('customer')?.status === 'syncing' ? 'text-amber-400 animate-pulse' : getModuleState('customer')?.status === 'error' ? 'text-red-400' : 'text-emerald-400'}`}>
                                        {getModuleState('customer')?.status?.toUpperCase() || 'BELUM PERNAH'}
                                    </strong></span>
                                    <span>Last Sync: {formatTimestamp(getModuleState('customer')?.updatedAt)}</span>
                                    <span>Paginator: Halaman {getModuleState('customer')?.lastPage || 1}</span>
                                </div>
                            </div>
                            <button
                                onClick={() => triggerSync('customer', '/customer/list.do')}
                                disabled={isTriggering || getModuleState('customer')?.status === 'syncing'}
                                className="flex items-center gap-2 px-4 py-2 bg-slate-800 hover:bg-emerald-600/20 hover:text-emerald-400 text-slate-300 border border-slate-700 hover:border-emerald-500/50 rounded-lg text-sm font-medium transition-all disabled:opacity-50"
                            >
                                <RefreshCw size={16} className={getModuleState('customer')?.status === 'syncing' ? 'animate-spin' : ''} />
                                {getModuleState('customer')?.status === 'syncing' ? 'Menarik...' : 'Sinkron'}
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
