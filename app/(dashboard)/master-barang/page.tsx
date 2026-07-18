/*
 * Tujuan: Workspace Master Barang per principal dengan tab Form Fix, Sumber PDF, Kamus Kode, dan QC.
 * Caller: Route dashboard /master-barang melalui SidebarLayout/RBAC.
 * Dependensi: /api/master-barang, sonner, lucide-react, dan React state/effects.
 * Main Functions: MasterBarangPage.
 * Side Effects: Fetch API, upload/download file, adaptasi master legacy, update Kamus Kode, dan konfirmasi 3 tahap.
 */
"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, BookOpen, CheckCircle2, Download, FileSpreadsheet, FileText, Loader2, PackagePlus, Plus, RefreshCcw, Save, ShieldAlert, Upload } from "lucide-react";
import { toast } from "sonner";

type MasterListItem = { id: string; principleCode: string; principleName: string; status: string; revision: number; itemCount: number; errors: number; warnings: number; over50: number; updatedAt: string };
type SourceItem = { sourceRow?: number; sourcePage?: number; kodePcpl?: string; kelompokPcpl?: string; namaBarang: string; isiCtn?: string | number; satuan?: string; gramasi?: string; kemasan?: string; confidence?: number; reviewNotes?: string[] };
type CodebookEntry = { key: string; level: string; scope: string; sourceName: string; name: string; code: string; generated: boolean };
type QcIssue = { severity: "error" | "warning" | "info"; code: string; row?: number; message: string };
type MasterDetail = MasterListItem & {
    principleNameNorm: string; revisionHash: string; sourceItems: SourceItem[]; codebook: CodebookEntry[]; formRows: Array<Record<string, string | number>>;
    qc: { errors: number; warnings: number; over50: number; invalidCodeLength: number; lowConfidence: number; duplicateCodes: number; issues: QcIssue[] };
    confirmationState: { similarity?: Confirmation; len50?: Confirmation };
    sources: Array<{ id: string; fileName: string; mimeType: string; fileSize: number; sha256: string; sourceKind: string; extraction: Record<string, unknown>; createdAt: string }>;
    audits: Array<{ id: string; action: string; detail: Record<string, unknown>; createdAt: string }>;
};
type Confirmation = { count: number; complete: boolean; bulk?: boolean; candidates?: Array<{ id: string; principleName: string; score: number }> };
type Tab = "form" | "source" | "codebook" | "qc";

const FORM_COLUMNS: Array<[string, string]> = [
    ["no", "NO"], ["kodePcpl", "Kode Pcpl"], ["kelompokPcpl", "Klp Brg Pcpl"], ["namaBarangPrinciple", "Nama Barang Principle"],
    ["isiCtn", "ISI/CTN"], ["ketTambahan", "Ket. Tambahan / Pembantu"], ["satuanFixWin", "SATUAN Fix Win"], ["namaKelompokWin", "Nama Kelompok Win"],
    ["kodeKelompokWin", "Kode Kelompok Win"], ["kodeBarangWin2", "Kode BARANG Win2"], ["len15", "LEN 15"], ["namaWin", "Nama Win"], ["len50", "LEN 50"],
    ["namaPcpl", "Nama Pcpl"], ["kodePcplWin", "Kode Principle Win"], ["namaKlp", "Nama KLP"], ["kodeKlp", "Kode KLP"],
    ["namaSubKlp", "Nama Sub KLP"], ["kodeSubKlp", "Kode Sub KLP"], ["namaSubKlp2", "Nama Sub KLP2"], ["kodeSubKlp2", "Kode Sub KLP2"],
    ["namaAroma", "Nama Aroma/Rasa"], ["kodeAroma", "Kode Aroma"], ["namaGramasi", "Nama Gramasi / Pack"], ["kodeGramasi", "Kode Gramasi"],
    ["namaKemasan", "Nama Jenis Kemasan"], ["kodeKemasan", "Kode Kemasan"], ["namaPromo", "Nama Promo"], ["kodePromo", "Kode Promo"],
    ["namaSachet", "Sachet"], ["kodeSachet", "Kode Sachet"], ["ketTambahan2", "KET TAMBAHAN2"], ["ketGolongan", "KET. GOLONGAN"], ["kodeGolongan", "Kode Golongan"],
];

