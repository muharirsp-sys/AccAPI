"use client";

/*
 * Tujuan: Halaman manajemen payments/SPPD untuk upload LPB/backup, entry manual, edit grid, dan submit cart.
 * Caller: Next.js App Router route `/payments`.
 * Dependensi: FastAPI payments endpoints, lucide-react, sonner.
 * Main Functions: PaymentsPage, fetchData, handleUpload, handleManualAdd, handleSubmitCart, handleSaveBulk, handleDelete.
 * Side Effects: HTTP call ke FastAPI, upload file Excel, update/delete payments.json melalui backend.
 */

import { useEffect, useState, useMemo } from "react";
import { Wallet, Upload, FileSpreadsheet, Send, Plus, Search, Save, Trash2, DownloadCloud, Landmark, FileText } from "lucide-react";
import { toast } from "sonner";

interface PaymentRecord {
    id?: string;
    record_id: string;
    ajukan?: boolean;
    tipe_pengajuan?: string;
    no_lpb?: string;
    principle?: string;
    tgl_setor?: string;
    tgl_win?: string;
    jt_win?: string;
    tgl_jtempo_win?: string;
    nilai_sistem?: number;
    nilai_win_display?: string;
    tgl_terima_barang?: string;
    tgl_invoice?: string;
    no_invoice?: string;
    invoice_no?: string;
    invoice?: string;
    jenis_dokumen?: string;
    nomor_dokumen?: string;
    nilai_invoice?: string | number;
    jt_invoice?: string;
    gap_nilai_display?: string;
    actual_date?: string;
    tgl_pembayaran?: string;
    status_pembayaran?: string;
}

type PaymentApiRecord = PaymentRecord & { id?: string; ajukan?: boolean };

const API_BASE = process.env.NEXT_PUBLIC_FASTAPI_BASE_URL || (typeof window !== "undefined" ? `${window.location.protocol}//${window.location.hostname}:8000` : "http://localhost:8000");
let cachedCsrfToken = "";

