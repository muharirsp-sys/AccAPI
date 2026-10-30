/*
 * Tujuan: Master Barang per principal (Fiori): satu ruang kerja dengan bagian Form Fix, Sumber, Kamus Kode, dan QC.
 *   Finalisasi, adaptasi master lama, dan simpan Kamus Kode lewat dialog konfirmasi yang menyebut jumlah dan akibatnya.
 * Caller: Route dashboard /master-barang melalui SidebarLayout/RBAC.
 * Dependensi: /api/master-barang (GET daftar/detail/ekspor/sumber, POST aksi + unggah), komponen Fiori, lib/tampil, lucide-react.
 * Main Functions: MasterBarangPage.
 * Side Effects: Fetch API, unggah/unduh berkas, adaptasi master lama (menulis ulang banyak berkas), update Kamus Kode, konfirmasi 3 tahap.
 */
"use client";

import { useEffect, useState } from "react";
import { Download, PackagePlus, RefreshCcw, Save, TriangleAlert, Upload, CircleCheck } from "lucide-react";
import { FioriScope } from "@/components/fiori/Scope";
import {
    Button, EmptyState, ErrorState, ListItem, MessageStrip, ObjectPageHeader, Section, Skeleton, StatusBadge, type Tone,
} from "@/components/fiori/core";
import { ConfirmDialog, FormField } from "@/components/fiori/interactive";
import { sebabHttp } from "@/lib/tampil";

type MasterListItem = { id: string; principleCode: string; principleName: string; status: string; revision: number; itemCount: number; errors: number; warnings: number; over50: number; updatedAt: string };
type SourceItem = { sourceRow?: number; sourcePage?: number; kodePcpl?: string; kelompokPcpl?: string; namaBarang: string; isiCtn?: string | number; satuan?: string; gramasi?: string; kemasan?: string; confidence?: number; reviewNotes?: string[] };
type CodebookEntry = { key: string; level: string; scope: string; sourceName: string; name: string; code: string; generated: boolean };
type QcIssue = { severity: "error" | "warning" | "info"; code: string; row?: number; message: string };
type MasterDetail = MasterListItem & {
    principleNameNorm: string; revisionHash: string; sourceItems: SourceItem[]; codebook: CodebookEntry[]; formRows: Array<Record<string, string | number>>;
    qc: { errors: number; warnings: number; over50: number; invalidCodeLength: number; lowConfidence: number; duplicateCodes: number; gramasiNearDup: number; issues: QcIssue[] };
    confirmationState: { similarity?: Confirmation; len50?: Confirmation; gramasi?: Confirmation };
    sources: Array<{ id: string; fileName: string; mimeType: string; fileSize: number; sha256: string; sourceKind: string; extraction: Record<string, unknown>; createdAt: string }>;
    audits: Array<{ id: string; action: string; detail: Record<string, unknown>; createdAt: string }>;
};
type Confirmation = { count: number; complete: boolean; bulk?: boolean; candidates?: Array<{ id: string; principleName: string; score: number }> };
type Tab = "form" | "source" | "codebook" | "qc";
type Dialog = "adaptasi" | "finalisasi" | "kamus" | null;
type Pesan = { tone: "pos" | "warn" | "neg"; teks: string };

// Samakan dengan NAMA_WIN_MAX di lib/master-barang/engine.ts (engine tidak diimpor ke
// client karena memakai node:crypto).
const NAMA_WIN_MAX = 55;