const statusStyle: Record<string, string> = {
    ready: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300", review: "border-amber-500/30 bg-amber-500/10 text-amber-300",
    blocked_similarity: "border-rose-500/30 bg-rose-500/10 text-rose-300", draft: "border-slate-500/30 bg-slate-500/10 text-slate-300",
};
const tabs: Array<{ key: Tab; label: string; icon: typeof FileSpreadsheet }> = [
    { key: "form", label: "Form Fix", icon: FileSpreadsheet }, { key: "source", label: "Sumber PDF", icon: FileText },
    { key: "codebook", label: "Kamus Kode", icon: BookOpen }, { key: "qc", label: "QC", icon: CheckCircle2 },
];

async function jsonFetch(url: string, init?: RequestInit) {
    const response = await fetch(url, { credentials: "include", ...init });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || "Permintaan gagal.");
    return data;
}

export default function MasterBarangPage() {
    const [masters, setMasters] = useState<MasterListItem[]>([]);
    const [selectedId, setSelectedId] = useState("");
    const [detail, setDetail] = useState<MasterDetail | null>(null);
    const [tab, setTab] = useState<Tab>("form");
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState("");
    const [newName, setNewName] = useState("");
    const [newCode, setNewCode] = useState("");
    const [codebookDraft, setCodebookDraft] = useState<CodebookEntry[]>([]);
    const [manual, setManual] = useState({ namaBarang: "", kodePcpl: "", kelompokPcpl: "", isiCtn: "", gramasi: "", kemasan: "" });

    const loadList = async (preferId?: string) => {
        const data = await jsonFetch("/api/master-barang");
        setMasters(data.masters || []);
        const next = preferId || selectedId || data.masters?.[0]?.id || "";
        if (next) setSelectedId(next);
        return next;
    };
    const loadDetail = async (id: string) => {
        if (!id) { setDetail(null); return; }
        const data = await jsonFetch(`/api/master-barang?id=${encodeURIComponent(id)}`);
        setDetail(data.master);
        setCodebookDraft(data.master.codebook || []);
    };
    const refresh = async (id?: string) => {
        setLoading(true);
        try { const next = await loadList(id); if (next) await loadDetail(next); }
        catch (error) { toast.error(error instanceof Error ? error.message : "Gagal memuat Master Barang."); }
        finally { setLoading(false); }
    };

    useEffect(() => { void refresh(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
    useEffect(() => { if (selectedId) void loadDetail(selectedId).catch((error) => toast.error(error.message)); }, [selectedId]);

    const post = async (action: string, payload: Record<string, unknown> = {}) => {
        setBusy(action);
        try {
            const data = await jsonFetch("/api/master-barang", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, ...payload }) });
            if (data.master) { setDetail(data.master); setCodebookDraft(data.master.codebook || []); await loadList(data.master.id); }
            return data;
        } finally { setBusy(""); }
    };

    const create = async () => {
        if (!newName.trim()) return toast.error("Nama Principle wajib diisi.");
        try {
            const data = await post("create", { principleName: newName, principleCode: newCode });
            setNewName(""); setNewCode(""); setSelectedId(data.master.id);
            toast.success(data.master.status === "blocked_similarity" ? "Nama mirip ditemukan. Selesaikan 3 konfirmasi." : "Draft Master Barang dibuat.");
        } catch (error) { toast.error(error instanceof Error ? error.message : "Gagal membuat master."); }
    };

    const upload = async (file: File | null) => {
        if (!file || !detail) return;
        setBusy("upload");
        const form = new FormData(); form.append("masterId", detail.id); form.append("file", file);
        try {
            const data = await jsonFetch("/api/master-barang", { method: "POST", body: form });
            setDetail(data.master); setCodebookDraft(data.master.codebook || []); await loadList(detail.id);
            toast.success(`${data.extracted} item diekstrak. Review Kamus Kode dan QC.`);
        } catch (error) { toast.error(error instanceof Error ? error.message : "Upload gagal."); }
        finally { setBusy(""); }
    };

    const addManual = async () => {
        if (!detail || !manual.namaBarang.trim()) return toast.error("Nama Barang wajib diisi.");
        try {
            await post("manual_items", { masterId: detail.id, items: [{ ...manual, confidence: 1 }] });
            setManual({ namaBarang: "", kodePcpl: "", kelompokPcpl: "", isiCtn: "", gramasi: "", kemasan: "" });
            toast.success("Item manual ditambahkan.");
        } catch (error) { toast.error(error instanceof Error ? error.message : "Gagal menambah item."); }
    };

    const confirm = async (kind: "similarity" | "len50") => {
        if (!detail) return;
        try {
            const action = kind === "similarity" ? "confirm_similarity" : "confirm_len50";
            const data = await post(action, { masterId: detail.id });
            await loadDetail(detail.id); await loadList(detail.id);
            toast.success(`Konfirmasi ${data.confirmation.count}/3 dicatat${data.confirmation.complete ? ". Selesai." : "."}`);
        } catch (error) { toast.error(error instanceof Error ? error.message : "Konfirmasi gagal."); }
    };

    const saveCodebook = async () => {
        if (!detail) return;
        try { await post("update_codebook", { masterId: detail.id, codebook: codebookDraft }); toast.success("Kamus Kode disimpan; Form Fix dan QC dibuat ulang."); }
        catch (error) { toast.error(error instanceof Error ? error.message : "Gagal menyimpan Kamus Kode."); }
    };

    const finalize = async () => {
        if (!detail) return;
        try { await post("finalize", { masterId: detail.id }); toast.success("Master Barang berstatus Ready."); }
        catch (error) { toast.error(error instanceof Error ? error.message : "Finalisasi gagal."); }
    };

    const adaptLegacy = async () => {
        setBusy("adapt_legacy");
        try {
            const data = await jsonFetch("/api/master-barang", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "adapt_legacy" }) });
            toast.success(`Adaptasi selesai: ${data.report.adapted} file, ${data.report.unchanged} tetap, ${data.report.failed} gagal.`);
            await refresh();
        } catch (error) { toast.error(error instanceof Error ? error.message : "Adaptasi gagal."); }
        finally { setBusy(""); }
    };

    const similarity = detail?.confirmationState.similarity;
    const len50 = detail?.confirmationState.len50;
    const selectedSummary = useMemo(() => masters.find((item) => item.id === selectedId), [masters, selectedId]);

    return (
        <div className="min-h-full pb-12 text-slate-100">
            <div className="mb-6 flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
                <div><p className="text-xs font-semibold uppercase tracking-[0.22em] text-indigo-300">Data Management</p><h1 className="mt-1 text-3xl font-semibold">Master Barang</h1><p className="mt-2 max-w-3xl text-sm text-slate-400">Satu principal, satu workspace. Form Fix selalu turunan read-only dari sumber dan Kamus Kode.</p></div>
                <button onClick={adaptLegacy} disabled={Boolean(busy)} className="inline-flex items-center justify-center gap-2 rounded-lg border border-indigo-400/30 bg-indigo-500/10 px-4 py-2.5 text-sm font-medium text-indigo-200 hover:bg-indigo-500/20 disabled:opacity-50"><RefreshCcw size={16} className={busy === "adapt_legacy" ? "animate-spin" : ""} />Adaptasi Semua Master Lama</button>
            </div>

            <div className="grid gap-5 xl:grid-cols-[310px_minmax(0,1fr)]">
                <aside className="rounded-2xl border border-white/10 bg-slate-950/45 p-4">
                    <h2 className="mb-3 text-sm font-semibold">Buat principal baru</h2>
                    <input value={newName} onChange={(event) => setNewName(event.target.value)} placeholder="Nama Principle" className="mb-2 w-full rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-sm outline-none focus:border-indigo-400" />
                    <div className="flex gap-2"><input value={newCode} onChange={(event) => setNewCode(event.target.value.toUpperCase().slice(0, 2))} placeholder="Kode 2 digit (opsional)" className="min-w-0 flex-1 rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-sm outline-none focus:border-indigo-400" /><button onClick={create} disabled={busy === "create"} className="rounded-lg bg-indigo-500 px-3 text-white hover:bg-indigo-400 disabled:opacity-50"><Plus size={18} /></button></div>
                    <div className="my-4 h-px bg-white/10" />
                    <div className="max-h-[64vh] space-y-2 overflow-y-auto pr-1">
                        {masters.map((master) => <button key={master.id} onClick={() => setSelectedId(master.id)} className={`w-full rounded-xl border p-3 text-left transition ${selectedId === master.id ? "border-indigo-400/50 bg-indigo-500/10" : "border-white/5 bg-white/[0.02] hover:bg-white/[0.05]"}`}><div className="flex items-start justify-between gap-2"><div><p className="font-medium">{master.principleName}</p><p className="mt-1 text-xs text-slate-500">{master.principleCode} · {master.itemCount} item · rev {master.revision}</p></div><span className={`rounded border px-1.5 py-0.5 text-[10px] uppercase ${statusStyle[master.status] || statusStyle.draft}`}>{master.status.replace("blocked_similarity", "mirip")}</span></div>{(master.errors > 0 || master.warnings > 0) && <p className="mt-2 text-xs text-amber-300">{master.errors} error · {master.warnings} warning</p>}</button>)}
                        {!loading && !masters.length && <p className="py-8 text-center text-sm text-slate-500">Belum ada master.</p>}
                    </div>
                </aside>

                <main className="min-w-0">
                    {loading ? <div className="flex h-72 items-center justify-center rounded-2xl border border-white/10 bg-slate-950/45"><Loader2 className="animate-spin text-indigo-300" /></div> : !detail ? <div className="rounded-2xl border border-dashed border-white/15 p-16 text-center text-slate-400">Buat atau pilih Master Barang.</div> : <>
                        <section className="mb-4 rounded-2xl border border-white/10 bg-slate-950/45 p-5">
                            <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between"><div><div className="flex flex-wrap items-center gap-2"><h2 className="text-2xl font-semibold">{detail.principleName}</h2><span className="rounded-md bg-white/5 px-2 py-1 font-mono text-sm text-indigo-200">{detail.principleCode}</span><span className={`rounded border px-2 py-1 text-xs uppercase ${statusStyle[detail.status] || statusStyle.draft}`}>{detail.status}</span></div><p className="mt-2 text-sm text-slate-400">{detail.formRows.length} item · revisi {detail.revision} · {detail.sources.length} sumber</p></div><div className="flex flex-wrap gap-2"><label className={`inline-flex cursor-pointer items-center gap-2 rounded-lg bg-indigo-500 px-3 py-2 text-sm font-medium hover:bg-indigo-400 ${busy === "upload" || detail.status === "blocked_similarity" ? "pointer-events-none opacity-50" : ""}`}><Upload size={15} />{busy === "upload" ? "Memproses..." : "Upload Sumber"}<input type="file" className="hidden" accept=".pdf,.xlsx,.xls,.csv,.tsv,.png,.jpg,.jpeg,.webp" onChange={(event) => { void upload(event.target.files?.[0] || null); event.target.value = ""; }} /></label><button onClick={() => window.location.assign(`/api/master-barang?id=${detail.id}&export=1`)} className="inline-flex items-center gap-2 rounded-lg border border-white/10 px-3 py-2 text-sm hover:bg-white/5"><Download size={15} />Excel 4 Sheet</button><button onClick={finalize} disabled={busy === "finalize"} className="inline-flex items-center gap-2 rounded-lg border border-emerald-400/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-200 hover:bg-emerald-500/20"><CheckCircle2 size={15} />Finalisasi</button></div></div>
                        </section>

                        {detail.status === "blocked_similarity" && similarity && <section className="mb-4 rounded-2xl border border-rose-400/30 bg-rose-500/10 p-5"><div className="flex gap-3"><ShieldAlert className="mt-0.5 shrink-0 text-rose-300" /><div className="flex-1"><h3 className="font-semibold text-rose-100">Nama principal mirip master yang sudah ada</h3><p className="mt-1 text-sm text-rose-100/70">{similarity.candidates?.map((item) => `${item.principleName} (${Math.round(item.score * 100)}%)`).join(", ")}</p><p className="mt-2 text-sm">Konfirmasi {similarity.count}/3. Tiap klik dicatat di audit.</p><button onClick={() => void confirm("similarity")} disabled={busy === "confirm_similarity"} className="mt-3 rounded-lg bg-rose-500 px-3 py-2 text-sm font-medium hover:bg-rose-400">Saya tetap lanjut · tahap {Math.min(3, similarity.count + 1)}/3</button></div></div></section>}

                        <nav className="mb-4 flex gap-1 overflow-x-auto rounded-xl border border-white/10 bg-slate-950/45 p-1">{tabs.map((item) => { const Icon = item.icon; return <button key={item.key} onClick={() => setTab(item.key)} className={`flex min-w-fit items-center gap-2 rounded-lg px-4 py-2 text-sm ${tab === item.key ? "bg-indigo-500 text-white" : "text-slate-400 hover:bg-white/5 hover:text-white"}`}><Icon size={15} />{item.label}{item.key === "qc" && detail.qc.warnings + detail.qc.errors > 0 ? <span className="rounded bg-amber-400/20 px-1.5 text-xs text-amber-200">{detail.qc.warnings + detail.qc.errors}</span> : null}</button>; })}</nav>

                        <section className="rounded-2xl border border-white/10 bg-slate-950/45">
                            {tab === "form" && <div><div className="border-b border-white/10 px-5 py-4"><h3 className="font-semibold">Form Fix</h3><p className="mt-1 text-xs text-slate-500">Read-only. Ubah struktur melalui Kamus Kode.</p></div><div className="max-h-[68vh] overflow-auto"><table className="min-w-max text-xs"><thead className="sticky top-0 z-10 bg-slate-900"><tr>{FORM_COLUMNS.map(([key, label]) => <th key={key} className="whitespace-nowrap border-b border-r border-white/10 px-3 py-2 text-left font-semibold text-slate-300">{label}</th>)}</tr></thead><tbody>{detail.formRows.map((row, index) => <tr key={`${row.kodeBarangWin2 || index}-${index}`} className="odd:bg-white/[0.015] hover:bg-indigo-500/5">{FORM_COLUMNS.map(([key]) => <td key={key} className={`max-w-[280px] whitespace-nowrap border-b border-r border-white/5 px-3 py-2 ${key === "len50" && Number(row[key]) > 50 ? "bg-amber-500/15 text-amber-200" : ""}`}>{String(row[key] ?? "")}</td>)}</tr>)}</tbody></table>{!detail.formRows.length && <p className="p-12 text-center text-slate-500">Upload sumber atau tambah item manual.</p>}</div></div>}

                            {tab === "source" && <div className="p-5"><h3 className="font-semibold">Sumber PDF / File</h3><div className="mt-4 grid gap-3 lg:grid-cols-2">{detail.sources.map((source) => <a key={source.id} href={`/api/master-barang?id=${detail.id}&sourceId=${source.id}`} className="rounded-xl border border-white/10 p-3 hover:bg-white/5"><div className="flex items-center gap-3"><FileText className="text-indigo-300" size={20} /><div className="min-w-0"><p className="truncate text-sm font-medium">{source.fileName}</p><p className="text-xs text-slate-500">{source.sourceKind} · {(source.fileSize / 1024).toFixed(1)} KB · {String(source.extraction.engine || "adapter")}</p></div></div></a>)}</div><div className="mt-6 rounded-xl border border-white/10 p-4"><h4 className="text-sm font-semibold">Tambah item manual</h4><div className="mt-3 grid gap-2 md:grid-cols-2 xl:grid-cols-3">{([['namaBarang','Nama Barang *'],['kodePcpl','Kode Pcpl (opsional)'],['kelompokPcpl','Kelompok Principle'],['isiCtn','ISI/CTN'],['gramasi','Gramasi'],['kemasan','Kemasan']] as const).map(([key, label]) => <input key={key} value={manual[key]} onChange={(event) => setManual((current) => ({ ...current, [key]: event.target.value }))} placeholder={label} className="rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-sm outline-none focus:border-indigo-400" />)}</div><button onClick={addManual} className="mt-3 inline-flex items-center gap-2 rounded-lg bg-indigo-500 px-3 py-2 text-sm hover:bg-indigo-400"><PackagePlus size={15} />Tambahkan</button></div><div className="mt-6 overflow-auto"><table className="min-w-full text-sm"><thead><tr className="text-left text-xs text-slate-400"><th className="px-3 py-2">Sumber</th><th className="px-3 py-2">Nama Barang</th><th className="px-3 py-2">Isi</th><th className="px-3 py-2">Gramasi</th><th className="px-3 py-2">Kemasan</th><th className="px-3 py-2">Confidence</th></tr></thead><tbody>{detail.sourceItems.map((item, index) => <tr key={index} className="border-t border-white/5"><td className="px-3 py-2 text-slate-500">{item.sourcePage ? `Hal. ${item.sourcePage}` : item.sourceRow ? `Baris ${item.sourceRow}` : "Manual"}</td><td className="px-3 py-2">{item.namaBarang}</td><td className="px-3 py-2">{item.isiCtn || ""}</td><td className="px-3 py-2">{item.gramasi || ""}</td><td className="px-3 py-2">{item.kemasan || ""}</td><td className="px-3 py-2">{Math.round(Number(item.confidence ?? 1) * 100)}%</td></tr>)}</tbody></table></div></div>}

                            {tab === "codebook" && <div><div className="flex items-center justify-between border-b border-white/10 px-5 py-4"><div><h3 className="font-semibold">Kamus Kode</h3><p className="mt-1 text-xs text-slate-500">Kemasan selalu mulai 1 per KLP. Menyimpan kamus membuat ulang Form Fix dan membatalkan konfirmasi LEN 50 lama.</p></div><button onClick={saveCodebook} disabled={busy === "update_codebook"} className="inline-flex items-center gap-2 rounded-lg bg-indigo-500 px-3 py-2 text-sm hover:bg-indigo-400"><Save size={15} />Simpan</button></div><div className="max-h-[68vh] overflow-auto"><table className="min-w-full text-sm"><thead className="sticky top-0 bg-slate-900"><tr className="text-left text-xs text-slate-400"><th className="px-3 py-2">Level</th><th className="px-3 py-2">Scope</th><th className="px-3 py-2">Nama sumber</th><th className="px-3 py-2">Nama hasil</th><th className="px-3 py-2">Kode</th></tr></thead><tbody>{codebookDraft.map((entry, index) => <tr key={entry.key} className="border-t border-white/5"><td className="px-3 py-2 font-mono text-xs text-indigo-300">{entry.level}</td><td className="px-3 py-2 text-xs text-slate-500">{entry.scope || "(root)"}</td><td className="px-3 py-2 text-xs">{entry.sourceName || "(kosong)"}</td><td className="px-3 py-2"><input value={entry.name} onChange={(event) => setCodebookDraft((rows) => rows.map((row, rowIndex) => rowIndex === index ? { ...row, name: event.target.value.toUpperCase() } : row))} className="w-full min-w-36 rounded border border-white/10 bg-black/20 px-2 py-1.5 outline-none focus:border-indigo-400" /></td><td className="px-3 py-2"><input value={entry.code} onChange={(event) => setCodebookDraft((rows) => rows.map((row, rowIndex) => rowIndex === index ? { ...row, code: event.target.value.replace(/\D/g, "").slice(0, 4) } : row))} className="w-20 rounded border border-white/10 bg-black/20 px-2 py-1.5 font-mono outline-none focus:border-indigo-400" /></td></tr>)}</tbody></table></div></div>}

                            {tab === "qc" && <div className="p-5"><div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">{[["Error", detail.qc.errors, "text-rose-300"], ["Warning", detail.qc.warnings, "text-amber-300"], ["Nama >50", detail.qc.over50, "text-amber-300"], ["Kode ≠15", detail.qc.invalidCodeLength, "text-sky-300"], ["Low confidence", detail.qc.lowConfidence, "text-violet-300"]].map(([label, value, color]) => <div key={String(label)} className="rounded-xl border border-white/10 bg-white/[0.02] p-4"><p className="text-xs text-slate-500">{label}</p><p className={`mt-1 text-2xl font-semibold ${color}`}>{value}</p></div>)}</div>{detail.qc.over50 > 0 && <div className="mt-5 rounded-xl border border-amber-400/30 bg-amber-500/10 p-4"><div className="flex items-start gap-3"><AlertTriangle className="mt-0.5 text-amber-300" /><div><h4 className="font-semibold">LEN 50 hanya review, bukan pemotongan otomatis</h4><p className="mt-1 text-sm text-amber-100/70">{detail.qc.over50} item lebih dari 50 karakter. Override ini berlaku bulk untuk seluruh revisi, bukan per item.</p><p className="mt-2 text-sm">Konfirmasi {len50?.count || 0}/3.</p><button onClick={() => void confirm("len50")} disabled={Boolean(len50?.complete)} className="mt-3 rounded-lg bg-amber-500 px-3 py-2 text-sm font-medium text-slate-950 hover:bg-amber-400 disabled:opacity-50">{len50?.complete ? "Konfirmasi bulk selesai" : `Terapkan bulk · tahap ${Math.min(3, (len50?.count || 0) + 1)}/3`}</button></div></div></div>}<div className="mt-5 overflow-auto"><table className="min-w-full text-sm"><thead><tr className="text-left text-xs text-slate-400"><th className="px-3 py-2">Severity</th><th className="px-3 py-2">Kode</th><th className="px-3 py-2">Baris</th><th className="px-3 py-2">Penjelasan</th></tr></thead><tbody>{detail.qc.issues.map((issue, index) => <tr key={`${issue.code}-${index}`} className="border-t border-white/5"><td className={`px-3 py-2 font-medium ${issue.severity === "error" ? "text-rose-300" : issue.severity === "warning" ? "text-amber-300" : "text-sky-300"}`}>{issue.severity}</td><td className="px-3 py-2 font-mono text-xs">{issue.code}</td><td className="px-3 py-2">{issue.row || ""}</td><td className="px-3 py-2">{issue.message}</td></tr>)}</tbody></table>{!detail.qc.issues.length && <p className="py-12 text-center text-emerald-300">Tidak ada temuan QC.</p>}</div></div>}
                        </section>
                    </>}
                </main>
            </div>
            {selectedSummary && <span className="sr-only">Master terpilih {selectedSummary.principleName}</span>}
        </div>
    );
}
