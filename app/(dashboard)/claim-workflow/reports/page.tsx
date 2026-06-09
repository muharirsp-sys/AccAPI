"use client";

/*
 * Tujuan: UI Phase R5 Reporting / Export — tab Summary, Paid, Outstanding
 *         dengan filter ringan + tombol export CSV.
 * Caller: Route `/claim-workflow/reports`.
 * Catatan:
 *   - Tidak ada chart/dashboard berat. Hanya tabel preview + CSV.
 *   - Tidak ada PEKA/EC/CN.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import {
  claimWorkflowStatusList,
  displayClaimStatusLabel,
} from "@/lib/claim-workflow/constants";

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

function rupiah(value: number) {
  return Number(value || 0).toLocaleString("id-ID");
}

function formatCell(column: ReportColumn, raw: unknown): string {
  if (raw === null || raw === undefined) return "-";
  const numericKeys = new Set([
    "totalDpp", "totalPpn", "totalPph", "totalClaim", "totalPaid",
    "remainingAmount", "paymentAmount", "workflowTotalClaim",
    "workflowTotalPaid", "workflowRemainingAmount",
  ]);
  if (numericKeys.has(column.key) && typeof raw === "number") {
    return rupiah(raw);
  }
  if (column.key === "daysOutstanding" && typeof raw === "number") {
    return String(raw);
  }
  if (column.key === "itemCount" && typeof raw === "number") {
    return String(raw);
  }
  if (column.key === "status" || column.key === "workflowStatus") {
    return displayClaimStatusLabel(String(raw));
  }
  if (
    column.key === "submittedToPrincipalAt" ||
    column.key === "closedAt" ||
    column.key === "createdAt" ||
    column.key === "voidedAt"
  ) {
    const date = new Date(String(raw));
    if (Number.isNaN(date.getTime())) return String(raw);
    return new Intl.DateTimeFormat("id-ID", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(date);
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
  summary: "Summary",
  paid: "Paid",
  outstanding: "Outstanding",
};

export default function ClaimWorkflowReportsPage() {
  const [tab, setTab] = useState<ReportTab>("summary");
  const [columns, setColumns] = useState<ReportColumn[]>([]);
  const [rows, setRows] = useState<ReportRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [rowCount, setRowCount] = useState(0);
  const [exporting, setExporting] = useState(false);
  const [filters, setFilters] = useState<FilterState>({
    status: "",
    principleCode: "",
    dateFrom: "",
    dateTo: "",
    onlyOpen: false,
    includeVoided: false,
  });

  const loadReport = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const qs = buildQueryString(tab, filters);
      const response = await fetch(`/api/claim-workflow/reports/${tab}${qs}`, {
        cache: "no-store",
      });
      const result = (await response.json()) as ReportResult;
      if (!response.ok || !result.ok) {
        throw new Error(result.error || "Gagal memuat report.");
      }
      setColumns(result.columns || []);
      setRows(result.rows || []);
      setRowCount(result.rowCount ?? (result.rows?.length || 0));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Gagal memuat report.");
      setColumns([]);
      setRows([]);
      setRowCount(0);
    } finally {
      setLoading(false);
    }
  }, [tab, filters]);

  useEffect(() => {
    void loadReport();
  }, [loadReport]);

  const handleExport = async () => {
    setExporting(true);
    try {
      const qs = buildQueryString(tab, filters);
      const url = `/api/claim-workflow/reports/${tab}/export${qs}`;
      const response = await fetch(url);
      if (!response.ok) {
        let message = "Gagal export CSV.";
        try {
          const data = (await response.json()) as { error?: string };
          if (data?.error) message = data.error;
        } catch {
          // ignore non-JSON body
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
      toast.success(`Export CSV ${TAB_LABEL[tab]} selesai.`);
    } catch (exportError) {
      const message = exportError instanceof Error ? exportError.message : "Gagal export CSV.";
      toast.error(message);
      setError(message);
    } finally {
      setExporting(false);
    }
  };

  const previewRows = useMemo(() => rows.slice(0, PREVIEW_LIMIT), [rows]);
  const truncated = rowCount > previewRows.length;

  return (
    <div className="w-full space-y-6 pb-12 pt-2">
      <div className="rounded-3xl border border-white/10 bg-gradient-to-br from-[#1a1c23] to-[#0f1115] p-7 shadow-2xl">
        <p className="text-xs font-bold uppercase tracking-[0.24em] text-indigo-300">
          Phase R5 — Reporting / Export
        </p>
        <h1 className="mt-3 text-3xl font-black tracking-tight text-white">
          Claim Workflow Reports
        </h1>
        <p className="mt-2 max-w-3xl text-sm leading-relaxed text-slate-400">
          Recap dan ekspor CSV menggantikan sheet Excel SUMMARY, PAID, dan
          MONITOR OUTSTANDING. Pilih tab di bawah, atur filter, lalu klik
          Export CSV untuk download.
        </p>
        <div className="mt-4">
          <Link
            href="/off-program-control?tab=claim&claimView=after-finance"
            className="text-xs font-semibold text-indigo-300 hover:text-indigo-200"
          >
            ← Kembali ke Validasi Keuangan
          </Link>
        </div>
      </div>

      <section className="rounded-2xl border border-white/10 bg-[#1a1c23] p-5">
        <div className="flex flex-wrap items-center gap-2">
          {(Object.keys(TAB_LABEL) as ReportTab[]).map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => setTab(option)}
              className={`rounded-full px-4 py-2 text-xs font-bold transition ${
                tab === option
                  ? "bg-indigo-600 text-white"
                  : "border border-white/10 bg-black/30 text-slate-300 hover:bg-white/10"
              }`}
            >
              {TAB_LABEL[option]}
            </button>
          ))}
        </div>

        <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="flex flex-col gap-1 text-xs font-semibold text-slate-300">
            Status
            <select
              value={filters.status}
              onChange={(event) => setFilters({ ...filters, status: event.target.value })}
              className="rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-white outline-none transition focus:border-indigo-500/60"
            >
              <option value="">Semua</option>
              {claimWorkflowStatusList.map((status) => (
                <option key={status} value={status}>
                  {status}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs font-semibold text-slate-300">
            Principle Code
            <input
              type="text"
              value={filters.principleCode}
              onChange={(event) => setFilters({ ...filters, principleCode: event.target.value })}
              placeholder="Contoh: GDI"
              className="rounded-lg border border-white/10 bg-black/40 px-3 py-2 font-mono text-sm uppercase text-white outline-none transition focus:border-indigo-500/60"
            />
          </label>
          {tab !== "outstanding" && (
            <>
              <label className="flex flex-col gap-1 text-xs font-semibold text-slate-300">
                {tab === "paid" ? "Payment Date From" : "Created From"}
                <input
                  type="date"
                  value={filters.dateFrom}
                  onChange={(event) => setFilters({ ...filters, dateFrom: event.target.value })}
                  className="rounded-lg border border-white/10 bg-black/40 px-3 py-2 font-mono text-sm text-white outline-none transition focus:border-indigo-500/60"
                />
              </label>
              <label className="flex flex-col gap-1 text-xs font-semibold text-slate-300">
                {tab === "paid" ? "Payment Date To" : "Created To"}
                <input
                  type="date"
                  value={filters.dateTo}
                  onChange={(event) => setFilters({ ...filters, dateTo: event.target.value })}
                  className="rounded-lg border border-white/10 bg-black/40 px-3 py-2 font-mono text-sm text-white outline-none transition focus:border-indigo-500/60"
                />
              </label>
            </>
          )}
          {tab === "summary" && (
            <label className="flex items-center gap-2 text-xs font-semibold text-slate-300">
              <input
                type="checkbox"
                checked={filters.onlyOpen}
                onChange={(event) => setFilters({ ...filters, onlyOpen: event.target.checked })}
                className="h-4 w-4 rounded border-white/20 bg-black/40 text-indigo-500"
              />
              Hanya workflow open (belum Paid/Closed/Cancelled)
            </label>
          )}
          {tab === "paid" && (
            <label className="flex items-center gap-2 text-xs font-semibold text-slate-300">
              <input
                type="checkbox"
                checked={filters.includeVoided}
                onChange={(event) => setFilters({ ...filters, includeVoided: event.target.checked })}
                className="h-4 w-4 rounded border-white/20 bg-black/40 text-indigo-500"
              />
              Sertakan pembayaran voided
            </label>
          )}
        </div>

        <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-slate-500">
            {loading
              ? "Memuat report..."
              : `${rowCount} baris — preview maksimal ${PREVIEW_LIMIT} baris pertama. Export CSV mencakup seluruh data.`}
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void loadReport()}
              disabled={loading}
              className="rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs font-bold text-slate-200 transition hover:bg-white/10 disabled:opacity-50"
            >
              {loading ? "Memuat..." : "Refresh"}
            </button>
            <button
              type="button"
              onClick={() => void handleExport()}
              disabled={exporting}
              className="rounded-lg bg-emerald-600 px-4 py-2 text-xs font-bold text-white transition hover:bg-emerald-500 disabled:opacity-50"
            >
              {exporting ? "Exporting..." : `Export CSV ${TAB_LABEL[tab]}`}
            </button>
          </div>
        </div>

        {error && (
          <div className="mt-4 rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-xs text-rose-200">
            {error}
          </div>
        )}
      </section>

      <section className="overflow-hidden rounded-2xl border border-white/10 bg-[#1a1c23] shadow-lg shadow-black/20">
        <div className="border-b border-white/10 px-5 py-3">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-indigo-300">
            Preview {TAB_LABEL[tab]}
          </p>
          {truncated && (
            <p className="mt-1 text-[11px] text-amber-200">
              Tabel hanya menampilkan {previewRows.length} dari {rowCount} baris. Gunakan tombol Export CSV untuk dataset lengkap.
            </p>
          )}
        </div>
        {loading ? (
          <div className="px-5 py-12 text-center text-sm text-slate-400">Memuat data...</div>
        ) : rows.length === 0 ? (
          <div className="px-5 py-12 text-center text-sm text-slate-500">
            Tidak ada data untuk filter saat ini.
          </div>
        ) : (
          <div className="max-h-[640px] overflow-auto">
            <table className="min-w-full text-left text-sm">
              <thead className="sticky top-0 z-10 bg-[#1a1c23]/95 text-xs uppercase tracking-wider text-slate-500 backdrop-blur">
                <tr className="border-b border-white/10">
                  {columns.map((col) => (
                    <th key={col.key} scope="col" className="whitespace-nowrap px-4 py-3 font-semibold">
                      {col.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {previewRows.map((row, idx) => {
                  const rowKey = String(row.paymentId || row.claimWorkflowNo || `${tab}-${idx}`);
                  return (
                    <tr key={rowKey} className="text-slate-300 hover:bg-white/[0.04]">
                      {columns.map((col) => (
                        <td
                          key={col.key}
                          className="whitespace-nowrap px-4 py-2 align-top text-xs"
                        >
                          {formatCell(col, row[col.key])}
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