const FORM_COLUMNS: Array<[string, string]> = [
    ["no", "NO"], ["kodePcpl", "Kode Pcpl"], ["kelompokPcpl", "Klp Brg Pcpl"], ["namaBarangPrinciple", "Nama Barang Principle"],
    ["isiCtn", "ISI/CTN"], ["ketTambahan", "Ket. Tambahan / Pembantu"], ["satuanFixWin", "SATUAN Fix Win"], ["namaKelompokWin", "Nama Kelompok Win"],
    ["kodeKelompokWin", "Kode Kelompok Win"], ["kodeBarangWin2", "Kode Barang"], ["len15", "LEN 15"], ["namaWin", "Nama Barang"], ["len50", "LEN 55"],
    ["namaPcpl", "Nama Pcpl"], ["kodePcplWin", "Kode Principle Win"], ["namaKlp", "Nama KLP"], ["kodeKlp", "Kode KLP"],
    ["namaSubKlp", "Nama Sub KLP"], ["kodeSubKlp", "Kode Sub KLP"], ["namaSubKlp2", "Nama Sub KLP2"], ["kodeSubKlp2", "Kode Sub KLP2"],
    ["namaAroma", "Nama Aroma/Rasa"], ["kodeAroma", "Kode Aroma"], ["namaGramasi", "Nama Gramasi / Pack"], ["kodeGramasi", "Kode Gramasi"],
    ["namaKemasan", "Nama Jenis Kemasan"], ["kodeKemasan", "Kode Kemasan"], ["namaPromo", "Nama Promo"], ["kodePromo", "Kode Promo"],
    ["namaSachet", "Sachet"], ["kodeSachet", "Kode Sachet"], ["ketTambahan2", "KET TAMBAHAN2"], ["ketGolongan", "KET. GOLONGAN"], ["kodeGolongan", "Kode Golongan"],
    ["hargaDistributorInclude", "Harga Distributor (Incl)"], ["hargaDistributorExclude", "Harga Distributor (Excl)"],
    ["hargaWholesalerInclude", "Harga Wholesaler (Incl)"], ["hargaWholesalerExclude", "Harga Wholesaler (Excl)"],
    ["hargaRetailerInclude", "Harga Retailer (Incl)"], ["hargaRetailerExclude", "Harga Retailer (Excl)"],
    ["hargaSupermarketInclude", "Harga Supermarket (Incl)"], ["hargaSupermarketExclude", "Harga Supermarket (Excl)"],
    ["hargaBujInclude", "Harga BUJ (Incl)"], ["hargaBujExclude", "Harga BUJ (Excl)"], ["marginPersen", "Margin %"],
];
// Kolom angka rata kanan dan tabular supaya bisa dibandingkan antarbaris.
const KOLOM_ANGKA = new Set(["no", "isiCtn", "len15", "len50", "marginPersen", ...FORM_COLUMNS.map(([key]) => key).filter((key) => key.startsWith("harga"))]);

// Status master: ikon + label + nada (bukan warna saja). Status di luar daftar tampil sebagai "tidak dikenal", bukan disamarkan jadi Draf.
const STATUS_MASTER: Record<string, { label: string; tone: Tone }> = {
    ready: { label: "Siap", tone: "pos" }, review: { label: "Perlu tinjau", tone: "warn" },
    blocked_similarity: { label: "Nama mirip", tone: "neg" }, draft: { label: "Draf", tone: "neu" },
};
const statusMaster = (status: string) => STATUS_MASTER[status] ?? { label: "Status tidak dikenal", tone: "neu" as Tone };
const TABS: Array<{ key: Tab; label: string }> = [
    { key: "form", label: "Form Fix" }, { key: "source", label: "Sumber" }, { key: "codebook", label: "Kamus Kode" }, { key: "qc", label: "QC" },
];
// position:relative supaya teks sr-only di dalam tabel lebar terpotong wadah gulir, bukan melebarkan halaman.
const GULIR_TABEL = { overflow: "auto", maxHeight: "68vh", position: "relative" } as const;

