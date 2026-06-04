"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  FileText,
  Send,
  Wallet,
  CircleDollarSign,
  CheckCircle2,
  Clock3,
} from "lucide-react";
import {
  claimWorkflowStatuses,
  displayClaimStatusLabel,
  isLegacyPekaStatus,
} from "@/lib/claim-workflow/constants";

type ClaimWorkflowListRow = {
  id: string;
  claimWorkflowNo: string;
  offBatchId: string;
  offNoPengajuan?: string | null;
  principleName: string;
  status: string;
  totalClaim: number;
  totalPaid: number;
  remainingAmount: number;
  noClaim?: string | null;
  createdAt: string | Date;
  // R7h — OFF finance gate fields
  offFinanceStatus?: string | null;
  offStatus?: string | null;
  offPaymentSummary?: {
    totalNominal: number;
    totalPaid: number;
    isFullyPaid: boolean;
  } | null;
  activeSubmissionCount?: number;
  activeSubmissionMissingNoClaimCount?: number;
  noClaimList?: string[];
  documentStatus?: string | null;
  canGenerateNoClaim?: boolean;
  noClaimGateReason?: string | null;
};

type OutstandingRow = {
  id: string;
  claimWorkflowNo: string;
  noClaim?: string | null;
  principleName: string;
  status: string;
  totalClaim: number;
  totalPaid: number;
  remainingAmount: number;
  submittedToPrincipalAt?: string | Date | null;
  latestPaymentDate?: string | null;
  daysOutstanding?: number | null;
  offNoPengajuan?: string | null;
};

type OutstandingSummary = {
  workflowCount: number;
  totalClaim: number;
  totalPaid: number;
  totalOutstanding: number;
};

type ListTab = "all" | "ready_no_claim" | "waiting_finance" | "docs_incomplete" | "ready_submit" | "submitted" | "outstanding" | "paid" | "closed";

function rupiah(value: number) {
  return `Rp ${Number(value || 0).toLocaleString("id-ID")}`;
}

function createdDate(value: string | Date) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return new Intl.DateTimeFormat("id-ID", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(date);
}

// Status legacy PEKA (Waiting PEKA / EC Received / CN Received) ditampilkan
// dengan tone "Submitted to Principal" karena flow PEKA sudah retired. UI
// tidak menyediakan aksi transisi PEKA apapun lagi.
function statusTone(status: string) {
  if (
    status === claimWorkflowStatuses.closed ||
    status === claimWorkflowStatuses.paid
  ) {
    return "border-emerald-500/30 bg-emerald-500/10 text-emerald-300";
  }
  if (
    status === claimWorkflowStatuses.needRevision ||
    status === claimWorkflowStatuses.cancelled
  ) {
    return "border-rose-500/30 bg-rose-500/10 text-rose-300";
  }
  if (
    status === claimWorkflowStatuses.submittedToPrincipal ||
    isLegacyPekaStatus(status)
  ) {
    return "border-sky-500/30 bg-sky-500/10 text-sky-300";
  }
  if (status === claimWorkflowStatuses.partiallyPaid) {
    return "border-emerald-500/30 bg-emerald-500/10 text-emerald-200";
  }
  if (status === claimWorkflowStatuses.outstanding) {
    return "border-orange-500/30 bg-orange-500/10 text-orange-300";
  }
  if (status === claimWorkflowStatuses.readyToSubmit) {
    return "border-indigo-500/30 bg-indigo-500/10 text-indigo-200";
  }
  return "border-amber-500/30 bg-amber-500/10 text-amber-300";
}

