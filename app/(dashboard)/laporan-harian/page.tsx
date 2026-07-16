/*
 * Tujuan: UI Laporan Harian SPV/SM/principal untuk upload, ringkasan, review file opsional, dan kirim email.
 * Caller: menu sidebar "Laporan Harian" (/laporan-harian). Guard RBAC: laporan_harian.view.
 * Dependensi: POST /api/laporan-harian/upload, GET /api/laporan-harian/[runId]/preview,
 *             POST /api/laporan-harian/[runId]/send, lucide-react, semantic UI classes global.
 * Main Functions: LaporanHarianPage, FilePicker, handleUpload, loadReview, handleSend.
 * Side Effects: HTTP upload/read/send; tidak menyimpan state di localStorage.
 */
"use client";

import { useState } from "react";
import {
    AlertTriangle,
    CheckCircle2,
    ChevronDown,
    Download,
    FileSearch,
    FileSpreadsheet,
    Send,
    UploadCloud,
} from "lucide-react";

type Summary = { spv: string; rows: number; dpp: number; ao: number; ec: number; ia: number };
type Recipient = { keyword: string; groupType: string; fileName: string; emails: string[] };
type GeneratedFile = { keyword: string; groupType: string; fileName: string; rows: number; stockRows: number };
type ReviewSample = { fileName: string; sheetName: string; columns: string[]; rows: unknown[][] };
type UploadResult = {
    ok: boolean;
    runId: string;
    period: { month: number; year: number };
    dashboardFed: { inserted: number };
    salesRows: number;
    netDpp: number;
    summary: Summary[];
    recipientsPreview: Recipient[];
    totalRecipients: number;
    generatedFiles: GeneratedFile[];
    unmatchedReportKeywords?: string[];
    unmappedProgress?: { rows: number; achievedValueDpp: number; branches: string[] };
};

type FilePickerProps = {
    id: string;
    label: string;
    helper: string;
    required?: boolean;
    file: File | null;
    onChange: (file: File | null) => void;
};

const rupiah = (value: number) => `Rp ${Math.round(value).toLocaleString("id-ID")}`;

function FilePicker({ id, label, helper, required, file, onChange }: FilePickerProps) {
    return (
        <label
            htmlFor={id}
            className="group flex min-h-32 cursor-pointer flex-col justify-between rounded-xl border border-[var(--border-strong)] bg-[var(--surface-2)] p-4 transition-colors hover:border-[var(--luxury-teal)]"
        >
            <input
                id={id}
                type="file"
                accept=".xlsx"
                className="sr-only"
                onChange={(event) => onChange(event.target.files?.[0] ?? null)}
            />
            <span className="flex items-start justify-between gap-3">
                <span>
                    <span className="block text-sm font-bold text-[var(--luxury-text)]">{label}</span>
                    <span className="mt-1 block text-xs leading-5 text-[var(--luxury-muted)]">{helper}</span>
                </span>
                <UploadCloud className="shrink-0 text-[var(--luxury-teal)]" size={20} aria-hidden="true" />
            </span>
            <span className="mt-4 flex min-w-0 items-center gap-2 text-xs font-semibold text-[var(--luxury-text)]">
                <FileSpreadsheet size={16} className="shrink-0 text-[var(--luxury-muted)]" aria-hidden="true" />
                <span className="truncate">{file?.name ?? (required ? "Pilih file XLSX" : "Tidak dipilih")}</span>
            </span>
        </label>
    );
}

function reviewValue(value: unknown, column: string): string {
    if (value === null || value === undefined || value === "") return "-";
    if (["DPP"].includes(column) && Number.isFinite(Number(value))) return rupiah(Number(value));
    if (["QTY"].includes(column) && Number.isFinite(Number(value))) return Number(value).toLocaleString("id-ID");
    return String(value);
}