async function jsonFetch(url: string, init?: RequestInit) {
    const response = await fetch(url, { credentials: "include", ...init }).catch(() => { throw new Error(sebabHttp(0)); });
    const data = await response.json().catch(() => ({}));
    if (response.status >= 500) {
        // Galat 5xx dari route bisa berisi teks teknis (mis. query SQL): rincian ke konsol, layar memakai kalimat sebab (audit desain 001, Fase 3).
        if (data.error) console.error(`master-barang ${url}:`, data.error);
        throw new Error(sebabHttp(response.status));
    }
    if (!response.ok || !data.ok) throw new Error(data.error || sebabHttp(response.status));
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
    const [galatMuat, setGalatMuat] = useState<string | null>(null);
    const [galatDetail, setGalatDetail] = useState<string | null>(null);
    const [galatBuat, setGalatBuat] = useState<string | null>(null);
    const [galatManual, setGalatManual] = useState<string | null>(null);
    const [pesan, setPesan] = useState<Pesan | null>(null);
    const [dialog, setDialog] = useState<Dialog>(null);

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
        try { const next = await loadList(id); if (next) await loadDetail(next); setGalatMuat(null); }
        catch (error) { setGalatMuat(error instanceof Error ? error.message : "Master barang gagal dimuat."); }
        finally { setLoading(false); }
    };

    useEffect(() => { void refresh(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
    useEffect(() => { if (selectedId) void loadDetail(selectedId).then(() => setGalatDetail(null)).catch((error) => setGalatDetail(error.message)); }, [selectedId]);

    const post = async (action: string, payload: Record<string, unknown> = {}) => {
        setBusy(action);
        try {
            const data = await jsonFetch("/api/master-barang", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, ...payload }) });
            if (data.master) { setDetail(data.master); setCodebookDraft(data.master.codebook || []); await loadList(data.master.id); }
            return data;
        } finally { setBusy(""); }
    };

    const create = async () => {
        setGalatBuat(null);
        if (!newName.trim()) { setGalatBuat("Nama principal wajib diisi."); return; }
        try {
            const data = await post("create", { principleName: newName, principleCode: newCode });
            setNewName(""); setNewCode(""); setSelectedId(data.master.id);
            setPesan(data.master.status === "blocked_similarity"
                ? { tone: "warn", teks: "Nama mirip ditemukan. Selesaikan 3 konfirmasi." }
                : { tone: "pos", teks: "Draf master barang dibuat." });
        } catch (error) { setGalatBuat(error instanceof Error ? error.message : "Master belum terbuat."); }
    };

    const upload = async (file: File | null) => {
        if (!file || !detail) return;
        setBusy("upload");
        setPesan(null);
        const form = new FormData(); form.append("masterId", detail.id); form.append("file", file);
        try {
            const data = await jsonFetch("/api/master-barang", { method: "POST", body: form });
            setDetail(data.master); setCodebookDraft(data.master.codebook || []); await loadList(detail.id);
            setPesan({ tone: "pos", teks: `${data.extracted} item diekstrak. Tinjau Kamus Kode dan QC.` });
        } catch (error) { setPesan({ tone: "neg", teks: `Berkas belum terunggah. ${error instanceof Error ? error.message : sebabHttp(0)}` }); }
        finally { setBusy(""); }
    };

    const addManual = async () => {
        setGalatManual(null);
        if (!detail || !manual.namaBarang.trim()) { setGalatManual("Nama barang wajib diisi."); return; }
        try {
            await post("manual_items", { masterId: detail.id, items: [{ ...manual, confidence: 1 }] });
            setManual({ namaBarang: "", kodePcpl: "", kelompokPcpl: "", isiCtn: "", gramasi: "", kemasan: "" });
            setPesan({ tone: "pos", teks: "Item manual ditambahkan." });
        } catch (error) { setGalatManual(error instanceof Error ? error.message : "Item belum tertambah."); }
    };

    const catatKonfirmasi = async (kind: "similarity" | "len50" | "gramasi") => {
        if (!detail) return;
        try {
            const action = kind === "similarity" ? "confirm_similarity" : kind === "len50" ? "confirm_len50" : "confirm_gramasi";
            const data = await post(action, { masterId: detail.id });
            await loadDetail(detail.id); await loadList(detail.id);
            setPesan({ tone: "pos", teks: `Konfirmasi ${data.confirmation.count} dari 3 dicatat${data.confirmation.complete ? ". Selesai." : "."}` });
        } catch (error) { setPesan({ tone: "neg", teks: `Konfirmasi belum tercatat. ${error instanceof Error ? error.message : sebabHttp(0)}` }); }
    };

    const saveCodebook = async () => {
        if (!detail) return;
        await post("update_codebook", { masterId: detail.id, codebook: codebookDraft });
        setDialog(null);
        setPesan({ tone: "pos", teks: "Kamus Kode disimpan; Form Fix dan QC dibuat ulang." });
    };

    const finalize = async () => {
        if (!detail) return;
        await post("finalize", { masterId: detail.id });
        setDialog(null);
        setPesan({ tone: "pos", teks: "Master barang berstatus Siap." });
    };

    const adaptLegacy = async () => {
        setBusy("adapt_legacy");
        try {
            const data = await jsonFetch("/api/master-barang", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "adapt_legacy" }) });
            setDialog(null);
            setPesan({ tone: data.report.failed > 0 ? "warn" : "pos", teks: `Adaptasi selesai: ${data.report.adapted} file diadaptasi, ${data.report.unchanged} tetap, ${data.report.failed} gagal.` });
            await refresh();
        } finally { setBusy(""); }
    };

    const similarity = detail?.confirmationState.similarity;
    const len50 = detail?.confirmationState.len50;
    const gramasi = detail?.confirmationState.gramasi;
    const status = detail ? statusMaster(detail.status) : null;
    const tidakBisaUnggah = busy === "upload" || detail?.status === "blocked_similarity";
    const kartuQc: Array<[string, number, Tone]> = detail ? [
        ["Error", detail.qc.errors, "neg"], ["Peringatan", detail.qc.warnings, "warn"], [`Nama lebih dari ${NAMA_WIN_MAX} karakter`, detail.qc.over50, "warn"],
        ["Kode tidak 15 karakter", detail.qc.invalidCodeLength, "info"], ["Keyakinan baca rendah", detail.qc.lowConfidence, "warn"], ["Gramasi mirip", detail.qc.gramasiNearDup ?? 0, "warn"],
    ] : [];
    const nadaTemuan: Record<QcIssue["severity"], { tone: Tone; label: string }> = { error: { tone: "neg", label: "Error" }, warning: { tone: "warn", label: "Peringatan" }, info: { tone: "info", label: "Info" } };

    return (
        <FioriScope>
            <div className="fi-page">
                <header className="fi-page-head">
                    <nav aria-label="Jejak halaman"><ol className="fi-crumb"><li><span>Pengaturan</span></li><li><span aria-current="page">Master Barang</span></li></ol></nav>
                    <div className="fi-page-bar">
                        <h1>Master Barang</h1>
                        <span className="fi-spacer" />
                        <Button icon={<RefreshCcw className="fi-icon" aria-hidden />} disabled={Boolean(busy)} disabledReason="Tunggu proses yang sedang berjalan" onClick={() => setDialog("adaptasi")}>Adaptasi master lama…</Button>
                    </div>
                    <p>Satu principal, satu ruang kerja. Form Fix selalu turunan dari sumber dan Kamus Kode, jadi tidak diubah langsung.</p>
                </header>

                {pesan && <MessageStrip tone={pesan.tone} title={pesan.teks} onClose={() => setPesan(null)} />}
                {galatMuat && masters.length > 0 && (
                    <MessageStrip tone="neg" title="Gagal memuat ulang. Yang tampil adalah hasil sebelumnya.">{galatMuat} <Button variant="tertiary" onClick={() => void refresh()}>Coba lagi</Button></MessageStrip>
                )}

                {galatMuat && masters.length === 0 && !loading ? (
                    <div className="fi-panel"><ErrorState title="Daftar master barang gagal dimuat" message={galatMuat} onRetry={() => void refresh()} /></div>
                ) : (
                    <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,320px)_minmax(0,1fr)]">
                        <div className="grid gap-4">
                            <Section title="Buat principal baru">
                                <div className="fi-sect-in">
                                    <FormField label="Nama principal" required error={galatBuat ?? undefined}>
                                        {(a11y) => <input {...a11y} className="fi-input" value={newName} placeholder="mis. PRINCIPLE A" onChange={(event) => setNewName(event.target.value)} />}
                                    </FormField>
                                    <FormField label="Kode Master Barang" help="2 karakter, sesuai Data Principal.">
                                        {(a11y) => <input {...a11y} className="fi-input fi-mono" value={newCode} maxLength={2} onChange={(event) => setNewCode(event.target.value.toUpperCase().slice(0, 2))} />}
                                    </FormField>
                                    <div className="fi-btnrow">
                                        <Button variant="primary" icon={<PackagePlus className="fi-icon" aria-hidden />} busy={busy === "create"} onClick={create}>Buat principal</Button>
                                    </div>
                                </div>
                            </Section>

                            <Section title="Master tersimpan" subtitle={masters.length ? `${masters.length} master` : undefined}>
                                {loading && masters.length === 0 ? <div className="fi-sect-in"><Skeleton rows={4} label="Memuat daftar master" /></div>
                                    : masters.length === 0 ? <EmptyState title="Belum ada master" message="Buat principal pertama lewat formulir di atas." />
                                    : (
                                        <ul className="fi-list" style={{ display: "block", maxHeight: "64vh", overflowY: "auto" }} aria-label="Daftar master barang">
                                            {masters.map((master) => {
                                                const s = statusMaster(master.status);
                                                return (
                                                    <li key={master.id} className="fi-wl-row">
                                                        <ListItem doc={master.principleCode} title={master.principleName}
                                                            meta={`${master.itemCount} item · revisi ${master.revision}${master.errors > 0 || master.warnings > 0 ? ` · ${master.errors} error, ${master.warnings} peringatan` : ""}`}
                                                            badge={<StatusBadge tone={s.tone} wrap>{s.label}</StatusBadge>} current={selectedId === master.id} onClick={() => setSelectedId(master.id)} />
                                                    </li>
                                                );
                                            })}
                                        </ul>
                                    )}
                            </Section>
                        </div>

                        <div className="grid min-w-0 gap-4">
                            {loading && !detail ? <div className="fi-panel"><Skeleton rows={6} label="Memuat master barang" /></div>
                                : galatDetail ? <MessageStrip tone="neg" title="Master ini gagal dimuat.">{galatDetail} <Button variant="tertiary" onClick={() => void loadDetail(selectedId).then(() => setGalatDetail(null)).catch((error) => setGalatDetail(error.message))}>Coba lagi</Button></MessageStrip>
                                : !detail || !status ? <div className="fi-panel"><EmptyState title="Belum ada master yang dipilih" message="Pilih master di daftar, atau buat principal baru." /></div>
                                : (
                                    <>
                                        <ObjectPageHeader headingLevel={2} title={detail.principleName} status={<StatusBadge tone={status.tone}>{status.label}</StatusBadge>}
                                            attributes={[
                                                { label: "Kode", value: <span className="fi-mono">{detail.principleCode}</span> },
                                                { label: "Item", value: detail.formRows.length }, { label: "Revisi", value: detail.revision }, { label: "Sumber", value: detail.sources.length },
                                            ]}
                                            actions={<>
                                                <label className="fi-btn fi-btn--secondary" aria-disabled={tidakBisaUnggah || undefined} title={detail.status === "blocked_similarity" ? "Selesaikan 3 konfirmasi nama mirip dulu" : undefined}>
                                                    <Upload className="fi-icon" aria-hidden />{busy === "upload" ? "Memproses…" : "Unggah sumber"}
                                                    <input type="file" className="sr-only" disabled={tidakBisaUnggah} accept=".pdf,.xlsx,.xls,.csv,.tsv,.png,.jpg,.jpeg,.webp" onChange={(event) => { void upload(event.target.files?.[0] || null); event.target.value = ""; }} />
                                                </label>
                                                <a className="fi-btn fi-btn--secondary" href={`/api/master-barang?id=${detail.id}&export=1`}><Download className="fi-icon" aria-hidden />Unduh Excel 4 sheet</a>
                                                <Button variant="primary" icon={<CircleCheck className="fi-icon" aria-hidden />} onClick={() => setDialog("finalisasi")}>Finalisasi…</Button>
                                            </>} />

                                        {detail.status === "blocked_similarity" && similarity && (
                                            <MessageStrip tone="neg" title="Nama principal mirip master yang sudah ada.">
                                                {similarity.candidates?.map((item) => `${item.principleName} (${Math.round(item.score * 100)}%)`).join(", ")}. Unggah sumber terkunci sampai 3 konfirmasi selesai. Konfirmasi {similarity.count} dari 3; tiap klik dicatat di audit.{" "}
                                                <Button variant="negative" busy={busy === "confirm_similarity"} onClick={() => void catatKonfirmasi("similarity")}>{`Saya tetap lanjut, tahap ${Math.min(3, similarity.count + 1)} dari 3`}</Button>
                                            </MessageStrip>
                                        )}

                                        <div className="fi-segs" role="group" aria-label="Bagian master">
                                            {TABS.map((item) => (
                                                <button key={item.key} type="button" aria-pressed={tab === item.key} onClick={() => setTab(item.key)}>
                                                    {item.label}{item.key === "qc" && detail.qc.warnings + detail.qc.errors > 0 ? ` (${detail.qc.warnings + detail.qc.errors})` : ""}
                                                </button>
                                            ))}
                                        </div>

                                        {tab === "form" && (
                                            <Section title="Form Fix" subtitle="hanya baca; ubah struktur lewat Kamus Kode">
                                                {detail.formRows.length === 0 ? <EmptyState title="Form Fix masih kosong" message="Unggah sumber atau tambah item manual di bagian Sumber." /> : (
                                                    <div className="fi-tablescroll" tabIndex={0} role="group" aria-label="Form Fix" style={GULIR_TABEL}>
                                                        <table className="fi-table">
                                                            <caption className="sr-only">Form Fix</caption>
                                                            <thead><tr>{FORM_COLUMNS.map(([key, label]) => <th key={key} scope="col" className={KOLOM_ANGKA.has(key) ? "fi-end" : undefined}>{label}</th>)}</tr></thead>
                                                            <tbody>{detail.formRows.map((row, index) => (
                                                                <tr key={`${row.kodeBarangWin2 || index}-${index}`}>
                                                                    {FORM_COLUMNS.map(([key]) => {
                                                                        const nilai = String(row[key] ?? "");
                                                                        const lewat = key === "len50" && Number(row[key]) > NAMA_WIN_MAX;
                                                                        return (
                                                                            <td key={key} className={KOLOM_ANGKA.has(key) ? "fi-end" : undefined} title={nilai.length > 40 ? nilai : undefined}
                                                                                style={{ maxWidth: 280, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", ...(lewat ? { background: "var(--warn-bg)", color: "var(--warn)", fontWeight: 600 } : null) }}>
                                                                                {lewat && <TriangleAlert className="fi-icon" aria-hidden style={{ width: 12, height: 12, marginRight: 4, verticalAlign: "-1px" }} />}
                                                                                {nilai}{lewat && <span className="sr-only"> (melebihi {NAMA_WIN_MAX} karakter)</span>}
                                                                            </td>
                                                                        );
                                                                    })}
                                                                </tr>
                                                            ))}</tbody>
                                                        </table>
                                                    </div>
                                                )}
                                            </Section>
                                        )}

                                        {tab === "source" && (
                                            <>
                                                <Section title="Sumber" subtitle={`${detail.sources.length} berkas`}>
                                                    {detail.sources.length === 0 ? <EmptyState title="Belum ada sumber" message="Unggah PDF, Excel, atau foto lewat tombol Unggah sumber di atas." /> : (
                                                        <div className="fi-dflow">
                                                            {detail.sources.map((source) => (
                                                                <a key={source.id} className="fi-dnode" href={`/api/master-barang?id=${detail.id}&sourceId=${source.id}`} title={`Pembaca: ${String(source.extraction.engine || "adapter")}`}>
                                                                    <b>{source.fileName}</b>
                                                                    <span>{source.sourceKind} · {(source.fileSize / 1024).toFixed(1)} KB</span>
                                                                </a>
                                                            ))}
                                                        </div>
                                                    )}
                                                </Section>

                                                <Section title="Tambah item manual" subtitle="untuk barang yang tidak ada di sumber">
                                                    <div className="fi-sect-in">
                                                        {galatManual && <MessageStrip tone="neg" title={galatManual} onClose={() => setGalatManual(null)} />}
                                                        <div className="fi-formgrid">
                                                            {([["namaBarang", "Nama barang", true], ["kodePcpl", "Kode principal", false], ["kelompokPcpl", "Kelompok principal", false], ["isiCtn", "ISI per karton", false], ["gramasi", "Gramasi", false], ["kemasan", "Kemasan", false]] as const).map(([key, label, wajib]) => (
                                                                <FormField key={key} label={label} required={wajib} help={key === "kodePcpl" ? "Opsional." : undefined}>
                                                                    {(a11y) => <input {...a11y} className="fi-input" value={manual[key]} onChange={(event) => setManual((current) => ({ ...current, [key]: event.target.value }))} />}
                                                                </FormField>
                                                            ))}
                                                        </div>
                                                        <div className="fi-btnrow"><Button variant="primary" icon={<PackagePlus className="fi-icon" aria-hidden />} busy={busy === "manual_items"} onClick={addManual}>Tambahkan</Button></div>
                                                    </div>
                                                </Section>

                                                <Section title="Item dari sumber" subtitle={`${detail.sourceItems.length} item`}>
                                                    {detail.sourceItems.length === 0 ? <EmptyState title="Belum ada item dari sumber" message="Item muncul setelah sumber diunggah atau item manual ditambahkan." /> : (
                                                        <div className="fi-tablescroll" tabIndex={0} role="group" aria-label="Item dari sumber" style={GULIR_TABEL}>
                                                            <table className="fi-table">
                                                                <caption className="sr-only">Item dari sumber</caption>
                                                                <thead><tr><th scope="col">Sumber</th><th scope="col">Nama barang</th><th scope="col">Isi</th><th scope="col">Gramasi</th><th scope="col">Kemasan</th><th scope="col" className="fi-end">Keyakinan baca</th></tr></thead>
                                                                <tbody>{detail.sourceItems.map((item, index) => (
                                                                    <tr key={index}>
                                                                        <td>{item.sourcePage ? `Hal. ${item.sourcePage}` : item.sourceRow ? `Baris ${item.sourceRow}` : "Manual"}</td>
                                                                        <td>{item.namaBarang}</td><td>{item.isiCtn || ""}</td><td>{item.gramasi || ""}</td><td>{item.kemasan || ""}</td>
                                                                        <td className="fi-end">{Math.round(Number(item.confidence ?? 1) * 100)}%</td>
                                                                    </tr>
                                                                ))}</tbody>
                                                            </table>
                                                        </div>
                                                    )}
                                                </Section>
                                            </>
                                        )}

                                        {tab === "codebook" && (
                                            <Section title="Kamus Kode" subtitle="kemasan selalu mulai dari 1 per KLP"
                                                actions={<Button variant="primary" icon={<Save className="fi-icon" aria-hidden />} onClick={() => setDialog("kamus")}>Simpan kamus…</Button>}>
                                                <div className="fi-sect-in"><p className="fi-small fi-muted">Menyimpan kamus membuat ulang Form Fix dan membatalkan konfirmasi nama lebih dari {NAMA_WIN_MAX} karakter yang lama.</p></div>
                                                {codebookDraft.length === 0 ? <EmptyState title="Kamus Kode masih kosong" message="Kamus terisi setelah sumber diunggah." /> : (
                                                    <div className="fi-tablescroll" tabIndex={0} role="group" aria-label="Kamus Kode" style={GULIR_TABEL}>
                                                        <table className="fi-table">
                                                            <caption className="sr-only">Kamus Kode</caption>
                                                            <thead><tr><th scope="col">Tingkat</th><th scope="col">Cakupan</th><th scope="col">Nama sumber</th><th scope="col">Nama hasil</th><th scope="col">Kode</th></tr></thead>
                                                            <tbody>{codebookDraft.map((entry, index) => (
                                                                <tr key={entry.key}>
                                                                    <td><span className="fi-mono">{entry.level}</span></td>
                                                                    <td className="fi-small">{entry.scope || "Tanpa induk"}</td>
                                                                    <td className="fi-small">{entry.sourceName || "Kosong"}</td>
                                                                    <td><input className="fi-input" style={{ minWidth: "9rem" }} aria-label={`Nama hasil baris ${index + 1}`} value={entry.name} onChange={(event) => setCodebookDraft((rows) => rows.map((row, rowIndex) => rowIndex === index ? { ...row, name: event.target.value.toUpperCase() } : row))} /></td>
                                                                    <td><input className="fi-input fi-mono" style={{ width: "5.5rem" }} aria-label={`Kode baris ${index + 1}`} value={entry.code} onChange={(event) => setCodebookDraft((rows) => rows.map((row, rowIndex) => rowIndex === index ? { ...row, code: event.target.value.replace(/\D/g, "").slice(0, 4) } : row))} /></td>
                                                                </tr>
                                                            ))}</tbody>
                                                        </table>
                                                    </div>
                                                )}
                                            </Section>
                                        )}

                                        {tab === "qc" && (
                                            <Section title="Pemeriksaan QC" subtitle={detail.qc.issues.length ? `${detail.qc.issues.length} temuan` : undefined}>
                                                <div className="fi-sect-in">
                                                    <div className="fi-kcards">
                                                        {kartuQc.map(([label, nilai, tone]) => (
                                                            <div key={label} className="fi-kc" data-tone={nilai > 0 ? tone : undefined}><span>{label}</span><b style={{ fontSize: "1.25rem" }}>{nilai}</b></div>
                                                        ))}
                                                    </div>
                                                    {detail.qc.gramasiNearDup > 0 && (
                                                        <MessageStrip tone="warn" title="Gramasi mirip perlu dikonfirmasi.">
                                                            {detail.qc.gramasiNearDup} pasangan item punya nama sama tetapi gramasinya beda kurang dari 30% (mis. 850 vs 825 GR). Kemungkinan itu perubahan gramasi produk yang sama, bukan SKU baru. Konfirmasi berlaku untuk seluruh revisi; beda 30% atau lebih tidak ditandai. Konfirmasi {gramasi?.count || 0} dari 3.{" "}
                                                            <Button variant="secondary" disabled={Boolean(gramasi?.complete)} busy={busy === "confirm_gramasi"} onClick={() => void catatKonfirmasi("gramasi")}>{gramasi?.complete ? "Konfirmasi selesai" : `Terapkan ke seluruh revisi, tahap ${Math.min(3, (gramasi?.count || 0) + 1)} dari 3`}</Button>
                                                        </MessageStrip>
                                                    )}
                                                    {detail.qc.over50 > 0 && (
                                                        <MessageStrip tone="warn" title={`Batas ${NAMA_WIN_MAX} karakter hanya untuk ditinjau, bukan pemotongan otomatis.`}>
                                                            {detail.qc.over50} item lebih dari {NAMA_WIN_MAX} karakter. Konfirmasi berlaku untuk seluruh revisi, bukan per item. Konfirmasi {len50?.count || 0} dari 3.{" "}
                                                            <Button variant="secondary" disabled={Boolean(len50?.complete)} busy={busy === "confirm_len50"} onClick={() => void catatKonfirmasi("len50")}>{len50?.complete ? "Konfirmasi selesai" : `Terapkan ke seluruh revisi, tahap ${Math.min(3, (len50?.count || 0) + 1)} dari 3`}</Button>
                                                        </MessageStrip>
                                                    )}
                                                </div>
                                                {detail.qc.issues.length === 0 ? <div className="fi-sect-in"><MessageStrip tone="pos" title="Tidak ada temuan QC." /></div> : (
                                                    <div className="fi-tablescroll" tabIndex={0} role="group" aria-label="Temuan QC" style={GULIR_TABEL}>
                                                        <table className="fi-table">
                                                            <caption className="sr-only">Temuan QC</caption>
                                                            <thead><tr><th scope="col">Tingkat</th><th scope="col" className="fi-end">Baris</th><th scope="col">Penjelasan</th></tr></thead>
                                                            <tbody>{detail.qc.issues.map((issue, index) => (
                                                                <tr key={`${issue.code}-${index}`}>
                                                                    <td><span title={issue.code}><StatusBadge tone={nadaTemuan[issue.severity].tone}>{nadaTemuan[issue.severity].label}</StatusBadge></span></td>
                                                                    <td className="fi-end">{issue.row || ""}</td>
                                                                    <td style={{ whiteSpace: "normal" }}>{issue.message}</td>
                                                                </tr>
                                                            ))}</tbody>
                                                        </table>
                                                    </div>
                                                )}
                                            </Section>
                                        )}
                                    </>
                                )}
                        </div>
                    </div>
                )}

                <ConfirmDialog open={dialog === "adaptasi"} onClose={() => setDialog(null)} tag="Adaptasi" tone="negative" title="Adaptasi semua master lama?" confirmLabel="Adaptasi semua master"
                    facts={[["Cakupan", `${masters.length} master`], ["Akibat", "Banyak berkas master ditulis ulang sekaligus"], ["Hasil", "Jumlah file yang diadaptasi, tetap, dan gagal ditampilkan sesudahnya"]]}
                    factsAlign="start" onConfirm={adaptLegacy} />
                <ConfirmDialog open={dialog === "finalisasi" && Boolean(detail)} onClose={() => setDialog(null)} tag="Finalisasi" title={`Finalisasi master ${detail?.principleName ?? ""}?`} confirmLabel="Finalisasi master"
                    facts={detail ? [["Master", `${detail.principleCode} · ${detail.principleName}`], ["Item", `${detail.formRows.length}`], ["Temuan QC", `${detail.qc.errors} error, ${detail.qc.warnings} peringatan`], ["Akibat", "Status master menjadi Siap"]] : []}
                    factsAlign="start" onConfirm={finalize} />
                <ConfirmDialog open={dialog === "kamus" && Boolean(detail)} onClose={() => setDialog(null)} tag="Kamus Kode" title="Simpan Kamus Kode?" confirmLabel="Simpan kamus"
                    facts={detail ? [["Master", `${detail.principleCode} · ${detail.principleName}`], ["Entri", `${codebookDraft.length}`], ["Akibat", "Form Fix dan QC dibuat ulang dari kamus ini"], ["Konfirmasi", `Konfirmasi nama lebih dari ${NAMA_WIN_MAX} karakter yang sudah dicatat dibatalkan`]] : []}
                    factsAlign="start" onConfirm={saveCodebook} />
            </div>
        </FioriScope>
    );
}