export default function ClaimWorkflowPage() {
  const [rows, setRows] = useState<ClaimWorkflowListRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<ListTab>("all");
  const [search, setSearch] = useState("");
  const [outstanding, setOutstanding] = useState<OutstandingRow[]>([]);
  const [outstandingSummary, setOutstandingSummary] = useState<OutstandingSummary | null>(null);
  const [outstandingLoading, setOutstandingLoading] = useState(true);
  const [outstandingError, setOutstandingError] = useState("");

  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const response = await fetch("/api/claim-workflow", {
          cache: "no-store",
        });
        const result = (await response.json()) as {
          ok?: boolean;
          workflows?: ClaimWorkflowListRow[];
          error?: string;
        };
        if (!response.ok || !result.ok) {
          throw new Error(result.error || "Gagal memuat Claim Workflow.");
        }
        if (active) setRows(result.workflows || []);
      } catch (loadError) {
        if (active) {
          setError(
            loadError instanceof Error
              ? loadError.message
              : "Gagal memuat Claim Workflow.",
          );
        }
      } finally {
        if (active) setLoading(false);
      }
    }
    void load();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const response = await fetch("/api/claim-workflow/outstanding", {
          cache: "no-store",
        });
        const result = (await response.json()) as {
          ok?: boolean;
          outstanding?: OutstandingRow[];
          summary?: OutstandingSummary;
          error?: string;
        };
        if (!response.ok || !result.ok) {
          throw new Error(result.error || "Gagal memuat Outstanding.");
        }
        if (active) {
          setOutstanding(result.outstanding || []);
          setOutstandingSummary(result.summary || null);
        }
      } catch (loadError) {
        if (active) {
          setOutstandingError(
            loadError instanceof Error
              ? loadError.message
              : "Gagal memuat Outstanding.",
          );
        }
      } finally {
        if (active) setOutstandingLoading(false);
      }
    }
    void load();
    return () => {
      active = false;
    };
  }, []);

  const filteredRows = useMemo(() => {
    // Step 1: text search across multiple fields
    let result = rows;
    const q = search.trim().toLowerCase();
    if (q) {
      result = result.filter((row) => {
        const fields = [
          row.claimWorkflowNo,
          row.noClaim,
          row.principleName,
          row.offNoPengajuan,
          row.status,
          row.offFinanceStatus,
          row.documentStatus,
          ...(row.noClaimList || []),
        ];
        return fields.some((f) => f && String(f).toLowerCase().includes(q));
      });
    }

    // Step 2: tab filter
    if (tab === "all") return result;
    if (tab === "ready_no_claim") {
      return result.filter((row) => row.canGenerateNoClaim === true);
    }
    if (tab === "waiting_finance") {
      return result.filter((row) => row.offFinanceStatus !== "Paid");
    }
    if (tab === "docs_incomplete") {
      return result.filter((row) => row.documentStatus === "none" || row.documentStatus === "partial");
    }
    if (tab === "ready_submit") {
      return result.filter((row) => row.status === claimWorkflowStatuses.readyToSubmit);
    }
    if (tab === "submitted") {
      return result.filter((row) => row.status === claimWorkflowStatuses.submittedToPrincipal);
    }
    if (tab === "outstanding") {
      return result.filter((row) => row.remainingAmount > 0 && (
        row.status === claimWorkflowStatuses.submittedToPrincipal ||
        row.status === claimWorkflowStatuses.partiallyPaid ||
        row.status === claimWorkflowStatuses.outstanding
      ));
    }
    if (tab === "paid") {
      return result.filter((row) => row.status === claimWorkflowStatuses.paid);
    }
    if (tab === "closed") {
      return result.filter((row) => row.status === claimWorkflowStatuses.closed);
    }
    return result;
  }, [rows, tab, search]);

  const metrics = useMemo(
    () => [
      {
        label: "Total Claim Workflow",
        value: rows.length,
        icon: FileText,
        tone: "text-indigo-300",
      },
      {
        label: "Draft",
        value: rows.filter((row) => row.status === claimWorkflowStatuses.draft)
          .length,
        icon: Clock3,
        tone: "text-amber-300",
      },
      {
        label: "Submitted to Principal",
        value: rows.filter(
          (row) =>
            row.status === claimWorkflowStatuses.submittedToPrincipal,
        ).length,
        icon: Send,
        tone: "text-sky-300",
      },
      {
        label: "Paid / Partially Paid",
        value: rows.filter(
          (row) =>
            row.status === claimWorkflowStatuses.paid ||
            row.status === claimWorkflowStatuses.partiallyPaid,
        ).length,
        icon: Wallet,
        tone: "text-emerald-300",
      },
      {
        label: "Outstanding",
        value: outstandingSummary?.workflowCount ?? 0,
        icon: CircleDollarSign,
        tone: "text-orange-300",
      },
      {
        label: "Closed",
        value: rows.filter((row) => row.status === claimWorkflowStatuses.closed)
          .length,
        icon: CheckCircle2,
        tone: "text-emerald-300",
      },
    ],
    [rows, outstandingSummary],
  );

  return (
    <div className="w-full space-y-6 pb-12 pt-2">
      <div className="rounded-3xl border border-white/10 bg-gradient-to-br from-[#1a1c23] to-[#0f1115] p-7 shadow-2xl">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.24em] text-indigo-300">
              After OFF Program Control
            </p>
            <h1 className="mt-3 text-3xl font-black tracking-tight text-white">
              Claim Workflow
            </h1>
            <p className="mt-2 max-w-3xl text-sm leading-relaxed text-slate-400">
              Pengajuan klaim ke principal: BASE → Summary → Paid → Monitor
              Outstanding. Setiap workflow dibuat dari OFF batch yang sudah OM
              Approved.
            </p>
          </div>
          <Link
            href="/claim-workflow/reports"
            className="inline-flex items-center gap-2 rounded-lg border border-indigo-500/30 bg-indigo-500/10 px-3 py-2 text-xs font-bold text-indigo-200 transition hover:bg-indigo-500/20"
          >
            Reports / Export →
          </Link>
        </div>
      </div>

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
        {metrics.map((metric) => {
          const Icon = metric.icon;
          return (
            <div
              key={metric.label}
              className="rounded-2xl border border-white/10 bg-[#1a1c23] p-4"
            >
              <Icon size={19} className={metric.tone} />
              <p className="mt-4 text-2xl font-black text-white">
                {metric.value}
              </p>
              <p className="mt-1 text-xs font-medium text-slate-400">
                {metric.label}
              </p>
            </div>
          );
        })}
      </section>

      <section className="overflow-hidden rounded-2xl border border-white/10 bg-[#1a1c23] shadow-lg shadow-black/20">
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-white/10 px-5 py-4">
          <div>
            <h2 className="text-base font-bold text-white">Monitor Outstanding</h2>
            <p className="mt-1 text-xs text-slate-500">
              Klaim yang sudah dikirim ke principal namun belum lunas. Sumber
              kebenaran sheet Excel `MONITOR OUTSTANDING`.
            </p>
          </div>
          {outstandingSummary && (
            <div className="flex flex-wrap items-center gap-3 text-xs">
              <span className="rounded-full border border-white/10 bg-black/30 px-3 py-1 text-slate-300">
                <strong className="text-white">{outstandingSummary.workflowCount}</strong> workflow
              </span>
              <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-3 py-1 text-amber-200">
                Outstanding: <strong>{rupiah(outstandingSummary.totalOutstanding)}</strong>
              </span>
              <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1 text-emerald-200">
                Paid: <strong>{rupiah(outstandingSummary.totalPaid)}</strong>
              </span>
            </div>
          )}
        </div>
        {outstandingLoading ? (
          <div className="px-5 py-10 text-center text-sm text-slate-400">Memuat outstanding...</div>
        ) : outstandingError ? (
          <div className="mx-5 my-4 rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">{outstandingError}</div>
        ) : outstanding.length === 0 ? (
          <div className="px-5 py-10 text-center text-sm text-slate-500">
            Tidak ada klaim outstanding. Semua klaim yang sudah disubmit sudah lunas atau ditutup.
          </div>
        ) : (
          <div className="max-h-[420px] overflow-auto">
            <table className="min-w-full text-left text-sm">
              <thead className="sticky top-0 z-10 bg-[#1a1c23]/95 text-xs uppercase tracking-wider text-slate-500 backdrop-blur">
                <tr className="border-b border-white/10">
                  <th scope="col" className="px-5 py-3 font-semibold">Claim No</th>
                  <th scope="col" className="px-5 py-3 font-semibold">No Claim</th>
                  <th scope="col" className="px-5 py-3 font-semibold">Principle</th>
                  <th scope="col" className="px-5 py-3 text-right font-semibold">Total Claim</th>
                  <th scope="col" className="px-5 py-3 text-right font-semibold">Total Paid</th>
                  <th scope="col" className="px-5 py-3 text-right font-semibold">Outstanding</th>
                  <th scope="col" className="px-5 py-3 font-semibold">Status</th>
                  <th scope="col" className="px-5 py-3 text-right font-semibold">Days</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {outstanding.map((row) => (
                  <tr key={row.id} className="text-slate-300 hover:bg-white/[0.04]">
                    <td className="whitespace-nowrap px-5 py-3 font-semibold">
                      <Link href={`/claim-workflow/${row.id}`} className="font-mono text-indigo-200 hover:underline">
                        {row.claimWorkflowNo}
                      </Link>
                    </td>
                    <td className="whitespace-nowrap px-5 py-3 font-mono text-xs text-slate-300">{row.noClaim || "-"}</td>
                    <td className="px-5 py-3">{row.principleName}</td>
                    <td className="whitespace-nowrap px-5 py-3 text-right tabular-nums text-white">{rupiah(row.totalClaim)}</td>
                    <td className="whitespace-nowrap px-5 py-3 text-right tabular-nums text-emerald-200">{rupiah(row.totalPaid)}</td>
                    <td className="whitespace-nowrap px-5 py-3 text-right tabular-nums text-amber-200">{rupiah(row.remainingAmount)}</td>
                    <td className="whitespace-nowrap px-5 py-3">
                      <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-semibold ${statusTone(row.status)}`}>
                        {displayClaimStatusLabel(row.status)}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-5 py-3 text-right tabular-nums text-slate-400">
                      {row.daysOutstanding ?? "-"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="overflow-hidden rounded-2xl border border-white/10 bg-[#1a1c23] shadow-lg shadow-black/20">
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-white/10 px-5 py-4">
          <div>
            <h2 className="text-base font-bold text-white">Daftar Claim Workflow</h2>
            {!loading && !error && (
              <p className="mt-1 text-xs text-slate-500">
                {filteredRows.length} workflow ditampilkan ({tab === "all" ? "semua" : tab.replace(/_/g, " ")})
              </p>
            )}
          </div>
          <div className="flex flex-col items-end gap-2">
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Cari: nomor, no claim, principal, nota, status..."
              className="w-64 rounded-lg border border-white/10 bg-black/30 px-3 py-1.5 text-xs text-white placeholder:text-slate-500 focus:border-indigo-500/50 focus:outline-none"
            />
            <div className="flex flex-wrap items-center gap-1 rounded-full border border-white/10 bg-black/30 p-1 text-xs">
              {([
                { key: "all", label: "Semua" },
                { key: "ready_no_claim", label: "Siap Generate No Claim" },
                { key: "waiting_finance", label: "Menunggu Finance" },
                { key: "docs_incomplete", label: "Belum Lengkap Dokumen" },
                { key: "ready_submit", label: "Ready to Submit" },
                { key: "submitted", label: "Submitted" },
                { key: "outstanding", label: "Outstanding" },
                { key: "closed", label: "Closed" },
              ] as Array<{ key: ListTab; label: string }>).map((option) => (
                <button
                  key={option.key}
                  type="button"
                  onClick={() => setTab(option.key)}
                  className={`rounded-full px-3 py-1.5 font-bold transition ${
                    tab === option.key
                      ? "bg-indigo-600 text-white"
                      : "text-slate-300 hover:bg-white/10"
                  }`}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
        </div>
        {loading ? (
          <div className="px-5 py-16 text-center text-sm text-slate-400">
            Memuat data Claim Workflow...
          </div>
        ) : error ? (
          <div className="mx-5 my-6 rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-4 text-center text-sm text-rose-200">
            {error}
          </div>
        ) : filteredRows.length === 0 ? (
          <div className="px-5 py-16 text-center">
            <FileText size={28} className="mx-auto text-slate-600" />
            <p className="mt-3 text-sm font-medium text-slate-300">
              Tidak ada workflow di tab ini.
            </p>
            <p className="mt-1 text-xs text-slate-500">
              {tab === "all"
                ? "Draft pertama dapat dibuat dari OFF batch yang sudah OM Approved."
                : "Coba ganti tab atau buat klaim baru dari OFF Program Control."}
            </p>
          </div>
        ) : (
          <div className="max-h-[640px] overflow-auto">
            <table className="min-w-full text-left text-sm">
              <thead className="sticky top-0 z-10 bg-[#1a1c23]/95 text-xs uppercase tracking-wider text-slate-500 backdrop-blur supports-[backdrop-filter]:bg-[#1a1c23]/70">
                <tr className="border-b border-white/10">
                  <th scope="col" className="px-5 py-3 font-semibold">Claim Workflow No</th>
                  <th scope="col" className="px-5 py-3 font-semibold">Principle</th>
                  <th scope="col" className="px-5 py-3 font-semibold">OFF Batch / No Pengajuan</th>
                  <th scope="col" className="px-5 py-3 text-right font-semibold">Total Claim</th>
                  <th scope="col" className="px-5 py-3 text-right font-semibold">Total Paid</th>
                  <th scope="col" className="px-5 py-3 text-right font-semibold">Outstanding</th>
                  <th scope="col" className="px-5 py-3 font-semibold">Status</th>
                  <th scope="col" className="px-5 py-3 font-semibold">Finance OFF</th>
                  <th scope="col" className="px-5 py-3 font-semibold">Created At</th>
                  <th scope="col" className="px-5 py-3 font-semibold">Aksi</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {filteredRows.map((row) => (
                  <tr
                    key={row.id}
                    className="text-slate-300 transition-colors hover:bg-white/[0.04]"
                  >
                    <td className="whitespace-nowrap px-5 py-4 font-semibold">
                      <Link
                        href={`/claim-workflow/${row.id}`}
                        className="font-mono text-indigo-200 transition-colors hover:text-indigo-100 hover:underline"
                      >
                        {row.claimWorkflowNo}
                      </Link>
                    </td>
                    <td className="px-5 py-4 text-slate-200">{row.principleName}</td>
                    <td className="whitespace-nowrap px-5 py-4">
                      <p className="text-slate-200">{row.offNoPengajuan || "-"}</p>
                      <p className="mt-1 font-mono text-[10px] uppercase tracking-wider text-slate-500">
                        {row.offBatchId.slice(0, 8)}…
                      </p>
                    </td>
                    <td className="whitespace-nowrap px-5 py-4 text-right font-semibold tabular-nums text-white">
                      {rupiah(row.totalClaim)}
                    </td>
                    <td className="whitespace-nowrap px-5 py-4 text-right tabular-nums text-slate-200">
                      {rupiah(row.totalPaid)}
                    </td>
                    <td
                      className={`whitespace-nowrap px-5 py-4 text-right tabular-nums ${
                        row.remainingAmount > 0 ? "text-amber-200" : "text-slate-500"
                      }`}
                    >
                      {rupiah(row.remainingAmount)}
                    </td>
                    <td className="whitespace-nowrap px-5 py-4">
                      <span
                        className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-semibold ${statusTone(row.status)}`}
                        title={isLegacyPekaStatus(row.status) ? "Legacy PEKA status — diperlakukan sebagai Submitted to Principal" : undefined}
                      >
                        {displayClaimStatusLabel(row.status)}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-5 py-4">
                      <span
                        className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-semibold ${
                          row.offFinanceStatus === "Paid"
                            ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
                            : "border-amber-500/30 bg-amber-500/10 text-amber-300"
                        }`}
                      >
                        {row.offFinanceStatus || "-"}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-5 py-4 text-slate-400">
                      {createdDate(row.createdAt)}
                    </td>
                    <td className="whitespace-nowrap px-5 py-4">
                      {row.canGenerateNoClaim ? (
                        <Link
                          href={`/claim-workflow/${row.id}?focus=no-claim`}
                          className="inline-flex items-center gap-1 rounded-lg border border-indigo-500/30 bg-indigo-500/10 px-2.5 py-1.5 text-xs font-bold text-indigo-200 transition hover:bg-indigo-500/20"
                        >
                          Buka Generate No Claim
                        </Link>
                      ) : row.noClaimGateReason ? (
                        <span className="text-xs text-slate-500" title={row.noClaimGateReason}>
                          {row.offFinanceStatus !== "Paid" ? "Menunggu Finance" : "-"}
                        </span>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
