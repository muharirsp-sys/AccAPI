/*
 * Tujuan: Halaman admin non-teknis untuk mengubah penerima email dan lookup golongan/SPV/SM laporan harian.
 * Caller: tombol "Kelola mapping" pada /laporan-harian.
 * Dependensi: GET/PUT /api/laporan-harian/mapping, lucide-react, semantic UI global.
 * Main Functions: LaporanHarianMappingPage, loadMapping, saveMapping, addRecipient.
 * Side Effects: HTTP read/write mapping; perubahan berlaku pada proses laporan berikutnya.
 */
"use client";

import { useEffect, useState } from "react";
import { ArrowLeft, Plus, Save, Trash2 } from "lucide-react";

type Recipient = { keyword: string; emails: string; active: boolean };
type LookupKey = "principal_to_spv" | "conca_to_spv" | "jp_map" | "sm_map" | "distribution_rules";
type Lookups = Record<LookupKey, unknown>;

const LOOKUP_LABELS: Array<{ key: LookupKey; title: string; helper: string }> = [
    { key: "principal_to_spv", title: "Principal ke golongan", helper: "Fallback nama principal ke nama laporan/SPV." },
    { key: "conca_to_spv", title: "Principal + jenis produk", helper: "Mapping khusus yang mengalahkan fallback principal." },
    { key: "sm_map", title: "Principal ke SM", helper: "Nama SM yang ditulis pada kolom Mapping PIC." },
    { key: "jp_map", title: "Kode jenis produk", helper: "Kode Accurate ke nama jenis produk." },
    { key: "distribution_rules", title: "Laporan khusus", helper: "Aturan ANI/JONAL: principal, kata pada salesman, channel, dan pengecualian jenis produk." },
];

export default function LaporanHarianMappingPage() {
    const [recipients, setRecipients] = useState<Recipient[]>([]);
    const [lookups, setLookups] = useState<Record<LookupKey, string>>({
        principal_to_spv: "{}", conca_to_spv: "{}", jp_map: "{}", sm_map: "{}", distribution_rules: "[]",
    });
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
            const loaded = data.lookups as Lookups;
            setLookups({
                principal_to_spv: JSON.stringify(loaded.principal_to_spv ?? {}, null, 2),
                conca_to_spv: JSON.stringify(loaded.conca_to_spv ?? {}, null, 2),
                jp_map: JSON.stringify(loaded.jp_map ?? {}, null, 2),
                sm_map: JSON.stringify(loaded.sm_map ?? {}, null, 2),
                distribution_rules: JSON.stringify(loaded.distribution_rules ?? [], null, 2),
            });
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
            const parsed = Object.fromEntries(
                (Object.keys(lookups) as LookupKey[]).map((key) => [key, JSON.parse(lookups[key])]),
            ) as Lookups;
            const response = await fetch("/api/laporan-harian/mapping", {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ recipients, lookups: parsed }),
            });
            const data = await response.json();
            if (!response.ok) throw new Error(data.error || "Mapping gagal disimpan");
            setMessage("Mapping tersimpan. Proses laporan berikutnya akan memakai data ini.");
            await loadMapping();
        } catch (saveError) {
            setError(saveError instanceof SyntaxError
                ? "Format JSON lookup belum valid. Periksa tanda kutip dan koma."
                : String(saveError));
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
                    <h1 className="ui-page-title">Mapping laporan harian</h1>
                    <p className="ui-page-description">Atur nama file/golongan dan alamat email tanpa mengubah kode aplikasi.</p>
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
                        <p className="mt-1 text-sm text-[var(--luxury-muted)]">Keyword dicocokkan dengan nama file. Pisahkan beberapa email dengan koma.</p>
                    </div>
                    <button onClick={addRecipient} className="ui-button-secondary min-h-10"><Plus size={16} /> Tambah penerima</button>
                </div>
                <div className="space-y-2">
                    {recipients.map((recipient, index) => (
                        <div key={`${recipient.keyword}-${index}`} className="grid gap-2 rounded-xl border border-[var(--border-soft)] bg-[var(--surface-2)] p-3 md:grid-cols-[1fr_2fr_auto_auto] md:items-center">
                            <input value={recipient.keyword} onChange={(event) => setRecipients((current) => current.map((item, row) => row === index ? { ...item, keyword: event.target.value } : item))} placeholder="Keyword, mis. ANI" className="min-h-10 rounded-lg border border-[var(--border-strong)] bg-[var(--surface)] px-3 text-sm" />
                            <input value={recipient.emails} onChange={(event) => setRecipients((current) => current.map((item, row) => row === index ? { ...item, emails: event.target.value } : item))} placeholder="nama@contoh.com" className="min-h-10 rounded-lg border border-[var(--border-strong)] bg-[var(--surface)] px-3 text-sm" />
                            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={recipient.active} onChange={(event) => setRecipients((current) => current.map((item, row) => row === index ? { ...item, active: event.target.checked } : item))} /> Aktif</label>
                            <button onClick={() => setRecipients((current) => current.filter((_, row) => row !== index))} className="ui-button-secondary min-h-10" aria-label={`Hapus ${recipient.keyword || "penerima"}`}><Trash2 size={16} /></button>
                        </div>
                    ))}
                </div>
            </section>

            <section className="grid gap-4 xl:grid-cols-2">
                {LOOKUP_LABELS.map((item) => (
                    <div key={item.key} className="ui-surface-panel ui-panel-padding">
                        <h2 className="text-base font-extrabold text-[var(--luxury-text)]">{item.title}</h2>
                        <p className="mt-1 text-sm text-[var(--luxury-muted)]">{item.helper}</p>
                        <textarea value={lookups[item.key]} onChange={(event) => setLookups((current) => ({ ...current, [item.key]: event.target.value }))} spellCheck={false} className="mt-4 min-h-72 w-full rounded-xl border border-[var(--border-strong)] bg-[var(--surface-2)] p-3 font-mono text-xs leading-5 text-[var(--luxury-text)]" />
                    </div>
                ))}
            </section>
        </main>
    );
}
