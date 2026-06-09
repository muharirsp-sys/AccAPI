"use client";

/*
 * Tujuan: Halaman konfigurasi format SPPD dan upload Excel update data pembayaran/SPPD.
 * Caller: Next.js App Router route `/payments/sppd`.
 * Dependensi: FastAPI `/payments/sppd/settings`, `/payments/sppd/upload`, DatePickerField, lucide-react, sonner.
 * Main Functions: PaymentsSppdSettingsPage, fetchSettings, handleSave, handleUpload, getCsrfToken.
 * Side Effects: HTTP read/write ke FastAPI dan update `payments.json`.
 */

import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, CheckCircle2, AlertTriangle, FileText, RefreshCcw, Save, Settings2, Upload, Database } from "lucide-react";
import { toast } from "sonner";
import DatePickerField from "@/components/ui/DatePickerField";

interface SppdSettings {
    last_sequence: number;
    number_template: string;
    fixed_jaminan_date: string;
    maturity_months: number;
    items_per_page: number;
    updated_at?: string;
    updated_by?: string;
}

interface SettingsResponse {
    ok: boolean;
    error?: string;
    settings?: SppdSettings;
    next_sequence?: number;
    preview_number?: string;
    preview_date?: string;
    template_path?: string;
    csrf_token?: string;
}

interface UploadResponse {
    ok: boolean;
    error?: string;
    updated?: number;
    not_found?: string[];
    ignored_columns?: string[];
    blocked_columns?: string[];
    changed_fields?: Record<string, number>;
}

const API_BASE = process.env.NEXT_PUBLIC_FASTAPI_BASE_URL || (typeof window !== "undefined" ? `${window.location.protocol}//${window.location.hostname}:8000` : "http://localhost:8000");

async function getJson<T>(url: string): Promise<T> {
    const res = await fetch(`${API_BASE}${url}`, { credentials: "include" });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || "Request gagal.");
    return data as T;
}

