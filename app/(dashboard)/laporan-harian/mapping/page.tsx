/*
 * Tujuan: Halaman admin non-teknis untuk mengubah penerima email laporan harian per keyword (SPV/SM/Principal).
 * Caller: tombol "Kelola mapping" pada /laporan-harian.
 * Dependensi: GET/PUT /api/laporan-harian/mapping, lucide-react, semantic UI global.
 * Main Functions: LaporanHarianMappingPage, loadMapping, saveMapping, addRecipient.
 * Side Effects: HTTP read/write mapping; perubahan berlaku pada proses laporan berikutnya.
 */
"use client";

import { useEffect, useState } from "react";
import { ArrowLeft, Plus, Save, Trash2 } from "lucide-react";

type Recipient = { keyword: string; emails: string; active: boolean };

export default function LaporanHarianMappingPage() {
    const [recipients, setRecipients] = useState<Recipient[]>([]);
    const [busy, setBusy] = useState(true);
    const [saving, setSaving] = useState(false);
    const [message, setMessage] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => { void loadMapping(); }, []);

    async function loadMapping() {
        setBusy(true);
        setError(null);
        try {
            const response = await fetch("/api/laporan-harian/mapping", { cache: "no-store" });
            const data = await response.json();
            if (!response.ok) throw new Error(data.error || "Mapping gagal dimuat");
            setRecipients((data.recipients as Recipient[]).map((item) => ({
                keyword: item.keyword, emails: item.emails, active: item.active,
            })));
        } catch (loadError) {
            setError(String(loadError));
        } finally {
            setBusy(false);
        }
    }

    function addRecipient() {
        setRecipients((current) => [...current, { keyword: "", emails: "", active: true }]);
    }

    async function saveMapping() {
        setSaving(true);
        setMessage(null);
        setError(null);
        try {
            const response = await fetch("/api/laporan-harian/mapping", {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ recipients }),
            });
            const data = await response.json();
            if (!response.ok) throw new Error(data.error || "Mapping gagal disimpan");
            setMessage("Mapping tersimpan. Upload laporan berikutnya akan memakai data ini.");
            await loadMapping();
        } catch (saveError) {
            setError(String(saveError));
        } finally {
            setSaving(false);
        }
    }

    return (
        <main className="ui-page-shell ui-page-shell--standard space-y-5" aria-busy={busy || saving}>
            <header className="ui-page-header">
                <div className="ui-page-heading">
                    <a href="/laporan-harian" className="mb-2 inline-flex items-center gap-2 text-sm font-bold text-[var(--luxury-teal)]">
                        <ArrowLeft size={16} /> Kembali ke laporan harian
                    </a>
                    <h1 className="ui-page-title">Mapping penerima laporan harian</h1>
                    <p className="ui-page-description">
                        Keyword dicocokkan otomatis ke SPV/SM/Principal yang ada di data. Atur email tanpa mengubah kode aplikasi.
                    </p>
                </div>
                <button onClick={saveMapping} disabled={busy || saving} className="ui-button-primary min-h-11 px-4">
                    <Save size={17} /> {saving ? "Menyimpan..." : "Simpan perubahan"}
                </button>
            </header>

            {message && <p className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800">{message}</p>}
            {error && <p className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700" role="alert">{error}</p>}

            <section className="ui-surface-panel ui-panel-padding space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                        <h2 className="text-base font-extrabold text-[var(--luxury-text)]">Penerima email</h2>
                        <p className="mt-1 text-sm text-[var(--luxury-muted)]">Pisahkan beberapa email dengan koma atau titik koma.</p>
                    </div>
                    <button onClick={addRecipient} className="ui-button-secondary min-h-10"><Plus size={16} /> Tambah penerima</button>
                </div>
                {busy && <div className="ui-state-panel min-h-24 text-sm text-[var(--luxury-muted)]">Memuat mapping...</div>}
                {!busy && (
                    <div className="space-y-2">
                        {recipients.map((recipient, index) => (
                            <div key={`${recipient.keyword}-${index}`} className="grid gap-2 rounded-xl border border-[var(--border-soft)] bg-[var(--surface-2)] p-3 md:grid-cols-[1fr_2fr_auto_auto] md:items-center">
                                <input value={recipient.keyword} onChange={(event) => setRecipients((current) => current.map((item, row) => row === index ? { ...item, keyword: event.target.value } : item))} placeholder="Keyword, mis. DENNY" className="min-h-10 rounded-lg border border-[var(--border-strong)] bg-[var(--surface)] px-3 text-sm" />
                                <input value={recipient.emails} onChange={(event) => setRecipients((current) => current.map((item, row) => row === index ? { ...item, emails: event.target.value } : item))} placeholder="nama@contoh.com" className="min-h-10 rounded-lg border border-[var(--border-strong)] bg-[var(--surface)] px-3 text-sm" />
                                <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={recipient.active} onChange={(event) => setRecipients((current) => current.map((item, row) => row === index ? { ...item, active: event.target.checked } : item))} /> Aktif</label>
                                <button onClick={() => setRecipients((current) => current.filter((_, row) => row !== index))} className="ui-button-secondary min-h-10" aria-label={`Hapus ${recipient.keyword || "penerima"}`}><Trash2 size={16} /></button>
                            </div>
                        ))}
                        {recipients.length === 0 && (
                            <p className="text-sm text-[var(--luxury-muted)]">Belum ada penerima. Klik &quot;Tambah penerima&quot; untuk mulai.</p>
                        )}
                    </div>
                )}
            </section>
        </main>
    );
}