export default function LaporanHarianPage() {
    const [penjualan, setPenjualan] = useState<File | null>(null);
    const [retur, setRetur] = useState<File | null>(null);
    const [stock, setStock] = useState<File | null>(null);
    const [processing, setProcessing] = useState(false);
    const [sending, setSending] = useState(false);
    const [result, setResult] = useState<UploadResult | null>(null);
    const [sendState, setSendState] = useState<{ status: string; sent?: number; failed?: number } | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [reviewOpen, setReviewOpen] = useState(false);
    const [reviewBusy, setReviewBusy] = useState(false);
    const [reviewError, setReviewError] = useState<string | null>(null);
    const [reviewFileName, setReviewFileName] = useState("");
    const [review, setReview] = useState<ReviewSample | null>(null);

    const busy = processing || sending;

    async function handleUpload() {
        if (!penjualan) {
            setError("Pilih file Penjualan terlebih dahulu.");
            return;
        }
        setError(null);
        setResult(null);
        setSendState(null);
        setReview(null);
        setReviewOpen(false);
        setProcessing(true);
        try {
            const form = new FormData();
            form.append("penjualan", penjualan);
            if (retur) form.append("retur", retur);
            if (stock) form.append("stock", stock);
            const response = await fetch("/api/laporan-harian/upload", { method: "POST", body: form });
            const data = await response.json();
            if (!response.ok || !data.ok) {
                setError([data.error, data.detail].filter(Boolean).join(": ") || "Proses gagal");
                return;
            }
            const uploaded = data as UploadResult;
            setResult(uploaded);
            setReviewFileName(uploaded.generatedFiles?.[0]?.fileName ?? "");
        } catch (uploadError) {
            setError(`Gagal upload atau memproses laporan: ${String(uploadError)}`);
        } finally {
            setProcessing(false);
        }
    }

    async function loadReview(fileName: string) {
        if (!result || !fileName) return;
        setReviewOpen(true);
        setReviewBusy(true);
        setReviewError(null);
        setReviewFileName(fileName);
        try {
            const response = await fetch(
                `/api/laporan-harian/${result.runId}/preview?file=${encodeURIComponent(fileName)}`,
            );
            const data = await response.json();
            if (!response.ok) {
                setReviewError(data.error || "Review file gagal dimuat");
                setReview(null);
                return;
            }
            setReview(data as ReviewSample);
        } catch (loadError) {
            setReviewError(`Review file gagal dimuat: ${String(loadError)}`);
            setReview(null);
        } finally {
            setReviewBusy(false);
        }
    }

    async function handleSend() {
        if (!result) return;
        if (!confirm(`Kirim ${result.totalRecipients} email untuk ${result.recipientsPreview.length} file?\nEmail akan benar-benar dikirim.`)) return;
        setSending(true);
        setError(null);
        try {
            const response = await fetch(`/api/laporan-harian/${result.runId}/send`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ confirm: true }),
            });
            const data = await response.json();
            if (!response.ok) {
                setError(data.error || "Pengiriman email gagal");
                return;
            }
            setSendState({ status: data.status, sent: data.emailsSent, failed: data.emailsFailed });
        } catch (sendError) {
            setError(`Pengiriman email gagal: ${String(sendError)}`);
        } finally {
            setSending(false);
        }
    }

    return (
        <main className="ui-page-shell ui-page-shell--standard space-y-5" aria-busy={busy}>
            <header className="ui-page-header">
                <div className="ui-page-heading">
                    <h1 className="ui-page-title">Laporan Harian SPV, SM, dan Principal</h1>
                    <p className="ui-page-description">
                        Unggah laporan Accurate, periksa ringkasan dan file hasil bila diperlukan, lalu kirim email setelah konfirmasi.
                    </p>
                </div>
            </header>

            <section className="ui-surface-panel ui-panel-padding" aria-labelledby="laporan-upload-title">
                <div className="mb-5 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
                    <div>
                        <h2 id="laporan-upload-title" className="text-base font-extrabold text-[var(--luxury-text)]">Sumber laporan</h2>
                        <p className="mt-1 text-sm text-[var(--luxury-muted)]">Penjualan wajib. Retur dan stock dapat dikosongkan.</p>
                    </div>
                    <span className="text-xs font-semibold text-[var(--luxury-muted)]">Format XLSX</span>
                </div>

                <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                    <FilePicker id="laporan-penjualan" label="Penjualan" helper="Rincian faktur penjualan INV" required file={penjualan} onChange={setPenjualan} />
                    <FilePicker id="laporan-retur" label="Retur" helper="Rincian retur penjualan RJN" file={retur} onChange={setRetur} />
                    <FilePicker id="laporan-stock" label="Stock" helper="Kuantitas barang per gudang" file={stock} onChange={setStock} />
                </div>

                <div className="mt-5 flex flex-wrap items-center gap-3">
                    <button onClick={handleUpload} disabled={busy || !penjualan} className="ui-button-primary min-h-11 px-4">
                        <UploadCloud size={17} aria-hidden="true" />
                        {processing ? "Memproses laporan..." : "Proses dan perbarui dashboard"}
                    </button>
                    {processing && <span className="text-sm text-[var(--luxury-muted)]">File sedang diproses. Jangan tutup halaman.</span>}
                </div>
                {error && <p className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700" role="alert">{error}</p>}
            </section>

            {result && (
                <>
                    <section className="ui-surface-panel overflow-hidden" aria-labelledby="laporan-result-title">
                        <div className="ui-panel-padding flex flex-col gap-4 border-b border-[var(--border-soft)] lg:flex-row lg:items-center lg:justify-between">
                            <div className="flex items-start gap-3">
                                <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-emerald-50 text-emerald-700">
                                    <CheckCircle2 size={21} aria-hidden="true" />
                                </span>
                                <div>
                                    <h2 id="laporan-result-title" className="font-extrabold text-[var(--luxury-text)]">Pengolahan selesai</h2>
                                    <p className="mt-1 text-sm text-[var(--luxury-muted)]">Dashboard sudah diperbarui. Email belum dikirim.</p>
                                </div>
                            </div>
                            <div className="flex flex-wrap gap-2">
                                <button
                                    onClick={() => reviewOpen ? setReviewOpen(false) : void loadReview(reviewFileName || result.generatedFiles?.[0]?.fileName)}
                                    disabled={!result.generatedFiles?.length || reviewBusy}
                                    className="ui-button-secondary min-h-11"
                                    aria-expanded={reviewOpen}
                                >
                                    <FileSearch size={17} aria-hidden="true" />
                                    {reviewOpen ? "Tutup review" : "Review hasil"}
                                </button>
                                <button
                                    onClick={handleSend}
                                    disabled={busy || result.totalRecipients === 0 || sendState?.status === "sent"}
                                    className="ui-button-primary min-h-11 px-4"
                                >
                                    <Send size={17} aria-hidden="true" />
                                    {sending ? "Mengirim email..." : `Kirim ${result.totalRecipients} email`}
                                </button>
                            </div>
                        </div>

                        <div className="grid grid-cols-2 divide-x divide-y divide-[var(--border-soft)] sm:grid-cols-4 sm:divide-y-0">
                            <div className="p-4">
                                <p className="text-xs font-semibold text-[var(--luxury-muted)]">Periode</p>
                                <p className="mt-1 text-lg font-extrabold tabular-nums text-[var(--luxury-text)]">{result.period.month}/{result.period.year}</p>
                            </div>
                            <div className="p-4">
                                <p className="text-xs font-semibold text-[var(--luxury-muted)]">Baris penjualan</p>
                                <p className="mt-1 text-lg font-extrabold tabular-nums text-[var(--luxury-text)]">{result.salesRows.toLocaleString("id-ID")}</p>
                            </div>
                            <div className="p-4">
                                <p className="text-xs font-semibold text-[var(--luxury-muted)]">Net DPP</p>
                                <p className="mt-1 text-lg font-extrabold tabular-nums text-[var(--luxury-text)]">{rupiah(result.netDpp)}</p>
                            </div>
                            <div className="p-4">
                                <p className="text-xs font-semibold text-[var(--luxury-muted)]">Progress tersimpan</p>
                                <p className="mt-1 text-lg font-extrabold tabular-nums text-[var(--luxury-text)]">{result.dashboardFed.inserted.toLocaleString("id-ID")}</p>
                            </div>
                        </div>
                    </section>

                    {!!result.unmappedProgress?.rows && (
                        <div className="flex items-start gap-3 rounded-xl border border-amber-300 bg-amber-50 p-4 text-amber-900" role="status">
                            <AlertTriangle className="mt-0.5 shrink-0" size={18} aria-hidden="true" />
                            <div className="text-sm leading-6">
                                <p className="font-bold">Ada data tanpa kode salesman</p>
                                <p>
                                    {result.unmappedProgress.rows.toLocaleString("id-ID")} baris agregat senilai {rupiah(result.unmappedProgress.achievedValueDpp)} disimpan sebagai UNMAPPED untuk {result.unmappedProgress.branches.join(", ")}.
                                    Nilai ini belum dialokasikan ke pencapaian salesman.
                                </p>
                            </div>
                        </div>
                    )}

                    {!!result.unmatchedReportKeywords?.length && (
                        <div className="flex items-start gap-3 rounded-xl border border-amber-300 bg-amber-50 p-4 text-amber-900" role="status">
                            <AlertTriangle className="mt-0.5 shrink-0" size={18} aria-hidden="true" />
                            <div className="text-sm leading-6">
                                <p className="font-bold">Ada target laporan yang belum dikenali</p>
                                <p>
                                    Periksa mapping keyword berikut: {result.unmatchedReportKeywords.join(", ")}.
                                    File dan email untuk target tersebut belum disiapkan.
                                </p>
                            </div>
                        </div>
                    )}

                    {reviewOpen && (
                        <section className="ui-surface-panel ui-panel-padding space-y-4" aria-labelledby="laporan-review-title">
                            <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
                                <div>
                                    <h2 id="laporan-review-title" className="text-base font-extrabold text-[var(--luxury-text)]">Review hasil pengolahan</h2>
                                    <p className="mt-1 text-sm text-[var(--luxury-muted)]">Opsional. Periksa 25 baris pertama atau unduh Excel lengkap.</p>
                                </div>
                                <div className="flex w-full flex-col gap-2 sm:flex-row lg:w-auto">
                                    <label className="sr-only" htmlFor="review-file">Pilih file hasil</label>
                                    <select
                                        id="review-file"
                                        value={reviewFileName}
                                        onChange={(event) => void loadReview(event.target.value)}
                                        className="min-h-11 min-w-64 rounded-lg border border-[var(--border-strong)] bg-[var(--surface)] px-3 text-sm text-[var(--luxury-text)]"
                                    >
                                        {result.generatedFiles.map((file) => (
                                            <option key={file.fileName} value={file.fileName}>
                                                {file.keyword} · {file.groupType.toUpperCase()} ({file.rows.toLocaleString("id-ID")} baris)
                                            </option>
                                        ))}
                                    </select>
                                    {reviewFileName && (
                                        <a
                                            href={`/api/laporan-harian/${result.runId}/preview?file=${encodeURIComponent(reviewFileName)}&download=1`}
                                            className="ui-button-secondary min-h-11"
                                        >
                                            <Download size={17} aria-hidden="true" /> Unduh Excel
                                        </a>
                                    )}
                                </div>
                            </div>

                            {reviewBusy && <div className="ui-state-panel min-h-32 text-sm text-[var(--luxury-muted)]">Memuat contoh file...</div>}
                            {reviewError && <p className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700" role="alert">{reviewError}</p>}
                            {!reviewBusy && review && (
                                <div className="ui-table-frame max-h-[28rem]">
                                    <table className="ui-data-table min-w-max text-xs">
                                        <caption className="sr-only">Contoh 25 baris pertama dari {review.fileName}</caption>
                                        <thead><tr>{review.columns.map((column) => <th key={column}>{column.replaceAll("_", " ")}</th>)}</tr></thead>
                                        <tbody>
                                            {review.rows.map((row, rowIndex) => (
                                                <tr key={rowIndex}>
                                                    {review.columns.map((column, columnIndex) => (
                                                        <td key={`${rowIndex}-${column}`} className="max-w-64 truncate" title={reviewValue(row[columnIndex], column)}>
                                                            {reviewValue(row[columnIndex], column)}
                                                        </td>
                                                    ))}
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            )}
                        </section>
                    )}

                    <details className="ui-surface-panel overflow-hidden" open>
                        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-5 py-4 text-sm font-extrabold text-[var(--luxury-text)]">
                            Ringkasan per SPV
                            <ChevronDown size={18} className="text-[var(--luxury-muted)]" aria-hidden="true" />
                        </summary>
                        <div className="border-t border-[var(--border-soft)] p-3 sm:p-5">
                            <div className="ui-table-frame">
                                <table className="ui-data-table min-w-[42rem]">
                                    <caption className="sr-only">Ringkasan laporan harian per SPV</caption>
                                    <thead><tr><th className="text-left">SPV</th><th className="text-right">Baris</th><th className="text-right">DPP</th><th className="text-right">AO</th><th className="text-right">EC</th><th className="text-right">Item aktif</th></tr></thead>
                                    <tbody>
                                        {result.summary.map((item) => (
                                            <tr key={item.spv}>
                                                <td className="font-bold">{item.spv}</td>
                                                <td className="text-right">{item.rows.toLocaleString("id-ID")}</td>
                                                <td className="text-right">{rupiah(item.dpp)}</td>
                                                <td className="text-right">{item.ao.toLocaleString("id-ID")}</td>
                                                <td className="text-right">{item.ec.toLocaleString("id-ID")}</td>
                                                <td className="text-right">{item.ia.toLocaleString("id-ID")}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        </div>
                    </details>

                    <details className="ui-surface-panel overflow-hidden">
                        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-5 py-4 text-sm font-extrabold text-[var(--luxury-text)]">
                            <span>Penerima email <span className="font-semibold text-[var(--luxury-muted)]">({result.totalRecipients} alamat, belum dikirim)</span></span>
                            <ChevronDown size={18} className="text-[var(--luxury-muted)]" aria-hidden="true" />
                        </summary>
                        <div className="border-t border-[var(--border-soft)] p-3 sm:p-5">
                            <div className="ui-table-frame max-h-80">
                                <table className="ui-data-table min-w-[42rem]">
                                    <caption className="sr-only">Daftar file dan penerima email</caption>
                                    <thead><tr><th className="text-left">File</th><th className="text-left">Target</th><th className="text-left">Email</th></tr></thead>
                                    <tbody>
                                        {result.recipientsPreview.map((recipient, index) => (
                                            <tr key={`${recipient.fileName}-${index}`}>
                                                <td>{recipient.fileName}</td>
                                                <td className="font-bold">{recipient.keyword} · {recipient.groupType.toUpperCase()}</td>
                                                <td>{recipient.emails.join(", ")}</td>
                                            </tr>
                                        ))}
                                        {result.recipientsPreview.length === 0 && (
                                            <tr><td colSpan={3} className="text-[var(--luxury-muted)]">Tidak ada penerima yang cocok. Periksa keyword penerima.</td></tr>
                                        )}
                                    </tbody>
                                </table>
                            </div>
                        </div>
                    </details>

                    {sendState && (
                        <div className="flex items-center gap-3 rounded-xl border border-[var(--border-strong)] bg-[var(--surface)] p-4 text-sm text-[var(--luxury-text)]" role="status">
                            <CheckCircle2 size={18} className="text-[var(--luxury-teal)]" aria-hidden="true" />
                            <span>Status <b>{sendState.status}</b>. Terkirim {sendState.sent ?? 0}{sendState.failed ? `, gagal ${sendState.failed}` : ""}.</span>
                        </div>
                    )}
                </>
            )}
        </main>
    );
}
