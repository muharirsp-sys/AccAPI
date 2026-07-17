"use client";

import { useEffect, useState } from "react";
import { Trash2, Plus, Upload, Play, FileText, Download, ChevronLeft, CalendarCheck2, Flag, Loader2, Inbox, AlertTriangle } from "lucide-react";
import Link from "next/link";
import { toast } from "sonner";
import { resolveApiBase } from "@/lib/apiBase";

interface Principle {
    [id: string]: { name: string; filename: string };
}

interface RowData {
    id: string;
    no: string;
    principle: string;
    surat_program: string;
    nama_program: string;
    promo_group_id: string;
    channel_gtmt: string;
    channel_list: string;
    periode_start: string;
    periode_end: string;
    kelompok: string;
    variant: string;
    gramasi: string;
    ketentuan: string;
    benefit_type: string;
    benefit: string;
    syarat_claim: string;
    update: string;
    keterangan: string;
    kode_barangs?: string;
    periode?: string;
    _original?: Record<string, any>;
    /** Dari matcher deterministik Priskila: baris surat yang TIDAK ketemu di
     *  master -- sengaja tidak ditebak, wajib direview manusia. */
    _priskila_unmatched?: boolean;
}

// Emulating Axios for backwards compatibility with legacy codebase
const API_BASE = resolveApiBase();
const api = {
    defaults: { baseURL: API_BASE },
    get: async (url: string, opts?: any) => {
        const fetchUrl = url.startsWith("http") ? url : `${API_BASE}${url}`;
        const isBlob = opts?.responseType === 'blob';
        const res = await fetch(fetchUrl, { credentials: "include" });
        if (!res.ok && !isBlob) throw new Error("Fetch failed");
        if (isBlob) return { data: await res.blob() };
        return { data: await res.json(), status: res.status, ok: res.ok };
    },
    post: async (url: string, data?: any, opts?: any) => {
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

const MultiSelect = ({
    options, value, onChange, placeholder
}: {
    options: { value: string, text: string }[], value: string, onChange: (val: string) => void, placeholder: string
}) => {
    const [isOpen, setIsOpen] = useState(false);
    const selectedValues = value ? value.split(/[,&]/).map(v => v.trim()).filter(Boolean) : [];

    const handleToggle = (optValue: string) => {
        let newSelected;
        if (selectedValues.includes(optValue)) newSelected = selectedValues.filter(v => v !== optValue);
        else newSelected = [...selectedValues, optValue];

        if (newSelected.length === options.length && options.length > 0 && (placeholder.includes("Variant") || placeholder.includes("Gramasi"))) {
            onChange(placeholder.includes("Variant") ? "All Variant" : "All Gramasi");
        } else {
            onChange(newSelected.join(" & "));
        }
    };

    let displayText = placeholder;
    if (value.toLowerCase().includes("all variant") || value.toLowerCase().includes("all gramasi")) {
        displayText = value;
    } else if (selectedValues.length > 0) {
        const displayTexts = selectedValues.map(v => {
            const opt = options.find(o => o.value === v);
            return opt ? opt.text : v;
        });
        displayText = displayTexts.length <= 2 ? displayTexts.join(", ") : `${displayTexts.length} dipilih`;
    }

    return (
        <div className="relative w-32">
            <button
                type="button"
                onClick={() => setIsOpen(!isOpen)}
                className="w-full text-left border border-white/10 rounded-lg px-2 py-1.5 bg-black/40 text-slate-300 truncate text-xs flex justify-between items-center outline-none focus:ring-1 focus:ring-emerald-500"
            >
                <span className="truncate">{displayText}</span>
                <span className="text-[10px] ml-1">▼</span>
            </button>
            {isOpen && (
                <>
                    <div className="fixed inset-0 z-10" onClick={() => setIsOpen(false)}></div>
                    <div className="absolute z-20 mt-1 w-48 bg-[#1a1c23] border border-white/10 rounded-lg shadow-xl shadow-black max-h-60 overflow-y-auto">
                        <div className="p-1 space-y-1">
                            {options.length === 0 ? (
                                <div className="p-2 text-slate-500 italic text-[10px]">Pilih kelompok dulu</div>
                            ) : (
                                options.map((opt, i) => {
                                    const isSelected = selectedValues.includes(opt.value) || value.toLowerCase().includes("all");
                                    return (
                                        <label key={i} className="flex items-center gap-2 p-1.5 hover:bg-white/5 rounded cursor-pointer">
                                            <input
                                                type="checkbox"
                                                checked={isSelected}
                                                onChange={() => handleToggle(opt.value)}
                                                className="rounded bg-black/50 border-white/10 text-emerald-500 focus:ring-emerald-500/50"
                                            />
                                            <span className="text-[11px] text-slate-300 truncate">{opt.text}</span>
                                        </label>
                                    );
                                })
                            )}
                        </div>
                    </div>
                </>
            )}
        </div>
    );
};

export default function SummaryManualPage() {
    const [principles, setPrinciples] = useState<Principle>({});
    const [selectedPrinciple, setSelectedPrinciple] = useState("");

    const [masterToken, setMasterToken] = useState("");
    const [kelompokList, setKelompokList] = useState<string[]>([]);
    const [masterStatus, setMasterStatus] = useState("");

    const [pdfFile, setPdfFile] = useState<File | null>(null);
    const [isPdfParsing, setIsPdfParsing] = useState(false);
    const [pdfStatus, setPdfStatus] = useState("");
    const [aiMode, setAiMode] = useState<"split" | "full">("split");

    const [rows, setRows] = useState<RowData[]>([]);
    const [variantOptions, setVariantOptions] = useState<Record<string, any[]>>({});
    const [gramasiOptions, setGramasiOptions] = useState<Record<string, any[]>>({});

    const [isGenerating, setIsGenerating] = useState(false);
    const [downloadId, setDownloadId] = useState<string | null>(null);
    const [downloadLinks, setDownloadLinks] = useState<{ form: string, dataset: string } | null>(null);
    const [pollStatus, setPollStatus] = useState("");

    const [emailTarget, setEmailTarget] = useState("");
    const [emailStatus, setEmailStatus] = useState("");

    useEffect(() => {
        api.get("/api/principles").then((res) => {
            if (res.data.ok) setPrinciples(res.data.principles);
        }).catch(e => {
            console.error(e);
            toast.error("Gagal terhubung ke Python Backend (localhost:8000). Pastikan FastAPI berjalan.");
        });
    }, []);

    const handleUsePrinciple = async () => {
        if (!selectedPrinciple) return;
        setMasterStatus("Memuat principle...");
        try {
            const res = await api.post(`/api/summary/manual/master/load_principle/${selectedPrinciple}`);
            if (res.data.ok) {
                setMasterToken(res.data.token);
                setKelompokList(res.data.kelompok_list || []);
                setMasterStatus(`Berhasil memuat Master (Kelompok: ${(res.data.kelompok_list || []).length})`);
                toast.success("Master Principle dimuat.");
            } else {
                setMasterStatus("Gagal: " + res.data.error);
            }
        } catch (e: any) {
            setMasterStatus("Error memuat Principle.");
        }
    };

    const handleMasterUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        if (!e.target.files?.[0]) return;
        setMasterStatus("Mengunggah master...");
        const fd = new FormData();
        fd.append("master", e.target.files[0]);
        try {
            const res = await api.post("/summary/manual/master/upload", fd);
            if (res.data.ok) {
                setMasterToken(res.data.token);
                setKelompokList(res.data.kelompok_list || []);
                setMasterStatus(`Berhasil unggah (Kelompok: ${(res.data.kelompok_list || []).length})`);
                toast.success("Master Excel berhasil diunggah.");
            } else {
                setMasterStatus("Gagal: " + res.data.error);
            }
        } catch {
            setMasterStatus("Error koneksi upload master.");
        }
    };

    const fetchOptions = async (rowId: string, kel: string, currentVariant?: string, currentGramasi?: string) => {
        if (!masterToken || !kel) return;
        try {
            const res = await api.get(`/summary/manual/master/options?token=${masterToken}&group=${encodeURIComponent(kel)}`);
            if (res.data.ok) {
                const variants = res.data.variants || [];
                const gramasis = res.data.gramasis || [];
                setVariantOptions(p => ({ ...p, [rowId]: variants }));
                setGramasiOptions(p => ({ ...p, [rowId]: gramasis }));

                if (currentVariant || currentGramasi) {
                    setRows(prev => prev.map(r => {
                        if (r.id !== rowId) return r;
                        let newV = r.variant;
                        let newG = r.gramasi;

                        if (currentVariant && currentVariant !== "...") {
                            const provided = currentVariant.split(",").map(x => x.trim().toLowerCase());
                            const matched = variants.filter((v: any) => provided.includes(v.text.toLowerCase())).map((v: any) => v.value);
                            if (matched.length > 0) newV = matched.join(", ");
                        }
                        if (currentGramasi && currentGramasi !== "...") {
                            const provided = currentGramasi.split(",").map(x => x.trim().toLowerCase());
                            const matched = gramasis.filter((g: any) => provided.includes(g.text.toLowerCase())).map((g: any) => g.value);
                            if (matched.length > 0) newG = matched.join(", ");
                        }
                        return { ...r, variant: newV, gramasi: newG };
                    }));
                }
            }
        } catch (e) { console.error(e); }
    };

    const handlePdfExtract = async (mode: 'regex' | 'ai') => {
        if (!pdfFile || !masterToken) return;
        setIsPdfParsing(true);
        const endpoint = mode === 'ai' ? 'parse_pdf_ai' : 'parse_pdf_regex';
        const label = mode === 'ai' ? 'Gemini 2.5 Flash' : 'Regex Manual';
        setPdfStatus(`Mengirim PDF dengan ${label}...`);

        const fd = new FormData();
        fd.append("pdf", pdfFile);
        fd.append("token", masterToken);
        if (mode === "ai") fd.append("ai_mode", aiMode);
        
        const principleName = principles[selectedPrinciple]?.name || "Priskila (Default)";
        fd.append("principle_name", principleName);

        try {
            const res = await api.post(`/summary/manual/${endpoint}`, fd);
            if (res.data.ok) {
                const parsedRows = res.data.rows.map((r: any) => {
                    const id = crypto.randomUUID();
                    let correctKelompok = r.kelompok || "";
                    // ponytail: simpan snapshot hasil AI asli utk fitur "Laporkan Salah" (before/after)
                    return { ...r, id, kelompok: correctKelompok, _original: { ...r } };
                });

                setRows(prev => [...prev, ...parsedRows]);
                setPdfStatus(`Sukses mengekstrak ${parsedRows.length} baris menggunakan ${label}.`);
                toast.success(`Ekstraksi PDF Selesai (${parsedRows.length} baris)`);

                for (const row of parsedRows) {
                    if (row.kelompok && row.kelompok !== "Bisa Meleset") fetchOptions(row.id, row.kelompok, row.variant, row.gramasi);
                }
            } else {
                setPdfStatus(`Gagal (${label}): ` + res.data.error);
                toast.error(res.data.error);
            }
        } catch {
            setPdfStatus(`Error proses PDF menggunakan ${label}.`);
            toast.error(`Terjadi kesalahan jaringan saat ekstraksi PDF.`);
        } finally {
            setIsPdfParsing(false);
        }
    };

    const createEmptyRow = (): RowData => {
        const today = new Date().toISOString().split('T')[0];
        const firstDay = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().split('T')[0];
        return {
            id: crypto.randomUUID(), no: "", principle: "", surat_program: "", nama_program: "",
            promo_group_id: "", channel_gtmt: "", channel_list: "", periode_start: firstDay, periode_end: today,
            kelompok: "", variant: "", gramasi: "", ketentuan: "", benefit_type: "DISC_PCT", benefit: "",
            syarat_claim: "", update: today, keterangan: "Manual"
        };
    };

    const addRow = () => setRows(p => [...p, createEmptyRow()]);
    const updateRow = (id: string, field: keyof RowData, val: string) => {
        setRows(p => p.map(r => {
            if (r.id === id) {
                const newR = { ...r, [field]: val };
                if (field === 'kelompok') fetchOptions(id, val, newR.variant, newR.gramasi);
                return newR;
            }
            return r;
        }));
    };

    const pollJobStatus = async (jobId: string) => {
        try {
            const res = await api.get(`/api/job_status/${jobId}`);
            const stat = res.data;
            if (stat.status === 'done' && stat.result && stat.result.file_id) {
                const fid = stat.result.file_id;
                setDownloadId(fid);
                setDownloadLinks({
                    form: `${api.defaults.baseURL}/summary/manual/download/${fid}/form/file.pdf`,
                    dataset: `${api.defaults.baseURL}/summary/manual/download/${fid}/dataset/file.xlsx`
                });
                setIsGenerating(false);
                setPollStatus("Selesai!");
                toast.success("Dokumen Summary berhasil di-generate.");
            } else if (stat.status === 'error') {
                toast.error("Gagal Generate: " + stat.error);
                setIsGenerating(false);
                setPollStatus("");
            } else {
                setPollStatus("Sedang render Excel file...");
                setTimeout(() => pollJobStatus(jobId), 1500);
            }
        } catch (e) {
            toast.error("Network error saat polling status.");
            setIsGenerating(false);
            setPollStatus("");
        }
    };

    const handleGenerate = async () => {
        if (!masterToken) return;
        setIsGenerating(true);
        setDownloadLinks(null);
        setDownloadId(null);
        setPollStatus("Memulai job background...");
        setEmailStatus("");

        try {
            const cleanRows = rows.map(({ id, ...rest }) => rest);
            const fd = new FormData();
            fd.append("token", masterToken);
            fd.append("rows_json", JSON.stringify(cleanRows));

            const res = await api.post("/summary/manual/generate", fd);

            if (res.data.ok) {
                if (res.data.file_id) {
                    const fid = res.data.file_id;
                    setDownloadId(fid);
                    setDownloadLinks({
                        form: `${api.defaults.baseURL}/summary/manual/download/${fid}/form/file.pdf`,
                        dataset: `${api.defaults.baseURL}/summary/manual/download/${fid}/dataset/file.xlsx`
                    });
                    setIsGenerating(false);
                    setPollStatus("Selesai!");
                    toast.success("Summary generated directly!");
                } else if (res.data.job_id) {
                    pollJobStatus(res.data.job_id);
                }
            } else {
                toast.error("Gagal: " + res.data.error);
                setIsGenerating(false);
                setPollStatus("");
            }
        } catch {
            toast.error("Error generate internal.");
            setIsGenerating(false);
            setPollStatus("");
        }
    };

    const handleSendEmail = async () => {
        if (!emailTarget || !downloadId) return;
        setEmailStatus("Mengirim via Email...");
        try {
            const res = await api.post(`/summary/manual/email`, { email: emailTarget, file_id: downloadId });
            if (res.data.ok) {
                setEmailStatus("Sedang diproses. Cek inbox beberapa menit lagi.");
                toast.success("Email antrean dijadwalkan.");
            } else setEmailStatus("Gagal: " + res.data.error);
        } catch (e) { setEmailStatus("Gagal terhubung ke server."); }
    };

    const handleReportWrong = async (row: RowData) => {
        const note = window.prompt("Catatan koreksi (opsional, mis. 'Camellia 22ml seharusnya Beli 7 bukan Beli 4'):", "");
        if (note === null) return; // batal
        const { id, _original, ...after } = row;
        const principleName = principles[selectedPrinciple]?.name || "Priskila (Default)";
        try {
            const res = await api.post("/summary/manual/report_correction", {
                principle_name: principleName,
                before: _original || {},
                after,
                note,
            });
            if (res.data.ok) toast.success("Koreksi tersimpan: jadi hint AI di ekstraksi berikutnya, DAN override pasti di generate berikutnya (kode barang sama).");
            else toast.error("Gagal simpan koreksi: " + res.data.error);
        } catch {
            toast.error("Error koneksi saat kirim koreksi.");
        }
    };

    const handleDownload = async (url: string, filename: string) => {
        try {
            const response = await api.get(url, { responseType: 'blob' });
            const blobUrl = window.URL.createObjectURL(response.data as Blob);
            const a = document.createElement('a');
            a.href = blobUrl;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            setTimeout(() => { a.remove(); window.URL.revokeObjectURL(blobUrl); }, 1000);
        } catch (error) { toast.error("Error saat mengunduh."); }
    };

    return (
        <div className="max-w-[1400px] mx-auto pb-12">
            <div className="mb-8">
                <h1 className="text-3xl font-bold text-white tracking-tight flex items-center gap-3">
                    <CalendarCheck2 className="text-emerald-500" />
                    Summary Promo Editor
                </h1>
                <p className="text-slate-400 mt-2 text-lg">Buat Summary Promo / LPB Form secara manual atau semi-otomatis</p>
            </div>

            <div className="space-y-6">
                {/* STEP 1: Master Setup */}
                <div className="bg-[#1a1c23]/60 backdrop-blur-xl p-6 rounded-2xl shadow-xl border border-white/10 relative overflow-hidden">
                    <div className="absolute top-0 right-0 w-32 h-32 bg-emerald-500/10 rounded-full blur-3xl -mr-10 -mt-10"></div>
                    <div className="flex items-center gap-3 mb-6 relative">
                        <div className="bg-emerald-500/15 text-emerald-400 w-8 h-8 rounded-full flex items-center justify-center font-bold border border-emerald-500/30">1</div>
                        <h2 className="text-xl font-bold text-white">Setup master barang</h2>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-8 relative">
                        <div className="p-4 bg-black/40 border border-white/5 rounded-xl">
                            <label className="block text-sm font-medium text-slate-300 mb-3">Pilih Principle Tersimpan</label>
                            <div className="flex gap-2">
                                <select className="flex-1 bg-black/50 border border-white/10 rounded-lg text-sm text-white px-3 py-2 outline-none focus:ring-1 focus:ring-emerald-500"
                                    value={selectedPrinciple} onChange={e => setSelectedPrinciple(e.target.value)}>
                                    <option value="" className="bg-black/80">-- Pilih Principle --</option>
                                    {Object.entries(principles).map(([id, p]) => <option key={id} value={id} className="bg-black/80">{p.name}</option>)}
                                </select>
                                <button onClick={handleUsePrinciple} className="bg-emerald-600 hover:bg-emerald-500 active:scale-[0.98] text-white px-4 py-2 rounded-lg text-sm font-semibold transition-all duration-200">
                                    Gunakan
                                </button>
                            </div>
                        </div>

                        <div className="p-4 bg-black/40 border border-white/5 rounded-xl">
                            <label className="block text-sm font-medium text-slate-300 mb-3">Unggah Excel Master Baru</label>
                            <input type="file" accept=".xlsx,.xls" onChange={handleMasterUpload} className="text-sm block w-full file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-sm file:font-semibold file:bg-emerald-500/15 file:text-emerald-300 hover:file:bg-emerald-500/25 file:transition-colors text-white/50 cursor-pointer" />
                        </div>
                    </div>
                    {masterStatus && <p className="mt-4 text-sm font-medium text-emerald-400 bg-emerald-500/10 inline-block px-3 py-1.5 rounded-md border border-emerald-500/20">{masterStatus}</p>}
                </div>

                {/* STEP 1.5: PDF Extraction */}
                {masterToken && (
                    <div className="bg-[#1a1c23]/60 backdrop-blur-xl p-6 rounded-2xl shadow-xl border border-emerald-500/20 relative overflow-hidden group">
                        <div className="absolute top-0 right-0 w-32 h-32 bg-emerald-500/10 rounded-full blur-3xl -mr-10 -mt-10 group-hover:bg-emerald-500/20 transition-all"></div>
                        <div className="flex items-center gap-3 mb-6 relative">
                            <div className="bg-emerald-500/15 text-emerald-400 w-8 h-8 rounded-full flex items-center justify-center font-bold border border-emerald-500/30">2</div>
                            <div>
                                <h2 className="text-lg font-bold text-white">Ekstrak dari dokumen PDF</h2>
                                <p className="text-sm text-slate-400">Unggah surat program, sistem mengisi tabel secara otomatis.</p>
                            </div>
                        </div>
                        <div className="flex flex-col gap-4 max-w-2xl relative">
                            <div className="flex flex-col sm:flex-row items-center gap-3">
                                <input type="file" accept="application/pdf" onChange={e => setPdfFile(e.target.files?.[0] || null)} className="text-sm w-full sm:flex-1 bg-black/40 border border-white/10 rounded-lg px-3 py-2 text-white/70" />
                                
                                <div className="flex gap-2 w-full sm:w-auto">
                                    <button onClick={() => handlePdfExtract('regex')} disabled={!pdfFile || isPdfParsing} className="flex-1 sm:flex-none flex items-center justify-center gap-2 bg-white/5 hover:bg-white/10 active:scale-[0.98] text-slate-300 hover:text-white px-4 py-2 border border-white/10 rounded-lg text-sm font-semibold disabled:opacity-50 disabled:pointer-events-none transition-all duration-200">
                                        Regex manual
                                    </button>

                                    <button onClick={() => handlePdfExtract('ai')} disabled={!pdfFile || isPdfParsing} className="flex-1 sm:flex-none flex items-center justify-center gap-2 bg-emerald-600 hover:bg-emerald-500 active:scale-[0.98] text-white px-4 py-2 border border-emerald-500 rounded-lg text-sm font-semibold disabled:opacity-50 disabled:pointer-events-none transition-all duration-200">
                                        {isPdfParsing ? (<><Loader2 size={15} className="animate-spin" /> Mengekstrak…</>) : "Ekstrak cerdas"}
                                    </button>
                                </div>
                            </div>
                        </div>
                        {pdfStatus && <p className="mt-4 text-sm font-medium text-emerald-300 bg-emerald-500/10 p-2.5 rounded-lg border border-emerald-500/20 inline-block">{pdfStatus}</p>}
                    </div>
                )}

                {/* STEP 2: Table */}
                {masterToken && (
                    <div className="bg-[#1a1c23]/60 backdrop-blur-xl p-6 rounded-2xl shadow-xl border border-white/10 overflow-hidden relative">
                        <div className="flex justify-between items-center mb-6">
                            <div className="flex items-center gap-3">
                                <div className="bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 w-8 h-8 rounded-full flex items-center justify-center font-bold">3</div>
                                <h2 className="text-xl font-bold text-white">Data summary</h2>
                                {rows.some(r => r._priskila_unmatched) && (
                                    <span className="flex items-center gap-1.5 text-xs font-semibold text-amber-400 bg-amber-500/10 border border-amber-500/25 px-2.5 py-1 rounded-md">
                                        <AlertTriangle size={13} />
                                        {rows.filter(r => r._priskila_unmatched).length} baris perlu review
                                    </span>
                                )}
                            </div>
                            <button onClick={addRow} className="flex items-center gap-2 bg-white/5 text-slate-300 hover:bg-white/10 hover:text-white active:scale-[0.98] border border-white/10 px-4 py-2 rounded-lg text-sm font-medium transition-all duration-200">
                                <Plus size={16} /> Tambah baris
                            </button>
                        </div>

                        <div className="overflow-x-auto rounded-xl border border-white/10 bg-black/20">
                            <table className="w-full text-xs text-left whitespace-nowrap min-w-max [font-variant-numeric:tabular-nums]">
                                <thead className="bg-black/60 border-b border-white/10 text-slate-400 uppercase tracking-tighter">
                                    <tr>
                                        <th className="px-3 py-3 font-semibold">No</th>
                                        <th className="px-3 py-3 font-semibold">Principle</th>
                                        <th className="px-3 py-3 font-semibold">Srt. Program</th>
                                        <th className="px-3 py-3 font-semibold">Nm. Program</th>
                                        <th className="px-3 py-3 font-semibold">Channel</th>
                                        <th className="px-3 py-3 font-semibold">Kelompok</th>
                                        <th className="px-3 py-3 font-semibold">Variant</th>
                                        <th className="px-3 py-3 font-semibold">Gramasi</th>
                                        <th className="px-3 py-3 font-semibold">Ketentuan</th>
                                        <th className="px-3 py-3 font-semibold">Benefit Type</th>
                                        <th className="px-3 py-3 font-semibold">Value</th>
                                        <th className="px-3 py-3 text-center font-semibold">Aksi</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-white/5">
                                    {rows.map((r) => (
                                        <tr key={r.id} title={r._priskila_unmatched ? "Baris surat ini tidak ketemu di master -- sistem sengaja tidak menebak. Lengkapi kelompok/variant secara manual." : undefined}
                                            className={r._priskila_unmatched
                                                ? "bg-amber-500/[0.06] border-l-2 border-l-amber-500 hover:bg-amber-500/10 transition-colors"
                                                : "hover:bg-white/[0.02] transition-colors"}>
                                            <td className="px-2 py-2"><input type="text" value={r.no} onChange={e => updateRow(r.id, "no", e.target.value)} className="w-10 bg-black/40 border border-white/10 rounded px-1.5 py-1 text-slate-300 focus:ring-1 focus:ring-emerald-500 outline-none" /></td>
                                            <td className="px-2 py-2"><input type="text" value={r.principle} onChange={e => updateRow(r.id, "principle", e.target.value)} className="w-24 bg-black/40 border border-white/10 rounded px-2 py-1 text-slate-300 focus:ring-1 focus:ring-emerald-500 outline-none" /></td>
                                            <td className="px-2 py-2"><input type="text" value={r.surat_program} onChange={e => updateRow(r.id, "surat_program", e.target.value)} className="w-28 bg-black/40 border border-white/10 rounded px-2 py-1 text-slate-300 focus:ring-1 focus:ring-emerald-500 outline-none" /></td>
                                            <td className="px-2 py-2"><input type="text" value={r.nama_program} onChange={e => updateRow(r.id, "nama_program", e.target.value)} className="w-32 bg-black/40 border border-white/10 rounded px-2 py-1 text-slate-300 focus:ring-1 focus:ring-emerald-500 outline-none" /></td>
                                            <td className="px-2 py-2">
                                                <select value={r.channel_gtmt} onChange={e => updateRow(r.id, "channel_gtmt", e.target.value)} className="bg-black/40 border border-white/10 rounded px-2 py-1.5 text-slate-300 focus:ring-1 focus:ring-emerald-500 outline-none">
                                                    <option value="">-</option><option value="GT">GT</option><option value="MT">MT</option>
                                                </select>
                                            </td>
                                            <td className="px-2 py-2">
                                                <MultiSelect options={kelompokList.map(k => ({ value: k, text: k }))} value={r.kelompok} onChange={v => updateRow(r.id, "kelompok", v)} placeholder="- Kelompok -" />
                                            </td>
                                            <td className="px-2 py-2">
                                                <MultiSelect options={variantOptions[r.id] || []} value={r.variant} onChange={v => updateRow(r.id, "variant", v)} placeholder="- Variant -" />
                                            </td>
                                            <td className="px-2 py-2">
                                                <MultiSelect options={gramasiOptions[r.id] || []} value={r.gramasi} onChange={g => updateRow(r.id, "gramasi", g)} placeholder="- Gramasi -" />
                                            </td>
                                            <td className="px-2 py-2"><input type="text" value={r.ketentuan} onChange={e => updateRow(r.id, "ketentuan", e.target.value)} className="w-20 bg-black/40 border border-white/10 rounded px-2 py-1 text-slate-300 outline-none focus:ring-1 focus:ring-emerald-500" /></td>
                                            <td className="px-2 py-2">
                                                <select value={r.benefit_type} onChange={e => updateRow(r.id, "benefit_type", e.target.value)} className="bg-black/40 border border-white/10 rounded px-2 py-1.5 text-slate-300 outline-none focus:ring-1 focus:ring-emerald-500">
                                                    <option value="DISC_PCT">DISC_PCT (%)</option>
                                                    <option value="DISC_RP">DISC_RP (Rp)</option>
                                                    <option value="BONUS_QTY">BONUS_QTY (+)</option>
                                                </select>
                                            </td>
                                            <td className="px-2 py-2"><input type="text" value={r.benefit} onChange={e => updateRow(r.id, "benefit", e.target.value)} className="w-20 bg-black/40 border border-white/10 rounded px-2 py-1 text-slate-300 outline-none focus:ring-1 focus:ring-emerald-500" /></td>
                                            <td className="px-2 py-2 text-center flex items-center justify-center gap-1">
                                                <button onClick={() => handleReportWrong(r)} title="Laporkan baris ini salah, AI akan belajar dari koreksinya" className="text-amber-400 hover:text-amber-300 hover:bg-amber-500/20 p-1.5 rounded transition-colors">
                                                    <Flag size={16} />
                                                </button>
                                                <button onClick={() => setRows(p => p.filter(x => x.id !== r.id))} className="text-red-400 hover:text-red-300 hover:bg-red-500/20 p-1.5 rounded transition-colors">
                                                    <Trash2 size={16} />
                                                </button>
                                            </td>
                                        </tr>
                                    ))}
                                    {rows.length === 0 && (
                                        <tr>
                                            <td colSpan={12} className="px-4 py-16">
                                                <div className="flex flex-col items-center gap-3 text-center">
                                                    <div className="w-12 h-12 rounded-xl bg-white/5 border border-white/10 flex items-center justify-center">
                                                        <Inbox size={22} className="text-slate-500" />
                                                    </div>
                                                    <p className="text-sm text-slate-400 font-medium">Belum ada data promo</p>
                                                    <p className="text-xs text-slate-500 max-w-xs [text-wrap:balance]">Unggah surat program PDF di langkah 2, atau tambah baris kosong untuk mengisi manual.</p>
                                                    <button onClick={addRow} className="mt-1 flex items-center gap-2 text-xs font-semibold text-emerald-400 hover:text-emerald-300 bg-emerald-500/10 hover:bg-emerald-500/15 border border-emerald-500/25 px-3 py-1.5 rounded-lg transition-colors">
                                                        <Plus size={14} /> Tambah baris pertama
                                                    </button>
                                                </div>
                                            </td>
                                        </tr>
                                    )}
                                </tbody>
                            </table>
                        </div>

                        {rows.length > 0 && (
                            <div className="mt-6 flex flex-col gap-4 p-6 bg-black/40 border border-white/5 rounded-xl justify-center items-center">
                                {!downloadLinks ? (
                                    <>
                                        <button onClick={handleGenerate} disabled={isGenerating} className="flex items-center gap-2 bg-emerald-600 text-white px-8 py-3.5 rounded-xl font-bold hover:bg-emerald-500 active:scale-[0.98] disabled:opacity-50 disabled:pointer-events-none shadow-lg shadow-emerald-500/20 transition-all duration-200">
                                            {isGenerating ? (<><Loader2 size={18} className="animate-spin" /> Memproses data…</>) : (<><Play size={18} /> Generate summary final</>)}
                                        </button>
                                        {pollStatus && <span className="text-sm text-emerald-400 font-medium animate-pulse">{pollStatus}</span>}
                                    </>
                                ) : (
                                    <div className="flex flex-col gap-6 w-full max-w-2xl bg-slate-900 border border-emerald-500/30 p-6 rounded-xl items-center relative overflow-hidden">
                                        <div className="absolute top-0 w-full h-1 bg-emerald-500"></div>
                                        <div className="flex flex-col sm:flex-row items-center gap-4 w-full justify-center">
                                            <button onClick={() => handleDownload(downloadLinks.form, "Form_Summary_Program.pdf")} className="w-full sm:w-auto flex items-center justify-center gap-2 bg-emerald-600 text-white px-6 py-3 rounded-xl font-bold hover:bg-emerald-500 active:scale-[0.98] shadow-lg shadow-emerald-500/20 transition-all duration-200">
                                                <Download size={18} /> Form PDF
                                            </button>
                                            <button onClick={() => handleDownload(downloadLinks.dataset, "Dataset_Diskon_With_Channel.xlsx")} className="w-full sm:w-auto flex items-center justify-center gap-2 bg-white/5 text-slate-200 px-6 py-3 rounded-xl font-bold border border-white/10 hover:bg-white/10 hover:text-white active:scale-[0.98] transition-all duration-200">
                                                <Download size={18} /> Excel engine
                                            </button>
                                        </div>
                                        <hr className="w-full border-white/10" />
                                        <div className="w-full">
                                            <label className="block text-sm font-bold text-slate-300 mb-2">Kirim hasil via email</label>
                                            <div className="flex flex-col sm:flex-row gap-3 w-full">
                                                <input type="email" value={emailTarget} onChange={e => setEmailTarget(e.target.value)} required placeholder="email divisi, mis. finance@perusahaan.co.id" className="flex-1 w-full text-sm border border-white/10 bg-black/50 text-white rounded-xl px-4 py-2.5 outline-none focus:ring-1 focus:ring-emerald-500" />
                                                <button type="button" onClick={handleSendEmail} disabled={!emailTarget} className="flex items-center justify-center gap-2 bg-emerald-600 text-white font-bold px-6 py-2.5 rounded-xl text-sm hover:bg-emerald-500 active:scale-[0.98] disabled:opacity-50 disabled:pointer-events-none shadow-lg shadow-emerald-500/20 transition-all duration-200">
                                                    Kirim otomatis
                                                </button>
                                            </div>
                                            {emailStatus && <div className="mt-3 text-sm text-emerald-400 font-medium bg-emerald-500/10 inline-block px-3 py-1.5 rounded-md border border-emerald-500/20">{emailStatus}</div>}
                                        </div>
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}