async function getBackendCsrfToken(forceRefresh = false): Promise<string> {
    if (cachedCsrfToken && !forceRefresh) return cachedCsrfToken;
    const res = await fetch(`${API_BASE}/api/me`, { credentials: "include" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.csrf_token) throw new Error("CSRF token backend tidak tersedia.");
    cachedCsrfToken = String(data.csrf_token);
    return cachedCsrfToken;
}

const api = {
    get: async (url: string) => {
        const fetchUrl = url.startsWith("http") ? url : `${API_BASE}${url}`;
        const res = await fetch(fetchUrl, { credentials: "include" });
        if (!res.ok) throw new Error("Fetch failed");
        return { data: await res.json(), status: res.status, ok: res.ok };
    },
    post: async (url: string, data?: unknown) => {
        const fetchUrl = url.startsWith("http") ? url : `${API_BASE}${url}`;
        const isFormData = data instanceof FormData;
        const csrfToken = await getBackendCsrfToken();
        const requestInit = (token: string): RequestInit => ({
            method: "POST",
            credentials: "include",
            body: isFormData ? data : JSON.stringify(data),
            headers: isFormData ? { "X-CSRF-Token": token } : { "Content-Type": "application/json", "X-CSRF-Token": token }
        });
        let res = await fetch(fetchUrl, requestInit(csrfToken));
        if (res.status === 403) {
            const retryToken = await getBackendCsrfToken(true);
            res = await fetch(fetchUrl, requestInit(retryToken));
        }
        return { data: await res.json(), status: res.status, ok: res.ok };
    }
};

export default function PaymentsPage() {
    const [loading, setLoading] = useState(true);
    const [records, setRecords] = useState<PaymentRecord[]>([]);
    
    // Upload & Manual
    const [uploadFile, setUploadFile] = useState<File | null>(null);
    const [isUploading, setIsUploading] = useState(false);
    const [manualEntry, setManualEntry] = useState({
        tipe: 'CBD', no_lpb: '', principle: '', invoice_no: '', nilai_invoice: '', jenis_dokumen: '', nomor_dokumen: ''
    });
    const [isAddingManual, setIsAddingManual] = useState(false);

    // Compilation & Actions
    const [payMethod, setPayMethod] = useState('NON_PANIN');
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [isDeleting, setIsDeleting] = useState(false);
    const [isSaving, setIsSaving] = useState(false);

    // Filters
    const [filters, setFilters] = useState<Record<string, string>>({});

    useEffect(() => {
        fetchData();
    }, []);

    const fetchData = async () => {
        try {
            setLoading(true);
            const res = await api.get("/payments/data");
            if (res.data.ok) {
                const data = res.data.data.map((r: PaymentApiRecord) => ({
                    ...r, record_id: r.id || r.record_id, ajukan: !!r.ajukan
                }));
                setRecords(data);
            } else {
                toast.error(res.data.error || "Gagal memuat data pembayaran.");
            }
        } catch {
            toast.error("Koneksi ke server Python terputus. Pastikan backend FastAPI aktif.");
        } finally {
            setLoading(false);
        }
    };

    const handleUpload = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!uploadFile) return;
        setIsUploading(true);
        const fd = new FormData();
        fd.append("file", uploadFile);
        try {
            const res = await api.post("/payments/upload", fd);
            if (res.data.ok) {
                setUploadFile(null);
                toast.success(res.data.message || `Berhasil mengunggah ${res.data.added} data pembayaran.`);
                fetchData();
            } else {
                toast.error(res.data.error || "Gagal mengunggah dataset pembayaran.");
            }
        } catch { toast.error("Koneksi gagal saat upload."); }
        finally { setIsUploading(false); }
    };

    const handleManualAdd = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!manualEntry.principle || !manualEntry.nilai_invoice) {
            toast.error("Principle dan Nilai Invoice wajib diisi untuk entri manual.");
            return;
        }
        setIsAddingManual(true);
        try {
            const body = {
                tipe_pengajuan: manualEntry.tipe,
                no_lpb: manualEntry.no_lpb,
                principle: manualEntry.principle,
                invoice_no: manualEntry.invoice_no,
                nilai_invoice: Number(manualEntry.nilai_invoice.replace(/[^0-9]/g, '')),
                jenis_dokumen: manualEntry.jenis_dokumen,
                nomor_dokumen: manualEntry.nomor_dokumen
            };
            const res = await api.post("/payments/manual/add", body);
            if (res.data.ok) {
                toast.success("Pengajuan manual berhasil ditambahkan.");
                setManualEntry({ tipe: 'CBD', no_lpb: '', principle: '', invoice_no: '', nilai_invoice: '', jenis_dokumen: '', nomor_dokumen: '' });
                fetchData();
            } else toast.error(res.data.error || "Gagal menambahkan.");
        } catch { toast.error("Error pada server backend saat tambah manual."); } 
        finally { setIsAddingManual(false); }
    };

    const handleSubmitCart = async () => {
        const selectedIds = records.filter(r => r.ajukan).map(r => r.record_id || r.id);
        if (selectedIds.length === 0) return toast.error('Pilih minimal 1 data untuk diajukan kompilasi.');
        
        setIsSubmitting(true);
        try {
            const res = await api.post('/payments/cart/create', { method: payMethod, record_ids: selectedIds });
            if (res.data.ok) window.location.href = `${API_BASE}/payments/cart/${res.data.draft_id}`;
            else toast.error(res.data.error || 'Gagal membuat pengajuan cart.');
        } catch { toast.error('Koneksi ke server gagal saat submit draft panin/non-panin.'); } 
        finally { setIsSubmitting(false); }
    };

    const handleSaveBulk = async () => {
        setIsSaving(true);
        try {
            const items = records.map(r => ({
                id: r.record_id || r.id,
                ajukan: r.ajukan,
                tgl_invoice: r.tgl_invoice,
                invoice_no: r.invoice_no || r.invoice,
                jenis_dokumen: r.jenis_dokumen,
                nomor_dokumen: r.nomor_dokumen,
                nilai_invoice: Number(String(r.nilai_invoice || "").replace(/[^0-9]/g, '')),
                jt_invoice: r.jt_invoice,
                actual_date: r.actual_date,
                tgl_pembayaran: r.tgl_pembayaran
            }));
            const res = await api.post("/payments/update", { items });
            if (res.data.ok) {
                toast.success("Perubahan pada master tabel berhasil disimpan.");
                fetchData();
            } else toast.error(res.data.error || "Gagal menyimpan perubahan tabel.");
        } catch { toast.error("Kesalahan jaringan saat sinkronisasi grid massal."); } 
        finally { setIsSaving(false); }
    };

    const handleDelete = async () => {
        const selectedIds = records.filter(r => r.ajukan).map(r => r.record_id || r.id);
        if (selectedIds.length === 0) return toast.error('Centang data di tabel terlebih dahulu untuk dihapus.');
        if (!window.confirm(`Yakin ingin menghapus secara permanen ${selectedIds.length} data terpilih?`)) return;

        setIsDeleting(true);
        try {
            const res = await api.post('/payments/delete', { record_ids: selectedIds });
            if (res.data.ok) {
                toast.success(`Berhasil menghapus ${res.data.deleted || 0} entri data LPB/CBD.`);
                fetchData();
            } else toast.error(res.data.error || 'Gagal mengeksekusi penghapusan dari SQL.');
        } catch { toast.error('Network Error.'); } 
        finally { setIsDeleting(false); }
    };

    const handleExport = () => window.open(`${API_BASE}/payments/export`, '_blank');
    const handleTemplate = () => window.open(`${API_BASE}/payments/template`, '_blank');

    const handleInputChange = (id: string, field: keyof PaymentRecord, value: PaymentRecord[keyof PaymentRecord] | boolean) => {
        setRecords(records.map(r => r.record_id === id ? { ...r, [field]: value } : r));
    };

    const handleFilterChange = (key: string, value: string) => {
        setFilters(prev => ({ ...prev, [key]: value.toLowerCase() }));
    };

    // Filter Logic
    const filteredRecords = useMemo(() => {
        return records.filter(r => {
            if (filters['ajukan'] === 'checked' && !r.ajukan) return false;
            if (filters['ajukan'] === 'unchecked' && r.ajukan) return false;

            const searchParams: { [key: string]: string | undefined } = {
                no_lpb: r.no_lpb, principle: r.principle, tgl_setor: r.tgl_setor, tgl_win: r.tgl_win,
                jtempo_win: r.jt_win || r.tgl_jtempo_win,
                nilai_sistem: r.nilai_win_display || String(r.nilai_sistem || ''),
                tgl_terima_barang: r.tgl_terima_barang, tgl_invoice: r.tgl_invoice,
                invoice: r.invoice_no || r.invoice, jenis_dokumen: r.jenis_dokumen,
                nomor_dokumen: r.nomor_dokumen, nilai_invoice: String(r.nilai_invoice || ''),
                jt_invoice: r.jt_invoice, gap_nilai_display: r.gap_nilai_display,
                actual_date: r.actual_date, tgl_pembayaran: r.tgl_pembayaran
            };

            for (const [fKey, getVal] of Object.entries(searchParams)) {
                if (filters[fKey] && !String(getVal || '').toLowerCase().includes(filters[fKey])) {
                    return false;
                }
            }

            const searchStatus = filters['status_pembayaran'];
            const tipeSt = `${r.tipe_pengajuan || 'LPB'} - ${r.status_pembayaran || '-'}`.toLowerCase();
            if (searchStatus && !tipeSt.includes(searchStatus)) return false;

            return true;
        });
    }, [records, filters]);

    return (
        <div className="max-w-[1700px] mx-auto pb-12">
            <div className="mb-8">
                <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                        <h1 className="text-3xl font-bold text-white tracking-tight flex items-center gap-3">
                            <Wallet className="text-blue-500" />
                            Manajemen Pembayaran & SPPD
                        </h1>
                        <p className="text-slate-400 mt-2 text-lg">Kelola tagihan harian, LPB, CBD, upload dataset dan jadwalkan ke pembayaran pusat.</p>
                    </div>
                    <a href="/payments/sppd" className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-slate-200 hover:bg-white/10">
                        <FileText size={16} /> Format SPPD
                    </a>
                </div>
            </div>

            <div className="grid lg:grid-cols-2 gap-6 mb-8">
                {/* Upload Panel */}
                <div className="bg-[#1a1c23]/60 backdrop-blur-xl p-6 rounded-2xl shadow-xl border border-white/10 relative overflow-hidden group">
                    <div className="absolute top-0 right-0 w-48 h-48 bg-blue-500/10 rounded-full blur-3xl -mr-16 -mt-16 group-hover:bg-blue-500/20 transition-colors"></div>
                    <div className="relative">
                        <h2 className="text-xl font-bold text-white flex items-center gap-2 mb-1">
                            <FileSpreadsheet size={20} className="text-blue-400" /> Unggah LPB / Restore Backup
                        </h2>
                        <p className="text-sm text-slate-400 mb-6">Terima template LPB lama atau backup export PAYMENTS untuk restore data tanpa input ulang.</p>

                        <div className="flex items-center gap-4">
                            <button onClick={handleTemplate} className="flex-1 bg-white/5 border border-white/10 text-slate-300 px-4 py-3 rounded-xl font-bold text-sm hover:bg-white/10 transition-colors">
                                Unduh Template LPB
                            </button>
                            <form onSubmit={handleUpload} className="flex-[2] flex bg-black/40 border border-white/10 rounded-xl overflow-hidden focus-within:ring-1 focus-within:ring-blue-500/50 transition-colors">
                                <input type="file" accept=".xlsx,.xls" onChange={e => setUploadFile(e.target.files?.[0] || null)} className="flex-1 text-sm text-slate-300 py-3 block file:hidden px-4" />
                                <button type="submit" disabled={!uploadFile || isUploading} className="bg-blue-600 text-white px-6 font-bold text-sm hover:bg-blue-500 transition-colors disabled:opacity-50">
                                    <Upload size={18} />
                                </button>
                            </form>
                        </div>
                    </div>
                </div>

                {/* Manual Add Panel */}
                <div className="bg-[#1a1c23]/60 backdrop-blur-xl p-6 rounded-2xl shadow-xl border border-white/10 relative overflow-hidden">
                    <h2 className="text-xl font-bold text-white flex items-center gap-2 mb-1">
                        <Plus size={20} className="text-emerald-400" /> Tambah Pengajuan Manual
                    </h2>
                    <p className="text-sm text-slate-400 mb-6">Input cepat data non-rutin (CBD / NON_LPB).</p>
                    
                    <form onSubmit={handleManualAdd} className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                        <select className="bg-black/50 border border-white/10 rounded-lg px-3 py-2 text-sm text-slate-300 outline-none focus:ring-1 focus:ring-emerald-500/50" value={manualEntry.tipe} onChange={e => setManualEntry({ ...manualEntry, tipe: e.target.value })}>
                            <option value="CBD">Tipe: CBD</option>
                            <option value="NON_LPB">Tipe: NON_LPB</option>
                        </select>
                        <input placeholder="No Ref/LPB (Opsional)" className="bg-black/50 border border-white/10 rounded-lg px-3 py-2 text-sm text-white outline-none focus:ring-1 focus:ring-emerald-500/50" value={manualEntry.no_lpb} onChange={e => setManualEntry({ ...manualEntry, no_lpb: e.target.value })} disabled={manualEntry.tipe === 'CBD'} />
                        <input placeholder="Principle (Wajib)" required className="bg-black/50 border border-white/10 rounded-lg px-3 py-2 text-sm text-white outline-none focus:ring-1 focus:ring-emerald-500/50" value={manualEntry.principle} onChange={e => setManualEntry({ ...manualEntry, principle: e.target.value })} />
                        <input placeholder="No Invoice" className="bg-black/50 border border-white/10 rounded-lg px-3 py-2 text-sm text-white outline-none focus:ring-1 focus:ring-emerald-500/50" value={manualEntry.invoice_no} onChange={e => setManualEntry({ ...manualEntry, invoice_no: e.target.value })} />
                        <input placeholder="Nilai Invoice (Wajib)" required className="bg-[#1e2333] font-bold border border-emerald-500/30 rounded-lg px-3 py-2 text-sm text-emerald-400 outline-none focus:ring-1 focus:ring-emerald-500" value={manualEntry.nilai_invoice} onChange={e => setManualEntry({ ...manualEntry, nilai_invoice: e.target.value })} />
                        <button type="submit" disabled={isAddingManual} className="bg-emerald-600/20 border border-emerald-500/30 text-emerald-400 font-bold rounded-lg px-3 py-2 text-sm hover:bg-emerald-500/30 transition-colors disabled:opacity-50">
                            Simpan Entry
                        </button>
                    </form>
                </div>
            </div>

            {/* Compilation & Submit */}
            <div className="bg-gradient-to-r from-blue-900/40 to-[#1a1c23]/60 backdrop-blur-xl p-8 rounded-2xl shadow-xl border border-blue-500/20 mb-8 flex flex-col md:flex-row items-center gap-8">
                <div className="flex-1">
                    <h2 className="text-2xl font-black text-white flex items-center gap-3 mb-2 tracking-tight">
                        <Landmark size={28} className="text-blue-400" /> Tahap Kompilasi Pembayaran
                    </h2>
                    <p className="text-slate-400">Centang baris data pada area tabel utama di bawah, tentukan rute bank sistem pencairan, lalu sinkronkan semuanya menjadi 1 Draft (SPPD).</p>
                </div>
                <div className="flex-1 w-full bg-black/40 p-4 border border-white/10 rounded-xl flex items-center gap-4">
                    <select className="flex-1 bg-[#1a1c23] border border-blue-500/30 text-white font-bold rounded-xl px-4 py-3 outline-none focus:ring-2 focus:ring-blue-500 shadow-inner" value={payMethod} onChange={e => setPayMethod(e.target.value)}>
                        <option value="NON_PANIN">Route: BNN (Bank Non Panin)</option>
                        <option value="BANK_PANIN">Route: BPA (Bank Panin Terkhusus)</option>
                    </select>
                    <button onClick={handleSubmitCart} disabled={isSubmitting} className="flex-1 flex items-center justify-center gap-2 bg-blue-600 text-white font-bold py-3 rounded-xl hover:bg-blue-500 shadow-lg shadow-blue-500/20 transition-all disabled:opacity-50 text-base">
                        Eksekusi Pengajuan <Send size={18} />
                    </button>
                </div>
            </div>

            {/* Main Interactive Matrix */}
            <div className="bg-[#1a1c23]/60 backdrop-blur-xl rounded-2xl shadow-xl border border-white/10 flex flex-col overflow-hidden relative">
                <div className="p-4 border-b border-white/5 bg-black/40 flex flex-col lg:flex-row justify-between lg:items-center gap-4">
                    <div className="flex items-center gap-2 text-emerald-400 font-semibold">
                        <Search size={18} /> Engine Filter Kolom Data
                    </div>
                    <div className="flex gap-2 text-sm">
                        <button onClick={handleExport} className="flex items-center gap-2 bg-white/5 border border-white/10 text-slate-300 font-bold px-4 py-2.5 rounded-xl hover:bg-white/10 transition-colors">
                            <DownloadCloud size={16} /> Backup Tabel
                        </button>
                        <button onClick={handleDelete} disabled={isDeleting} className="flex items-center gap-2 bg-rose-500/10 border border-rose-500/20 text-rose-400 font-bold px-4 py-2.5 rounded-xl hover:bg-rose-500/20 transition-colors disabled:opacity-50">
                            <Trash2 size={16} /> Hapus Ceklis
                        </button>
                        <button onClick={handleSaveBulk} disabled={isSaving} className="flex items-center gap-2 bg-emerald-600 text-white font-bold px-5 py-2.5 rounded-xl hover:bg-emerald-500 shadow-lg shadow-emerald-500/20 transition-all disabled:opacity-50">
                            <Save size={16} /> Update Semua (Massal)
                        </button>
                    </div>
                </div>

                <div className="overflow-x-auto h-[65vh] w-full custom-scrollbar relative">
                    <table className="w-full text-sm text-left relative min-w-max border-separate border-spacing-0">
                        <thead className="text-[10px] uppercase font-bold text-slate-500 sticky top-0 z-30">
                            <tr>
                                {/* Header Labels */}
                                <th className="px-3 py-3 border-b border-white/10 bg-[#16181f]">Ajukan</th>
                                <th className="px-3 py-3 border-b border-white/10 bg-[#1e212b] sticky left-0 z-40 shadow-[1px_0_0_0_rgba(255,255,255,0.1)] text-white">No. LPB / Ref</th>
                                <th className="px-3 py-3 border-b border-white/10 bg-[#16181f]">Principle</th>
                                <th className="px-3 py-3 border-b border-white/10 bg-[#16181f]">Tgl Setor</th>
                                <th className="px-3 py-3 border-b border-white/10 bg-[#16181f]">Tgl Win</th>
                                <th className="px-3 py-3 border-b border-white/10 bg-[#16181f]">J.Tempo Win</th>
                                <th className="px-3 py-3 border-b border-white/10 bg-[#16181f] text-right text-emerald-500/70">Nilai Sistem</th>
                                <th className="px-3 py-3 border-b border-white/10 bg-[#16181f]">Terima Brg</th>
                                <th className="px-3 py-3 border-b border-white/10 bg-[#16181f] text-blue-400">Tgl Invoice</th>
                                <th className="px-3 py-3 border-b border-white/10 bg-[#16181f] text-blue-400">Invoice</th>
                                <th className="px-3 py-3 border-b border-white/10 bg-[#16181f] text-blue-400">Jenis Dok.</th>
                                <th className="px-3 py-3 border-b border-white/10 bg-[#16181f] text-blue-400">No. Dok</th>
                                <th className="px-3 py-3 border-b border-white/10 bg-[#16181f] text-right text-indigo-400">Nilai Inv.</th>
                                <th className="px-3 py-3 border-b border-white/10 bg-[#16181f] text-blue-400">JT Invoice</th>
                                <th className="px-3 py-3 border-b border-white/10 bg-[#16181f] text-right text-red-400/70">Gap</th>
                                <th className="px-3 py-3 border-b border-white/10 bg-[#16181f] text-blue-400">Actual Date</th>
                                <th className="px-3 py-3 border-b border-white/10 bg-[#16181f] text-emerald-400">Tgl Bayar Pst</th>
                                <th className="px-3 py-3 border-b border-white/10 bg-[#16181f]">Status Track</th>
                            </tr>
                            {/* Filter Controls */}
                            <tr>
                                <th className="p-1 px-[2px] bg-[#0f1115] border-b border-white/5 sticky top-[41px] z-30">
                                    <select className="w-full bg-black/60 border border-white/10 rounded text-[10px] py-1 text-slate-300 outline-none" onChange={e => handleFilterChange('ajukan', e.target.value)}>
                                        <option value="">Semua</option><option value="checked">Ceklis</option><option value="unchecked">Kosong</option>
                                    </select>
                                </th>
                                <th className="p-1 px-[2px] bg-[#1a1c24] border-b border-white/5 sticky left-0 top-[41px] z-40 shadow-[1px_0_0_0_rgba(255,255,255,0.1)]">
                                    <input type="text" placeholder="Cari Ref..." className="w-[120px] bg-black/60 border border-white/10 focus:border-blue-500 rounded text-[10px] py-1 px-2 text-white outline-none placeholder:text-slate-600 font-mono" onChange={e => handleFilterChange('no_lpb', e.target.value)} />
                                </th>
                                {['principle', 'tgl_setor', 'tgl_win', 'jtempo_win', 'nilai_sistem', 'tgl_terima_barang', 'tgl_invoice', 'invoice', 'jenis_dokumen', 'nomor_dokumen', 'nilai_invoice', 'jt_invoice', 'gap_nilai_display', 'actual_date', 'tgl_pembayaran', 'status_pembayaran'].map((fKey, i) => (
                                    <th key={i} className="p-1 px-[2px] bg-[#0f1115] border-b border-white/5 sticky top-[41px] z-30">
                                        <input type="text" placeholder="Filter..." className="w-full min-w-[70px] bg-black/60 border border-white/10 focus:border-blue-500 rounded text-[10px] py-1 px-1.5 text-slate-300 outline-none placeholder:text-slate-700 font-mono" onChange={e => handleFilterChange(fKey, e.target.value)} />
                                    </th>
                                ))}
                            </tr>
                        </thead>
                        <tbody className="textxs divide-y divide-white/5">
                            {loading && records.length === 0 ? (
                                <tr><td colSpan={18} className="px-5 py-24 text-center text-slate-500 pb-[200px]">Memuat dataset internal...</td></tr>
                            ) : filteredRecords.length === 0 ? (
                                <tr><td colSpan={18} className="px-5 py-24 text-center text-slate-500 italic pb-[200px]">Data pembayaran SPPD tidak ditemukan (Kosong).</td></tr>
                            ) : (
                                filteredRecords.map((r, i) => (
                                    <tr key={i} className="hover:bg-white/[0.03] transition-colors whitespace-nowrap group">
                                        <td className="px-3 py-1.5 text-center">
                                            <input type="checkbox" checked={!!r.ajukan} onChange={e => handleInputChange(r.record_id, 'ajukan', e.target.checked)} className="rounded bg-black/50 border-white/10 text-emerald-500 focus:ring-emerald-500/50 w-4 h-4 cursor-pointer" />
                                        </td>
                                        <td className="px-3 py-1.5 sticky left-0 z-10 font-mono font-bold text-white bg-[#101217] group-hover:bg-[#1a1d24] shadow-[1px_0_0_0_rgba(255,255,255,0.05)] transition-colors">
                                            {r.no_lpb || "-"}
                                        </td>
                                        <td className="px-3 py-1.5 text-slate-300 font-medium truncate max-w-[150px]">{r.principle || "-"}</td>
                                        <td className="px-3 py-1.5 font-mono text-slate-500">{r.tgl_setor || "-"}</td>
                                        <td className="px-3 py-1.5 font-mono text-slate-500">{r.tgl_win || "-"}</td>
                                        <td className="px-3 py-1.5 font-mono text-slate-500">{r.tgl_jtempo_win || r.jt_win || "-"}</td>
                                        <td className="px-3 py-1.5 text-right font-mono text-emerald-200/50 lg:font-bold">{r.nilai_win_display || (r.nilai_sistem ? `Rp ${r.nilai_sistem.toLocaleString()}` : "-")}</td>
                                        <td className="px-3 py-1.5 font-mono text-slate-500">{r.tgl_terima_barang || "-"}</td>
                                        
                                        {/* Editable Columns Start */}
                                        <td className="px-1 py-1"><input type="date" value={r.tgl_invoice || ""} onChange={e => handleInputChange(r.record_id, 'tgl_invoice', e.target.value)} className="w-[120px] rounded border border-white/10 bg-black/40 text-slate-300 px-2 py-1 outline-none focus:border-blue-500/50" /></td>
                                        <td className="px-1 py-1"><input type="text" value={r.invoice_no || r.invoice || ""} onChange={e => handleInputChange(r.record_id, 'invoice_no', e.target.value)} className="w-[120px] rounded border border-white/10 bg-black/40 text-slate-300 px-2 py-1 outline-none focus:border-blue-500/50" /></td>
                                        <td className="px-1 py-1"><input type="text" value={r.jenis_dokumen || ""} onChange={e => handleInputChange(r.record_id, 'jenis_dokumen', e.target.value)} className="w-[90px] rounded border border-white/10 bg-black/40 text-slate-300 px-2 py-1 outline-none focus:border-blue-500/50 placeholder:text-slate-600" placeholder="-" /></td>
                                        <td className="px-1 py-1"><input type="text" value={r.nomor_dokumen || ""} onChange={e => handleInputChange(r.record_id, 'nomor_dokumen', e.target.value)} className="w-[120px] rounded border border-white/10 bg-black/40 text-slate-300 px-2 py-1 outline-none focus:border-blue-500/50 placeholder:text-slate-600" placeholder="-" /></td>
                                        <td className="px-1 py-1"><input type="text" value={r.nilai_invoice || ""} onChange={e => handleInputChange(r.record_id, 'nilai_invoice', e.target.value)} className="w-[120px] text-indigo-400 font-bold text-right rounded border border-indigo-500/30 bg-indigo-500/5 px-2 py-1 outline-none focus:border-indigo-500" /></td>
                                        <td className="px-1 py-1"><input type="date" value={r.jt_invoice || ""} onChange={e => handleInputChange(r.record_id, 'jt_invoice', e.target.value)} className="w-[120px] rounded border border-white/10 bg-black/40 text-slate-300 px-2 py-1 outline-none focus:border-blue-500/50" /></td>
                                        <td className="px-3 py-1.5 text-right font-mono text-red-400 text-xs">{r.gap_nilai_display || "0"}</td>
                                        <td className="px-1 py-1"><input type="date" value={r.actual_date || ""} onChange={e => handleInputChange(r.record_id, 'actual_date', e.target.value)} className="w-[120px] rounded border border-white/10 bg-black/40 text-slate-300 px-2 py-1 outline-none focus:border-blue-500/50" /></td>
                                        <td className="px-1 py-1"><input type="date" value={r.tgl_pembayaran || ""} onChange={e => handleInputChange(r.record_id, 'tgl_pembayaran', e.target.value)} className="w-[120px] rounded border border-emerald-500/30 bg-emerald-500/5 text-emerald-400 font-semibold px-2 py-1 outline-none focus:border-emerald-500" /></td>
                                        <td className="px-3 py-1.5">
                                            <span className="inline-block px-2.5 py-1 rounded-md text-[10px] font-bold uppercase tracking-wider bg-white/5 border border-white/10 text-slate-400">
                                                {(r.tipe_pengajuan || "LPB")} | {(r.status_pembayaran || "Draft")}
                                            </span>
                                        </td>
                                    </tr>
                                ))
                            )}
                        </tbody>
                    </table>
                </div>
            </div>
            {/* Inject Global CSS just for this table scrollbar for a seamless dark-theme view */}
            <style jsx global>{`
                .custom-scrollbar::-webkit-scrollbar { width: 10px; height: 10px; }
                .custom-scrollbar::-webkit-scrollbar-track { background: #0f1115; border-radius: 6px; }
                .custom-scrollbar::-webkit-scrollbar-thumb { background: #334155; border-radius: 6px; }
                .custom-scrollbar::-webkit-scrollbar-thumb:hover { background: #475569; }
            `}</style>
        </div>
    );
}
