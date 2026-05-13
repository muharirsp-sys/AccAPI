"use client";

/*
 * Tujuan: Halaman konfigurasi format SPPD untuk nomor surat, tanggal fixed Jaminan, dan aturan jatuh tempo.
 * Caller: Next.js App Router route `/payments/sppd`.
 * Dependensi: FastAPI `/payments/sppd/settings`, lucide-react, sonner.
 * Main Functions: PaymentsSppdSettingsPage, fetchSettings, handleSave, getCsrfToken.
 * Side Effects: HTTP read/write ke FastAPI dan update `payments.json`.
 */

import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, FileText, RefreshCcw, Save, Settings2 } from "lucide-react";
import { toast } from "sonner";

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

const API_BASE = typeof window !== "undefined" ? `${window.location.protocol}//${window.location.hostname}:8000` : "http://localhost:8000";

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
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);

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
                            <input type="date" value={settings.fixed_jaminan_date} onChange={(e) => updateSetting("fixed_jaminan_date", e.target.value)} className="mt-2 w-full px-3 py-2 rounded-lg bg-black/40 border border-white/10 text-white outline-none focus:border-emerald-500" />
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
                            <input type="date" value={previewDate} onChange={(e) => setPreviewDate(e.target.value)} className="mt-2 w-full px-3 py-2 rounded-lg bg-black/40 border border-white/10 text-white outline-none focus:border-emerald-500" />
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
        </div>
    );
}
