"use client";

/*
 * Tujuan: Laporan klaim (Fiori): rekap dan ekspor CSV pengganti sheet Excel SUMMARY, PAID, dan MONITOR OUTSTANDING.
 *   Tiga bagian (Ringkasan, Pembayaran, Belum lunas) dengan saringan ringan, pratinjau tabel, dan tombol Unduh CSV.
 * Caller: Route `/claim-workflow/reports`.
 * Dependensi: GET /api/claim-workflow/reports/{bagian} dan .../{bagian}/export, komponen Fiori, lib/claim-workflow-ui, lib/tampil.
 * Main Functions: ClaimWorkflowReportsPage, formatCell, buildQueryString.
 * Side Effects: HTTP baca; unduhan CSV dibuat di peramban dari jawaban server. Tanpa grafik dan tanpa alur PEKA (EC/CN).
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { ArrowLeft, Download, RefreshCw } from "lucide-react";
import { FioriScope } from "@/components/fiori/Scope";
import { Button, EmptyState, ErrorState, MessageStrip, Section, Skeleton, StatusBadge } from "@/components/fiori/core";
import { FilterBar, FormField } from "@/components/fiori/interactive";
import { claimWorkflowStatusList } from "@/lib/claim-workflow/constants";
import { statusKlaim } from "@/lib/claim-workflow-ui";
import { KOSONG, sebabHttp, waktuWita } from "@/lib/tampil";

type ReportTab = "summary" | "paid" | "outstanding";

type ReportColumn = { key: string; label: string };

type ReportRow = Record<string, unknown>;

type ReportResult = {
    ok?: boolean;
    error?: string;
    columns?: ReportColumn[];
    rows?: ReportRow[];
    rowCount?: number;
};

type FilterState = {
    status: string;
    principleCode: string;
    dateFrom: string;
    dateTo: string;
    onlyOpen: boolean;
    includeVoided: boolean;
};

const PREVIEW_LIMIT = 200;
const FILTER_AWAL: FilterState = { status: "", principleCode: "", dateFrom: "", dateTo: "", onlyOpen: false, includeVoided: false };
const KOLOM_NOMINAL = new Set([
    "totalDpp", "totalPpn", "totalPph", "totalClaim", "totalPaid",
    "remainingAmount", "paymentAmount", "workflowTotalClaim",
    "workflowTotalPaid", "workflowRemainingAmount",
]);
const KOLOM_WAKTU = new Set(["submittedToPrincipalAt", "closedAt", "createdAt", "voidedAt"]);
const KOLOM_STATUS = new Set(["status", "workflowStatus"]);
// Kolom angka rata kanan dan tabular supaya bisa dibandingkan antarbaris.
const KOLOM_ANGKA = new Set([...KOLOM_NOMINAL, "daysOutstanding", "itemCount"]);

// ponytail: salinan kecil useDebounced milik AturanPromo; modul bersama promo-ui diimpor helper server, jadi tidak diberi hook React.
function useDebounced(value: string, ms: number) {
    const [v, setV] = useState(value);
    useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
    return v;
}

function angka(value: number) {
    return Number(value || 0).toLocaleString("id-ID");
}

function formatCell(column: ReportColumn, raw: unknown): ReactNode {
    if (raw === null || raw === undefined) return KOSONG;
    if (KOLOM_NOMINAL.has(column.key) && typeof raw === "number") {
        return angka(raw);
    }
    if (column.key === "daysOutstanding" && typeof raw === "number") {
        return String(raw);
    }
    if (column.key === "itemCount" && typeof raw === "number") {
        return String(raw);
    }
    if (KOLOM_STATUS.has(column.key)) {
        const s = statusKlaim(String(raw));
        return <StatusBadge tone={s.tone} wrap>{s.label}</StatusBadge>;
    }
    if (KOLOM_WAKTU.has(column.key)) {
        const date = new Date(String(raw));
        if (Number.isNaN(date.getTime())) return String(raw);
        return waktuWita(date);
    }
    return String(raw);
}

function buildQueryString(tab: ReportTab, filters: FilterState): string {
    const params = new URLSearchParams();
    if (filters.status) params.set("status", filters.status);
    if (filters.principleCode.trim()) params.set("principleCode", filters.principleCode.trim());
    if (tab !== "outstanding") {
        if (filters.dateFrom) params.set("dateFrom", filters.dateFrom);
        if (filters.dateTo) params.set("dateTo", filters.dateTo);
    }
    if (tab === "summary" && filters.onlyOpen) params.set("onlyOpen", "true");
    if (tab === "paid" && filters.includeVoided) params.set("includeVoided", "true");
    const qs = params.toString();
    return qs ? `?${qs}` : "";
}

const TAB_LABEL: Record<ReportTab, string> = {
    summary: "Ringkasan",
    paid: "Pembayaran",
    outstanding: "Belum lunas",
};

export default function ClaimWorkflowReportsPage() {
    const [tab, setTab] = useState<ReportTab>("summary");
    const [columns, setColumns] = useState<ReportColumn[]>([]);
    const [rows, setRows] = useState<ReportRow[]>([]);
    const [tabMuat, setTabMuat] = useState<ReportTab | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");
    const [rowCount, setRowCount] = useState(0);
    const [exporting, setExporting] = useState(false);
    const [galatEkspor, setGalatEkspor] = useState("");
    const [pesan, setPesan] = useState("");
    const [filters, setFilters] = useState<FilterState>(FILTER_AWAL);
    const terakhir = useRef(0);

    // Kode principal dijeda: satu permintaan per jeda ketik, dan jawaban lama yang terlambat tidak menimpa yang terbaru.
    const kodeTunda = useDebounced(filters.principleCode, 300);
    const { status, dateFrom, dateTo, onlyOpen, includeVoided } = filters;

    const loadReport = useCallback(async () => {
        const nomor = ++terakhir.current;
        setLoading(true);
        setError("");
        try {
            const qs = buildQueryString(tab, { status, principleCode: kodeTunda, dateFrom, dateTo, onlyOpen, includeVoided });
            const response = await fetch(`/api/claim-workflow/reports/${tab}${qs}`, {
                cache: "no-store",
            });
            const result = (await response.json().catch(() => ({}))) as ReportResult;
            if (nomor !== terakhir.current) return;
            if (!response.ok || !result.ok) {
                throw new Error(result.error || sebabHttp(response.status));
            }
            setColumns(result.columns || []);
            setRows(result.rows || []);
            setRowCount(result.rowCount ?? (result.rows?.length || 0));
            setTabMuat(tab);
        } catch (loadError) {
            if (nomor !== terakhir.current) return;
            setError(loadError instanceof Error && !(loadError instanceof TypeError) ? loadError.message : sebabHttp(0));
            setColumns([]);
            setRows([]);
            setRowCount(0);
            setTabMuat(null);
        } finally {
            if (nomor === terakhir.current) setLoading(false);
        }
    }, [tab, status, kodeTunda, dateFrom, dateTo, onlyOpen, includeVoided]);

    useEffect(() => {
        void loadReport();
    }, [loadReport]);

    const handleExport = async () => {
        setExporting(true);
        setGalatEkspor("");
        setPesan("");
        try {
            const qs = buildQueryString(tab, filters);
            const url = `/api/claim-workflow/reports/${tab}/export${qs}`;
            const response = await fetch(url).catch(() => { throw new Error(sebabHttp(0)); });
            if (!response.ok) {
                let message = sebabHttp(response.status);
                try {
                    const data = (await response.json()) as { error?: string };
                    if (data?.error) message = data.error;
                } catch {
                    // bukan JSON: pakai sebab dari status
                }
                throw new Error(message);
            }
            const blob = await response.blob();
            const objectUrl = URL.createObjectURL(blob);
            const link = document.createElement("a");
            const fileName = response.headers.get("content-disposition")?.match(/filename="?([^";]+)"?/)?.[1]
                || `claim-${tab}-report.csv`;
            link.href = objectUrl;
            link.download = fileName;
            document.body.appendChild(link);
            link.click();
            link.remove();
            URL.revokeObjectURL(objectUrl);
            setPesan(`Unduhan CSV ${TAB_LABEL[tab]} selesai.`);
        } catch (exportError) {
            setGalatEkspor(exportError instanceof Error ? exportError.message : sebabHttp(0));
        } finally {
            setExporting(false);
        }
    };

    const previewRows = useMemo(() => rows.slice(0, PREVIEW_LIMIT), [rows]);
    const truncated = rowCount > previewRows.length;
    const tglDari = tab === "paid" ? "Tanggal bayar dari" : "Dibuat dari";
    const tglSampai = tab === "paid" ? "Tanggal bayar sampai" : "Dibuat sampai";
    const saringAktif = [filters.status, filters.principleCode.trim(), tab !== "outstanding" && (filters.dateFrom || filters.dateTo), tab === "summary" && filters.onlyOpen, tab === "paid" && filters.includeVoided].filter(Boolean).length;
    const adaDataLama = tabMuat === tab && rows.length > 0;

    return (
        <FioriScope>
            <div className="fi-page">
                <header className="fi-page-head">
                    <nav aria-label="Jejak halaman"><ol className="fi-crumb"><li><span>Promo &amp; Klaim</span></li><li><Link href="/claim-workflow">Claim Workflow</Link></li><li><span aria-current="page">Laporan klaim</span></li></ol></nav>
                    <div className="fi-page-bar">
                        <h1>Laporan klaim</h1>
                        <span className="fi-spacer" />
                        <Link className="fi-btn fi-btn--tertiary" href="/off-program-control?tab=claim&claimView=after-finance"><ArrowLeft className="fi-icon" aria-hidden />Kembali ke Validasi Keuangan</Link>
                    </div>
                    <p>Rekap dan ekspor CSV pengganti sheet Excel SUMMARY, PAID, dan MONITOR OUTSTANDING. Pilih bagian, atur saringan, lalu unduh CSV.</p>
                </header>

                <div className="fi-segs" role="group" aria-label="Jenis laporan">
                    {(Object.keys(TAB_LABEL) as ReportTab[]).map((option) => (
                        <button key={option} type="button" aria-pressed={tab === option} onClick={() => setTab(option)}>{TAB_LABEL[option]}</button>
                    ))}
                </div>

                <div className="fi-panel" style={{ padding: 0, overflow: "clip" }}>
                    <FilterBar title="Saringan" activeCount={saringAktif} onReset={() => setFilters(FILTER_AWAL)}
                        actions={<>
                            <Button icon={<RefreshCw className="fi-icon" aria-hidden />} busy={loading} onClick={() => void loadReport()}>Muat ulang</Button>
                            <Button variant="primary" icon={<Download className="fi-icon" aria-hidden />} busy={exporting} onClick={() => void handleExport()}>{`Unduh CSV ${TAB_LABEL[tab]}`}</Button>
                        </>}
                        search={<FormField label="Kode principal">{(a11y) => <input {...a11y} className="fi-input fi-mono" type="text" value={filters.principleCode} placeholder="mis. PA" onChange={(event) => setFilters({ ...filters, principleCode: event.target.value })} />}</FormField>}
                        fields={<>
                            <FormField label="Status">{(a11y) => (
                                <select {...a11y} className="fi-input" value={filters.status} onChange={(event) => setFilters({ ...filters, status: event.target.value })}>
                                    <option value="">Semua</option>
                                    {claimWorkflowStatusList.map((s) => <option key={s} value={s}>{statusKlaim(s).label}</option>)}
                                </select>
                            )}</FormField>
                            {tab !== "outstanding" && (
                                <>
                                    <FormField label={tglDari}>{(a11y) => <input {...a11y} className="fi-input" type="date" value={filters.dateFrom} onChange={(event) => setFilters({ ...filters, dateFrom: event.target.value })} />}</FormField>
                                    <FormField label={tglSampai}>{(a11y) => <input {...a11y} className="fi-input" type="date" value={filters.dateTo} onChange={(event) => setFilters({ ...filters, dateTo: event.target.value })} />}</FormField>
                                </>
                            )}
                            {tab === "summary" && (
                                <label className="fi-check"><input type="checkbox" checked={filters.onlyOpen} onChange={(event) => setFilters({ ...filters, onlyOpen: event.target.checked })} />Hanya klaim terbuka (belum Lunas, Ditutup, atau Dibatalkan)</label>
                            )}
                            {tab === "paid" && (
                                <label className="fi-check"><input type="checkbox" checked={filters.includeVoided} onChange={(event) => setFilters({ ...filters, includeVoided: event.target.checked })} />Sertakan pembayaran yang dibatalkan</label>
                            )}
                        </>}
                        chips={[
                            ...(filters.status ? [{ label: `Status: ${statusKlaim(filters.status).label}`, onRemove: () => setFilters({ ...filters, status: "" }) }] : []),
                            ...(filters.principleCode.trim() ? [{ label: `Kode principal: ${filters.principleCode.trim()}`, onRemove: () => setFilters({ ...filters, principleCode: "" }) }] : []),
                            ...(tab !== "outstanding" && (filters.dateFrom || filters.dateTo) ? [{ label: `${tab === "paid" ? "Tanggal bayar" : "Dibuat"}: ${filters.dateFrom || "..."} sampai ${filters.dateTo || "..."}`, onRemove: () => setFilters({ ...filters, dateFrom: "", dateTo: "" }) }] : []),
                            ...(tab === "summary" && filters.onlyOpen ? [{ label: "Hanya klaim terbuka", onRemove: () => setFilters({ ...filters, onlyOpen: false }) }] : []),
                            ...(tab === "paid" && filters.includeVoided ? [{ label: "Termasuk pembayaran dibatalkan", onRemove: () => setFilters({ ...filters, includeVoided: false }) }] : []),
                        ]} />
                </div>

                {pesan && <MessageStrip tone="pos" title={pesan} onClose={() => setPesan("")} />}
                {galatEkspor && <MessageStrip tone="neg" title="Unduhan CSV belum berhasil." onClose={() => setGalatEkspor("")}>{galatEkspor}</MessageStrip>}

                <Section title={`Pratinjau ${TAB_LABEL[tab].toLowerCase()}`} subtitle={loading ? "memuat..." : error ? undefined : `${rowCount} baris. Tabel menampilkan paling banyak ${PREVIEW_LIMIT} baris pertama; unduhan CSV memuat seluruh data.`}>
                    {truncated && !loading && (
                        <div className="fi-sect-in"><MessageStrip tone="warn" title={`Tabel hanya menampilkan ${previewRows.length} dari ${rowCount} baris.`}>Pakai tombol Unduh CSV untuk data lengkap.</MessageStrip></div>
                    )}
                    {loading && !adaDataLama ? <div className="fi-sect-in"><Skeleton rows={5} label="Memuat laporan" /></div>
                        : error ? <ErrorState title="Laporan gagal dimuat" message={error} onRetry={() => void loadReport()} />
                        : rows.length === 0 ? <EmptyState title="Tidak ada data untuk saringan ini" message="Ubah atau hapus saringan." />
                        : (
                            <div className={`min-w-0${loading ? " fi-busy" : ""}`} aria-busy={loading || undefined}>
                                <div className="fi-tablescroll" tabIndex={0} role="group" aria-label={`Pratinjau laporan klaim ${TAB_LABEL[tab].toLowerCase()}`} style={{ maxHeight: "640px", position: "relative" }}>
                                    <table className="fi-table">
                                        <caption className="sr-only">{`Pratinjau laporan klaim ${TAB_LABEL[tab].toLowerCase()}`}</caption>
                                        <thead>
                                            <tr>
                                                {columns.map((col) => (
                                                    <th key={col.key} scope="col" className={KOLOM_ANGKA.has(col.key) ? "fi-end" : undefined}>{col.label}</th>
                                                ))}
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {previewRows.map((row, idx) => {
                                                const rowKey = String(row.paymentId || row.claimWorkflowNo || `${tab}-${idx}`);
                                                return (
                                                    <tr key={rowKey}>
                                                        {columns.map((col) => (
                                                            <td key={col.key} className={KOLOM_ANGKA.has(col.key) ? "fi-end" : undefined} style={{ whiteSpace: "nowrap", verticalAlign: "top" }}>
                                                                {formatCell(col, row[col.key])}
                                                            </td>
                                                        ))}
                                                    </tr>
                                                );
                                            })}
                                        </tbody>
                                    </table>
                                </div>
                            </div>
                        )}
                </Section>
            </div>
        </FioriScope>
    );
}