async function postJson<T>(url: string, body: Record<string, unknown>, csrfToken: string): Promise<T> {
    const res = await fetch(`${API_BASE}${url}`, {
        method: "POST",
        credentials: "include",
        headers: {
            "Content-Type": "application/json",
            "X-CSRF-Token": csrfToken,
        },
        body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || "Request gagal.");
    return data as T;
}

async function postForm<T>(url: string, body: FormData, csrfToken: string): Promise<T> {
    const res = await fetch(`${API_BASE}${url}`, {
        method: "POST",
        credentials: "include",
        headers: {
            "X-CSRF-Token": csrfToken,
        },
        body,
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || "Request gagal.");
    return data as T;
}

function formatPreview(template: string, nextSeq: number, previewDate: string) {
    if (!previewDate) return "";
    const dt = new Date(`${previewDate}T00:00:00`);
    if (Number.isNaN(dt.getTime())) return "";
    const romans = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII"];
    const year = String(dt.getFullYear());
    return (template || "{seq:03d}/SPA/PDSB/{roman_month}/{year}")
        .replaceAll("{seq:03d}", String(nextSeq).padStart(3, "0"))
        .replaceAll("{seq3}", String(nextSeq).padStart(3, "0"))
        .replaceAll("{seq}", String(nextSeq))
        .replaceAll("{roman_month}", romans[dt.getMonth()])
        .replaceAll("{month}", String(dt.getMonth() + 1))
        .replaceAll("{year}", year)
        .replaceAll("{yy}", year.slice(-2));
}

/* ─── Bank Data Section: Replace & Auto-Fix Principle Names ─── */

interface BankDataItem {
    principle: string;
    bank: string;
    rekening: string;
    penerima: string;
    has_rekening: boolean;
}

interface MatchReportData {
    matched: Array<{ web_name: string; excel_name: string; bank: string; rekening: string; penerima: string }>;
    unmatched: string[];
    ambiguous: string[];
    empty_rekening: Array<{ principle: string; bank: string; reason: string }>;
}

interface AutoFixChange {
    old: string;
    new: string;
    count: number;
}

interface AutoFixResult {
    ok: boolean;
    executed: boolean;
    changes: AutoFixChange[];
    skipped: Array<{ name: string; reason: string; count: string }>;
    already_correct: string[];
    total_records_affected: number;
    message: string;
}

interface ReplaceResult {
    ok: boolean;
    replaced: number;
    old_name: string;
    new_name: string;
    message: string;
}

function BankDataSection() {
    const [bankItems, setBankItems] = useState<BankDataItem[]>([]);
    const [matchReport, setMatchReport] = useState<MatchReportData | null>(null);
    const [autoFixResult, setAutoFixResult] = useState<AutoFixResult | null>(null);
    const [replaceOld, setReplaceOld] = useState("");
    const [replaceNew, setReplaceNew] = useState("");
    const [replaceResult, setReplaceResult] = useState<ReplaceResult | null>(null);
    const [loading, setLoading] = useState(false);
    const [replacing, setReplacing] = useState(false);
    const [autoFixing, setAutoFixing] = useState(false);
    const [showTable, setShowTable] = useState(false);

    const API = process.env.NEXT_PUBLIC_FASTAPI_BASE_URL || (typeof window !== "undefined" ? `${window.location.protocol}//${window.location.hostname}:8000` : "http://localhost:8000");

    const fetchBankData = async () => {
        setLoading(true);
        try {
            const res = await fetch(`${API}/api/bank-data`, { credentials: "include" });
            if (!res.ok) {
                const errData = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
                toast.error(`Gagal memuat data rekening: ${errData.error || res.statusText}`);
                return;
            }
            const data = await res.json();
            if (data.ok) setBankItems(data.items || []);
        } catch (err: unknown) {
            toast.error(err instanceof Error ? `Koneksi gagal: ${err.message}` : "Tidak bisa terhubung ke backend.");
        } finally { setLoading(false); }
    };

    const fetchMatchReport = async () => {
        setLoading(true);
        try {
            const res = await fetch(`${API}/api/bank-data/match-report`, { credentials: "include" });
            if (!res.ok) {
                const errData = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
                toast.error(`Gagal memuat report: ${errData.error || res.statusText}`);
                return;
            }
            const data = await res.json();
            if (data.ok) setMatchReport(data.report);
        } catch (err: unknown) {
            toast.error(err instanceof Error ? `Koneksi gagal: ${err.message}` : "Tidak bisa terhubung ke backend.");
        } finally { setLoading(false); }
    };

    const handleReplace = async () => {
        if (!replaceOld.trim() || !replaceNew.trim()) {
            toast.error("Nama lama dan nama baru wajib diisi.");
            return;
        }
        setReplacing(true);
        setReplaceResult(null);
        try {
            const res = await fetch(`${API}/api/bank-data/replace-principle-name`, {
                method: "POST",
                credentials: "include",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ old_name: replaceOld, new_name: replaceNew }),
            });
            const data = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
            if (data.ok) {
                setReplaceResult(data);
                toast.success(data.message);
            } else {
                toast.error(data.error || `Gagal replace (HTTP ${res.status}).`);
            }
        } catch (err: unknown) {
            toast.error(err instanceof Error ? `Koneksi gagal: ${err.message}` : "Tidak bisa terhubung ke backend.");
        } finally {
            setReplacing(false);
        }
    };

    const handleAutoFix = async (confirm: boolean) => {
        setAutoFixing(true);
        try {
            const res = await fetch(`${API}/api/bank-data/auto-fix-names`, {
                method: "POST",
                credentials: "include",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ confirm }),
            });
            const data = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
            if (data.ok) {
                setAutoFixResult(data);
                if (confirm && data.executed) toast.success(data.message);
                else if (!confirm) toast.info("Preview auto-fix siap. Klik Eksekusi jika setuju.");
            } else {
                toast.error(data.error || `Gagal auto-fix (HTTP ${res.status}).`);
            }
        } catch (err: unknown) {
            toast.error(err instanceof Error ? `Koneksi gagal: ${err.message}` : "Tidak bisa terhubung ke backend.");
        } finally {
            setAutoFixing(false);
        }
    };

    useEffect(() => { fetchBankData(); }, []);

    return (
        <section className="mt-5 border border-white/10 bg-black/30 rounded-lg p-5 space-y-5">
            <div className="flex flex-wrap items-center justify-between gap-4">
                <div className="flex items-center gap-2 text-slate-200 font-semibold">
                    <Database size={18} className="text-amber-400" />
                    Data Rekening Principle
                </div>
                <div className="flex flex-wrap gap-2">
                    <button onClick={() => setShowTable(!showTable)} className="px-3 py-1.5 rounded-lg border border-white/10 bg-white/5 text-xs text-slate-300 hover:bg-white/10">
                        {showTable ? "Tutup Tabel" : "Lihat Daftar Rekening"}
                    </button>
                    <button onClick={fetchMatchReport} disabled={loading} className="px-3 py-1.5 rounded-lg border border-white/10 bg-white/5 text-xs text-slate-300 hover:bg-white/10 disabled:opacity-50">
                        Cek Match Report
                    </button>
                </div>
            </div>

            {/* Daftar Rekening Table */}
            {showTable && (
                <div className="overflow-x-auto max-h-[300px] overflow-y-auto rounded-lg border border-white/10">
                    <table className="w-full text-xs text-left">
                        <thead className="bg-black/40 text-slate-400 sticky top-0">
                            <tr>
                                <th className="px-3 py-2">Principle</th>
                                <th className="px-3 py-2">Bank</th>
                                <th className="px-3 py-2">No. Rekening</th>
                                <th className="px-3 py-2">Penerima</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-white/5">
                            {loading ? (
                                <tr>
                                    <td colSpan={4} className="px-3 py-8 text-center text-slate-400">
                                        Memuat data rekening...
                                    </td>
                                </tr>
                            ) : bankItems.length === 0 ? (
                                <tr>
                                    <td colSpan={4} className="px-3 py-8 text-center text-slate-500 italic">
                                        Data rekening tidak ditemukan. Pastikan file master rekening sudah diupload dan backend aktif.
                                    </td>
                                </tr>
                            ) : (
                                bankItems.map((item, i) => (
                                    <tr key={`${item.principle}-${item.rekening}-${i}`} className={`${item.has_rekening ? "text-slate-300" : "text-slate-500 italic"}`}>
                                        <td className="px-3 py-1.5">{item.principle}</td>
                                        <td className="px-3 py-1.5">{item.bank}</td>
                                        <td className="px-3 py-1.5 font-mono">{item.rekening || "(kosong)"}</td>
                                        <td className="px-3 py-1.5">{item.penerima || "-"}</td>
                                    </tr>
                                ))
                            )}
                        </tbody>
                    </table>
                </div>
            )}

            {/* Replace All Section */}
            <div className="border border-white/10 rounded-lg p-4 bg-black/20">
                <div className="text-sm font-semibold text-slate-300 mb-3">Replace Nama Principle (Semua Record)</div>
                <p className="text-xs text-slate-500 mb-3">Ganti nama principle yang salah/tidak sesuai data rekening. Semua record di payments yang cocok akan diupdate.</p>
                <div className="grid sm:grid-cols-[1fr_1fr_auto] gap-2 items-end">
                    <label className="block">
                        <span className="text-[10px] uppercase tracking-wide text-slate-500">Nama Lama (di Web)</span>
                        <input
                            value={replaceOld}
                            onChange={(e) => setReplaceOld(e.target.value)}
                            placeholder="cth: ABC PRESIDENT INDONESIA PT"
                            className="mt-1 w-full px-3 py-2 rounded-lg bg-black/40 border border-white/10 text-white text-sm outline-none focus:border-amber-500"
                        />
                    </label>
                    <label className="block">
                        <span className="text-[10px] uppercase tracking-wide text-slate-500">Nama Baru (sesuai Rekening)</span>
                        <input
                            value={replaceNew}
                            onChange={(e) => setReplaceNew(e.target.value)}
                            placeholder="cth: PT Abc President Indonesia"
                            className="mt-1 w-full px-3 py-2 rounded-lg bg-black/40 border border-white/10 text-white text-sm outline-none focus:border-amber-500"
                        />
                    </label>
                    <button
                        onClick={handleReplace}
                        disabled={replacing || !replaceOld || !replaceNew}
                        className="px-4 py-2 rounded-lg bg-amber-600 text-white text-sm font-semibold hover:bg-amber-500 disabled:opacity-50"
                    >
                        {replacing ? "..." : "Replace All"}
                    </button>
                </div>
                {replaceResult && (
                    <div className="mt-3 text-xs p-2 rounded bg-black/40 border border-white/10">
                        <span className={replaceResult.replaced > 0 ? "text-emerald-400" : "text-slate-400"}>
                            {replaceResult.message}
                        </span>
                    </div>
                )}
            </div>

            {/* Auto-Fix Section */}
            <div className="border border-white/10 rounded-lg p-4 bg-black/20">
                <div className="text-sm font-semibold text-slate-300 mb-2">Auto-Fix Nama Principle</div>
                <p className="text-xs text-slate-500 mb-3">
                    Otomatis cocokkan semua nama principle di web ke format yang benar (sesuai file daftar rekening).
                    Preview dulu, baru eksekusi.
                </p>
                <div className="flex gap-2">
                    <button
                        onClick={() => handleAutoFix(false)}
                        disabled={autoFixing}
                        className="px-4 py-2 rounded-lg bg-slate-700 text-white text-sm font-semibold hover:bg-slate-600 disabled:opacity-50"
                    >
                        {autoFixing ? "..." : "Preview"}
                    </button>
                    {autoFixResult && autoFixResult.changes.length > 0 && !autoFixResult.executed && (
                        <button
                            onClick={() => handleAutoFix(true)}
                            disabled={autoFixing}
                            className="px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm font-semibold hover:bg-emerald-500 disabled:opacity-50"
                        >
                            Eksekusi ({autoFixResult.total_records_affected} record)
                        </button>
                    )}
                </div>
                {autoFixResult && (
                    <div className="mt-3 space-y-2 text-xs">
                        {autoFixResult.executed && (
                            <div className="flex items-center gap-1 text-emerald-400">
                                <CheckCircle2 size={14} /> {autoFixResult.message}
                            </div>
                        )}
                        {autoFixResult.changes.length > 0 && (
                            <div className="overflow-x-auto max-h-[200px] overflow-y-auto rounded border border-white/10">
                                <table className="w-full text-xs">
                                    <thead className="bg-black/40 text-slate-400 sticky top-0">
                                        <tr>
                                            <th className="px-2 py-1 text-left">Nama Lama</th>
                                            <th className="px-2 py-1 text-left">→ Nama Baru</th>
                                            <th className="px-2 py-1 text-right">Record</th>
                                        </tr>
                                    </thead>
                                    <tbody className="divide-y divide-white/5 text-slate-300">
                                        {autoFixResult.changes.map((c, i) => (
                                            <tr key={i}>
                                                <td className="px-2 py-1 text-red-300">{c.old}</td>
                                                <td className="px-2 py-1 text-emerald-300">{c.new}</td>
                                                <td className="px-2 py-1 text-right">{c.count}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        )}
                        {autoFixResult.skipped.length > 0 && (
                            <div>
                                <span className="text-amber-400 flex items-center gap-1"><AlertTriangle size={12} /> Skipped ({autoFixResult.skipped.length}):</span>
                                <ul className="ml-4 mt-1 text-slate-400 space-y-0.5">
                                    {autoFixResult.skipped.map((s, i) => (
                                        <li key={i}>{s.name} — <span className="text-amber-300">{s.reason}</span> ({s.count} record)</li>
                                    ))}
                                </ul>
                            </div>
                        )}
                        {autoFixResult.changes.length === 0 && !autoFixResult.executed && (
                            <div className="text-slate-400">Semua nama principle sudah benar atau tidak ditemukan match.</div>
                        )}
                    </div>
                )}
            </div>

            {/* Match Report */}
            {matchReport && (
                <div className="border border-white/10 rounded-lg p-4 bg-black/20 space-y-3 text-xs">
                    <div className="text-sm font-semibold text-slate-300">Match Report</div>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                        <div className="p-2 rounded bg-emerald-900/30 border border-emerald-500/20">
                            <div className="text-emerald-400 font-bold text-lg">{matchReport.matched.length}</div>
                            <div className="text-slate-400">Matched</div>
                        </div>
                        <div className="p-2 rounded bg-red-900/30 border border-red-500/20">
                            <div className="text-red-400 font-bold text-lg">{matchReport.unmatched.length}</div>
                            <div className="text-slate-400">Unmatched</div>
                        </div>
                        <div className="p-2 rounded bg-amber-900/30 border border-amber-500/20">
                            <div className="text-amber-400 font-bold text-lg">{matchReport.ambiguous.length}</div>
                            <div className="text-slate-400">Ambiguous</div>
                        </div>
                        <div className="p-2 rounded bg-slate-800/50 border border-white/10">
                            <div className="text-slate-300 font-bold text-lg">{matchReport.empty_rekening.length}</div>
                            <div className="text-slate-400">Rek. Kosong</div>
                        </div>
                    </div>
                    {matchReport.unmatched.length > 0 && (
                        <div>
                            <span className="text-red-400 font-semibold">Unmatched:</span>
                            <ul className="ml-3 mt-1 text-slate-400 space-y-0.5">{matchReport.unmatched.map((n, i) => <li key={i}>{n}</li>)}</ul>
                        </div>
                    )}
                    {matchReport.ambiguous.length > 0 && (
                        <div>
                            <span className="text-amber-400 font-semibold">Ambiguous:</span>
                            <ul className="ml-3 mt-1 text-slate-400 space-y-0.5">{matchReport.ambiguous.map((n, i) => <li key={i}>{n}</li>)}</ul>
                        </div>
                    )}
                </div>
            )}
        </section>
    );
}

export default function PaymentsSppdSettingsPage() {
    const [settings, setSettings] = useState<SppdSettings>({
        last_sequence: 0,
        number_template: "{seq:03d}/SPA/PDSB/{roman_month}/{year}",
        fixed_jaminan_date: "2026-02-19",
        maturity_months: 6,
        items_per_page: 7,
    });
    const [previewDate, setPreviewDate] = useState("");
    const [serverPreview, setServerPreview] = useState("");
    const [templatePath, setTemplatePath] = useState("");
    const [csrfToken, setCsrfToken] = useState("");
    const [uploadFile, setUploadFile] = useState<File | null>(null);
    const [uploadResult, setUploadResult] = useState<UploadResponse | null>(null);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [uploading, setUploading] = useState(false);

    const nextSequence = Number(settings.last_sequence || 0) + 1;
    const localPreview = useMemo(
        () => formatPreview(settings.number_template, nextSequence, previewDate),
        [settings.number_template, nextSequence, previewDate]
    );

    const fetchSettings = async () => {
        setLoading(true);
        try {
            const me = await getJson<SettingsResponse>("/api/me");
            if (me.csrf_token) setCsrfToken(me.csrf_token);
            const data = await getJson<SettingsResponse>("/payments/sppd/settings");
            if (data.settings) setSettings(data.settings);
            setPreviewDate(data.preview_date || "");
            setServerPreview(data.preview_number || "");
            setTemplatePath(data.template_path || "");
        } catch (err: unknown) {
            toast.error(err instanceof Error ? err.message : "Gagal memuat setting SPPD.");
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchSettings();
    }, []);

    const updateSetting = (key: keyof SppdSettings, value: string) => {
        setSettings((prev) => ({
            ...prev,
            [key]: key === "number_template" || key === "fixed_jaminan_date" ? value : Number(value),
        }));
    };

    const handleSave = async () => {
        setSaving(true);
        try {
            const token = csrfToken || (await getJson<SettingsResponse>("/api/me")).csrf_token || "";
            const data = await postJson<SettingsResponse>("/payments/sppd/settings", settings as unknown as Record<string, unknown>, token);
            if (data.settings) setSettings(data.settings);
            setServerPreview(data.preview_number || "");
            toast.success("Format SPPD tersimpan.");
        } catch (err: unknown) {
            toast.error(err instanceof Error ? err.message : "Gagal menyimpan format SPPD.");
        } finally {
            setSaving(false);
        }
    };

    const handleUpload = async (event: React.FormEvent) => {
        event.preventDefault();
        if (!uploadFile) {
            toast.error("Pilih file Excel dulu.");
            return;
        }
        setUploading(true);
        setUploadResult(null);
        try {
            const token = csrfToken || (await getJson<SettingsResponse>("/api/me")).csrf_token || "";
            const body = new FormData();
            body.append("file", uploadFile);
            const result = await postForm<UploadResponse>("/payments/sppd/upload", body, token);
            setUploadResult(result);
            toast.success(`Upload Excel berhasil: ${result.updated || 0} record diupdate.`);
        } catch (err: unknown) {
            toast.error(err instanceof Error ? err.message : "Gagal upload Excel SPPD.");
        } finally {
            setUploading(false);
        }
    };

    return (
        <div className="max-w-6xl mx-auto pb-10">
            <div className="flex flex-wrap items-center justify-between gap-4 mb-6">
                <div>
                    <div className="flex items-center gap-3 text-white">
                        <Settings2 className="text-emerald-400" size={26} />
                        <h1 className="text-2xl font-bold tracking-tight">Format SPPD Bank Panin</h1>
                    </div>
                    <div className="mt-2 text-sm text-slate-400">Nomor berikutnya: <span className="text-emerald-300 font-semibold">{localPreview || serverPreview || "-"}</span></div>
                </div>
                <div className="flex flex-wrap gap-2">
                    <a href="/payments" className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-white/10 bg-white/5 text-slate-200 hover:bg-white/10">
                        <ArrowLeft size={16} /> Payments
                    </a>
                    <button onClick={fetchSettings} disabled={loading || saving} className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-white/10 bg-white/5 text-slate-200 hover:bg-white/10 disabled:opacity-50">
                        <RefreshCcw size={16} /> Refresh
                    </button>
                    <button onClick={handleSave} disabled={loading || saving} className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-emerald-600 text-white font-semibold hover:bg-emerald-500 disabled:opacity-50">
                        <Save size={16} /> Simpan
                    </button>
                </div>
            </div>

            <div className="grid lg:grid-cols-[1.2fr_0.8fr] gap-5">
                <section className="border border-white/10 bg-black/30 rounded-lg p-5">
                    <div className="grid md:grid-cols-2 gap-4">
                        <label className="block">
                            <span className="text-xs uppercase tracking-wide text-slate-500">Nomor Surat Terakhir</span>
                            <input type="number" min={0} value={settings.last_sequence} onChange={(e) => updateSetting("last_sequence", e.target.value)} className="mt-2 w-full px-3 py-2 rounded-lg bg-black/40 border border-white/10 text-white outline-none focus:border-emerald-500" />
                        </label>
                        <label className="block">
                            <span className="text-xs uppercase tracking-wide text-slate-500">Tanggal Jaminan</span>
                            <div className="mt-2">
                                <DatePickerField value={settings.fixed_jaminan_date} onChange={(value) => updateSetting("fixed_jaminan_date", value)} className="text-white focus:border-emerald-500" ariaLabel="Tanggal jaminan" />
                            </div>
                        </label>
                        <label className="block md:col-span-2">
                            <span className="text-xs uppercase tracking-wide text-slate-500">Format Nomor</span>
                            <input value={settings.number_template} onChange={(e) => updateSetting("number_template", e.target.value)} className="mt-2 w-full px-3 py-2 rounded-lg bg-black/40 border border-white/10 text-white outline-none focus:border-emerald-500" />
                        </label>
                        <label className="block">
                            <span className="text-xs uppercase tracking-wide text-slate-500">Jatuh Tempo Bank</span>
                            <input type="number" min={1} max={24} value={settings.maturity_months} onChange={(e) => updateSetting("maturity_months", e.target.value)} className="mt-2 w-full px-3 py-2 rounded-lg bg-black/40 border border-white/10 text-white outline-none focus:border-emerald-500" />
                        </label>
                        <label className="block">
                            <span className="text-xs uppercase tracking-wide text-slate-500">Transfer per Halaman</span>
                            <input type="number" min={1} max={20} value={settings.items_per_page} onChange={(e) => updateSetting("items_per_page", e.target.value)} className="mt-2 w-full px-3 py-2 rounded-lg bg-black/40 border border-white/10 text-white outline-none focus:border-emerald-500" />
                        </label>
                    </div>
                </section>

                <section className="border border-white/10 bg-black/30 rounded-lg p-5">
                    <div className="flex items-center gap-2 text-slate-200 font-semibold mb-4">
                        <FileText size={18} className="text-emerald-400" />
                        Preview
                    </div>
                    <div className="space-y-3 text-sm">
                        <label className="block">
                            <span className="text-xs uppercase tracking-wide text-slate-500">Tanggal Makassar</span>
                            <div className="mt-2">
                                <DatePickerField value={previewDate} onChange={setPreviewDate} className="text-white focus:border-emerald-500" ariaLabel="Tanggal Makassar" />
                            </div>
                        </label>
                        <div className="rounded-lg border border-white/10 bg-black/40 p-4 text-slate-300">
                            <div className="text-xs uppercase tracking-wide text-slate-500">Nomor Berikutnya</div>
                            <div className="mt-1 text-lg font-semibold text-white">{localPreview || serverPreview || "-"}</div>
                            <div className="mt-4 text-xs uppercase tracking-wide text-slate-500">Template DOCX</div>
                            <div className="mt-1 break-all text-slate-400">{templatePath || "-"}</div>
                        </div>
                        <div className="text-xs text-slate-500">Updated: {settings.updated_at || "-"} {settings.updated_by ? `oleh ${settings.updated_by}` : ""}</div>
                    </div>
                </section>
            </div>

            <section className="mt-5 border border-white/10 bg-black/30 rounded-lg p-5">
                <div className="flex flex-wrap items-start justify-between gap-4">
                    <div>
                        <div className="flex items-center gap-2 text-slate-200 font-semibold">
                            <Upload size={18} className="text-indigo-400" />
                            Upload Excel Data SPPD
                        </div>
                        <p className="mt-1 text-sm text-slate-400">
                            Update data pembayaran dari Excel. Kolom ajukan, gap, status track/status pembayaran, draft/submission, dan nomor SPPD tidak ditulis dari Excel.
                        </p>
                    </div>
                    <form onSubmit={handleUpload} className="flex flex-wrap items-center gap-2">
                        <input
                            type="file"
                            accept=".xlsx,.xls"
                            onChange={(event) => setUploadFile(event.target.files?.[0] || null)}
                            className="max-w-[280px] rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-slate-200 file:mr-3 file:rounded-md file:border-0 file:bg-indigo-600 file:px-3 file:py-1.5 file:text-xs file:font-semibold file:text-white"
                        />
                        <button disabled={uploading || !uploadFile} className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-indigo-600 text-white font-semibold hover:bg-indigo-500 disabled:opacity-50">
                            <Upload size={16} /> {uploading ? "Uploading..." : "Upload"}
                        </button>
                    </form>
                </div>
                {uploadResult && (
                    <div className="mt-4 grid gap-3 md:grid-cols-3 text-sm">
                        <div className="rounded-lg border border-white/10 bg-black/40 p-3">
                            <div className="text-xs uppercase tracking-wide text-slate-500">Record Update</div>
                            <div className="mt-1 text-xl font-bold text-white">{uploadResult.updated || 0}</div>
                        </div>
                        <div className="rounded-lg border border-white/10 bg-black/40 p-3">
                            <div className="text-xs uppercase tracking-wide text-slate-500">Kolom Diblok</div>
                            <div className="mt-1 text-slate-300">{uploadResult.blocked_columns?.join(", ") || "-"}</div>
                        </div>
                        <div className="rounded-lg border border-white/10 bg-black/40 p-3">
                            <div className="text-xs uppercase tracking-wide text-slate-500">Tidak Ditemukan</div>
                            <div className="mt-1 text-slate-300">{uploadResult.not_found?.join(", ") || "-"}</div>
                        </div>
                    </div>
                )}
            </section>

            <BankDataSection />
        </div>
    );
}
