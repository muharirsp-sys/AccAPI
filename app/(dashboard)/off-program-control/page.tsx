"use client";

import {
  useEffect,
  useMemo,
  useState,
  type ElementType,
  type ReactNode,
} from "react";
import {
  AlertTriangle,
  ArrowRight,
  Bell,
  CalendarClock,
  CheckCircle2,
  ClipboardCheck,
  Clock3,
  FileCheck2,
  FileText,
  ListChecks,
  Mail,
  Plus,
  ReceiptText,
  ScrollText,
  Send,
  ShieldCheck,
  Wallet,
  XCircle,
} from "lucide-react";
import {
  offPaymentMethods,
  offPrinciples,
} from "@/lib/off-program-control/constants";
import { authClient } from "@/lib/auth-client";
import {
  canPerformOffAction,
  getOffAccessibleTabs,
  resolveOffRole,
  type OffRole,
} from "@/lib/off-program-control/access";

type TabKey =
  | "overview"
  | "supervisor"
  | "sales"
  | "claim"
  | "om"
  | "finance"
  | "audit";

type OffDashboardProps = {
  offRole: OffRole;
};

type Principle = (typeof offPrinciples)[number];

const PRINCIPLE_OPTIONS: Principle[] = offPrinciples;

const tabs: Array<{ key: TabKey; label: string }> = [
  { key: "overview", label: "Ringkasan" },
  { key: "supervisor", label: "Supervisor" },
  { key: "sales", label: "Sales Manager" },
  { key: "claim", label: "Claim" },
  { key: "om", label: "Operational Manager" },
  { key: "finance", label: "Keuangan" },
  { key: "audit", label: "Log Audit" },
];

const workflowSteps = [
  "Input Massal Supervisor",
  "Review Data Sales Manager",
  "Validasi Claim",
  "Persetujuan Operational Manager",
  "Pembayaran Keuangan",
  "Verifikasi Final Pembayaran Claim",
  "Selesai",
];

type SupervisorBulkRow = {
  id: string;
  noSurat: string;
  namaProgram: string;
  periodeAwal: string;
  periodeAkhir: string;
  toko: string;
  barang: string;
  nominal: string;
  caraBayar: string;
  type: string;
  deadline: string;
  kwt: boolean;
  skp: boolean;
  fp: boolean;
  pc: boolean;
  foto: boolean;
  rekap: boolean;
  others: boolean;
  othersText: string;
};

type OffApiBatch = {
  id: string;
  noPengajuan: string;
  gelombang: string;
  principleName: string;
  principleCode: string;
  bulan: string;
  tahun: string;
  supervisorName: string;
  status: string;
  smStatus: string;
  claimStatus: string;
  omStatus: string;
  financeStatus: string;
  finalStatus: string;
  smNote?: string | null;
  claimNote?: string | null;
  omNote?: string | null;
  noClaim?: string | null;
  claimSubmittedDate?: string | null;
  claimDeadline?: string | null;
  paymentDate?: string | null;
  paidAmount?: number | null;
  financeNote?: string | null;
  verifiedAmount?: number | null;
  finalClaimNote?: string | null;
  locked: boolean;
  pdfUrl?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  summary?: BatchQueueSummary;
  paymentSummary?: OffPaymentSummary;
  payments?: OffApiPayment[];
};

type OffApiPayment = {
  id: string;
  batchId: string;
  paymentNo: number;
  paymentDate: string;
  paymentMethod: string;
  paidAmount: number;
  senderBank?: string | null;
  paymentProofName: string;
  paymentProofMime?: string | null;
  paymentProofSize?: number | null;
  proofUrl?: string | null;
  note?: string | null;
};

type OffPaymentSummary = {
  totalNominal: number;
  totalPaid: number;
  remainingAmount: number;
  isFullyPaid: boolean;
};

type OffApiItem = {
  id: string;
  itemNo: number;
  noSurat: string;
  noClaim?: string | null;
  namaProgram: string;
  periode: string | null;
  toko: string;
  barang: string | null;
  nominal: number;
  caraBayar: string | null;
  type: string | null;
  deadline: string | null;
  kwt: boolean;
  skp: boolean;
  fp: boolean;
  pc: boolean;
  foto: boolean;
  rekap: boolean;
  others: boolean;
  othersText: string | null;
};

type OffNotificationPreview = {
  to: string;
  subject: string;
  message: string;
  status?: string;
};

type BatchQueueSummary = {
  rowCount?: number;
  totalNominal: number;
  totalRows?: number;
  transfer?: number;
  tunai?: number;
};

type MetricItem = {
  label: string;
  value: string;
  tone: string;
  icon: ElementType;
};

const initialBulkRows: SupervisorBulkRow[] = [
  {
    id: "row-1",
    noSurat: "SP/OFF/051",
    namaProgram: "Endcap Support",
    periodeAwal: "2026-05-01",
    periodeAkhir: "2026-05-31",
    toko: "Toko Makmur",
    barang: "Dettol",
    nominal: "Rp 4.400.000",
    caraBayar: "Transfer",
    type: "OFF Display",
    deadline: "2026-05-30",
    kwt: true,
    skp: false,
    fp: true,
    pc: false,
    foto: true,
    rekap: false,
    others: true,
    othersText: "Surat display tambahan outlet",
  },
  {
    id: "row-2",
    noSurat: "SP/OFF/052",
    namaProgram: "Area Visibility",
    periodeAwal: "2026-05-10",
    periodeAkhir: "2026-05-24",
    toko: "CV Prima",
    barang: "Harpic",
    nominal: "Rp 3.750.000",
    caraBayar: "Tunai",
    type: "Visibility",
    deadline: "2026-06-03",
    kwt: false,
    skp: true,
    fp: true,
    pc: false,
    foto: true,
    rekap: true,
    others: false,
    othersText: "",
  },
  {
    id: "row-3",
    noSurat: "SP/OFF/053",
    namaProgram: "Sampling Area",
    periodeAwal: "2026-05-15",
    periodeAkhir: "2026-05-30",
    toko: "UD Maju",
    barang: "Vanish",
    nominal: "Rp 4.350.000",
    caraBayar: "Tunai",
    type: "Sampling",
    deadline: "2026-06-05",
    kwt: true,
    skp: false,
    fp: false,
    pc: true,
    foto: true,
    rekap: false,
    others: true,
    othersText: "BA sampling",
  },
];

const documentChecks = ["KWT", "SKP", "FP", "PC", "Foto", "Rekap", "Others"];

const auditLogs = [
  {
    title: "Supervisor mengirim pengajuan",
    detail: "Supervisor mengirim batch 001/RB/05/2026 ke Sales Manager",
    time: "16 May 2026 09:15",
  },
  {
    title: "Sales Manager menyetujui",
    detail:
      "SM menyetujui batch, memberi notifikasi OM, dan mengunci data untuk Supervisor",
    time: "16 May 2026 10:05",
  },
  {
    title: "Claim input No Claim",
    detail:
      "Claim memverifikasi syarat, dokumen lainnya, dan menginput nomor claim untuk batch",
    time: "16 May 2026 11:20",
  },
  {
    title: "OM menyetujui",
    detail:
      "Operational Manager menyetujui batch setelah melihat status SM dan Claim",
    time: "16 May 2026 13:40",
  },
  {
    title: "Keuangan upload bukti bayar",
    detail:
      "Keuangan membayar dan mengirim batch kembali ke Claim untuk verifikasi final",
    time: "16 May 2026 15:10",
  },
  {
    title: "Verifikasi final Claim selesai",
    detail:
      "Claim memverifikasi bukti bayar dan jumlah, lalu menyelesaikan pengajuan",
    time: "16 May 2026 16:25",
  },
];

function getPrincipleCode(name: string) {
  return PRINCIPLE_OPTIONS.find((item) => item.name === name)?.code || "";
}

function parseUiCurrency(value: string | number) {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const cleaned = String(value || "").replace(/[^\d,.-]/g, "");
  if (!cleaned) return 0;
  if (cleaned.includes(".") && cleaned.includes(",")) {
    const decimalSeparator =
      cleaned.lastIndexOf(",") > cleaned.lastIndexOf(".") ? "," : ".";
    return (
      Number(
        cleaned
          .replace(
            new RegExp(`\\${decimalSeparator === "," ? "." : ","}`, "g"),
            "",
          )
          .replace(decimalSeparator, "."),
      ) || 0
    );
  }
  if (cleaned.includes(".")) return Number(cleaned.replace(/\./g, "")) || 0;
  if (cleaned.includes(",")) return Number(cleaned.replace(/,/g, "")) || 0;
  return Number(cleaned) || 0;
}

function normalizeUiPaymentMethod(value: string) {
  const normalized = value.trim().toLowerCase();
  if (normalized === "transfer") return "Transfer";
  if (normalized === "tunai") return "Tunai";
  return value;
}

function computeUiPaymentSummary(
  items: Array<{ nominal: string | number; caraBayar: string }>,
) {
  return items.reduce(
    (summary, item) => {
      const nominal = parseUiCurrency(item.nominal);
      summary.total += nominal;
      const method = normalizeUiPaymentMethod(item.caraBayar);
      if (method === "Transfer") summary.transfer += nominal;
      if (method === "Tunai") summary.tunai += nominal;
      return summary;
    },
    { total: 0, transfer: 0, tunai: 0 },
  );
}

function createEmptyBulkRow(index: number): SupervisorBulkRow {
  return {
    id: `row-${Date.now()}-${index}`,
    noSurat: "",
    namaProgram: "",
    periodeAwal: "",
    periodeAkhir: "",
    toko: "",
    barang: "",
    nominal: "",
    caraBayar: "Transfer",
    type: "",
    deadline: "",
    kwt: false,
    skp: false,
    fp: false,
    pc: false,
    foto: false,
    rekap: false,
    others: false,
    othersText: "",
  };
}

function splitPeriodDates(periode: string | null | undefined) {
  const [periodeAwal = "", periodeAkhir = ""] = String(periode || "").split(
    " - ",
  );
  return { periodeAwal, periodeAkhir };
}

function buildPeriodString(periodeAwal: string, periodeAkhir: string) {
  if (periodeAwal && periodeAkhir) return `${periodeAwal} - ${periodeAkhir}`;
  return periodeAwal || periodeAkhir || "";
}

function formatDateDisplay(value: string | null | undefined) {
  if (!value) return "-";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const [year, month, day] = value.split("-");
  return `${day}/${month}/${year}`;
}

const statusLabelMap: Record<string, string> = {
  Draft: "Draf",
  "Submitted to SM": "Dikirim ke Sales Manager",
  "Waiting Review": "Menunggu Review",
  "Returned by SM": "Dikembalikan oleh Sales Manager",
  "Returned by Claim": "Dikembalikan oleh Claim",
  Returned: "Dikembalikan",
  "Approved by SM": "Disetujui Sales Manager",
  "Approved by SM - Locked": "Disetujui Sales Manager - Terkunci",
  "Waiting Claim": "Menunggu Claim",
  "Claim Approved": "Disetujui Claim",
  "Waiting Approval": "Menunggu Persetujuan",
  "Ready for OM": "Siap Diproses OM",
  "Waiting OM": "Menunggu OM",
  "OM Approved": "Disetujui OM",
  "Cancelled by OM": "Dibatalkan OM",
  "Waiting Payment": "Menunggu Pembayaran",
  "Partial Paid": "Dibayar Sebagian",
  "Need Correction": "Perlu Koreksi",
  Paid: "Sudah Dibayar",
  "Waiting Claim Final Verification": "Menunggu Verifikasi Final Claim",
  "Incomplete Documents": "Kelengkapan Belum Lengkap",
  Completed: "Selesai",
  "Not Started": "Belum Dimulai",
  Approved: "Disetujui",
  Cancelled: "Dibatalkan",
  Ready: "Siap",
  Aman: "Aman",
  Kurang: "Kurang",
  "Perlu Revisi": "Perlu Revisi",
};

function displayStatusLabel(status: string | null | undefined) {
  if (!status) return "-";
  return statusLabelMap[status] || status;
}

function itemDocsSummary(item: OffApiItem) {
  const docs = [
    item.kwt ? "KWT" : "",
    item.skp ? "SKP" : "",
    item.fp ? "FP" : "",
    item.pc ? "PC" : "",
    item.foto ? "Foto" : "",
    item.rekap ? "Rekap" : "",
    item.others ? "Lainnya" : "",
  ].filter(Boolean);
  return docs.length ? docs.join(", ") : "-";
}

function apiItemToBulkRow(item: OffApiItem, index: number): SupervisorBulkRow {
  const period = splitPeriodDates(item.periode);
  return {
    id: item.id || `returned-row-${index + 1}`,
    noSurat: item.noSurat || "",
    namaProgram: item.namaProgram || "",
    periodeAwal: period.periodeAwal,
    periodeAkhir: period.periodeAkhir,
    toko: item.toko || "",
    barang: item.barang || "",
    nominal: item.nominal
      ? `Rp ${Number(item.nominal).toLocaleString("id-ID")}`
      : "",
    caraBayar: item.caraBayar || "Transfer",
    type: item.type || "",
    deadline: item.deadline || "",
    kwt: Boolean(item.kwt),
    skp: Boolean(item.skp),
    fp: Boolean(item.fp),
    pc: Boolean(item.pc),
    foto: Boolean(item.foto),
    rekap: Boolean(item.rekap),
    others: Boolean(item.others),
    othersText: item.othersText || "",
  };
}

async function parseJsonResponse(response: Response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { error: text };
  }
}

function statusClass(status: string) {
  if (
    status.includes("Completed") ||
    status.includes("Approved") ||
    status.includes("Aman")
  )
    return "bg-emerald-500/10 text-emerald-300 border-emerald-500/30";
  if (status.includes("OM") || status.includes("Ready"))
    return "bg-purple-500/10 text-purple-300 border-purple-500/30";
  if (status.includes("Claim"))
    return "bg-sky-500/10 text-sky-300 border-sky-500/30";
  if (status.includes("Locked"))
    return "bg-slate-500/10 text-slate-300 border-slate-500/30";
  if (
    status.includes("Returned") ||
    status.includes("Kurang") ||
    status.includes("Revisi")
  )
    return "bg-rose-500/10 text-rose-300 border-rose-500/30";
  return "bg-amber-500/10 text-amber-300 border-amber-500/30";
}

function batchSearchText(batch: OffApiBatch) {
  return [
    batch.noPengajuan,
    batch.principleName,
    batch.principleCode,
    batch.status,
    batch.smStatus,
    batch.claimStatus,
    batch.omStatus,
    batch.financeStatus,
    batch.finalStatus,
    batch.noClaim,
  ]
    .join(" ")
    .toLowerCase();
}

function filterBatchesBySearch(batches: OffApiBatch[], query: string) {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return batches;
  return batches.filter((batch) => batchSearchText(batch).includes(normalized));
}

function getBatchStatusOptions(batches: OffApiBatch[]) {
  return Array.from(
    new Set(
      batches
        .map((batch) => batch.status)
        .filter((status): status is string => Boolean(status)),
    ),
  ).sort((a, b) => a.localeCompare(b));
}

function filterBatchesByMainStatus(
  batches: OffApiBatch[],
  statusFilter: string,
) {
  if (!statusFilter) return batches;
  return batches.filter((batch) => batch.status === statusFilter);
}

function isSupervisorEditableBatch(batch: OffApiBatch) {
  return (
    !batch.locked &&
    (batch.status === "Draft" ||
      batch.status === "Returned by SM" ||
      batch.status === "Returned by Claim" ||
      batch.smStatus === "Returned" ||
      batch.claimStatus === "Returned")
  );
}

function isSmActionableBatch(batch: OffApiBatch | null) {
  return Boolean(
    batch &&
    batch.status === "Submitted to SM" &&
    batch.smStatus === "Waiting Review",
  );
}

function isOmActionableBatch(batch: OffApiBatch | null) {
  return Boolean(
    batch &&
    batch.claimStatus === "Approved" &&
    batch.omStatus === "Waiting Approval" &&
    ["Claim Approved", "Ready for OM", "Waiting OM"].includes(batch.status),
  );
}

function isFinanceActionableBatch(batch: OffApiBatch | null) {
  return Boolean(
    batch &&
    batch.omStatus === "Approved" &&
    ["Waiting Payment", "Partial Paid", "Need Correction"].includes(
      batch.financeStatus,
    ),
  );
}

function isFinanceMonitoringBatch(batch: OffApiBatch) {
  const hasPayments =
    Number(batch.paidAmount || 0) > 0 ||
    Boolean(batch.paymentSummary && batch.paymentSummary.totalPaid > 0) ||
    Boolean(batch.payments?.length);
  return (
    ["Waiting Payment", "Partial Paid", "Need Correction", "Paid"].includes(
      batch.financeStatus,
    ) ||
    batch.status === "Paid" ||
    batch.status === "Partial Paid" ||
    ((batch.status === "Completed" || batch.finalStatus === "Completed") &&
      hasPayments)
  );
}

function financeActionLabel(batch: OffApiBatch) {
  if (isFinanceActionableBatch(batch)) return "Input Pembayaran";
  if (
    batch.financeStatus === "Paid" ||
    batch.status === "Paid" ||
    batch.status === "Completed" ||
    batch.finalStatus === "Completed"
  )
    return "Lihat Pembayaran";
  return "Lihat Detail";
}

function filterFinanceBatchesByStatus(batches: OffApiBatch[], status: string) {
  if (!status) return batches;
  return batches.filter(
    (batch) =>
      batch.status === status ||
      batch.financeStatus === status ||
      batch.finalStatus === status,
  );
}

function MonitoringSearch({
  value,
  onChange,
  placeholder = "Cari No Pengajuan, principle, kode, atau status...",
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  return (
    <input
      value={value}
      onChange={(event) => onChange(event.target.value)}
      placeholder={placeholder}
      className="w-full rounded-xl border border-white/10 bg-black/40 px-4 py-2.5 text-sm text-slate-200 outline-none placeholder:text-slate-600 focus:border-teal-500/50"
    />
  );
}

function StatusFilterSelect({
  value,
  onChange,
  options,
  label = "Filter Status",
}: {
  value: string;
  onChange: (value: string) => void;
  options: Array<string | { value: string; label: string }>;
  label?: string;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-semibold text-slate-500">
        {label}
      </span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="w-full rounded-xl border border-white/10 bg-black/40 px-4 py-2.5 text-sm text-slate-200 outline-none focus:border-teal-500/50"
      >
        <option value="" className="bg-[#1a1c23]">
          Semua Status
        </option>
        {options.map((option) => {
          const value = typeof option === "string" ? option : option.value;
          const label =
            typeof option === "string"
              ? displayStatusLabel(option)
              : option.label;

          return (
            <option key={value} value={value} className="bg-[#1a1c23]">
              {label}
            </option>
          );
        })}
      </select>
    </label>
  );
}

function BatchMonitoringTable({
  batches,
  selectedBatchId,
  onSelect,
  actionLabel,
  emptyText = "Belum ada batch yang cocok.",
  stickyAction = false,
}: {
  batches: OffApiBatch[];
  selectedBatchId?: string | null;
  onSelect: (batch: OffApiBatch) => void;
  actionLabel: (batch: OffApiBatch) => string;
  emptyText?: string;
  stickyAction?: boolean;
}) {
  const headers = [
    "No Pengajuan",
    "Principle",
    "Kode Principle",
    "Total",
    "Status",
    "Status SM",
    "Status Claim",
    "Status OM",
    "Status Keuangan",
    "Status Final",
    "Dibuat/Diperbarui",
    "Aksi",
  ];

  return (
    <div className="overflow-x-auto rounded-xl border border-white/10">
      <table className="w-full min-w-[1650px] text-left text-sm">
        <thead className="border-b border-white/10 bg-black/50 text-xs uppercase tracking-wider text-slate-500">
          <tr>
            {headers.map((header) => {
              const isActionColumn = header === "Aksi";

              return (
                <th
                  key={header}
                  className={`px-3 py-3 font-bold ${
                    stickyAction && isActionColumn
                      ? "sticky right-0 z-30 min-w-[150px] bg-[#0f1115] shadow-[-12px_0_18px_rgba(0,0,0,0.45)]"
                      : ""
                  }`}
                >
                  {header}
                </th>
              );
            })}
          </tr>
        </thead>

        <tbody className="divide-y divide-white/5">
          {batches.map((batch) => (
            <tr
              key={batch.id}
              className={`${
                selectedBatchId === batch.id
                  ? "bg-teal-500/10"
                  : "hover:bg-white/[0.03]"
              }`}
            >
              <td className="min-w-[180px] whitespace-nowrap px-3 py-3 font-mono font-bold text-white">
                {batch.noPengajuan}
              </td>

              <td className="min-w-[260px] px-3 py-3 text-slate-300">
                {batch.principleName}
              </td>

              <td className="px-3 py-3 font-mono text-teal-300">
                {batch.principleCode}
              </td>

              <td className="px-3 py-3 text-right font-mono text-emerald-300">
                Rp{" "}
                {Number(batch.summary?.totalNominal || 0).toLocaleString(
                  "id-ID",
                )}
              </td>

              <td className="px-3 py-3">
                <span
                  className={`inline-flex rounded-md border px-2 py-1 text-xs font-bold ${statusClass(batch.status)}`}
                >
                  {displayStatusLabel(batch.status)}
                </span>
              </td>

              <td className="px-3 py-3 text-slate-300">
                {displayStatusLabel(batch.smStatus)}
              </td>

              <td className="px-3 py-3 text-slate-300">
                {displayStatusLabel(batch.claimStatus)}
              </td>

              <td className="px-3 py-3 text-slate-300">
                {displayStatusLabel(batch.omStatus)}
              </td>

              <td className="px-3 py-3 text-slate-300">
                {displayStatusLabel(batch.financeStatus)}
              </td>

              <td className="px-3 py-3 text-slate-300">
                {displayStatusLabel(batch.finalStatus)}
              </td>

              <td className="min-w-[180px] px-3 py-3 text-xs text-slate-400">
                <div>Dibuat: {formatDateDisplay(batch.createdAt)}</div>
                <div>Diperbarui: {formatDateDisplay(batch.updatedAt)}</div>
              </td>

              <td
                className={`px-3 py-3 ${
                  stickyAction
                    ? "sticky right-0 z-20 min-w-[150px] bg-[#0f1115] shadow-[-12px_0_18px_rgba(0,0,0,0.45)]"
                    : ""
                }`}
              >
                <button
                  onClick={() => onSelect(batch)}
                  className="w-full rounded-lg border border-teal-500/30 bg-teal-500/10 px-3 py-2 text-xs font-bold text-teal-200 hover:bg-teal-500/20"
                >
                  {actionLabel(batch)}
                </button>
              </td>
            </tr>
          ))}

          {batches.length === 0 && (
            <tr>
              <td colSpan={12} className="px-3 py-6 text-center text-slate-500">
                {emptyText}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function FinanceMonitoringTable({
  batches,
  selectedBatchId,
  onSelect,
}: {
  batches: OffApiBatch[];
  selectedBatchId?: string | null;
  onSelect: (batch: OffApiBatch) => void;
}) {
  const headers = [
    "No Pengajuan",
    "Batch",
    "Principle",
    "Kode Principle",
    "Jumlah Baris",
    "Total Nominal",
    "Status Keuangan",
    "Status Final",
    "Total Dibayar",
    "Sisa Pembayaran",
    "Status",
    "Aksi",
  ];

  return (
    <div className="overflow-x-auto rounded-xl border border-white/10">
      <table className="w-full min-w-[1650px] text-left text-sm">
        <thead className="border-b border-white/10 bg-black/50 text-xs uppercase tracking-wider text-slate-500">
          <tr>
            {headers.map((header) => (
              <th
                key={header}
                className={`px-3 py-3 font-bold ${
                  header === "Aksi"
                    ? "sticky right-0 z-30 min-w-[160px] bg-[#0f1115] shadow-[-12px_0_18px_rgba(0,0,0,0.45)]"
                    : ""
                }`}
              >
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-white/5">
          {batches.map((batch) => {
            const summary = batch.summary || {
              totalRows: 0,
              rowCount: 0,
              totalNominal: 0,
            };
            const paymentSummary = batch.paymentSummary || {
              totalPaid: Number(batch.paidAmount || 0),
              remainingAmount: Math.max(
                0,
                Number(summary.totalNominal || 0) -
                  Number(batch.paidAmount || 0),
              ),
            };

            return (
              <tr
                key={batch.id}
                className={
                  selectedBatchId === batch.id
                    ? "bg-teal-500/10"
                    : "hover:bg-white/[0.03]"
                }
              >
                <td className="min-w-[180px] whitespace-nowrap px-3 py-3 font-mono font-bold text-white">
                  {batch.noPengajuan}
                </td>
                <td className="px-3 py-3 text-slate-300">
                  Gelombang {batch.gelombang || "-"}
                </td>
                <td className="min-w-[260px] px-3 py-3 text-slate-300">
                  {batch.principleName}
                </td>
                <td className="px-3 py-3 font-mono text-teal-300">
                  {batch.principleCode}
                </td>
                <td className="px-3 py-3 text-center text-slate-300">
                  {summary.totalRows || summary.rowCount || 0}
                </td>
                <td className="px-3 py-3 text-right font-mono text-emerald-300">
                  Rp {Number(summary.totalNominal || 0).toLocaleString("id-ID")}
                </td>
                <td className="px-3 py-3 text-slate-300">
                  {displayStatusLabel(batch.financeStatus)}
                </td>
                <td className="px-3 py-3 text-slate-300">
                  {displayStatusLabel(batch.finalStatus)}
                </td>
                <td className="px-3 py-3 text-right font-mono text-sky-300">
                  Rp{" "}
                  {Number(paymentSummary.totalPaid || 0).toLocaleString(
                    "id-ID",
                  )}
                </td>
                <td className="px-3 py-3 text-right font-mono text-amber-300">
                  Rp{" "}
                  {Number(paymentSummary.remainingAmount || 0).toLocaleString(
                    "id-ID",
                  )}
                </td>
                <td className="px-3 py-3">
                  <span
                    className={`inline-flex rounded-md border px-2 py-1 text-xs font-bold ${statusClass(batch.status)}`}
                  >
                    {displayStatusLabel(batch.status)}
                  </span>
                </td>
                <td className="sticky right-0 z-20 min-w-[160px] bg-[#0f1115] px-3 py-3 shadow-[-12px_0_18px_rgba(0,0,0,0.45)]">
                  <button
                    onClick={() => onSelect(batch)}
                    className="w-full rounded-lg border border-teal-500/30 bg-teal-500/10 px-3 py-2 text-xs font-bold text-teal-200 hover:bg-teal-500/20"
                  >
                    {financeActionLabel(batch)}
                  </button>
                </td>
              </tr>
            );
          })}
          {batches.length === 0 && (
            <tr>
              <td colSpan={12} className="px-3 py-6 text-center text-slate-500">
                Belum ada batch pembayaran yang cocok.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function Field({ label, value = "" }: { label: string; value?: string }) {
  return (
    <label className="block">
      <span className="text-xs text-slate-500 font-semibold">{label}</span>
      <input
        readOnly
        value={value}
        placeholder={label}
        className="mt-1 w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-slate-300 outline-none placeholder:text-slate-600"
      />
    </label>
  );
}

function EditableField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="block">
      <span className="text-xs text-slate-500 font-semibold">{label}</span>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="mt-1 w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-slate-200 outline-none focus:border-teal-500/50"
      />
    </label>
  );
}

function DateField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="block">
      <span className="text-xs text-slate-500 font-semibold">{label}</span>
      <input
        type="date"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="mt-1 w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-slate-200 outline-none [color-scheme:dark] focus:border-teal-500/50"
      />
    </label>
  );
}

function PrincipleSelect({
  label,
  value,
  onChange,
  compact = false,
}: {
  label?: string;
  value: string;
  onChange: (value: string) => void;
  compact?: boolean;
}) {
  return (
    <label className="block">
      {label && (
        <span className="text-xs text-slate-500 font-semibold">{label}</span>
      )}
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={`${label ? "mt-1" : ""} w-full rounded-lg border border-white/10 bg-black/40 px-3 ${compact ? "py-2 min-w-[250px]" : "py-2.5"} text-sm text-slate-200 outline-none focus:border-teal-500/50`}
      >
        {PRINCIPLE_OPTIONS.map((item) => (
          <option key={item.code} value={item.name} className="bg-[#1a1c23]">
            {item.name}
          </option>
        ))}
      </select>
    </label>
  );
}

function TextArea({ label, value = "" }: { label: string; value?: string }) {
  return (
    <label className="block">
      <span className="text-xs text-slate-500 font-semibold">{label}</span>
      <textarea
        readOnly
        value={value}
        placeholder={label}
        rows={4}
        className="mt-1 w-full resize-none rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-slate-300 outline-none placeholder:text-slate-600"
      />
    </label>
  );
}

function Panel({
  title,
  icon: Icon,
  children,
}: {
  title: string;
  icon: ElementType;
  children: ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-white/10 bg-[#1a1c23]/60 p-5 shadow-xl">
      <h2 className="text-lg font-bold text-white flex items-center gap-2 mb-5">
        <Icon className="text-teal-300" size={20} /> {title}
      </h2>
      {children}
    </section>
  );
}

function ReadOnlyPresenceBadge({ value }: { value: boolean }) {
  return value ? (
    <span className="inline-flex rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 text-xs font-bold text-emerald-300">
      Ada
    </span>
  ) : (
    <span className="text-xs font-bold text-slate-600">-</span>
  );
}

function InfoNote({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-xl border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-200 flex items-start gap-2">
      <AlertTriangle size={18} className="shrink-0 mt-0.5" />
      <p>{children}</p>
    </div>
  );
}

function MetricsGrid({ metrics }: { metrics: MetricItem[] }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
      {metrics.map((metric) => {
        const Icon = metric.icon;
        return (
          <div
            key={metric.label}
            className="rounded-2xl border border-white/10 bg-[#1a1c23]/60 p-5 shadow-xl"
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-sm text-slate-400">{metric.label}</p>
                <p className="mt-2 text-3xl font-black text-white">
                  {metric.value}
                </p>
              </div>
              <div className="w-11 h-11 rounded-xl bg-black/40 border border-white/10 flex items-center justify-center">
                <Icon className={metric.tone} size={22} />
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function WorkflowStepper() {
  return (
    <div className="rounded-2xl border border-white/10 bg-[#1a1c23]/60 p-5 shadow-xl">
      <div className="flex items-center justify-between gap-4 mb-5">
        <div>
          <h2 className="text-lg font-bold text-white">Alur Persetujuan</h2>
          <p className="text-sm text-slate-400">
            Alur batch dari input massal sampai verifikasi final pembayaran
            Claim.
          </p>
        </div>
        <span className="hidden sm:inline-flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-teal-300">
          <ArrowRight size={14} /> Alur Batch
        </span>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-7 gap-3">
        {workflowSteps.map((step, index) => (
          <div
            key={step}
            className="relative rounded-xl border border-white/10 bg-black/30 p-4 min-h-28"
          >
            <div className="flex items-center justify-between mb-4">
              <span className="w-8 h-8 rounded-lg bg-teal-500/10 border border-teal-500/30 text-teal-300 flex items-center justify-center text-sm font-black">
                {index + 1}
              </span>
              {index < workflowSteps.length - 1 && (
                <ArrowRight
                  className="hidden xl:block text-slate-600"
                  size={16}
                />
              )}
            </div>
            <p className="text-sm font-bold text-white leading-snug">{step}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

function OverviewMonitoringTable({
  batches,
  selectedBatchId,
  onSelect,
}: {
  batches: OffApiBatch[];
  selectedBatchId?: string | null;
  onSelect: (batch: OffApiBatch) => void;
}) {
  const headers = [
    "No Pengajuan",
    "Batch",
    "Principle",
    "Kode Principle",
    "Jumlah Baris",
    "Total Nominal",
    "Status SM",
    "Status Claim",
    "Status OM",
    "Status Keuangan",
    "Status Final",
    "Status",
    "Aksi",
  ];
  return (
    <div className="rounded-2xl border border-white/10 bg-[#1a1c23]/60 overflow-hidden shadow-xl">
      <div className="p-5 border-b border-white/10 bg-black/30">
        <h2 className="text-lg font-bold text-white flex items-center gap-2">
          <ReceiptText className="text-teal-300" size={20} /> Monitoring Batch
          Pengajuan
        </h2>
        <p className="text-sm text-slate-400 mt-1">
          Pilih batch untuk melihat detail baca-saja.
        </p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[1750px] text-sm text-left">
          <thead className="bg-black/50 text-xs uppercase tracking-wider text-slate-500 border-b border-white/10">
            <tr>
              {headers.map((col) => {
                const isActionColumn = col === "Aksi";
                return (
                  <th
                    key={col}
                    className={`px-4 py-3 font-bold ${col === "No Pengajuan" ? "min-w-[180px]" : ""} ${
                      isActionColumn
                        ? "sticky right-0 z-30 min-w-[150px] bg-[#0f1115] shadow-[-12px_0_18px_rgba(0,0,0,0.45)]"
                        : ""
                    }`}
                  >
                    {col}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5">
            {batches.map((batch) => {
              const summary = batch.summary || {
                totalRows: 0,
                rowCount: 0,
                totalNominal: 0,
              };
              return (
                <tr
                  key={batch.id}
                  className={
                    selectedBatchId === batch.id
                      ? "bg-teal-500/10"
                      : "hover:bg-white/[0.03]"
                  }
                >
                  <td className="px-4 py-4 min-w-[180px] whitespace-nowrap font-mono font-bold text-white">
                    {batch.noPengajuan}
                  </td>
                  <td className="px-4 py-4 text-slate-300">
                    Gelombang {batch.gelombang || "-"}
                  </td>
                  <td className="px-4 py-4 text-slate-300 min-w-[260px]">
                    {batch.principleName}
                  </td>
                  <td className="px-4 py-4 font-mono text-teal-300">
                    {batch.principleCode}
                  </td>
                  <td className="px-4 py-4 text-center text-slate-300">
                    {summary.totalRows || summary.rowCount || 0}
                  </td>
                  <td className="px-4 py-4 text-right font-mono text-emerald-300">
                    Rp{" "}
                    {Number(summary.totalNominal || 0).toLocaleString("id-ID")}
                  </td>
                  <td className="px-4 py-4 text-slate-300">
                    {displayStatusLabel(batch.smStatus)}
                  </td>
                  <td className="px-4 py-4 text-slate-300">
                    {displayStatusLabel(batch.claimStatus)}
                  </td>
                  <td className="px-4 py-4 text-slate-300">
                    {displayStatusLabel(batch.omStatus)}
                  </td>
                  <td className="px-4 py-4 text-slate-300">
                    {displayStatusLabel(batch.financeStatus)}
                  </td>
                  <td className="px-4 py-4 text-slate-300">
                    {displayStatusLabel(batch.finalStatus)}
                  </td>
                  <td className="px-4 py-4">
                    <span
                      className={`inline-flex px-2.5 py-1 rounded-md border text-xs font-bold ${statusClass(batch.status)}`}
                    >
                      {displayStatusLabel(batch.status)}
                    </span>
                  </td>
                  <td className="sticky right-0 z-20 min-w-[150px] bg-[#0f1115] px-4 py-4 shadow-[-12px_0_18px_rgba(0,0,0,0.45)]">
                    <button
                      onClick={() => onSelect(batch)}
                      className="w-full rounded-lg border border-teal-500/30 bg-teal-500/10 px-3 py-2 text-xs font-bold text-teal-200 hover:bg-teal-500/20"
                    >
                      Lihat Detail
                    </button>
                  </td>
                </tr>
              );
            })}
            {batches.length === 0 && (
              <tr>
                <td
                  colSpan={13}
                  className="px-4 py-6 text-center text-sm text-slate-500"
                >
                  Belum ada batch OFF Program Control.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function BatchOverviewActionTable({
  batches,
  selectedBatchId,
  onSelect,
  actionLabel,
  emptyText = "Belum ada batch pengajuan.",
}: {
  batches: OffApiBatch[];
  selectedBatchId?: string | null;
  onSelect: (batch: OffApiBatch) => void;
  actionLabel: (batch: OffApiBatch) => string;
  emptyText?: string;
}) {
  const headers = [
    "No Pengajuan",
    "Batch",
    "Principle",
    "Kode Principle",
    "Jumlah Baris",
    "Total Nominal",
    "Status SM",
    "Status Claim",
    "Status OM",
    "Status",
    "Aksi",
  ];

  return (
    <div className="rounded-2xl border border-white/10 bg-[#1a1c23]/60 overflow-hidden shadow-xl">
      <div className="p-5 border-b border-white/10 bg-black/30">
        <h2 className="text-lg font-bold text-white flex items-center gap-2">
          <ReceiptText className="text-teal-300" size={20} /> Monitoring Batch
          Pengajuan
        </h2>
        <p className="text-sm text-slate-400 mt-1">
          Pilih batch untuk membuka detail review.
        </p>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[1550px] text-sm text-left">
          <thead className="bg-black/50 text-xs uppercase tracking-wider text-slate-500 border-b border-white/10">
            <tr>
              {headers.map((col) => {
                const isActionColumn = col === "Aksi";

                return (
                  <th
                    key={col}
                    className={`px-4 py-3 font-bold ${
                      col === "No Pengajuan" ? "min-w-[180px]" : ""
                    } ${
                      isActionColumn
                        ? "sticky right-0 z-30 min-w-[150px] bg-[#0f1115] shadow-[-12px_0_18px_rgba(0,0,0,0.45)]"
                        : ""
                    }`}
                  >
                    {col}
                  </th>
                );
              })}
            </tr>
          </thead>

          <tbody className="divide-y divide-white/5">
            {batches.map((batch) => {
              const summary = batch.summary || {
                totalRows: 0,
                rowCount: 0,
                totalNominal: 0,
              };

              return (
                <tr
                  key={batch.id}
                  className={`${
                    selectedBatchId === batch.id
                      ? "bg-teal-500/10"
                      : "hover:bg-white/[0.03]"
                  }`}
                >
                  <td className="px-4 py-4 min-w-[180px] whitespace-nowrap font-mono font-bold text-white">
                    {batch.noPengajuan}
                  </td>

                  <td className="px-4 py-4 text-slate-300">
                    Gelombang {batch.gelombang || "-"}
                  </td>

                  <td className="px-4 py-4 text-slate-300 min-w-[260px]">
                    {batch.principleName}
                  </td>

                  <td className="px-4 py-4 font-mono text-teal-300">
                    {batch.principleCode}
                  </td>

                  <td className="px-4 py-4 text-center text-slate-300">
                    {summary.totalRows || summary.rowCount || 0}
                  </td>

                  <td className="px-4 py-4 text-right font-mono text-emerald-300">
                    Rp{" "}
                    {Number(summary.totalNominal || 0).toLocaleString("id-ID")}
                  </td>

                  <td className="px-4 py-4 text-slate-300">
                    {displayStatusLabel(batch.smStatus)}
                  </td>

                  <td className="px-4 py-4 text-slate-300">
                    {displayStatusLabel(batch.claimStatus)}
                  </td>

                  <td className="px-4 py-4 text-slate-300">
                    {displayStatusLabel(batch.omStatus)}
                  </td>

                  <td className="px-4 py-4">
                    <span
                      className={`inline-flex px-2.5 py-1 rounded-md border text-xs font-bold ${statusClass(batch.status)}`}
                    >
                      {displayStatusLabel(batch.status)}
                    </span>
                  </td>

                  <td className="sticky right-0 z-20 min-w-[150px] bg-[#0f1115] px-4 py-4 shadow-[-12px_0_18px_rgba(0,0,0,0.45)]">
                    <button
                      onClick={() => onSelect(batch)}
                      className="w-full rounded-lg border border-teal-500/30 bg-teal-500/10 px-3 py-2 text-xs font-bold text-teal-200 hover:bg-teal-500/20"
                    >
                      {actionLabel(batch)}
                    </button>
                  </td>
                </tr>
              );
            })}

            {batches.length === 0 && (
              <tr>
                <td
                  colSpan={11}
                  className="px-4 py-6 text-center text-sm text-slate-500"
                >
                  {emptyText}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SupervisorDashboard({ offRole }: OffDashboardProps) {
  const canSubmitSupervisor = canPerformOffAction(offRole, "submit_batch");
  const canEditSupervisor = canPerformOffAction(offRole, "edit_returned_batch");
  const [supervisorMenu, setSupervisorMenu] = useState<
    "pengajuan" | "monitoring"
  >("pengajuan");
  const [supervisorName, setSupervisorName] = useState("Supervisor Area 1");
  const [batchPrinciple, setBatchPrinciple] = useState("RECKITT BENCKISER, PT");
  const [gelombangInput, setGelombangInput] = useState("001");
  const [bulanInput, setBulanInput] = useState("05");
  const [tahunInput, setTahunInput] = useState("2026");
  const [submitStatus, setSubmitStatus] = useState("");
  const [submitResult, setSubmitResult] = useState<{
    batchId: string;
    noPengajuan: string;
    rowCount: number;
    pdfUrl: string;
    total: number;
    transfer: number;
    tunai: number;
  } | null>(null);
  const [pdfUrl, setPdfUrl] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [rows, setRows] = useState<SupervisorBulkRow[]>(initialBulkRows);
  const [allSupervisorBatches, setAllSupervisorBatches] = useState<
    OffApiBatch[]
  >([]);
  const [monitoringSearch, setMonitoringSearch] = useState("");
  const [monitoringStatusFilter, setMonitoringStatusFilter] = useState("");
  const [returnedBatches, setReturnedBatches] = useState<OffApiBatch[]>([]);
  const [returnedSummaries, setReturnedSummaries] = useState<
    Record<string, BatchQueueSummary>
  >({});
  const [editingBatchId, setEditingBatchId] = useState("");
  const [editingLocked, setEditingLocked] = useState(false);
  const [returnNote, setReturnNote] = useState("");
  const [returnedStatus, setReturnedStatus] = useState("");
  const gelombang = gelombangInput.padStart(3, "0");
  const bulan = bulanInput.padStart(2, "0");
  const tahun = tahunInput;
  const batchCode = getPrincipleCode(batchPrinciple);
  const generatedNo = `${gelombang}/${batchCode}/${bulan}/${tahun}`;

  const loadReturnedBatches = async () => {
    try {
      const response = await fetch("/api/off-program-control/batches", {
        credentials: "include",
      });
      const data = await parseJsonResponse(response);
      if (!response.ok || !data.ok)
        throw new Error(
          String(data.error || "Gagal mengambil batch yang dikembalikan."),
        );
      const allBatches = Array.isArray(data.batches)
        ? (data.batches as OffApiBatch[])
        : [];
      setAllSupervisorBatches(allBatches);
      const returned = allBatches.filter(
        (batch) =>
          batch.status === "Draft" ||
          batch.status === "Returned by SM" ||
          batch.smStatus === "Returned" ||
          batch.status === "Returned by Claim" ||
          batch.claimStatus === "Returned",
      );
      setReturnedBatches(returned);
      const entries = await Promise.all(
        returned.map(async (batch) => {
          try {
            const detailRes = await fetch(
              `/api/off-program-control/batches/${batch.id}`,
              { credentials: "include" },
            );
            const detailData = await parseJsonResponse(detailRes);
            const items =
              detailRes.ok && detailData.ok && Array.isArray(detailData.items)
                ? (detailData.items as OffApiItem[])
                : [];
            return [
              batch.id,
              {
                rowCount: items.length,
                totalNominal: items.reduce(
                  (total, item) => total + Number(item.nominal || 0),
                  0,
                ),
              },
            ] as const;
          } catch {
            return [batch.id, { rowCount: 0, totalNominal: 0 }] as const;
          }
        }),
      );
      setReturnedSummaries(Object.fromEntries(entries));
    } catch (error) {
      setReturnedStatus(
        error instanceof Error
          ? error.message
          : "Gagal mengambil batch yang dikembalikan.",
      );
    }
  };

  useEffect(() => {
    loadReturnedBatches();
  }, []);

  const updateBatchPrinciple = (nextValue: string) => {
    setBatchPrinciple(nextValue);
  };

  const openReturnedBatch = async (batch: OffApiBatch) => {
    setReturnedStatus("Memuat batch revisi...");
    setSubmitStatus("");
    setPdfUrl(batch.pdfUrl || "");
    setSubmitResult(null);
    try {
      const response = await fetch(
        `/api/off-program-control/batches/${batch.id}`,
        { credentials: "include" },
      );
      const data = await parseJsonResponse(response);
      if (!response.ok || !data.ok)
        throw new Error(
          String(data.error || "Gagal membuka detail batch yang dikembalikan."),
        );
      const detailBatch = data.batch as OffApiBatch;
      const detailItems = Array.isArray(data.items)
        ? (data.items as OffApiItem[])
        : [];
      setEditingBatchId(detailBatch.id);
      setEditingLocked(!isSupervisorEditableBatch(detailBatch));
      setReturnNote(detailBatch.claimNote || detailBatch.smNote || "");
      setSupervisorName(detailBatch.supervisorName || "Supervisor Area 1");
      setGelombangInput(detailBatch.gelombang || "001");
      setBatchPrinciple(detailBatch.principleName || "RECKITT BENCKISER, PT");
      setBulanInput(detailBatch.bulan || "05");
      setTahunInput(detailBatch.tahun || "2026");
      setRows(
        detailItems.length
          ? detailItems.map(apiItemToBulkRow)
          : [createEmptyBulkRow(1)],
      );
      setReturnedStatus(
        !isSupervisorEditableBatch(detailBatch)
          ? "Batch ini baca-saja karena sudah dikirim/disetujui atau terkunci."
          : detailBatch.status === "Draft"
            ? `Draf ${detailBatch.noPengajuan} siap diedit.`
            : `Batch ${detailBatch.noPengajuan} siap direvisi.`,
      );
      setSupervisorMenu("pengajuan");
    } catch (error) {
      setReturnedStatus(
        error instanceof Error
          ? error.message
          : "Gagal membuka batch yang dikembalikan.",
      );
    }
  };

  const addRow = () => {
    if (editingLocked) return;
    setRows((currentRows) => [
      ...currentRows,
      createEmptyBulkRow(currentRows.length + 1),
    ]);
  };

  const deleteRow = (rowId: string) => {
    if (editingLocked) return;
    setRows((currentRows) =>
      currentRows.length > 1
        ? currentRows.filter((row) => row.id !== rowId)
        : currentRows,
    );
  };

  const updateRow = (
    rowId: string,
    field: keyof SupervisorBulkRow,
    value: string | boolean,
  ) => {
    if (editingLocked) return;
    setRows((currentRows) =>
      currentRows.map((row) =>
        row.id === rowId ? { ...row, [field]: value } : row,
      ),
    );
  };

  const buildSupervisorItems = () =>
    rows.map((row) => ({
      noSurat: row.noSurat,
      namaProgram: row.namaProgram,
      periodeAwal: row.periodeAwal,
      periodeAkhir: row.periodeAkhir,
      periode: buildPeriodString(row.periodeAwal, row.periodeAkhir),
      toko: row.toko,
      barang: row.barang,
      nominal: row.nominal,
      caraBayar: row.caraBayar,
      type: row.type,
      deadline: row.deadline,
      kwt: row.kwt,
      skp: row.skp,
      fp: row.fp,
      pc: row.pc,
      foto: row.foto,
      rekap: row.rekap,
      others: row.others,
      othersText: row.othersText,
    }));

  const saveDraft = async () => {
    if (editingLocked) {
      setSubmitStatus("Batch baca-saja dan tidak bisa disimpan sebagai draf.");
      return;
    }
    setIsSubmitting(true);
    setSubmitStatus("Menyimpan draf massal...");
    setSubmitResult(null);
    try {
      const items = buildSupervisorItems();
      const response = await fetch(
        editingBatchId
          ? `/api/off-program-control/batches/${editingBatchId}`
          : "/api/off-program-control/batches",
        {
          method: editingBatchId ? "PATCH" : "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            supervisorName,
            gelombang,
            principleCode: batchCode,
            principleName: batchPrinciple,
            bulan,
            tahun,
            items,
          }),
        },
      );
      const data = await parseJsonResponse(response);
      if (!response.ok || !data.ok)
        throw new Error(
          String(data.message || data.error || "Gagal menyimpan draf."),
        );
      const savedBatchId = editingBatchId || String(data.batchId || "");
      setEditingBatchId(savedBatchId);
      setEditingLocked(false);
      setSubmitStatus(
        `Draf ${data.noPengajuan || generatedNo} berhasil disimpan.`,
      );
      await loadReturnedBatches();
    } catch (error) {
      setSubmitStatus(
        error instanceof Error ? error.message : "Gagal menyimpan draf.",
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleSubmitBatch = async () => {
    if (editingLocked) {
      setSubmitStatus(
        "Batch sudah disetujui oleh SM dan terkunci untuk Supervisor.",
      );
      return;
    }
    setIsSubmitting(true);
    setSubmitStatus(
      editingBatchId
        ? "Menyimpan revisi dan mengirim ulang ke Sales Manager..."
        : "Menyimpan batch dan membuat PDF...",
    );
    setPdfUrl("");
    setSubmitResult(null);
    try {
      const items = buildSupervisorItems();
      const localSummary = computeUiPaymentSummary(items);
      const saveRes = await fetch(
        editingBatchId
          ? `/api/off-program-control/batches/${editingBatchId}`
          : "/api/off-program-control/batches",
        {
          method: editingBatchId ? "PATCH" : "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            supervisorName,
            gelombang,
            principleCode: batchCode,
            principleName: batchPrinciple,
            bulan,
            tahun,
            items,
          }),
        },
      );
      const saveData = await parseJsonResponse(saveRes);
      if (saveData.code === "ALREADY_SUBMITTED") {
        const existingPdfUrl = String(saveData.pdfUrl || "");
        setPdfUrl(existingPdfUrl);
        setSubmitResult({
          batchId: String(saveData.existingBatchId || "-"),
          noPengajuan: String(saveData.noPengajuan || generatedNo),
          rowCount: items.length,
          total: localSummary.total,
          transfer: localSummary.transfer,
          tunai: localSummary.tunai,
          pdfUrl: existingPdfUrl,
        });
        setSubmitStatus(
          "Pengajuan ini sudah pernah dikirim. Silakan cek PDF atau lanjutkan alur persetujuan.",
        );
        return;
      }
      if (!saveRes.ok || !saveData.ok)
        throw new Error(
          String(saveData.message || saveData.error || "Gagal menyimpan batch"),
        );
      const savedBatchId = editingBatchId || String(saveData.batchId || "");

      const submitRes = await fetch(
        `/api/off-program-control/batches/${savedBatchId}/submit`,
        {
          method: "POST",
          credentials: "include",
        },
      );
      const submitData = await parseJsonResponse(submitRes);
      if (!submitRes.ok || !submitData.ok)
        throw new Error(String(submitData.error || "Gagal mengirim batch"));

      setPdfUrl(String(submitData.pdfUrl || ""));
      setSubmitResult({
        batchId: String(submitData.batchId || savedBatchId),
        noPengajuan: String(submitData.noPengajuan || generatedNo),
        rowCount: items.length,
        total: Number(
          (submitData.summary as { total?: number } | undefined)?.total ||
            localSummary.total,
        ),
        transfer: Number(
          (submitData.summary as { transfer?: number } | undefined)?.transfer ||
            localSummary.transfer,
        ),
        tunai: Number(
          (submitData.summary as { tunai?: number } | undefined)?.tunai ||
            localSummary.tunai,
        ),
        pdfUrl: String(submitData.pdfUrl || ""),
      });
      setSubmitStatus(
        `Batch ${submitData.noPengajuan} berhasil dikirim. PDF berhasil dibuat.`,
      );
      setEditingBatchId("");
      setReturnNote("");
      await loadReturnedBatches();
      if (submitData.pdfUrl) window.open(String(submitData.pdfUrl), "_blank");
    } catch (error) {
      setSubmitStatus(
        error instanceof Error ? error.message : "Gagal mengirim batch.",
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  const supervisorMonitoringStatusOptions =
    getBatchStatusOptions(allSupervisorBatches);

  const filteredSupervisorMonitoringBatches = filterBatchesByMainStatus(
    filterBatchesBySearch(allSupervisorBatches, monitoringSearch),
    monitoringStatusFilter,
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap gap-2 rounded-2xl border border-white/10 bg-[#1a1c23]/60 p-2">
        {[
          ["pengajuan", "Pengajuan"],
          ["monitoring", "Monitoring Semua Status"],
        ].map(([key, label]) => (
          <button
            key={key}
            onClick={() => setSupervisorMenu(key as "pengajuan" | "monitoring")}
            className={`rounded-xl px-4 py-2.5 text-sm font-bold transition-colors ${
              supervisorMenu === key
                ? "border border-teal-500/30 bg-teal-500/20 text-teal-200"
                : "border border-transparent text-slate-400 hover:bg-white/5 hover:text-white"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {supervisorMenu === "monitoring" && (
        <Panel title="Monitoring Semua Status" icon={ReceiptText}>
          <div className="mb-4 grid grid-cols-1 gap-3 xl:grid-cols-[1fr_280px]">
            <MonitoringSearch
              value={monitoringSearch}
              onChange={setMonitoringSearch}
            />

            <StatusFilterSelect
              value={monitoringStatusFilter}
              onChange={setMonitoringStatusFilter}
              options={supervisorMonitoringStatusOptions}
            />
          </div>

          <BatchMonitoringTable
            batches={filteredSupervisorMonitoringBatches}
            selectedBatchId={editingBatchId}
            stickyAction
            onSelect={openReturnedBatch}
            actionLabel={(batch) =>
              batch.status === "Draft"
                ? "Buka Draf"
                : isSupervisorEditableBatch(batch)
                  ? "Buka Revisi"
                  : "Lihat Detail"
            }
          />
        </Panel>
      )}

      {supervisorMenu === "pengajuan" && (
        <>
          <Panel
            title="Draf / Dikembalikan / Perlu Revisi"
            icon={AlertTriangle}
          >
            {returnedStatus && (
              <div className="mb-4 rounded-xl border border-white/10 bg-black/30 px-4 py-3 text-sm text-slate-300">
                {returnedStatus}
              </div>
            )}
            {returnNote && (
              <div className="mb-4 rounded-xl border border-rose-500/20 bg-rose-500/10 px-4 py-3 text-sm text-rose-100">
                <span className="font-bold">Catatan SM:</span> {returnNote}
              </div>
            )}
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
              {returnedBatches.map((batch) => {
                const summary = returnedSummaries[batch.id] || {
                  rowCount: 0,
                  totalNominal: 0,
                };
                return (
                  <div
                    key={batch.id}
                    className="rounded-xl border border-white/10 bg-black/30 p-4"
                  >
                    <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                      <div>
                        <p className="font-mono text-sm font-bold text-white">
                          {batch.noPengajuan}
                        </p>
                        <p className="mt-1 text-sm text-slate-300">
                          {batch.principleName}{" "}
                          <span className="font-mono text-teal-300">
                            ({batch.principleCode})
                          </span>
                        </p>
                        <p className="mt-2 text-xs text-slate-500">
                          Baris: {summary.rowCount} | Total: Rp{" "}
                          {summary.totalNominal.toLocaleString("id-ID")}
                        </p>
                        <p className="mt-2 text-sm text-rose-200">
                          {batch.claimNote ||
                            batch.smNote ||
                            "Tidak ada catatan pengembalian."}
                        </p>
                        <span
                          className={`mt-3 inline-flex rounded-md border px-2 py-1 text-xs font-bold ${statusClass(batch.status)}`}
                        >
                          {displayStatusLabel(batch.status)}
                        </span>
                      </div>
                      {canEditSupervisor && (
                        <button
                          onClick={() => openReturnedBatch(batch)}
                          className="inline-flex items-center justify-center rounded-xl border border-teal-500/30 bg-teal-500/10 px-4 py-2 text-sm font-bold text-teal-200 hover:bg-teal-500/20"
                        >
                          Buka Revisi
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
              {returnedBatches.length === 0 && (
                <p className="text-sm text-slate-400">
                  Belum ada draf atau batch yang dikembalikan/perlu revisi.
                </p>
              )}
            </div>
          </Panel>
          <Panel title="Setup Batch" icon={ClipboardCheck}>
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-6 gap-3">
              <EditableField
                label="Nama Supervisor"
                value={supervisorName}
                onChange={(value) => !editingLocked && setSupervisorName(value)}
              />
              <EditableField
                label="Gelombang Input"
                value={gelombangInput}
                onChange={(value) => !editingLocked && setGelombangInput(value)}
              />
              <PrincipleSelect
                label="Principle"
                value={batchPrinciple}
                onChange={(value) =>
                  !editingLocked && updateBatchPrinciple(value)
                }
              />
              <Field label="Kode Principle" value={batchCode} />
              <EditableField
                label="Bulan"
                value={bulanInput}
                onChange={(value) => !editingLocked && setBulanInput(value)}
              />
              <EditableField
                label="Tahun"
                value={tahunInput}
                onChange={(value) => !editingLocked && setTahunInput(value)}
              />
            </div>
            <div className="mt-4 rounded-xl border border-teal-500/20 bg-teal-500/10 px-4 py-3">
              <p className="text-xs uppercase tracking-wider text-teal-300 font-bold">
                No Pengajuan Otomatis
              </p>
              <p className="mt-1 font-mono text-2xl font-black text-white">
                {generatedNo}
              </p>
            </div>
            {editingBatchId && (
              <div className="mt-4 rounded-xl border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
                Mode revisi batch yang dikembalikan.{" "}
                {editingLocked
                  ? "Batch sudah disetujui oleh SM dan terkunci untuk Supervisor."
                  : "Supervisor dapat mengubah data lalu mengirim ulang ke Sales Manager."}
              </div>
            )}
          </Panel>

          <Panel title="Input Massal Pengajuan Supervisor" icon={FileText}>
            <div className="overflow-x-auto rounded-xl border border-white/10">
              <table className="w-full min-w-[1980px] text-sm text-left">
                <thead className="bg-black/50 text-xs uppercase tracking-wider text-slate-500 border-b border-white/10">
                  <tr>
                    {[
                      "No Pengajuan",
                      "Principle",
                      "Kode Principle",
                      "No Surat",
                      "Nama Program",
                      "Periode Awal",
                      "Periode Akhir",
                      "Toko",
                      "Barang",
                      "Nominal",
                      "Cara Bayar",
                      "Tipe",
                      "Deadline",
                      "Kelengkapan",
                      "Lainnya",
                      "Aksi",
                    ].map((header) => (
                      <th key={header} className="px-3 py-3 font-bold">
                        {header}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                  {rows.map((row) => (
                    <tr
                      key={row.id}
                      className="hover:bg-white/[0.03] align-top"
                    >
                      <td className="px-3 py-3">
                        <input
                          readOnly
                          value={generatedNo}
                          className="w-full min-w-[170px] rounded-lg border border-white/10 bg-slate-900/80 px-3 py-2 text-sm font-mono font-bold text-white outline-none"
                        />
                      </td>
                      <td className="px-3 py-3">
                        <input
                          readOnly
                          value={batchPrinciple}
                          className="w-full min-w-[250px] rounded-lg border border-white/10 bg-slate-900/80 px-3 py-2 text-sm text-slate-200 outline-none"
                        />
                      </td>
                      <td className="px-3 py-3">
                        <input
                          readOnly
                          value={batchCode}
                          className="w-full min-w-[100px] rounded-lg border border-white/10 bg-slate-900/80 px-3 py-2 text-sm font-mono font-bold text-teal-300 outline-none"
                        />
                      </td>
                      <td className="px-3 py-3">
                        <input
                          readOnly={editingLocked}
                          value={row.noSurat}
                          onChange={(event) =>
                            updateRow(row.id, "noSurat", event.target.value)
                          }
                          className="w-full min-w-[130px] rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-slate-200 outline-none focus:border-teal-500/50"
                        />
                      </td>
                      <td className="px-3 py-3">
                        <input
                          readOnly={editingLocked}
                          value={row.namaProgram}
                          onChange={(event) =>
                            updateRow(row.id, "namaProgram", event.target.value)
                          }
                          className="w-full min-w-[150px] rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-slate-200 outline-none focus:border-teal-500/50"
                        />
                      </td>
                      <td className="px-3 py-3">
                        <input
                          type="date"
                          readOnly={editingLocked}
                          value={row.periodeAwal}
                          onChange={(event) =>
                            updateRow(row.id, "periodeAwal", event.target.value)
                          }
                          className="w-full min-w-[150px] rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-slate-200 outline-none [color-scheme:dark] focus:border-teal-500/50"
                        />
                      </td>
                      <td className="px-3 py-3">
                        <input
                          type="date"
                          readOnly={editingLocked}
                          value={row.periodeAkhir}
                          onChange={(event) =>
                            updateRow(
                              row.id,
                              "periodeAkhir",
                              event.target.value,
                            )
                          }
                          className="w-full min-w-[150px] rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-slate-200 outline-none [color-scheme:dark] focus:border-teal-500/50"
                        />
                      </td>
                      <td className="px-3 py-3">
                        <input
                          readOnly={editingLocked}
                          value={row.toko}
                          onChange={(event) =>
                            updateRow(row.id, "toko", event.target.value)
                          }
                          className="w-full min-w-[130px] rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-slate-200 outline-none focus:border-teal-500/50"
                        />
                      </td>
                      <td className="px-3 py-3">
                        <input
                          readOnly={editingLocked}
                          value={row.barang}
                          onChange={(event) =>
                            updateRow(row.id, "barang", event.target.value)
                          }
                          className="w-full min-w-[130px] rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-slate-200 outline-none focus:border-teal-500/50"
                        />
                      </td>
                      <td className="px-3 py-3">
                        <input
                          readOnly={editingLocked}
                          value={row.nominal}
                          onChange={(event) =>
                            updateRow(row.id, "nominal", event.target.value)
                          }
                          placeholder="Rp 0"
                          className="w-full min-w-[130px] rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-slate-200 outline-none focus:border-teal-500/50"
                        />
                      </td>
                      <td className="px-3 py-3">
                        <select
                          disabled={editingLocked}
                          value={row.caraBayar}
                          onChange={(event) =>
                            updateRow(row.id, "caraBayar", event.target.value)
                          }
                          className="w-full min-w-[150px] rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-slate-200 outline-none focus:border-teal-500/50 disabled:opacity-70"
                        >
                          {offPaymentMethods.map((method) => (
                            <option
                              key={method}
                              className="bg-[#1a1c23]"
                              value={method}
                            >
                              {method}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="px-3 py-3">
                        <input
                          readOnly={editingLocked}
                          value={row.type}
                          onChange={(event) =>
                            updateRow(row.id, "type", event.target.value)
                          }
                          className="w-full min-w-[130px] rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-slate-200 outline-none focus:border-teal-500/50"
                        />
                      </td>
                      <td className="px-3 py-3">
                        <input
                          type="date"
                          readOnly={editingLocked}
                          value={row.deadline}
                          onChange={(event) =>
                            updateRow(row.id, "deadline", event.target.value)
                          }
                          className="w-full min-w-[150px] rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-slate-200 outline-none [color-scheme:dark] focus:border-teal-500/50"
                        />
                      </td>
                      <td className="px-3 py-3">
                        <div className="grid min-w-[260px] grid-cols-2 gap-2">
                          {documentChecks
                            .filter((item) => item !== "Others")
                            .map((item) => (
                              <label
                                key={item}
                                className="flex items-center gap-2 rounded-lg border border-white/10 bg-black/40 px-2 py-1.5 text-xs text-slate-300"
                              >
                                <input
                                  type="checkbox"
                                  checked={Boolean(
                                    row[
                                      item.toLowerCase() as keyof SupervisorBulkRow
                                    ],
                                  )}
                                  onChange={(event) =>
                                    updateRow(
                                      row.id,
                                      item.toLowerCase() as keyof SupervisorBulkRow,
                                      event.target.checked,
                                    )
                                  }
                                  disabled={editingLocked}
                                  className="rounded bg-black/50 border-white/10 text-teal-500"
                                />
                                {item === "Others" ? "Lainnya" : item}
                              </label>
                            ))}
                        </div>
                      </td>
                      <td className="px-3 py-3">
                        <div className="min-w-[220px] space-y-2">
                          <label className="flex items-center gap-2 rounded-lg border border-white/10 bg-black/40 px-2 py-1.5 text-xs text-slate-300">
                            <input
                              type="checkbox"
                              checked={row.others}
                              onChange={(event) =>
                                updateRow(
                                  row.id,
                                  "others",
                                  event.target.checked,
                                )
                              }
                              disabled={editingLocked}
                              className="rounded bg-black/50 border-white/10 text-teal-500"
                            />
                            Lainnya
                          </label>
                          <input
                            readOnly={editingLocked}
                            value={row.othersText}
                            onChange={(event) =>
                              updateRow(
                                row.id,
                                "othersText",
                                event.target.value,
                              )
                            }
                            placeholder="Sebutkan dokumen lainnya"
                            className="w-full rounded-lg border border-white/10 bg-black/40 px-2 py-1.5 text-xs text-slate-200 outline-none placeholder:text-slate-600 focus:border-teal-500/50"
                          />
                        </div>
                      </td>
                      <td className="px-3 py-3">
                        <button
                          onClick={() => deleteRow(row.id)}
                          disabled={editingLocked || rows.length === 1}
                          className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs font-bold text-rose-300 transition-colors hover:bg-rose-500/20 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          Hapus
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mt-5 flex flex-wrap gap-3">
              <button
                onClick={addRow}
                disabled={editingLocked}
                className="inline-flex items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm font-bold text-slate-200 transition-colors hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Plus size={16} /> Tambah Baris
              </button>
              <button
                onClick={saveDraft}
                disabled={isSubmitting || editingLocked}
                className="inline-flex items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm font-bold text-slate-200 transition-colors hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Simpan Draf Massal
              </button>
              {canSubmitSupervisor ? (
                <button
                  onClick={handleSubmitBatch}
                  disabled={isSubmitting || editingLocked}
                  className="inline-flex items-center justify-center gap-2 rounded-xl border border-emerald-500 bg-emerald-600 px-4 py-2.5 text-sm font-bold text-white transition-colors hover:bg-emerald-500 disabled:opacity-50"
                >
                  {isSubmitting
                    ? "Mengirim..."
                    : editingBatchId
                      ? "Kirim Ulang ke Sales Manager"
                      : "Kirim Semua ke Sales Manager"}
                </button>
              ) : (
                <span className="rounded-xl border border-white/10 bg-black/30 px-4 py-2.5 text-sm text-slate-400">
                  Baca-saja: role ini tidak bisa mengirim pengajuan Supervisor.
                </span>
              )}
            </div>
            {submitStatus && (
              <div className="mt-4 rounded-xl border border-white/10 bg-black/30 px-4 py-3 text-sm text-slate-300">
                {submitStatus}
              </div>
            )}
            {pdfUrl && (
              <a
                href={pdfUrl}
                target="_blank"
                className="mt-3 inline-flex rounded-xl border border-teal-500/30 bg-teal-500/10 px-4 py-2 text-sm font-bold text-teal-200 hover:bg-teal-500/20"
              >
                Unduh PDF Surat
              </a>
            )}
            {submitResult && (
              <div className="mt-4 rounded-xl border border-white/10 bg-[#0f1115]/80 p-4 text-xs text-slate-400">
                <p className="mb-2 font-bold uppercase tracking-wider text-slate-300">
                  Hasil Pengiriman
                </p>
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-2">
                  <p>
                    Batch ID:{" "}
                    <span className="font-mono text-slate-200">
                      {submitResult.batchId}
                    </span>
                  </p>
                  <p>
                    No Pengajuan:{" "}
                    <span className="font-mono text-slate-200">
                      {submitResult.noPengajuan}
                    </span>
                  </p>
                  <p>
                    Jumlah baris terkirim:{" "}
                    <span className="font-mono text-slate-200">
                      {submitResult.rowCount}
                    </span>
                  </p>
                  <p>
                    Total Nominal:{" "}
                    <span className="font-mono text-slate-200">
                      Rp {submitResult.total.toLocaleString("id-ID")}
                    </span>
                  </p>
                  <p>
                    Transfer:{" "}
                    <span className="font-mono text-slate-200">
                      Rp {submitResult.transfer.toLocaleString("id-ID")}
                    </span>
                  </p>
                  <p>
                    Tunai:{" "}
                    <span className="font-mono text-slate-200">
                      Rp {submitResult.tunai.toLocaleString("id-ID")}
                    </span>
                  </p>
                  <p>
                    PDF URL:{" "}
                    <span className="font-mono text-slate-200 break-all">
                      {submitResult.pdfUrl}
                    </span>
                  </p>
                </div>
              </div>
            )}
            <p className="mt-4 text-sm text-slate-400">
              Kelengkapan yang diisi Supervisor adalah informasi awal. Validasi
              aman/tidaknya tetap ditentukan oleh Claim.
            </p>
          </Panel>

          <Panel title="Status Kunci" icon={ShieldCheck}>
            <div className="space-y-3">
              {[
                "Draft",
                "Submitted to SM",
                "Returned by SM",
                "Approved by SM - Locked",
              ].map((item) => (
                <span
                  key={item}
                  className={`inline-flex mr-2 rounded-md border px-2.5 py-1 text-xs font-bold ${statusClass(item)}`}
                >
                  {displayStatusLabel(item)}
                </span>
              ))}
            </div>
            <p className="mt-4 text-sm text-slate-400">
              Supervisor masih bisa edit saat Draf atau Dikembalikan. Batch yang
              sudah dikirim ke SM atau disetujui/terkunci bersifat baca-saja.
            </p>
          </Panel>
        </>
      )}
    </div>
  );
}

function SalesManagerDashboard({ offRole }: OffDashboardProps) {
  const canReviewSm =
    canPerformOffAction(offRole, "sm_approve") ||
    canPerformOffAction(offRole, "sm_return");
  const [smMenu, setSmMenu] = useState<"monitoring" | "review">("monitoring");
  const [batches, setBatches] = useState<OffApiBatch[]>([]);
  const [smSearch, setSmSearch] = useState("");
  const [smStatusFilter, setSmStatusFilter] = useState("");
  const [selectedBatch, setSelectedBatch] = useState<OffApiBatch | null>(null);
  const [selectedItems, setSelectedItems] = useState<OffApiItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isActionLoading, setIsActionLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [actionMessage, setActionMessage] = useState("");
  const [smNote, setSmNote] = useState("");
  const [notificationPreview, setNotificationPreview] =
    useState<OffNotificationPreview | null>(null);
  const totalNominal = selectedItems.reduce(
    (total, item) => total + Number(item.nominal || 0),
    0,
  );

  const loadBatchDetail = async (batch: OffApiBatch) => {
    setLoadError("");
    const detailRes = await fetch(
      `/api/off-program-control/batches/${batch.id}`,
      { credentials: "include" },
    );
    const detailData = await parseJsonResponse(detailRes);
    if (!detailRes.ok || !detailData.ok)
      throw new Error(
        String(detailData.error || "Gagal mengambil detail batch."),
      );
    setSelectedBatch((detailData.batch as OffApiBatch) || batch);
    setSelectedItems(
      Array.isArray(detailData.items) ? (detailData.items as OffApiItem[]) : [],
    );
  };

  const loadSalesBatches = async (preferredBatchId?: string) => {
    setIsLoading(true);
    setLoadError("");
    try {
      const listRes = await fetch("/api/off-program-control/batches", {
        credentials: "include",
      });
      const listData = await parseJsonResponse(listRes);
      if (!listRes.ok || !listData.ok)
        throw new Error(
          String(listData.error || "Gagal mengambil data batch."),
        );
      const rows = Array.isArray(listData.batches)
        ? (listData.batches as OffApiBatch[])
        : [];
      setBatches(rows);
      const nextBatch =
        rows.find((row) => row.id === preferredBatchId) ||
        selectedBatch ||
        null;
      setSelectedBatch(nextBatch);

      if (!nextBatch) {
        setSelectedItems([]);
        return;
      }

      await loadBatchDetail(nextBatch);
    } catch (error) {
      setLoadError(
        error instanceof Error
          ? error.message
          : "Gagal mengambil data Sales Manager.",
      );
      setSelectedItems([]);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    let isActive = true;

    async function loadInitialData() {
      setIsLoading(true);
      setLoadError("");
      try {
        const listRes = await fetch("/api/off-program-control/batches", {
          credentials: "include",
        });
        const listData = await parseJsonResponse(listRes);
        if (!listRes.ok || !listData.ok)
          throw new Error(
            String(listData.error || "Gagal mengambil data batch."),
          );
        const rows = Array.isArray(listData.batches)
          ? (listData.batches as OffApiBatch[])
          : [];
        const nextBatch = rows[0] || null;
        if (!isActive) return;
        setBatches(rows);
        setSelectedBatch(nextBatch);

        if (!nextBatch) {
          setSelectedItems([]);
          return;
        }

        const detailRes = await fetch(
          `/api/off-program-control/batches/${nextBatch.id}`,
          { credentials: "include" },
        );
        const detailData = await parseJsonResponse(detailRes);
        if (!detailRes.ok || !detailData.ok)
          throw new Error(
            String(detailData.error || "Gagal mengambil detail batch."),
          );
        if (!isActive) return;
        setSelectedBatch((detailData.batch as OffApiBatch) || nextBatch);
        setSelectedItems(
          Array.isArray(detailData.items)
            ? (detailData.items as OffApiItem[])
            : [],
        );
      } catch (error) {
        if (!isActive) return;
        setLoadError(
          error instanceof Error
            ? error.message
            : "Gagal mengambil data Sales Manager.",
        );
        setSelectedItems([]);
      } finally {
        if (isActive) setIsLoading(false);
      }
    }

    loadInitialData();

    return () => {
      isActive = false;
    };
  }, []);

  const selectBatch = async (batch: OffApiBatch) => {
    setSelectedBatch(batch);
    setSmMenu("review");
    setSelectedItems([]);
    setActionMessage("");
    setNotificationPreview(null);
    try {
      await loadBatchDetail(batch);
    } catch (error) {
      setLoadError(
        error instanceof Error
          ? error.message
          : "Gagal mengambil detail batch.",
      );
    }
  };

  const returnToSupervisor = async () => {
    if (!selectedBatch) return;
    const note = smNote.trim();
    if (!note) {
      setActionMessage(
        "Catatan Sales Manager wajib diisi sebelum dikembalikan.",
      );
      return;
    }
    setIsActionLoading(true);
    setActionMessage("");
    try {
      const response = await fetch(
        `/api/off-program-control/batches/${selectedBatch.id}/sm-return`,
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ note }),
        },
      );
      const data = await parseJsonResponse(response);
      if (!response.ok || !data.ok)
        throw new Error(
          String(
            data.error ||
              data.message ||
              "Gagal mengembalikan batch ke Supervisor.",
          ),
        );
      setActionMessage(
        String(data.message || "Pengajuan dikembalikan ke Supervisor."),
      );
      setSmNote("");
      setNotificationPreview(null);
      await loadSalesBatches();
    } catch (error) {
      setActionMessage(
        error instanceof Error
          ? error.message
          : "Gagal mengembalikan batch ke Supervisor.",
      );
    } finally {
      setIsActionLoading(false);
    }
  };

  const approveBatch = async () => {
    if (!selectedBatch) return;
    setIsActionLoading(true);
    setActionMessage("");
    try {
      const response = await fetch(
        `/api/off-program-control/batches/${selectedBatch.id}/sm-approve`,
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ note: smNote }),
        },
      );
      const data = await parseJsonResponse(response);
      if (!response.ok || !data.ok)
        throw new Error(
          String(data.error || data.message || "Gagal menyetujui batch."),
        );
      setActionMessage(
        String(
          data.message ||
            "Pengajuan disetujui Sales Manager dan notifikasi OM dibuat.",
        ),
      );
      setNotificationPreview(
        (data.notification as OffNotificationPreview) || null,
      );
      setSmNote("");
      await loadSalesBatches();
    } catch (error) {
      setActionMessage(
        error instanceof Error ? error.message : "Gagal menyetujui batch.",
      );
    } finally {
      setIsActionLoading(false);
    }
  };

  const smStatusOptions = getBatchStatusOptions(batches);

  const filteredSmBatches = filterBatchesByMainStatus(
    filterBatchesBySearch(batches, smSearch),
    smStatusFilter,
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap gap-2 rounded-2xl border border-white/10 bg-[#1a1c23]/60 p-2">
        {[
          ["monitoring", "Monitoring Batch Pengajuan"],
          ["review", "Review Batch Sales Manager"],
        ].map(([key, label]) => (
          <button
            key={key}
            onClick={() => setSmMenu(key as "monitoring" | "review")}
            className={`rounded-xl px-4 py-2.5 text-sm font-bold transition-colors ${
              smMenu === key
                ? "border border-teal-500/30 bg-teal-500/20 text-teal-200"
                : "border border-transparent text-slate-400 hover:bg-white/5 hover:text-white"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {smMenu === "monitoring" && (
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-3 xl:grid-cols-[1fr_280px]">
            <MonitoringSearch value={smSearch} onChange={setSmSearch} />

            <StatusFilterSelect
              value={smStatusFilter}
              onChange={setSmStatusFilter}
              options={smStatusOptions}
            />
          </div>

          {isLoading && (
            <p className="text-sm text-slate-400">
              Memuat data Sales Manager...
            </p>
          )}

          <BatchOverviewActionTable
            batches={filteredSmBatches}
            selectedBatchId={selectedBatch?.id}
            onSelect={selectBatch}
            actionLabel={(batch) =>
              isSmActionableBatch(batch) ? "Review Batch" : "Lihat Detail"
            }
          />
        </div>
      )}

      {smMenu === "review" && (
        <div className="space-y-6">
          <Panel title="Review Batch Sales Manager" icon={ShieldCheck}>
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
              <Field
                label="No Pengajuan Batch"
                value={selectedBatch?.noPengajuan || "-"}
              />
              <Field
                label="Gelombang"
                value={selectedBatch?.gelombang || "-"}
              />
              <Field
                label="Principle"
                value={selectedBatch?.principleName || "-"}
              />
              <Field
                label="Kode Principle"
                value={selectedBatch?.principleCode || "-"}
              />
              <Field
                label="Bulan/Tahun"
                value={
                  selectedBatch
                    ? `${selectedBatch.bulan}/${selectedBatch.tahun}`
                    : "-"
                }
              />
              <Field
                label="Supervisor"
                value={selectedBatch?.supervisorName || "-"}
              />
              <Field
                label="Jumlah Baris dalam Batch"
                value={String(selectedItems.length || 0)}
              />
              <Field
                label="Total Nominal Batch"
                value={`Rp ${totalNominal.toLocaleString("id-ID")}`}
              />
              <Field
                label="Status"
                value={displayStatusLabel(selectedBatch?.status)}
              />
              <Field
                label="Status SM"
                value={displayStatusLabel(selectedBatch?.smStatus)}
              />
            </div>
            <div className="mt-5 overflow-x-auto rounded-xl border border-white/10">
              <table className="w-full min-w-[1150px] text-left text-sm">
                <thead className="border-b border-white/10 bg-black/50 text-xs uppercase tracking-wider text-slate-500">
                  <tr>
                    {[
                      "No",
                      "No Surat",
                      "Nama Program",
                      "Periode",
                      "Toko",
                      "Barang",
                      "Nominal",
                      "Cara Bayar",
                      "Tipe",
                      "Deadline",
                    ].map((header) => (
                      <th key={header} className="px-3 py-3 font-bold">
                        {header}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                  {selectedItems.map((item, index) => (
                    <tr
                      key={item.id || `${item.noSurat}-${index}`}
                      className="hover:bg-white/[0.03]"
                    >
                      <td className="px-3 py-3 font-mono text-slate-300">
                        {item.itemNo || index + 1}
                      </td>
                      <td className="px-3 py-3 font-mono text-slate-200">
                        {item.noSurat || "-"}
                      </td>
                      <td className="px-3 py-3 min-w-[180px] text-slate-200">
                        {item.namaProgram || "-"}
                      </td>
                      <td className="px-3 py-3 text-slate-300">
                        {item.periode || "-"}
                      </td>
                      <td className="px-3 py-3 min-w-[140px] text-slate-300">
                        {item.toko || "-"}
                      </td>
                      <td className="px-3 py-3 text-slate-300">
                        {item.barang || "-"}
                      </td>
                      <td className="px-3 py-3 text-right font-mono text-emerald-300">
                        Rp {Number(item.nominal || 0).toLocaleString("id-ID")}
                      </td>
                      <td className="px-3 py-3 text-slate-300">
                        {item.caraBayar || "-"}
                      </td>
                      <td className="px-3 py-3 text-slate-300">
                        {item.type || "-"}
                      </td>
                      <td className="px-3 py-3 text-slate-300">
                        {item.deadline || "-"}
                      </td>
                    </tr>
                  ))}
                  {!isLoading && selectedItems.length === 0 && (
                    <tr>
                      <td
                        colSpan={10}
                        className="px-3 py-6 text-center text-sm text-slate-500"
                      >
                        Pilih batch untuk melihat item.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <div className="mt-4">
              <label className="block">
                <span className="text-xs text-slate-500 font-semibold">
                  Catatan Sales Manager
                </span>
                <textarea
                  value={smNote}
                  onChange={(event) => setSmNote(event.target.value)}
                  placeholder="Isi catatan jika dikembalikan. Catatan persetujuan boleh dikosongkan."
                  rows={4}
                  className="mt-1 w-full resize-none rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-slate-200 outline-none placeholder:text-slate-600 focus:border-teal-500/50"
                />
              </label>
            </div>
            {actionMessage && (
              <div className="mt-4 rounded-xl border border-white/10 bg-black/30 px-4 py-3 text-sm text-slate-300">
                {actionMessage}
              </div>
            )}
            {canReviewSm ? (
              <div className="mt-5 flex flex-wrap gap-3">
                <button
                  onClick={returnToSupervisor}
                  disabled={
                    !selectedBatch ||
                    !isSmActionableBatch(selectedBatch) ||
                    isActionLoading
                  }
                  className="inline-flex items-center justify-center gap-2 rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-2.5 text-sm font-bold text-rose-300 transition-colors hover:bg-rose-500/20 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Tolak / Kembalikan ke Supervisor
                </button>
                <button
                  onClick={approveBatch}
                  disabled={
                    !selectedBatch ||
                    !isSmActionableBatch(selectedBatch) ||
                    isActionLoading
                  }
                  className="inline-flex items-center justify-center gap-2 rounded-xl border border-emerald-500 bg-emerald-600 px-4 py-2.5 text-sm font-bold text-white transition-colors hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <Bell size={16} /> Setujui Data & Beri Notifikasi OM
                </button>
              </div>
            ) : (
              <div className="mt-5 rounded-xl border border-white/10 bg-black/30 px-4 py-3 text-sm text-slate-400">
                Baca-saja: role ini tidak bisa menyetujui/mengembalikan data
                Sales Manager.
              </div>
            )}
          </Panel>
          <Panel title="Kelengkapan Awal dari Supervisor" icon={ListChecks}>
            <p className="mb-4 text-sm text-slate-400">
              Kelengkapan ini adalah informasi awal dari Supervisor. Validasi
              kelengkapan tetap dilakukan oleh Claim.
            </p>
            {loadError && (
              <div className="mb-4 rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
                {loadError}
              </div>
            )}
            <div className="overflow-x-auto rounded-xl border border-white/10">
              <table className="w-full min-w-[1200px] text-left text-sm">
                <thead className="border-b border-white/10 bg-black/50 text-xs uppercase tracking-wider text-slate-500">
                  <tr>
                    {[
                      "No",
                      "No Surat",
                      "Nama Program",
                      "Toko",
                      "KWT",
                      "SKP",
                      "FP",
                      "PC",
                      "Foto",
                      "Rekap",
                      "Lainnya",
                      "Keterangan Lainnya",
                    ].map((header) => (
                      <th key={header} className="px-3 py-3 font-bold">
                        {header}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                  {selectedItems.map((item, index) => (
                    <tr
                      key={item.id || `${item.noSurat}-${index}`}
                      className="hover:bg-white/[0.03]"
                    >
                      <td className="px-3 py-3 font-mono text-slate-300">
                        {item.itemNo || index + 1}
                      </td>
                      <td className="px-3 py-3 font-mono text-slate-200">
                        {item.noSurat || "-"}
                      </td>
                      <td className="px-3 py-3 min-w-[180px] text-slate-200">
                        {item.namaProgram || "-"}
                      </td>
                      <td className="px-3 py-3 min-w-[140px] text-slate-300">
                        {item.toko || "-"}
                      </td>
                      <td className="px-3 py-3">
                        <ReadOnlyPresenceBadge value={item.kwt} />
                      </td>
                      <td className="px-3 py-3">
                        <ReadOnlyPresenceBadge value={item.skp} />
                      </td>
                      <td className="px-3 py-3">
                        <ReadOnlyPresenceBadge value={item.fp} />
                      </td>
                      <td className="px-3 py-3">
                        <ReadOnlyPresenceBadge value={item.pc} />
                      </td>
                      <td className="px-3 py-3">
                        <ReadOnlyPresenceBadge value={item.foto} />
                      </td>
                      <td className="px-3 py-3">
                        <ReadOnlyPresenceBadge value={item.rekap} />
                      </td>
                      <td className="px-3 py-3">
                        <ReadOnlyPresenceBadge value={item.others} />
                      </td>
                      <td className="px-3 py-3 min-w-[180px] text-slate-300">
                        {item.othersText || "-"}
                      </td>
                    </tr>
                  ))}
                  {!isLoading && selectedItems.length === 0 && (
                    <tr>
                      <td
                        colSpan={12}
                        className="px-3 py-6 text-center text-sm text-slate-500"
                      >
                        Belum ada item batch yang bisa ditampilkan.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </Panel>
          <Panel title="Pratinjau Notifikasi" icon={Mail}>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <Field
                label="Email Tujuan"
                value={
                  notificationPreview?.to || "operational.manager@company.local"
                }
              />
              <Field
                label="Subjek"
                value={
                  notificationPreview?.subject ||
                  "Pengajuan OFF Disetujui Sales Manager"
                }
              />
              <Field
                label="Status"
                value={notificationPreview?.status || "Pratinjau"}
              />
            </div>
            <div className="mt-4">
              <TextArea
                label="Pesan"
                value={
                  notificationPreview?.message ||
                  "Ada batch pengajuan OFF yang sudah disetujui Sales Manager dan siap ditinjau OM."
                }
              />
            </div>
          </Panel>
        </div>
      )}
    </div>
  );
}

function ClaimDashboard({ offRole }: OffDashboardProps) {
  const canReviewClaim = canPerformOffAction(offRole, "claim_review");
  const canFinalClaim = canPerformOffAction(offRole, "claim_final");
  const [claimView, setClaimView] = useState<
    "hub" | "after-sm" | "after-finance"
  >("hub");
  const [claimBatches, setClaimBatches] = useState<OffApiBatch[]>([]);
  const [claimSearch, setClaimSearch] = useState("");
  const [finalBatches, setFinalBatches] = useState<OffApiBatch[]>([]);
  const [finalClaimSearch, setFinalClaimSearch] = useState("");
  const [finalHistory, setFinalHistory] = useState<OffApiBatch[]>([]);
  const [selectedBatch, setSelectedBatch] = useState<OffApiBatch | null>(null);
  const [selectedItems, setSelectedItems] = useState<OffApiItem[]>([]);
  const [selectedFinalBatch, setSelectedFinalBatch] =
    useState<OffApiBatch | null>(null);
  const [selectedFinalItems, setSelectedFinalItems] = useState<OffApiItem[]>(
    [],
  );
  const [selectedFinalPayments, setSelectedFinalPayments] = useState<
    OffApiPayment[]
  >([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isActionLoading, setIsActionLoading] = useState(false);
  const [claimMessage, setClaimMessage] = useState("");
  const [claimSubmittedDate, setClaimSubmittedDate] = useState("");
  const [claimDeadline, setClaimDeadline] = useState("");
  const [completenessStatus, setCompletenessStatus] = useState("Aman");
  const [claimNote, setClaimNote] = useState("");
  const [finalClaimNote, setFinalClaimNote] = useState("");
  const [finalClaimRefs, setFinalClaimRefs] = useState<Record<string, string>>(
    {},
  );
  const totalNominal = selectedItems.reduce(
    (total, item) => total + Number(item.nominal || 0),
    0,
  );
  const finalSummary = selectedFinalBatch?.summary;
  const finalTotalNominal = Number(
    finalSummary?.totalNominal ||
      selectedFinalItems.reduce(
        (total, item) => total + Number(item.nominal || 0),
        0,
      ),
  );
  const finalTransfer = Number(
    finalSummary?.transfer ||
      selectedFinalItems
        .filter(
          (item) =>
            normalizeUiPaymentMethod(item.caraBayar || "") === "Transfer",
        )
        .reduce((total, item) => total + Number(item.nominal || 0), 0),
  );
  const finalTunai = Number(
    finalSummary?.tunai ||
      selectedFinalItems
        .filter(
          (item) => normalizeUiPaymentMethod(item.caraBayar || "") === "Tunai",
        )
        .reduce((total, item) => total + Number(item.nominal || 0), 0),
  );
  const finalPaymentSummary = selectedFinalBatch?.paymentSummary;
  const paidAmount = Number(
    finalPaymentSummary?.totalPaid ?? selectedFinalBatch?.paidAmount ?? 0,
  );
  const remainingFinalAmount = Number(
    finalPaymentSummary?.remainingAmount ??
      Math.max(0, finalTotalNominal - paidAmount),
  );

  const isClaimQueueBatch = (batch: OffApiBatch) => {
    const claimStatus = String(batch.claimStatus || "");
    const status = String(batch.status || "");
    return (
      batch.smStatus === "Approved by SM" &&
      !["Approved", "Returned"].includes(claimStatus) &&
      ![
        "Cancelled",
        "Completed",
        "Claim Approved",
        "Returned by Claim",
      ].includes(status)
    );
  };

  const isFinalQueueBatch = (batch: OffApiBatch) =>
    batch.financeStatus === "Paid" &&
    ["Waiting Claim Final Verification", "Incomplete Documents"].includes(
      batch.finalStatus,
    ) &&
    batch.status === "Paid" &&
    batch.paymentSummary?.isFullyPaid === true;

  const loadClaimDetail = async (batch: OffApiBatch) => {
    const response = await fetch(
      `/api/off-program-control/batches/${batch.id}`,
      { credentials: "include" },
    );
    const data = await parseJsonResponse(response);
    if (!response.ok || !data.ok)
      throw new Error(String(data.error || "Gagal mengambil detail Claim."));
    const detailBatch = data.batch as OffApiBatch;
    const items = Array.isArray(data.items) ? (data.items as OffApiItem[]) : [];
    setSelectedBatch(detailBatch || batch);
    setSelectedItems(items);
    setClaimSubmittedDate(detailBatch?.claimSubmittedDate || "");
    setClaimDeadline(detailBatch?.claimDeadline || "");
    setClaimNote(detailBatch?.claimNote || "");
  };

  const loadFinalDetail = async (batch: OffApiBatch) => {
    const response = await fetch(
      `/api/off-program-control/batches/${batch.id}`,
      { credentials: "include" },
    );
    const data = await parseJsonResponse(response);
    if (!response.ok || !data.ok)
      throw new Error(
        String(data.error || "Gagal mengambil detail final Claim."),
      );
    const detailBatch = data.batch as OffApiBatch;
    const items = Array.isArray(data.items) ? (data.items as OffApiItem[]) : [];
    const payments = Array.isArray(data.payments)
      ? (data.payments as OffApiPayment[])
      : [];
    const paymentSummary = data.paymentSummary as OffPaymentSummary | undefined;
    const batchWithPaymentSummary = {
      ...(detailBatch || batch),
      paymentSummary,
      payments,
    };
    setSelectedFinalBatch(batchWithPaymentSummary);
    setSelectedFinalItems(items);
    setFinalClaimRefs(
      Object.fromEntries(items.map((item) => [item.id, item.noClaim || ""])),
    );
    setSelectedFinalPayments(payments);
    setFinalClaimNote(detailBatch?.finalClaimNote || "");
  };

  const loadClaimBatches = async () => {
    setIsLoading(true);
    setClaimMessage("");
    try {
      const response = await fetch("/api/off-program-control/batches", {
        credentials: "include",
      });
      const data = await parseJsonResponse(response);
      if (!response.ok || !data.ok)
        throw new Error(String(data.error || "Gagal mengambil antrean Claim."));
      const rows = Array.isArray(data.batches)
        ? (data.batches as OffApiBatch[])
        : [];
      const queue = rows.filter(isClaimQueueBatch);
      const finalQueue = rows.filter(isFinalQueueBatch);
      setClaimBatches(queue);
      setFinalBatches(finalQueue);
      setFinalHistory(
        rows.filter(
          (batch) =>
            batch.finalStatus === "Completed" ||
            batch.finalStatus === "Need Correction from Finance" ||
            batch.status === "Completed" ||
            batch.status === "Returned to Finance",
        ),
      );
      const nextBatch = queue[0] || null;
      const nextFinalBatch = finalQueue[0] || null;
      setSelectedBatch(nextBatch);
      setSelectedFinalBatch(nextFinalBatch);
      if (nextBatch) {
        await loadClaimDetail(nextBatch);
      } else {
        setSelectedItems([]);
        setClaimSubmittedDate("");
        setClaimDeadline("");
        setClaimNote("");
      }
      if (nextFinalBatch) {
        await loadFinalDetail(nextFinalBatch);
      } else {
        setSelectedFinalItems([]);
        setFinalClaimRefs({});
        setSelectedFinalPayments([]);
        setFinalClaimNote("");
      }
    } catch (error) {
      setClaimMessage(
        error instanceof Error
          ? error.message
          : "Gagal mengambil antrean Claim.",
      );
      setSelectedItems([]);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadClaimBatches();
    // Claim queue should load once when this tab component mounts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectClaimBatch = async (batch: OffApiBatch) => {
    setSelectedBatch(batch);
    setSelectedItems([]);
    setClaimMessage("");
    try {
      await loadClaimDetail(batch);
    } catch (error) {
      setClaimMessage(
        error instanceof Error
          ? error.message
          : "Gagal mengambil detail Claim.",
      );
    }
  };

  const selectFinalBatch = async (batch: OffApiBatch) => {
    setSelectedFinalBatch(batch);
    setSelectedFinalItems([]);
    setSelectedFinalPayments([]);
    setClaimMessage("");
    try {
      await loadFinalDetail(batch);
    } catch (error) {
      setClaimMessage(
        error instanceof Error
          ? error.message
          : "Gagal mengambil detail final Claim.",
      );
    }
  };

  const returnByClaim = async () => {
    if (!selectedBatch) return;
    if (!claimNote.trim()) {
      setClaimMessage("Catatan Claim wajib diisi untuk pengembalian.");
      return;
    }
    setIsActionLoading(true);
    setClaimMessage("");
    try {
      const response = await fetch(
        `/api/off-program-control/batches/${selectedBatch.id}/claim-review`,
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "return",
            note: claimNote,
            completenessStatus,
          }),
        },
      );
      const data = await parseJsonResponse(response);
      if (!response.ok || !data.ok)
        throw new Error(
          String(
            data.error || data.message || "Gagal mengembalikan dari Claim.",
          ),
        );
      setClaimMessage(
        String(
          data.message || "Pengajuan dikembalikan oleh Claim untuk diperbaiki.",
        ),
      );
      await loadClaimBatches();
    } catch (error) {
      setClaimMessage(
        error instanceof Error
          ? error.message
          : "Gagal mengembalikan dari Claim.",
      );
    } finally {
      setIsActionLoading(false);
    }
  };

  const approveByClaim = async () => {
    if (!selectedBatch) return;
    setIsActionLoading(true);
    setClaimMessage("");
    try {
      const response = await fetch(
        `/api/off-program-control/batches/${selectedBatch.id}/claim-review`,
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "approve",
            claimSubmittedDate,
            claimDeadline,
            completenessStatus,
            note: claimNote,
          }),
        },
      );
      const data = await parseJsonResponse(response);
      if (!response.ok || !data.ok)
        throw new Error(
          String(data.error || data.message || "Gagal menyetujui Claim."),
        );
      setClaimMessage(
        String(
          data.message || "Claim menyetujui pengajuan dan meneruskan ke OM.",
        ),
      );
      await loadClaimBatches();
    } catch (error) {
      setClaimMessage(
        error instanceof Error ? error.message : "Gagal menyetujui Claim.",
      );
    } finally {
      setIsActionLoading(false);
    }
  };

  const returnToFinance = async () => {
    if (!selectedFinalBatch) return;
    if (!finalClaimNote.trim()) {
      setClaimMessage("Catatan wajib diisi untuk mengembalikan ke Keuangan.");
      return;
    }
    setIsActionLoading(true);
    setClaimMessage("");
    try {
      const response = await fetch(
        `/api/off-program-control/batches/${selectedFinalBatch.id}/final-claim`,
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "return_to_finance",
            note: finalClaimNote,
          }),
        },
      );
      const data = await parseJsonResponse(response);
      if (!response.ok || !data.ok)
        throw new Error(
          String(
            data.error || data.message || "Gagal mengembalikan ke Keuangan.",
          ),
        );
      setClaimMessage(
        String(
          data.message || "Pengajuan dikembalikan ke Keuangan untuk koreksi.",
        ),
      );
      await loadClaimBatches();
    } catch (error) {
      setClaimMessage(
        error instanceof Error
          ? error.message
          : "Gagal mengembalikan ke Keuangan.",
      );
    } finally {
      setIsActionLoading(false);
    }
  };

  const rejectIncompleteDocuments = async () => {
    if (!selectedFinalBatch) return;
    if (!finalClaimNote.trim()) {
      setClaimMessage(
        "Catatan Final Claim wajib diisi untuk kelengkapan belum lengkap.",
      );
      return;
    }
    setIsActionLoading(true);
    setClaimMessage("");
    try {
      const response = await fetch(
        `/api/off-program-control/batches/${selectedFinalBatch.id}/final-claim`,
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "reject_incomplete_documents",
            note: finalClaimNote,
          }),
        },
      );
      const data = await parseJsonResponse(response);
      if (!response.ok || !data.ok)
        throw new Error(
          String(data.error || data.message || "Gagal menolak kelengkapan."),
        );
      setClaimMessage(
        String(data.message || "Pengajuan ditandai belum lengkap."),
      );
      await loadClaimBatches();
    } catch (error) {
      setClaimMessage(
        error instanceof Error ? error.message : "Gagal menolak kelengkapan.",
      );
    } finally {
      setIsActionLoading(false);
    }
  };

  const completeFinalClaim = async () => {
    if (!selectedFinalBatch) return;
    if (remainingFinalAmount > 0) {
      setClaimMessage("Pembayaran belum lunas, belum bisa disetujui Claim.");
      return;
    }

    const missingNoClaim = selectedFinalItems
      .filter((item) => item.noSurat)
      .filter((item) => !String(finalClaimRefs[item.id] || "").trim());

    if (missingNoClaim.length > 0) {
      setClaimMessage(
        `No Claim wajib diisi untuk No Surat: ${missingNoClaim
          .map((item) => item.noSurat)
          .join(", ")}`,
      );
      return;
    }

    const claimRefs = selectedFinalItems
      .filter((item) => item.noSurat)
      .map((item) => ({
        itemId: item.id,
        noSurat: item.noSurat,
        noClaim: String(finalClaimRefs[item.id] || "").trim(),
      }));

    setIsActionLoading(true);
    setClaimMessage("");
    try {
      const response = await fetch(
        `/api/off-program-control/batches/${selectedFinalBatch.id}/final-claim`,
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "complete",
            note: finalClaimNote,
            claimRefs,
          }),
        },
      );
      const data = await parseJsonResponse(response);
      if (!response.ok || !data.ok)
        throw new Error(
          String(
            data.error || data.message || "Gagal menyelesaikan final Claim.",
          ),
        );
      setClaimMessage(String(data.message || "Pengajuan selesai."));
      await loadClaimBatches();
    } catch (error) {
      setClaimMessage(
        error instanceof Error
          ? error.message
          : "Gagal menyelesaikan final Claim.",
      );
    } finally {
      setIsActionLoading(false);
    }
  };

  const filteredClaimBatches = filterBatchesBySearch(claimBatches, claimSearch);

  const filteredFinalBatches = filterBatchesBySearch(
    finalBatches,
    finalClaimSearch,
  );

  if (claimView === "hub") {
    return (
      <div className="space-y-6">
        <div className="rounded-2xl border border-white/10 bg-[#1a1c23]/60 p-6 shadow-xl">
          <h2 className="text-2xl font-black text-white">Dashboard Claim</h2>
          <p className="mt-2 text-sm text-slate-400">
            Pilih jenis validasi Claim yang ingin diproses.
          </p>
        </div>
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
          <section className="rounded-2xl border border-white/10 bg-[#1a1c23]/60 p-6 shadow-xl">
            <div className="flex items-start justify-between gap-4">
              <div className="w-12 h-12 rounded-xl border border-sky-500/30 bg-sky-500/10 flex items-center justify-center">
                <FileCheck2 className="text-sky-300" size={24} />
              </div>
              <span className="rounded-lg border border-sky-500/30 bg-sky-500/10 px-3 py-1 text-xs font-bold text-sky-300">
                {claimBatches.length} menunggu
              </span>
            </div>
            <h3 className="mt-5 text-xl font-black text-white">
              Validasi Setelah SM
            </h3>
            <p className="mt-2 text-sm leading-6 text-slate-400">
              Cek data batch yang sudah disetujui Sales Manager dan validasi
              kelengkapan awal sebelum diteruskan ke OM.
            </p>
            <button
              onClick={() => setClaimView("after-sm")}
              className="mt-6 inline-flex rounded-xl border border-teal-500 bg-teal-600 px-4 py-2.5 text-sm font-bold text-white transition-colors hover:bg-teal-500"
            >
              Buka Validasi Setelah SM
            </button>
          </section>
          <section className="rounded-2xl border border-white/10 bg-[#1a1c23]/60 p-6 shadow-xl">
            <div className="flex items-start justify-between gap-4">
              <div className="w-12 h-12 rounded-xl border border-emerald-500/30 bg-emerald-500/10 flex items-center justify-center">
                <Wallet className="text-emerald-300" size={24} />
              </div>
              <span className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-1 text-xs font-bold text-emerald-300">
                {finalBatches.length} menunggu
              </span>
            </div>
            <h3 className="mt-5 text-xl font-black text-white">
              Validasi Setelah Keuangan
            </h3>
            <p className="mt-2 text-sm leading-6 text-slate-400">
              Cek data yang sudah dibayar Keuangan, verifikasi bukti bayar dan
              jumlah pembayaran, lalu selesaikan atau kembalikan ke Keuangan.
            </p>
            <button
              onClick={() => setClaimView("after-finance")}
              className="mt-6 inline-flex rounded-xl border border-teal-500 bg-teal-600 px-4 py-2.5 text-sm font-bold text-white transition-colors hover:bg-teal-500"
            >
              Buka Validasi Setelah Keuangan
            </button>
          </section>
        </div>
        {claimMessage && (
          <div className="rounded-xl border border-white/10 bg-black/30 px-4 py-3 text-sm text-slate-300">
            {claimMessage}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <button
        onClick={() => setClaimView("hub")}
        className="inline-flex rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm font-bold text-slate-200 hover:bg-white/10"
      >
        Kembali ke Dashboard Claim
      </button>
      <div className="rounded-2xl border border-white/10 bg-[#1a1c23]/60 p-5 shadow-xl">
        <h2 className="text-xl font-black text-white">
          {claimView === "after-sm"
            ? "Validasi Setelah SM"
            : "Validasi Setelah Keuangan"}
        </h2>
        <p className="mt-1 text-sm text-slate-400">
          {claimView === "after-sm"
            ? "Cek batch yang sudah disetujui Sales Manager dan lakukan validasi Claim awal."
            : "Cek pembayaran Keuangan, verifikasi bukti bayar, lalu selesaikan atau kembalikan ke Keuangan."}
        </p>
      </div>
      <InfoNote>
        Checklist Supervisor bukan persetujuan. Claim wajib melakukan verifikasi
        nyata sebelum menyetujui.
      </InfoNote>
      {claimView === "after-sm" && (
        <div className="grid grid-cols-1 xl:grid-cols-[0.75fr_1.25fr] gap-6">
          <Panel title="Menunggu Validasi Claim" icon={FileCheck2}>
            <div className="mb-4">
              <MonitoringSearch
                value={claimSearch}
                onChange={setClaimSearch}
                placeholder="Cari No Pengajuan, principle, kode, atau status Claim..."
              />
            </div>

            <div className="space-y-3">
              {isLoading && (
                <p className="text-sm text-slate-400">
                  Memuat antrean Claim...
                </p>
              )}

              {!isLoading && filteredClaimBatches.length === 0 && (
                <p className="text-sm text-slate-400">
                  Belum ada batch yang disetujui SM dan menunggu Claim.
                </p>
              )}

              {filteredClaimBatches.map((batch) => {
                const summary = batch.summary || {
                  totalRows: 0,
                  totalNominal: 0,
                };

                return (
                  <button
                    key={batch.id}
                    onClick={() => selectClaimBatch(batch)}
                    className={`w-full rounded-xl border p-4 text-left transition-colors ${
                      selectedBatch?.id === batch.id
                        ? "border-teal-500/40 bg-teal-500/10"
                        : "border-white/10 bg-black/30 hover:bg-white/[0.04]"
                    }`}
                  >
                    <p className="font-mono text-sm font-bold text-white">
                      {batch.noPengajuan}
                    </p>

                    <p className="mt-1 text-sm text-slate-300">
                      {batch.principleName}{" "}
                      <span className="font-mono text-teal-300">
                        ({batch.principleCode})
                      </span>
                    </p>

                    <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-slate-400">
                      <span>
                        Baris:{" "}
                        <b className="text-slate-200">
                          {summary.totalRows || summary.rowCount || 0}
                        </b>
                      </span>

                      <span>
                        Total:{" "}
                        <b className="text-emerald-300">
                          Rp{" "}
                          {Number(summary.totalNominal || 0).toLocaleString(
                            "id-ID",
                          )}
                        </b>
                      </span>

                      <span>
                        SM:{" "}
                        <b className="text-emerald-300">
                          {displayStatusLabel(batch.smStatus)}
                        </b>
                      </span>

                      <span>
                        Claim:{" "}
                        <b className="text-sky-300">
                          {displayStatusLabel(batch.claimStatus)}
                        </b>
                      </span>

                      <span>
                        Deadline:{" "}
                        <b className="text-slate-200">
                          {batch.claimDeadline || "-"}
                        </b>
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>
          </Panel>

          <div className="space-y-6">
            <Panel title="Detail Validasi Claim" icon={FileCheck2}>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <Field
                  label="No Pengajuan"
                  value={selectedBatch?.noPengajuan || "-"}
                />
                <Field
                  label="Gelombang"
                  value={selectedBatch?.gelombang || "-"}
                />
                <Field
                  label="Principle"
                  value={selectedBatch?.principleName || "-"}
                />
                <Field
                  label="Kode Principle"
                  value={selectedBatch?.principleCode || "-"}
                />
                <Field
                  label="Bulan/Tahun"
                  value={
                    selectedBatch
                      ? `${selectedBatch.bulan}/${selectedBatch.tahun}`
                      : "-"
                  }
                />
                <Field
                  label="Supervisor"
                  value={selectedBatch?.supervisorName || "-"}
                />
                <Field
                  label="Total Nominal"
                  value={`Rp ${totalNominal.toLocaleString("id-ID")}`}
                />
                <Field
                  label="Status SM"
                  value={displayStatusLabel(selectedBatch?.smStatus)}
                />
                <Field
                  label="Status Claim"
                  value={displayStatusLabel(selectedBatch?.claimStatus)}
                />
              </div>
              <div className="mt-5 overflow-x-auto rounded-xl border border-white/10">
                <table className="w-full min-w-[1150px] text-left text-sm">
                  <thead className="border-b border-white/10 bg-black/50 text-xs uppercase tracking-wider text-slate-500">
                    <tr>
                      {[
                        "No",
                        "No Surat",
                        "Nama Program",
                        "Periode",
                        "Toko",
                        "Barang",
                        "Nominal",
                        "Cara Bayar",
                        "Tipe",
                        "Deadline",
                      ].map((header) => (
                        <th key={header} className="px-3 py-3 font-bold">
                          {header}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/5">
                    {selectedItems.map((item, index) => (
                      <tr
                        key={item.id || `${item.noSurat}-${index}`}
                        className="hover:bg-white/[0.03]"
                      >
                        <td className="px-3 py-3 font-mono text-slate-300">
                          {item.itemNo || index + 1}
                        </td>
                        <td className="px-3 py-3 font-mono text-slate-200">
                          {item.noSurat || "-"}
                        </td>
                        <td className="px-3 py-3 min-w-[180px] text-slate-200">
                          {item.namaProgram || "-"}
                        </td>
                        <td className="px-3 py-3 text-slate-300">
                          {item.periode || "-"}
                        </td>
                        <td className="px-3 py-3 min-w-[140px] text-slate-300">
                          {item.toko || "-"}
                        </td>
                        <td className="px-3 py-3 text-slate-300">
                          {item.barang || "-"}
                        </td>
                        <td className="px-3 py-3 text-right font-mono text-emerald-300">
                          Rp {Number(item.nominal || 0).toLocaleString("id-ID")}
                        </td>
                        <td className="px-3 py-3 text-slate-300">
                          {item.caraBayar || "-"}
                        </td>
                        <td className="px-3 py-3 text-slate-300">
                          {item.type || "-"}
                        </td>
                        <td className="px-3 py-3 text-slate-300">
                          {item.deadline || "-"}
                        </td>
                      </tr>
                    ))}
                    {!isLoading && selectedItems.length === 0 && (
                      <tr>
                        <td
                          colSpan={10}
                          className="px-3 py-6 text-center text-sm text-slate-500"
                        >
                          Pilih batch untuk melihat item.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </Panel>

            <Panel title="Kelengkapan Awal dari Supervisor" icon={ListChecks}>
              <p className="mb-4 text-sm text-slate-400">
                Kelengkapan dari Supervisor adalah informasi awal. Claim wajib
                melakukan verifikasi nyata sebelum menyetujui.
              </p>
              <div className="overflow-x-auto rounded-xl border border-white/10">
                <table className="w-full min-w-[1200px] text-left text-sm">
                  <thead className="border-b border-white/10 bg-black/50 text-xs uppercase tracking-wider text-slate-500">
                    <tr>
                      {[
                        "No",
                        "No Surat",
                        "Nama Program",
                        "Toko",
                        "KWT",
                        "SKP",
                        "FP",
                        "PC",
                        "Foto",
                        "Rekap",
                        "Lainnya",
                        "Keterangan Lainnya",
                      ].map((header) => (
                        <th key={header} className="px-3 py-3 font-bold">
                          {header}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/5">
                    {selectedItems.map((item, index) => (
                      <tr
                        key={item.id || `${item.noSurat}-${index}`}
                        className="hover:bg-white/[0.03]"
                      >
                        <td className="px-3 py-3 font-mono text-slate-300">
                          {item.itemNo || index + 1}
                        </td>
                        <td className="px-3 py-3 font-mono text-slate-200">
                          {item.noSurat || "-"}
                        </td>
                        <td className="px-3 py-3 min-w-[180px] text-slate-200">
                          {item.namaProgram || "-"}
                        </td>
                        <td className="px-3 py-3 min-w-[140px] text-slate-300">
                          {item.toko || "-"}
                        </td>
                        <td className="px-3 py-3">
                          <ReadOnlyPresenceBadge value={item.kwt} />
                        </td>
                        <td className="px-3 py-3">
                          <ReadOnlyPresenceBadge value={item.skp} />
                        </td>
                        <td className="px-3 py-3">
                          <ReadOnlyPresenceBadge value={item.fp} />
                        </td>
                        <td className="px-3 py-3">
                          <ReadOnlyPresenceBadge value={item.pc} />
                        </td>
                        <td className="px-3 py-3">
                          <ReadOnlyPresenceBadge value={item.foto} />
                        </td>
                        <td className="px-3 py-3">
                          <ReadOnlyPresenceBadge value={item.rekap} />
                        </td>
                        <td className="px-3 py-3">
                          <ReadOnlyPresenceBadge value={item.others} />
                        </td>
                        <td className="px-3 py-3 min-w-[180px] text-slate-300">
                          {item.othersText || "-"}
                        </td>
                      </tr>
                    ))}
                    {!isLoading && selectedItems.length === 0 && (
                      <tr>
                        <td
                          colSpan={12}
                          className="px-3 py-6 text-center text-sm text-slate-500"
                        >
                          Belum ada item batch yang bisa ditampilkan.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </Panel>

            <Panel title="Form Validasi Claim" icon={ClipboardCheck}>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <DateField
                  label="Tanggal Diajukan"
                  value={claimSubmittedDate}
                  onChange={setClaimSubmittedDate}
                />
                <DateField
                  label="Deadline Claim"
                  value={claimDeadline}
                  onChange={setClaimDeadline}
                />
                <label className="block">
                  <span className="text-xs text-slate-500 font-semibold">
                    Status Kelengkapan Claim
                  </span>
                  <select
                    value={completenessStatus}
                    onChange={(event) =>
                      setCompletenessStatus(event.target.value)
                    }
                    className="mt-1 w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2.5 text-sm text-slate-200 outline-none focus:border-teal-500/50"
                  >
                    <option className="bg-[#1a1c23]" value="Aman">
                      Aman
                    </option>
                    <option className="bg-[#1a1c23]" value="Kurang">
                      Kurang
                    </option>
                    <option className="bg-[#1a1c23]" value="Perlu Revisi">
                      Perlu Revisi
                    </option>
                  </select>
                </label>
              </div>
              <div className="mt-4">
                <label className="block">
                  <span className="text-xs text-slate-500 font-semibold">
                    Catatan Claim
                  </span>
                  <textarea
                    value={claimNote}
                    onChange={(event) => setClaimNote(event.target.value)}
                    rows={4}
                    className="mt-1 w-full resize-none rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-slate-200 outline-none placeholder:text-slate-600 focus:border-teal-500/50"
                  />
                </label>
              </div>
              {claimMessage && (
                <div className="mt-4 rounded-xl border border-white/10 bg-black/30 px-4 py-3 text-sm text-slate-300">
                  {claimMessage}
                </div>
              )}
              {canReviewClaim ? (
                <div className="mt-5 flex flex-wrap gap-3">
                  <button
                    onClick={returnByClaim}
                    disabled={!selectedBatch || isActionLoading}
                    className="inline-flex items-center justify-center gap-2 rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-2.5 text-sm font-bold text-rose-300 transition-colors hover:bg-rose-500/20 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Kembalikan untuk Koreksi
                  </button>
                  <button
                    onClick={approveByClaim}
                    disabled={!selectedBatch || isActionLoading}
                    className="inline-flex items-center justify-center gap-2 rounded-xl border border-emerald-500 bg-emerald-600 px-4 py-2.5 text-sm font-bold text-white transition-colors hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Setujui Claim
                  </button>
                </div>
              ) : (
                <div className="mt-5 rounded-xl border border-white/10 bg-black/30 px-4 py-3 text-sm text-slate-400">
                  Baca-saja: role ini tidak bisa memproses Claim.
                </div>
              )}
            </Panel>
          </div>
        </div>
      )}

      {claimView === "after-finance" && (
        <div className="grid grid-cols-1 xl:grid-cols-[0.75fr_1.25fr] gap-6">
          <Panel
            title="Menunggu Verifikasi Final Setelah Pembayaran"
            icon={Wallet}
          >
            <div className="mb-4">
              <MonitoringSearch
                value={finalClaimSearch}
                onChange={setFinalClaimSearch}
                placeholder="Cari No Pengajuan, principle, kode, status pembayaran, atau No Surat..."
              />
            </div>
            <div className="space-y-3">
              {isLoading && (
                <p className="text-sm text-slate-400">
                  Memuat antrean final Claim...
                </p>
              )}
              {!isLoading && filteredFinalBatches.length === 0 && (
                <p className="text-sm text-slate-400">
                  Belum ada batch sudah dibayar yang menunggu verifikasi final.
                </p>
              )}
              {filteredFinalBatches.map((batch) => {
                const batchSummary = batch.summary || { totalNominal: 0 };
                const batchPaymentSummary = batch.paymentSummary || {
                  totalPaid: Number(batch.paidAmount || 0),
                  remainingAmount: Math.max(
                    0,
                    Number(batchSummary.totalNominal || 0) -
                      Number(batch.paidAmount || 0),
                  ),
                };
                return (
                  <button
                    key={batch.id}
                    onClick={() => selectFinalBatch(batch)}
                    className={`w-full rounded-xl border p-4 text-left transition-colors ${selectedFinalBatch?.id === batch.id ? "border-teal-500/40 bg-teal-500/10" : "border-white/10 bg-black/30 hover:bg-white/[0.04]"}`}
                  >
                    <p className="font-mono text-sm font-bold text-white">
                      {batch.noPengajuan}
                    </p>
                    <p className="mt-1 text-sm text-slate-300">
                      {batch.principleName}{" "}
                      <span className="font-mono text-teal-300">
                        ({batch.principleCode})
                      </span>
                    </p>
                    <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-slate-400">
                      <span>
                        No Claim:{" "}
                        <b className="text-slate-200">{batch.noClaim || "-"}</b>
                      </span>
                      <span>
                        Total:{" "}
                        <b className="text-emerald-300">
                          Rp{" "}
                          {Number(
                            batchSummary.totalNominal || 0,
                          ).toLocaleString("id-ID")}
                        </b>
                      </span>
                      <span>
                        Dibayar:{" "}
                        <b className="text-emerald-300">
                          Rp{" "}
                          {Number(
                            batchPaymentSummary.totalPaid || 0,
                          ).toLocaleString("id-ID")}
                        </b>
                      </span>
                      <span>
                        Sisa:{" "}
                        <b className="text-amber-300">
                          Rp{" "}
                          {Number(
                            batchPaymentSummary.remainingAmount || 0,
                          ).toLocaleString("id-ID")}
                        </b>
                      </span>
                      <span>
                        Tgl Bayar:{" "}
                        <b className="text-slate-200">
                          {formatDateDisplay(batch.paymentDate)}
                        </b>
                      </span>
                      <span>
                        Keuangan:{" "}
                        <b className="text-sky-300">
                          {displayStatusLabel(batch.financeStatus)}
                        </b>
                      </span>
                      <span>
                        Final:{" "}
                        <b className="text-purple-300">
                          {displayStatusLabel(batch.finalStatus)}
                        </b>
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>
            <div className="mt-6 border-t border-white/10 pt-5">
              <p className="mb-3 text-sm font-bold text-white">
                Riwayat Final Claim
              </p>
              <div className="space-y-2">
                {finalHistory.slice(0, 5).map((batch) => (
                  <div
                    key={batch.id}
                    className="rounded-lg border border-white/10 bg-black/20 p-3"
                  >
                    <p className="font-mono text-xs font-bold text-slate-200">
                      {batch.noPengajuan}
                    </p>
                    <p className="mt-1 text-xs text-slate-500">
                      {batch.principleCode} - {batch.principleName}
                    </p>
                    <span
                      className={`mt-2 inline-flex rounded-md border px-2 py-1 text-xs font-bold ${statusClass(batch.finalStatus)}`}
                    >
                      {displayStatusLabel(batch.finalStatus)}
                    </span>
                  </div>
                ))}
                {finalHistory.length === 0 && (
                  <p className="text-sm text-slate-500">
                    Belum ada riwayat final Claim.
                  </p>
                )}
              </div>
            </div>
          </Panel>

          <div className="space-y-6">
            <Panel title="Detail Final Claim" icon={ListChecks}>
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                <Field
                  label="No Pengajuan"
                  value={selectedFinalBatch?.noPengajuan || "-"}
                />
                <Field
                  label="Principle"
                  value={selectedFinalBatch?.principleName || "-"}
                />
                <Field
                  label="Kode Principle"
                  value={selectedFinalBatch?.principleCode || "-"}
                />
                <Field
                  label="No Claim"
                  value={selectedFinalBatch?.noClaim || "-"}
                />
                <Field
                  label="Tanggal Diajukan Claim"
                  value={formatDateDisplay(
                    selectedFinalBatch?.claimSubmittedDate,
                  )}
                />
                <Field
                  label="Deadline Claim"
                  value={formatDateDisplay(selectedFinalBatch?.claimDeadline)}
                />
                <Field
                  label="Total Nominal"
                  value={`Rp ${finalTotalNominal.toLocaleString("id-ID")}`}
                />
                <Field
                  label="Status SM"
                  value={displayStatusLabel(selectedFinalBatch?.smStatus)}
                />
                <Field
                  label="Status Claim"
                  value={displayStatusLabel(selectedFinalBatch?.claimStatus)}
                />
                <Field
                  label="Status OM"
                  value={displayStatusLabel(selectedFinalBatch?.omStatus)}
                />
                <Field
                  label="Status Keuangan"
                  value={displayStatusLabel(selectedFinalBatch?.financeStatus)}
                />
                <Field
                  label="Status Final"
                  value={displayStatusLabel(selectedFinalBatch?.finalStatus)}
                />
              </div>
            </Panel>

            <Panel title="Riwayat Pembayaran dari Keuangan" icon={Wallet}>
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                <Field
                  label="Tanggal Bayar"
                  value={formatDateDisplay(selectedFinalBatch?.paymentDate)}
                />
                <Field
                  label="Total Pengajuan"
                  value={`Rp ${finalTotalNominal.toLocaleString("id-ID")}`}
                />
                <Field
                  label="Total Dibayar Keuangan"
                  value={`Rp ${paidAmount.toLocaleString("id-ID")}`}
                />
                <Field
                  label="Sisa Pembayaran"
                  value={`Rp ${remainingFinalAmount.toLocaleString("id-ID")}`}
                />
                <Field
                  label="Jumlah Pembayaran"
                  value={`${selectedFinalPayments.length} pembayaran`}
                />
              </div>
              <div className="mt-4">
                <TextArea
                  label="Catatan Keuangan"
                  value={selectedFinalBatch?.financeNote || "-"}
                />
              </div>
              <div className="mt-5 overflow-x-auto rounded-xl border border-white/10">
                <table className="w-full min-w-[900px] text-left text-sm">
                  <thead className="border-b border-white/10 bg-black/50 text-xs uppercase tracking-wider text-slate-500">
                    <tr>
                      {[
                        "No Pembayaran",
                        "Tanggal Bayar",
                        "Metode",
                        "Jumlah",
                        "Bank Pengirim",
                        "Bukti Pembayaran",
                        "Catatan",
                      ].map((header) => (
                        <th key={header} className="px-3 py-3 font-bold">
                          {header}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/5">
                    {selectedFinalPayments.map((payment) => (
                      <tr key={payment.id} className="hover:bg-white/[0.03]">
                        <td className="px-3 py-3 font-mono text-slate-300">
                          {payment.paymentNo}
                        </td>
                        <td className="px-3 py-3 text-slate-300">
                          {formatDateDisplay(payment.paymentDate)}
                        </td>
                        <td className="px-3 py-3 text-slate-300">
                          {payment.paymentMethod}
                        </td>
                        <td className="px-3 py-3 text-right font-mono text-emerald-300">
                          Rp{" "}
                          {Number(payment.paidAmount || 0).toLocaleString(
                            "id-ID",
                          )}
                        </td>
                        <td className="px-3 py-3 text-slate-300">
                          {payment.senderBank || "-"}
                        </td>
                        <td className="px-3 py-3">
                          <div className="min-w-[180px] space-y-2">
                            <p className="font-mono text-xs text-slate-300">
                              {payment.paymentProofName || "-"}
                            </p>
                            {payment.proofUrl && (
                              <button
                                type="button"
                                onClick={() =>
                                  window.open(payment.proofUrl || "", "_blank")
                                }
                                className="rounded-lg border border-teal-500/30 bg-teal-500/10 px-2 py-1 text-xs font-bold text-teal-300 hover:bg-teal-500/20"
                              >
                                Lihat Bukti
                              </button>
                            )}
                          </div>
                        </td>
                        <td className="px-3 py-3 text-slate-300">
                          {payment.note || "-"}
                        </td>
                      </tr>
                    ))}
                    {!isLoading && selectedFinalPayments.length === 0 && (
                      <tr>
                        <td
                          colSpan={7}
                          className="px-3 py-6 text-center text-sm text-slate-500"
                        >
                          Belum ada riwayat pembayaran.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </Panel>

            <Panel title="Item Batch Verifikasi Final" icon={ReceiptText}>
              <div className="overflow-x-auto rounded-xl border border-white/10">
                <table className="w-full min-w-[1250px] text-sm text-left">
                  <thead className="bg-black/50 text-xs uppercase tracking-wider text-slate-500 border-b border-white/10">
                    <tr>
                      {[
                        "No",
                        "No Surat",
                        "No Claim",
                        "Nama Program",
                        "Periode Awal",
                        "Periode Akhir",
                        "Toko",
                        "Barang",
                        "Nominal",
                        "Cara Bayar",
                        "Tipe",
                        "Deadline",
                      ].map((header) => (
                        <th key={header} className="px-3 py-3 font-bold">
                          {header}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/5">
                    {selectedFinalItems.map((item, index) => {
                      const period = splitPeriodDates(item.periode);
                      return (
                        <tr
                          key={item.id || `${item.noSurat}-${index}`}
                          className="hover:bg-white/[0.03]"
                        >
                          <td className="px-3 py-3 font-mono text-slate-300">
                            {item.itemNo || index + 1}
                          </td>
                          <td className="px-3 py-3 font-mono text-slate-200">
                            {item.noSurat || "-"}
                          </td>
                          <td className="px-3 py-3">
                            <input
                              value={finalClaimRefs[item.id] || ""}
                              onChange={(event) =>
                                setFinalClaimRefs((current) => ({
                                  ...current,
                                  [item.id]: event.target.value,
                                }))
                              }
                              placeholder="Isi No Claim"
                              className="w-full min-w-[160px] rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm font-mono text-slate-200 outline-none placeholder:text-slate-600 focus:border-teal-500/50"
                            />
                          </td>
                          <td className="px-3 py-3 min-w-[180px] text-slate-200">
                            {item.namaProgram || "-"}
                          </td>
                          <td className="px-3 py-3 text-slate-300">
                            {formatDateDisplay(period.periodeAwal)}
                          </td>
                          <td className="px-3 py-3 text-slate-300">
                            {formatDateDisplay(period.periodeAkhir)}
                          </td>
                          <td className="px-3 py-3 min-w-[140px] text-slate-300">
                            {item.toko || "-"}
                          </td>
                          <td className="px-3 py-3 text-slate-300">
                            {item.barang || "-"}
                          </td>
                          <td className="px-3 py-3 text-right font-mono text-emerald-300">
                            Rp{" "}
                            {Number(item.nominal || 0).toLocaleString("id-ID")}
                          </td>
                          <td className="px-3 py-3 text-slate-300">
                            {item.caraBayar || "-"}
                          </td>
                          <td className="px-3 py-3 text-slate-300">
                            {item.type || "-"}
                          </td>
                          <td className="px-3 py-3 text-slate-300">
                            {formatDateDisplay(item.deadline)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </Panel>

            <Panel title="Ringkasan Pembayaran Final" icon={ReceiptText}>
              <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-5 gap-3">
                <Field
                  label="Total Nominal"
                  value={`Rp ${finalTotalNominal.toLocaleString("id-ID")}`}
                />
                <Field
                  label="Transfer"
                  value={`Rp ${finalTransfer.toLocaleString("id-ID")}`}
                />
                <Field
                  label="Tunai"
                  value={`Rp ${finalTunai.toLocaleString("id-ID")}`}
                />
                <Field
                  label="Jumlah Dibayar Keuangan"
                  value={`Rp ${paidAmount.toLocaleString("id-ID")}`}
                />
                <Field
                  label="Sisa Pembayaran"
                  value={`Rp ${remainingFinalAmount.toLocaleString("id-ID")}`}
                />
              </div>
            </Panel>

            <Panel title="Form Verifikasi Final Claim" icon={ClipboardCheck}>
              <InfoNote>
                Claim hanya perlu mengecek bukti pembayaran dan kesesuaian total
                pembayaran. Jika ada masalah, kembalikan ke Keuangan. Jika
                sesuai, selesaikan pengajuan.
              </InfoNote>
              <div className="mt-4">
                <label className="block">
                  <span className="text-xs text-slate-500 font-semibold">
                    Catatan Final Claim
                  </span>
                  <textarea
                    value={finalClaimNote}
                    onChange={(event) => setFinalClaimNote(event.target.value)}
                    rows={4}
                    className="mt-1 w-full resize-none rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-slate-200 outline-none placeholder:text-slate-600 focus:border-teal-500/50"
                  />
                </label>
              </div>
              {canFinalClaim ? (
                <div className="mt-5 flex flex-wrap gap-3">
                  <button
                    onClick={returnToFinance}
                    disabled={!selectedFinalBatch || isActionLoading}
                    className="inline-flex items-center justify-center rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-2.5 text-sm font-bold text-rose-300 hover:bg-rose-500/20 disabled:opacity-50"
                  >
                    Kembalikan ke Keuangan
                  </button>
                  <button
                    onClick={rejectIncompleteDocuments}
                    disabled={!selectedFinalBatch || isActionLoading}
                    className="inline-flex items-center justify-center rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-2.5 text-sm font-bold text-amber-300 hover:bg-amber-500/20 disabled:opacity-50"
                  >
                    Tolak karena kelengkapan belum lengkap
                  </button>
                  <button
                    onClick={completeFinalClaim}
                    disabled={!selectedFinalBatch || isActionLoading}
                    className="inline-flex items-center justify-center rounded-xl border border-emerald-500 bg-emerald-600 px-4 py-2.5 text-sm font-bold text-white hover:bg-emerald-500 disabled:opacity-50"
                  >
                    Selesaikan
                  </button>
                </div>
              ) : (
                <div className="mt-5 rounded-xl border border-white/10 bg-black/30 px-4 py-3 text-sm text-slate-400">
                  Baca-saja: role ini tidak bisa memproses final Claim.
                </div>
              )}
            </Panel>
          </div>
        </div>
      )}
    </div>
  );
}

function LiveQueueSummaryPanel({ batches }: { batches: OffApiBatch[] }) {
  const queues = [
    {
      title: "Draf/Dikembalikan Supervisor",
      count: batches.filter(
        (batch) =>
          batch.status === "Draft" ||
          batch.status === "Returned by SM" ||
          batch.status === "Returned by Claim" ||
          batch.smStatus === "Returned" ||
          batch.claimStatus === "Returned",
      ).length,
      desc: "Batch masih bisa diedit Supervisor.",
      icon: FileText,
    },
    {
      title: "Menunggu Review SM",
      count: batches.filter((batch) => isSmActionableBatch(batch)).length,
      desc: "Menunggu validasi benar/salah data batch.",
      icon: Send,
    },
    {
      title: "Menunggu Validasi Claim",
      count: batches.filter(
        (batch) =>
          batch.smStatus === "Approved by SM" &&
          !["Approved", "Returned"].includes(batch.claimStatus) &&
          ![
            "Cancelled",
            "Completed",
            "Claim Approved",
            "Returned by Claim",
          ].includes(batch.status),
      ).length,
      desc: "Claim mengecek data dan syarat secara manual.",
      icon: FileCheck2,
    },
    {
      title: "Menunggu Persetujuan OM",
      count: batches.filter((batch) => isOmActionableBatch(batch)).length,
      desc: "Batch disetujui Claim, menunggu OM.",
      icon: ShieldCheck,
    },
    {
      title: "Menunggu Pembayaran Keuangan",
      count: batches.filter((batch) => isFinanceActionableBatch(batch)).length,
      desc: "Sudah disetujui OM, menunggu pembayaran.",
      icon: Wallet,
    },
    {
      title: "Menunggu Verifikasi Final Claim",
      count: batches.filter(
        (batch) =>
          batch.status === "Paid" &&
          batch.financeStatus === "Paid" &&
          batch.finalStatus !== "Completed",
      ).length,
      desc: "Sudah dibayar, verifikasi final claim.",
      icon: ListChecks,
    },
    {
      title: "Selesai",
      count: batches.filter(
        (batch) =>
          batch.status === "Completed" || batch.finalStatus === "Completed",
      ).length,
      desc: "Alur batch sudah selesai.",
      icon: CheckCircle2,
    },
  ];

  return (
    <Panel title="Ringkasan Antrean Per Divisi" icon={ListChecks}>
      <div className="grid grid-cols-1 md:grid-cols-2 2xl:grid-cols-7 gap-3">
        {queues.map((queue) => {
          const Icon = queue.icon;

          return (
            <div
              key={queue.title}
              className="rounded-xl border border-white/10 bg-black/30 p-4"
            >
              <div className="flex items-start justify-between gap-3">
                <Icon className="text-teal-300 shrink-0" size={20} />
                <span className="font-mono text-xl font-black text-white">
                  {queue.count}
                </span>
              </div>
              <p className="text-sm font-bold text-white mt-3">{queue.title}</p>
              <p className="text-xs text-slate-500 mt-1">{queue.desc}</p>
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

function OperationalManagerDashboard({ offRole }: OffDashboardProps) {
  const canDecideOm =
    canPerformOffAction(offRole, "om_approve") ||
    canPerformOffAction(offRole, "om_cancel");
  const [omBatches, setOmBatches] = useState<OffApiBatch[]>([]);
  const [omMenu, setOmMenu] = useState<"monitoring" | "approval">("monitoring");
  const [omSearch, setOmSearch] = useState("");
  const [omStatusFilter, setOmStatusFilter] = useState("");
  const [selectedBatch, setSelectedBatch] = useState<OffApiBatch | null>(null);
  const [selectedItems, setSelectedItems] = useState<OffApiItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isActionLoading, setIsActionLoading] = useState(false);
  const [omNote, setOmNote] = useState("");
  const [omMessage, setOmMessage] = useState("");
  const summary = selectedBatch?.summary;
  const totalNominal = Number(
    summary?.totalNominal ||
      selectedItems.reduce(
        (total, item) => total + Number(item.nominal || 0),
        0,
      ),
  );
  const transfer = Number(
    summary?.transfer ||
      selectedItems
        .filter(
          (item) =>
            normalizeUiPaymentMethod(item.caraBayar || "") === "Transfer",
        )
        .reduce((total, item) => total + Number(item.nominal || 0), 0),
  );
  const tunai = Number(
    summary?.tunai ||
      selectedItems
        .filter(
          (item) => normalizeUiPaymentMethod(item.caraBayar || "") === "Tunai",
        )
        .reduce((total, item) => total + Number(item.nominal || 0), 0),
  );
  const hasMixedPaymentTypes = transfer > 0 && tunai > 0;

  const isOmQueueBatch = (batch: OffApiBatch) =>
    batch.smStatus === "Approved by SM" &&
    batch.claimStatus === "Approved" &&
    batch.omStatus === "Waiting Approval" &&
    (batch.status === "Claim Approved" ||
      batch.status === "Ready for OM" ||
      batch.status === "Waiting OM") &&
    !["Cancelled by OM", "OM Approved", "Completed"].includes(batch.status);

  const loadOmDetail = async (batch: OffApiBatch) => {
    const response = await fetch(
      `/api/off-program-control/batches/${batch.id}`,
      { credentials: "include" },
    );
    const data = await parseJsonResponse(response);
    if (!response.ok || !data.ok)
      throw new Error(String(data.error || "Gagal mengambil detail OM."));
    setSelectedBatch((data.batch as OffApiBatch) || batch);
    setSelectedItems(
      Array.isArray(data.items) ? (data.items as OffApiItem[]) : [],
    );
    setOmNote((data.batch as OffApiBatch)?.omNote || "");
  };

  const loadOmBatches = async () => {
    setIsLoading(true);
    setOmMessage("");
    try {
      const response = await fetch("/api/off-program-control/batches", {
        credentials: "include",
      });
      const data = await parseJsonResponse(response);
      if (!response.ok || !data.ok)
        throw new Error(String(data.error || "Gagal mengambil antrean OM."));
      const rows = Array.isArray(data.batches)
        ? (data.batches as OffApiBatch[])
        : [];
      setOmBatches(rows);
      const nextBatch = rows.find(isOmQueueBatch) || rows[0] || null;
      setSelectedBatch(nextBatch);
      if (nextBatch) {
        await loadOmDetail(nextBatch);
      } else {
        setSelectedItems([]);
        setOmNote("");
      }
    } catch (error) {
      setOmMessage(
        error instanceof Error ? error.message : "Gagal mengambil antrean OM.",
      );
      setSelectedItems([]);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadOmBatches();
    // OM queue should load once when this tab component mounts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectOmBatch = async (batch: OffApiBatch) => {
    setSelectedBatch(batch);
    setOmMenu("approval");
    setSelectedItems([]);
    setOmMessage("");
    try {
      await loadOmDetail(batch);
    } catch (error) {
      setOmMessage(
        error instanceof Error ? error.message : "Gagal mengambil detail OM.",
      );
    }
  };

  const decideOm = async (action: "approve" | "cancel") => {
    if (!selectedBatch) return;
    if (action === "cancel" && !omNote.trim()) {
      setOmMessage("Catatan wajib diisi untuk cancel.");
      return;
    }
    setIsActionLoading(true);
    setOmMessage("");
    try {
      const response = await fetch(
        `/api/off-program-control/batches/${selectedBatch.id}/om-decision`,
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action, note: omNote }),
        },
      );
      const data = await parseJsonResponse(response);
      if (!response.ok || !data.ok)
        throw new Error(
          String(data.error || data.message || "Gagal memproses keputusan OM."),
        );
      setOmMessage(String(data.message || "Keputusan OM berhasil disimpan."));
      setOmNote("");
      await loadOmBatches();
    } catch (error) {
      setOmMessage(
        error instanceof Error
          ? error.message
          : "Gagal memproses keputusan OM.",
      );
    } finally {
      setIsActionLoading(false);
    }
  };

  const omStatusOptions = getBatchStatusOptions(omBatches);

  const filteredOmBatches = filterBatchesByMainStatus(
    filterBatchesBySearch(omBatches, omSearch),
    omStatusFilter,
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap gap-2 rounded-2xl border border-white/10 bg-[#1a1c23]/60 p-2">
        {[
          ["monitoring", "Monitoring Batch Pengajuan"],
          ["approval", "Persetujuan OM"],
        ].map(([key, label]) => (
          <button
            key={key}
            onClick={() => setOmMenu(key as "monitoring" | "approval")}
            className={`rounded-xl px-4 py-2.5 text-sm font-bold transition-colors ${
              omMenu === key
                ? "border border-teal-500/30 bg-teal-500/20 text-teal-200"
                : "border border-transparent text-slate-400 hover:bg-white/5 hover:text-white"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {omMenu === "monitoring" && (
        <div className="space-y-6">
          <LiveQueueSummaryPanel batches={omBatches} />

          <div className="space-y-4">
            <div className="grid grid-cols-1 gap-3 xl:grid-cols-[1fr_280px]">
              <MonitoringSearch
                value={omSearch}
                onChange={setOmSearch}
                placeholder="Cari No Pengajuan, principle, kode, atau status OM..."
              />

              <StatusFilterSelect
                value={omStatusFilter}
                onChange={setOmStatusFilter}
                options={omStatusOptions}
              />
            </div>

            {isLoading && (
              <p className="text-sm text-slate-400">Memuat data OM...</p>
            )}

            <BatchOverviewActionTable
              batches={filteredOmBatches}
              selectedBatchId={selectedBatch?.id}
              onSelect={selectOmBatch}
              actionLabel={(batch) =>
                isOmActionableBatch(batch) ? "Review OM" : "Lihat Detail"
              }
            />
          </div>
        </div>
      )}

      {omMenu === "approval" && (
        <div className="space-y-6">
          <Panel title="Detail Persetujuan OM" icon={ClipboardCheck}>
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
              <Field
                label="No Pengajuan"
                value={selectedBatch?.noPengajuan || "-"}
              />
              <Field
                label="Gelombang"
                value={selectedBatch?.gelombang || "-"}
              />
              <Field
                label="Principle"
                value={selectedBatch?.principleName || "-"}
              />
              <Field
                label="Kode Principle"
                value={selectedBatch?.principleCode || "-"}
              />
              <Field
                label="Bulan/Tahun"
                value={
                  selectedBatch
                    ? `${selectedBatch.bulan}/${selectedBatch.tahun}`
                    : "-"
                }
              />
              <Field
                label="Supervisor"
                value={selectedBatch?.supervisorName || "-"}
              />
              <Field label="No Claim" value={selectedBatch?.noClaim || "-"} />
              <Field
                label="Tanggal Diajukan Claim"
                value={formatDateDisplay(selectedBatch?.claimSubmittedDate)}
              />
              <Field
                label="Deadline Claim"
                value={formatDateDisplay(selectedBatch?.claimDeadline)}
              />
              <Field
                label="Total Nominal"
                value={`Rp ${totalNominal.toLocaleString("id-ID")}`}
              />
              <Field
                label="Status SM"
                value={displayStatusLabel(selectedBatch?.smStatus)}
              />
              <Field
                label="Status Claim"
                value={displayStatusLabel(selectedBatch?.claimStatus)}
              />
              <Field
                label="Status OM"
                value={displayStatusLabel(selectedBatch?.omStatus)}
              />
            </div>
          </Panel>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="rounded-xl border border-white/10 bg-black/30 p-4">
              <h3 className="font-bold text-white mb-3">Data Disetujui SM</h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <Field
                  label="Status SM"
                  value={displayStatusLabel(selectedBatch?.smStatus)}
                />
                <Field
                  label="Supervisor Terkunci"
                  value={selectedBatch?.locked ? "Ya" : "Tidak"}
                />
                <Field
                  label="Audit Persetujuan SM"
                  value="Tercatat di log audit"
                />
                <Field
                  label="Pratinjau Notifikasi OM"
                  value={
                    selectedBatch?.omStatus === "Waiting Approval"
                      ? "Claim meneruskan ke OM"
                      : displayStatusLabel(selectedBatch?.omStatus)
                  }
                />
              </div>
              <div className="mt-3">
                <TextArea
                  label="Catatan SM"
                  value={selectedBatch?.smNote || "-"}
                />
              </div>
            </div>
            <div className="rounded-xl border border-white/10 bg-black/30 p-4">
              <h3 className="font-bold text-white mb-3">Validasi Claim</h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <Field
                  label="Status Claim"
                  value={displayStatusLabel(selectedBatch?.claimStatus)}
                />
                <Field label="No Claim" value={selectedBatch?.noClaim || "-"} />
                <Field
                  label="Tanggal Diajukan"
                  value={formatDateDisplay(selectedBatch?.claimSubmittedDate)}
                />
                <Field
                  label="Deadline Claim"
                  value={formatDateDisplay(selectedBatch?.claimDeadline)}
                />
                <Field label="Status Kelengkapan Claim" value="Aman" />
              </div>
              <div className="mt-3">
                <TextArea
                  label="Catatan Claim"
                  value={selectedBatch?.claimNote || "-"}
                />
              </div>
            </div>
          </div>

          <Panel title="Item Batch untuk Persetujuan OM" icon={ReceiptText}>
            <div className="overflow-x-auto rounded-xl border border-white/10">
              <table className="w-full min-w-[1350px] text-sm text-left">
                <thead className="bg-black/50 text-xs uppercase tracking-wider text-slate-500 border-b border-white/10">
                  <tr>
                    {[
                      "No",
                      "No Surat",
                      "Nama Program",
                      "Periode Awal",
                      "Periode Akhir",
                      "Toko",
                      "Barang",
                      "Nominal",
                      "Cara Bayar",
                      "Tipe",
                      "Deadline",
                      "Kelengkapan",
                    ].map((header) => (
                      <th key={header} className="px-3 py-3 font-bold">
                        {header}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                  {selectedItems.map((item, index) => {
                    const period = splitPeriodDates(item.periode);
                    return (
                      <tr
                        key={item.id || `${item.noSurat}-${index}`}
                        className="hover:bg-white/[0.03]"
                      >
                        <td className="px-3 py-3 font-mono text-slate-300">
                          {item.itemNo || index + 1}
                        </td>
                        <td className="px-3 py-3 font-mono text-slate-200">
                          {item.noSurat || "-"}
                        </td>
                        <td className="px-3 py-3 min-w-[180px] text-slate-200">
                          {item.namaProgram || "-"}
                        </td>
                        <td className="px-3 py-3 text-slate-300">
                          {formatDateDisplay(period.periodeAwal)}
                        </td>
                        <td className="px-3 py-3 text-slate-300">
                          {formatDateDisplay(period.periodeAkhir)}
                        </td>
                        <td className="px-3 py-3 min-w-[140px] text-slate-300">
                          {item.toko || "-"}
                        </td>
                        <td className="px-3 py-3 text-slate-300">
                          {item.barang || "-"}
                        </td>
                        <td className="px-3 py-3 text-right font-mono text-emerald-300">
                          Rp {Number(item.nominal || 0).toLocaleString("id-ID")}
                        </td>
                        <td className="px-3 py-3 text-slate-300">
                          {item.caraBayar || "-"}
                        </td>
                        <td className="px-3 py-3 text-slate-300">
                          {item.type || "-"}
                        </td>
                        <td className="px-3 py-3 text-slate-300">
                          {formatDateDisplay(item.deadline)}
                        </td>
                        <td className="px-3 py-3 min-w-[180px] text-slate-300">
                          {itemDocsSummary(item)}
                        </td>
                      </tr>
                    );
                  })}
                  {!isLoading && selectedItems.length === 0 && (
                    <tr>
                      <td
                        colSpan={12}
                        className="px-3 py-6 text-center text-sm text-slate-500"
                      >
                        Pilih batch untuk melihat item.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </Panel>

          <Panel title="Ringkasan Pembayaran" icon={Wallet}>
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
              <Field
                label="Total"
                value={`Rp ${totalNominal.toLocaleString("id-ID")}`}
              />
              <Field
                label="Transfer"
                value={`Rp ${transfer.toLocaleString("id-ID")}`}
              />
              <Field
                label="Tunai"
                value={`Rp ${tunai.toLocaleString("id-ID")}`}
              />
            </div>
            {hasMixedPaymentTypes && (
              <div className="mt-4 rounded-xl border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
                Batch ini memiliki lebih dari satu jenis pembayaran. Pastikan
                pembayaran sesuai rincian baris.
              </div>
            )}
          </Panel>

          <Panel title="Keputusan Operational Manager" icon={ShieldCheck}>
            <label className="block">
              <span className="text-xs text-slate-500 font-semibold">
                Catatan OM
              </span>
              <textarea
                value={omNote}
                onChange={(event) => setOmNote(event.target.value)}
                placeholder="Catatan wajib diisi untuk pembatalan. Catatan persetujuan boleh dikosongkan."
                rows={4}
                className="mt-1 w-full resize-none rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-slate-200 outline-none placeholder:text-slate-600 focus:border-teal-500/50"
              />
            </label>
            {omMessage && (
              <div className="mt-4 rounded-xl border border-white/10 bg-black/30 px-4 py-3 text-sm text-slate-300">
                {omMessage}
              </div>
            )}
            {canDecideOm ? (
              <div className="mt-5 flex flex-wrap gap-3">
                <button
                  onClick={() => decideOm("cancel")}
                  disabled={
                    !selectedBatch ||
                    !isOmActionableBatch(selectedBatch) ||
                    isActionLoading
                  }
                  className="inline-flex items-center justify-center gap-2 rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-2.5 text-sm font-bold text-rose-300 transition-colors hover:bg-rose-500/20 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <XCircle size={16} /> Batalkan
                </button>
                <button
                  onClick={() => decideOm("approve")}
                  disabled={
                    !selectedBatch ||
                    !isOmActionableBatch(selectedBatch) ||
                    isActionLoading
                  }
                  className="inline-flex items-center justify-center gap-2 rounded-xl border border-emerald-500 bg-emerald-600 px-4 py-2.5 text-sm font-bold text-white transition-colors hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <CheckCircle2 size={16} /> Setujui
                </button>
              </div>
            ) : (
              <div className="mt-5 rounded-xl border border-white/10 bg-black/30 px-4 py-3 text-sm text-slate-400">
                Baca-saja: role ini tidak bisa mengambil keputusan OM.
              </div>
            )}
          </Panel>
        </div>
      )}
    </div>
  );
}

function FinanceDashboard({ offRole }: OffDashboardProps) {
  const canPayFinance = canPerformOffAction(offRole, "finance_payment");
  const [financeMenu, setFinanceMenu] = useState<"monitoring" | "payment">(
    "monitoring",
  );
  const [financeBatches, setFinanceBatches] = useState<OffApiBatch[]>([]);
  const [financeSearch, setFinanceSearch] = useState("");
  const [financeStatusFilter, setFinanceStatusFilter] = useState("");
  const [selectedBatch, setSelectedBatch] = useState<OffApiBatch | null>(null);
  const [selectedFinanceBatchId, setSelectedFinanceBatchId] = useState<
    string | null
  >(null);
  const [selectedItems, setSelectedItems] = useState<OffApiItem[]>([]);
  const [selectedPayments, setSelectedPayments] = useState<OffApiPayment[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isActionLoading, setIsActionLoading] = useState(false);
  const [financeMessage, setFinanceMessage] = useState("");
  const [paymentDate, setPaymentDate] = useState("");
  const [paidAmount, setPaidAmount] = useState("");
  const [paymentMethod, setPaymentMethod] = useState("Transfer");
  const [senderBank, setSenderBank] = useState("");
  const [paymentProofFile, setPaymentProofFile] = useState<File | null>(null);
  const [financeNote, setFinanceNote] = useState("");
  const [paymentResult, setPaymentResult] = useState<{
    paymentNo?: number;
    paymentDate: string;
    paidAmount: string;
    paymentMethod: string;
    senderBank: string;
    paymentProofName: string;
    remainingAmount?: number;
    isFullyPaid?: boolean;
  } | null>(null);
  const summary = selectedBatch?.summary;
  const totalNominal = Number(
    summary?.totalNominal ||
      selectedItems.reduce(
        (total, item) => total + Number(item.nominal || 0),
        0,
      ),
  );
  const transfer = Number(
    summary?.transfer ||
      selectedItems
        .filter(
          (item) =>
            normalizeUiPaymentMethod(item.caraBayar || "") === "Transfer",
        )
        .reduce((total, item) => total + Number(item.nominal || 0), 0),
  );
  const tunai = Number(
    summary?.tunai ||
      selectedItems
        .filter(
          (item) => normalizeUiPaymentMethod(item.caraBayar || "") === "Tunai",
        )
        .reduce((total, item) => total + Number(item.nominal || 0), 0),
  );
  const paymentSummary = selectedBatch?.paymentSummary;
  const totalPaid = Number(
    paymentSummary?.totalPaid ??
      selectedBatch?.paidAmount ??
      selectedPayments.reduce(
        (total, payment) => total + Number(payment.paidAmount || 0),
        0,
      ),
  );
  const remainingAmount = Number(
    paymentSummary?.remainingAmount ?? Math.max(0, totalNominal - totalPaid),
  );
  const hasMixedItemPayments = transfer > 0 && tunai > 0;

  const isFinanceQueueBatch = (batch: OffApiBatch) =>
    batch.smStatus === "Approved by SM" &&
    batch.claimStatus === "Approved" &&
    batch.omStatus === "Approved" &&
    ["Waiting Payment", "Partial Paid", "Need Correction"].includes(
      batch.financeStatus,
    ) &&
    !["Cancelled by OM", "Paid", "Completed", "Cancelled"].includes(
      batch.status,
    );

  const loadFinanceDetail = async (batch: OffApiBatch) => {
    const response = await fetch(
      `/api/off-program-control/batches/${batch.id}`,
      { credentials: "include" },
    );
    const data = await parseJsonResponse(response);
    if (!response.ok || !data.ok)
      throw new Error(String(data.error || "Gagal mengambil detail Keuangan."));
    const detailBatch = data.batch as OffApiBatch;
    const payments = Array.isArray(data.payments)
      ? (data.payments as OffApiPayment[])
      : [];
    setSelectedBatch({
      ...(detailBatch || batch),
      paymentSummary: data.paymentSummary as OffPaymentSummary | undefined,
      payments,
    });
    setSelectedItems(
      Array.isArray(data.items) ? (data.items as OffApiItem[]) : [],
    );
    setSelectedPayments(payments);
    setPaymentDate("");
    setPaidAmount("");
    setFinanceNote(detailBatch?.financeNote || "");
  };

  const loadFinanceBatches = async (options?: {
    preserveSelectedId?: string | null;
    autoSelectFirst?: boolean;
  }) => {
    setIsLoading(true);
    setFinanceMessage("");
    try {
      const response = await fetch("/api/off-program-control/batches", {
        credentials: "include",
      });
      const data = await parseJsonResponse(response);
      if (!response.ok || !data.ok)
        throw new Error(
          String(data.error || "Gagal mengambil antrean Keuangan."),
        );
      const rows = Array.isArray(data.batches)
        ? (data.batches as OffApiBatch[])
        : [];
      const monitoringRows = rows.filter(isFinanceMonitoringBatch);
      const queue = rows.filter(isFinanceQueueBatch);
      setFinanceBatches(monitoringRows);
      const preservedId = options?.preserveSelectedId || selectedFinanceBatchId;
      const preservedBatch = preservedId
        ? queue.find((batch) => batch.id === preservedId) || null
        : null;
      const nextBatch =
        preservedBatch ||
        (options?.autoSelectFirst === false ? null : queue[0] || null);
      if (nextBatch) {
        setSelectedBatch(nextBatch);
        setSelectedFinanceBatchId(nextBatch.id);
        await loadFinanceDetail(nextBatch);
      } else if (preservedId) {
        const finishedBatch =
          rows.find((batch) => batch.id === preservedId) || null;
        if (finishedBatch) {
          setSelectedBatch(finishedBatch);
          setSelectedFinanceBatchId(finishedBatch.id);
          await loadFinanceDetail(finishedBatch);
        }
      } else {
        setSelectedBatch(null);
        setSelectedFinanceBatchId(null);
        setSelectedItems([]);
        setSelectedPayments([]);
        setPaymentDate("");
        setPaidAmount("");
        setFinanceNote("");
      }
    } catch (error) {
      setFinanceMessage(
        error instanceof Error
          ? error.message
          : "Gagal mengambil antrean Keuangan.",
      );
      setSelectedItems([]);
      setSelectedPayments([]);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadFinanceBatches({ autoSelectFirst: false });
    // Finance queue should load once when this tab component mounts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectFinanceBatch = async (batch: OffApiBatch) => {
    setSelectedBatch(batch);
    setSelectedFinanceBatchId(batch.id);
    setSelectedItems([]);
    setSelectedPayments([]);
    setFinanceMessage("");
    setPaymentResult(null);
    setPaymentProofFile(null);
    setFinanceMenu("payment");
    try {
      await loadFinanceDetail(batch);
    } catch (error) {
      setFinanceMessage(
        error instanceof Error
          ? error.message
          : "Gagal mengambil detail Keuangan.",
      );
    }
  };

  const submitFinancePayment = async () => {
    if (!selectedBatch) return;
    setIsActionLoading(true);
    setFinanceMessage("");
    try {
      if (!paymentProofFile) {
        setFinanceMessage("Bukti pembayaran wajib diupload.");
        return;
      }
      if (
        !["application/pdf", "image/png", "image/jpeg"].includes(
          paymentProofFile.type,
        )
      ) {
        setFinanceMessage("File bukti pembayaran harus PDF/PNG/JPG/JPEG.");
        return;
      }
      if (paymentProofFile.size > 5 * 1024 * 1024) {
        setFinanceMessage("Ukuran file maksimal 5MB.");
        return;
      }
      const formData = new FormData();
      formData.append("paymentDate", paymentDate);
      formData.append("paidAmount", paidAmount);
      formData.append("paymentMethod", paymentMethod);
      formData.append("senderBank", senderBank);
      formData.append("note", financeNote);
      formData.append("paymentProof", paymentProofFile);
      const response = await fetch(
        `/api/off-program-control/batches/${selectedBatch.id}/finance-payment`,
        {
          method: "POST",
          credentials: "include",
          body: formData,
        },
      );
      const data = await parseJsonResponse(response);
      if (!response.ok || !data.ok)
        throw new Error(
          String(data.error || data.message || "Gagal mengirim pembayaran."),
        );
      const nextPaymentSummary = data.paymentSummary as
        | OffPaymentSummary
        | undefined;
      setFinanceMessage(
        nextPaymentSummary?.isFullyPaid
          ? "Pembayaran lunas. Pengajuan dikirim ke Verifikasi Final Claim."
          : String(data.message || "Pembayaran berhasil dicatat."),
      );
      const payment = data.payment as OffApiPayment | undefined;
      setPaymentResult({
        paymentNo: payment?.paymentNo,
        paymentDate,
        paidAmount,
        paymentMethod,
        senderBank,
        paymentProofName: paymentProofFile.name,
        remainingAmount: nextPaymentSummary?.remainingAmount,
        isFullyPaid: nextPaymentSummary?.isFullyPaid,
      });
      setPaymentDate("");
      setPaidAmount("");
      setPaymentProofFile(null);
      await loadFinanceBatches({
        preserveSelectedId: selectedBatch.id,
        autoSelectFirst: false,
      });
    } catch (error) {
      setFinanceMessage(
        error instanceof Error ? error.message : "Gagal mengirim pembayaran.",
      );
    } finally {
      setIsActionLoading(false);
    }
  };

  const financeStatusOptions = [
    "Waiting Payment",
    "Partial Paid",
    "Need Correction",
    "Paid",
    "Waiting Claim Final Verification",
    "Incomplete Documents",
    "Completed",
  ].map((status) => ({
    value: status,
    label: displayStatusLabel(status),
  }));

  const filteredFinanceBatches = filterFinanceBatchesByStatus(
    filterBatchesBySearch(financeBatches, financeSearch),
    financeStatusFilter,
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap gap-2 rounded-2xl border border-white/10 bg-[#1a1c23]/60 p-2">
        {[
          ["monitoring", "Monitoring Batch Pembayaran"],
          ["payment", "Pembayaran"],
        ].map(([key, label]) => (
          <button
            key={key}
            onClick={() => setFinanceMenu(key as "monitoring" | "payment")}
            className={`rounded-xl px-4 py-2.5 text-sm font-bold transition-colors ${
              financeMenu === key
                ? "border border-teal-500/30 bg-teal-500/20 text-teal-200"
                : "border border-transparent text-slate-400 hover:bg-white/5 hover:text-white"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {financeMenu === "monitoring" && (
        <Panel title="Monitoring Batch Pembayaran" icon={Wallet}>
          <div className="mb-4 grid grid-cols-1 gap-3 xl:grid-cols-[1fr_280px]">
            <MonitoringSearch
              value={financeSearch}
              onChange={setFinanceSearch}
              placeholder="Cari No Pengajuan, principle, kode, status, atau No Claim..."
            />
            <StatusFilterSelect
              value={financeStatusFilter}
              onChange={setFinanceStatusFilter}
              options={financeStatusOptions}
            />
          </div>
          {isLoading && (
            <p className="mb-4 text-sm text-slate-400">
              Memuat data Keuangan...
            </p>
          )}
          <FinanceMonitoringTable
            batches={filteredFinanceBatches}
            selectedBatchId={selectedBatch?.id}
            onSelect={selectFinanceBatch}
          />
        </Panel>
      )}

      {financeMenu === "payment" && !selectedBatch && (
        <Panel title="Pembayaran" icon={Wallet}>
          <p className="text-sm text-slate-400">
            Pilih batch dari Monitoring Batch Pembayaran untuk melihat detail
            pembayaran.
          </p>
        </Panel>
      )}

      {financeMenu === "payment" && selectedBatch && (
        <div className="space-y-6">
          <Panel title="Detail Pembayaran Keuangan" icon={Wallet}>
            <InfoNote>
              Keuangan menerima data setelah OM menyetujui. Setelah bayar, data
              masuk kembali ke Claim untuk verifikasi final pembayaran.
            </InfoNote>
            <div className="mt-5 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
              <Field
                label="No Pengajuan"
                value={selectedBatch?.noPengajuan || "-"}
              />
              <Field
                label="Principle"
                value={selectedBatch?.principleName || "-"}
              />
              <Field
                label="Kode Principle"
                value={selectedBatch?.principleCode || "-"}
              />
              <Field
                label="Bulan/Tahun"
                value={
                  selectedBatch
                    ? `${selectedBatch.bulan}/${selectedBatch.tahun}`
                    : "-"
                }
              />
              <Field
                label="Supervisor"
                value={selectedBatch?.supervisorName || "-"}
              />
              <Field label="No Claim" value={selectedBatch?.noClaim || "-"} />
              <Field
                label="Tanggal Diajukan Claim"
                value={formatDateDisplay(selectedBatch?.claimSubmittedDate)}
              />
              <Field
                label="Deadline Claim"
                value={formatDateDisplay(selectedBatch?.claimDeadline)}
              />
              <Field
                label="Total Nominal"
                value={`Rp ${totalNominal.toLocaleString("id-ID")}`}
              />
              <Field
                label="Status SM"
                value={displayStatusLabel(selectedBatch?.smStatus)}
              />
              <Field
                label="Status Claim"
                value={displayStatusLabel(selectedBatch?.claimStatus)}
              />
              <Field
                label="Status OM"
                value={displayStatusLabel(selectedBatch?.omStatus)}
              />
              <Field
                label="Status Keuangan"
                value={displayStatusLabel(selectedBatch?.financeStatus)}
              />
            </div>
          </Panel>

          <Panel title="Ringkasan Pembayaran Disetujui" icon={ReceiptText}>
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
              <Field
                label="Total Pengajuan"
                value={`Rp ${totalNominal.toLocaleString("id-ID")}`}
              />
              <Field
                label="Total Sudah Dibayar"
                value={`Rp ${totalPaid.toLocaleString("id-ID")}`}
              />
              <Field
                label="Sisa Pembayaran"
                value={`Rp ${remainingAmount.toLocaleString("id-ID")}`}
              />
              <Field
                label="Status"
                value={displayStatusLabel(selectedBatch?.financeStatus)}
              />
              <Field
                label="Total Transfer Baris"
                value={`Rp ${transfer.toLocaleString("id-ID")}`}
              />
              <Field
                label="Total Tunai Baris"
                value={`Rp ${tunai.toLocaleString("id-ID")}`}
              />
            </div>
            {hasMixedItemPayments && (
              <div className="mt-4 rounded-xl border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
                Batch ini memiliki lebih dari satu jenis pembayaran. Pastikan
                pembayaran sesuai rincian baris.
              </div>
            )}
          </Panel>

          <Panel title="Item Batch untuk Pembayaran" icon={ListChecks}>
            <div className="overflow-x-auto rounded-xl border border-white/10">
              <table className="w-full min-w-[1250px] text-sm text-left">
                <thead className="bg-black/50 text-xs uppercase tracking-wider text-slate-500 border-b border-white/10">
                  <tr>
                    {[
                      "No",
                      "No Surat",
                      "Nama Program",
                      "Periode Awal",
                      "Periode Akhir",
                      "Toko",
                      "Barang",
                      "Nominal",
                      "Cara Bayar",
                      "Tipe",
                      "Deadline",
                    ].map((header) => (
                      <th key={header} className="px-3 py-3 font-bold">
                        {header}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                  {selectedItems.map((item, index) => {
                    const period = splitPeriodDates(item.periode);
                    return (
                      <tr
                        key={item.id || `${item.noSurat}-${index}`}
                        className="hover:bg-white/[0.03]"
                      >
                        <td className="px-3 py-3 font-mono text-slate-300">
                          {item.itemNo || index + 1}
                        </td>
                        <td className="px-3 py-3 font-mono text-slate-200">
                          {item.noSurat || "-"}
                        </td>
                        <td className="px-3 py-3 min-w-[180px] text-slate-200">
                          {item.namaProgram || "-"}
                        </td>
                        <td className="px-3 py-3 text-slate-300">
                          {formatDateDisplay(period.periodeAwal)}
                        </td>
                        <td className="px-3 py-3 text-slate-300">
                          {formatDateDisplay(period.periodeAkhir)}
                        </td>
                        <td className="px-3 py-3 min-w-[140px] text-slate-300">
                          {item.toko || "-"}
                        </td>
                        <td className="px-3 py-3 text-slate-300">
                          {item.barang || "-"}
                        </td>
                        <td className="px-3 py-3 text-right font-mono text-emerald-300">
                          Rp {Number(item.nominal || 0).toLocaleString("id-ID")}
                        </td>
                        <td className="px-3 py-3 text-slate-300">
                          {item.caraBayar || "-"}
                        </td>
                        <td className="px-3 py-3 text-slate-300">
                          {item.type || "-"}
                        </td>
                        <td className="px-3 py-3 text-slate-300">
                          {formatDateDisplay(item.deadline)}
                        </td>
                      </tr>
                    );
                  })}
                  {!isLoading && selectedItems.length === 0 && (
                    <tr>
                      <td
                        colSpan={11}
                        className="px-3 py-6 text-center text-sm text-slate-500"
                      >
                        Pilih batch untuk melihat item.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </Panel>

          <Panel title="Riwayat Pembayaran" icon={ReceiptText}>
            <div className="overflow-x-auto rounded-xl border border-white/10">
              <table className="w-full min-w-[900px] text-sm text-left">
                <thead className="bg-black/50 text-xs uppercase tracking-wider text-slate-500 border-b border-white/10">
                  <tr>
                    {[
                      "No Pembayaran",
                      "Tanggal Bayar",
                      "Metode",
                      "Jumlah",
                      "Bank Pengirim",
                      "Bukti Pembayaran",
                      "Catatan",
                    ].map((header) => (
                      <th key={header} className="px-3 py-3 font-bold">
                        {header}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                  {selectedPayments.map((payment) => (
                    <tr key={payment.id} className="hover:bg-white/[0.03]">
                      <td className="px-3 py-3 font-mono text-slate-300">
                        {payment.paymentNo}
                      </td>
                      <td className="px-3 py-3 text-slate-300">
                        {formatDateDisplay(payment.paymentDate)}
                      </td>
                      <td className="px-3 py-3 text-slate-300">
                        {payment.paymentMethod}
                      </td>
                      <td className="px-3 py-3 text-right font-mono text-emerald-300">
                        Rp{" "}
                        {Number(payment.paidAmount || 0).toLocaleString(
                          "id-ID",
                        )}
                      </td>
                      <td className="px-3 py-3 text-slate-300">
                        {payment.senderBank || "-"}
                      </td>
                      <td className="px-3 py-3">
                        <div className="min-w-[180px] space-y-2">
                          <p className="font-mono text-xs text-slate-300">
                            {payment.paymentProofName || "-"}
                          </p>
                          {payment.proofUrl && (
                            <button
                              type="button"
                              onClick={() =>
                                window.open(payment.proofUrl || "", "_blank")
                              }
                              className="rounded-lg border border-teal-500/30 bg-teal-500/10 px-2 py-1 text-xs font-bold text-teal-300 hover:bg-teal-500/20"
                            >
                              Lihat Bukti
                            </button>
                          )}
                        </div>
                      </td>
                      <td className="px-3 py-3 text-slate-300">
                        {payment.note || "-"}
                      </td>
                    </tr>
                  ))}
                  {!isLoading && selectedPayments.length === 0 && (
                    <tr>
                      <td
                        colSpan={7}
                        className="px-3 py-6 text-center text-sm text-slate-500"
                      >
                        Belum ada pembayaran untuk batch ini.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </Panel>

          <Panel title="Form Pembayaran Keuangan" icon={Wallet}>
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
              <DateField
                label="Tanggal Bayar"
                value={paymentDate}
                onChange={setPaymentDate}
              />
              <EditableField
                label="Jumlah Dibayar oleh Keuangan"
                value={paidAmount}
                onChange={setPaidAmount}
              />
              <label className="block">
                <span className="text-xs text-slate-500 font-semibold">
                  Metode Pembayaran
                </span>
                <select
                  value={paymentMethod}
                  onChange={(event) => setPaymentMethod(event.target.value)}
                  className="mt-1 w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2.5 text-sm text-slate-200 outline-none focus:border-teal-500/50"
                >
                  {offPaymentMethods.map((method) => (
                    <option
                      key={method}
                      className="bg-[#1a1c23]"
                      value={method}
                    >
                      {method}
                    </option>
                  ))}
                </select>
              </label>
              <EditableField
                label="Bank Pengirim"
                value={senderBank}
                onChange={setSenderBank}
              />
              <label className="block">
                <span className="text-xs text-slate-500 font-semibold">
                  Bukti Pembayaran
                </span>
                <input
                  type="file"
                  accept="application/pdf,image/png,image/jpeg"
                  onChange={(event) => {
                    const file = event.target.files?.[0] || null;
                    setPaymentProofFile(file);
                  }}
                  className="mt-1 w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2.5 text-sm text-slate-200 file:mr-3 file:rounded-md file:border-0 file:bg-teal-600 file:px-3 file:py-1.5 file:text-xs file:font-bold file:text-white outline-none focus:border-teal-500/50"
                />
                <p className="mt-1 text-[11px] text-slate-500">
                  PDF, PNG, JPG, atau JPEG. Maksimal 5MB.
                </p>
              </label>
            </div>
            <div className="mt-4">
              <label className="block">
                <span className="text-xs text-slate-500 font-semibold">
                  Catatan Keuangan
                </span>
                <textarea
                  value={financeNote}
                  onChange={(event) => setFinanceNote(event.target.value)}
                  rows={4}
                  className="mt-1 w-full resize-none rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-slate-200 outline-none placeholder:text-slate-600 focus:border-teal-500/50"
                />
              </label>
            </div>
            {financeMessage && (
              <div className="mt-4 rounded-xl border border-white/10 bg-black/30 px-4 py-3 text-sm text-slate-300">
                {financeMessage}
              </div>
            )}
            {paymentResult && (
              <div className="mt-4 rounded-xl border border-emerald-500/20 bg-emerald-500/10 p-4 text-xs text-emerald-100">
                <p className="mb-2 font-bold uppercase tracking-wider">
                  Hasil Pembayaran
                </p>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                  <p>
                    Tanggal Bayar:{" "}
                    <span className="font-mono">
                      {formatDateDisplay(paymentResult.paymentDate)}
                    </span>
                  </p>
                  <p>
                    Jumlah Dibayar:{" "}
                    <span className="font-mono">
                      {paymentResult.paidAmount}
                    </span>
                  </p>
                  <p>
                    Metode Pembayaran:{" "}
                    <span className="font-mono">
                      {paymentResult.paymentMethod}
                    </span>
                  </p>
                  <p>
                    Bank Pengirim:{" "}
                    <span className="font-mono">
                      {paymentResult.senderBank || "-"}
                    </span>
                  </p>
                  <p>
                    Bukti Pembayaran:{" "}
                    <span className="font-mono">
                      {paymentResult.paymentProofName}
                    </span>
                  </p>
                  <p>
                    No Pembayaran:{" "}
                    <span className="font-mono">
                      {paymentResult.paymentNo || "-"}
                    </span>
                  </p>
                  <p>
                    Sisa Pembayaran:{" "}
                    <span className="font-mono">
                      Rp{" "}
                      {Number(
                        paymentResult.remainingAmount || 0,
                      ).toLocaleString("id-ID")}
                    </span>
                  </p>
                  <p>
                    Status Lunas:{" "}
                    <span className="font-mono">
                      {paymentResult.isFullyPaid ? "Lunas" : "Belum Lunas"}
                    </span>
                  </p>
                </div>
              </div>
            )}
            {canPayFinance ? (
              <div className="mt-5 flex flex-wrap gap-3">
                <button
                  onClick={submitFinancePayment}
                  disabled={
                    !selectedBatch ||
                    !isFinanceActionableBatch(selectedBatch) ||
                    isActionLoading
                  }
                  className="inline-flex items-center justify-center gap-2 rounded-xl border border-emerald-500 bg-emerald-600 px-4 py-2.5 text-sm font-bold text-white transition-colors hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Tambah Pembayaran
                </button>
              </div>
            ) : (
              <div className="mt-5 rounded-xl border border-white/10 bg-black/30 px-4 py-3 text-sm text-slate-400">
                Baca-saja: role ini tidak bisa menambah pembayaran Keuangan.
              </div>
            )}
          </Panel>
        </div>
      )}
    </div>
  );
}

function AuditTimeline() {
  return (
    <Panel title="Linimasa Log Audit" icon={ScrollText}>
      <div className="space-y-4">
        {auditLogs.map((log, index) => (
          <div key={log.title} className="grid grid-cols-[auto_1fr] gap-4">
            <div className="flex flex-col items-center">
              <span className="w-9 h-9 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 text-sm font-black flex items-center justify-center">
                {index + 1}
              </span>
              {index < auditLogs.length - 1 && (
                <span className="w-px flex-1 bg-white/10 my-2" />
              )}
            </div>
            <div className="rounded-xl border border-white/10 bg-black/30 p-4">
              <div className="flex flex-col md:flex-row md:items-center justify-between gap-2">
                <p className="font-bold text-white">{log.title}</p>
                <p className="text-xs font-mono text-slate-500">{log.time}</p>
              </div>
              <p className="text-sm text-slate-400 mt-2">{log.detail}</p>
            </div>
          </div>
        ))}
      </div>
    </Panel>
  );
}

function OverviewReadOnlyDetail({
  batch,
  items,
  payments,
  paymentSummary,
}: {
  batch: OffApiBatch;
  items: OffApiItem[];
  payments: OffApiPayment[];
  paymentSummary?: OffPaymentSummary;
}) {
  const totalNominal = Number(
    batch.summary?.totalNominal ||
      items.reduce((total, item) => total + Number(item.nominal || 0), 0),
  );
  const totalPaid = Number(paymentSummary?.totalPaid ?? batch.paidAmount ?? 0);
  const remainingAmount = Number(
    paymentSummary?.remainingAmount ?? Math.max(0, totalNominal - totalPaid),
  );

  return (
    <div className="space-y-6">
      <Panel title="Detail Batch Ringkasan" icon={ClipboardCheck}>
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
          <Field label="No Pengajuan" value={batch.noPengajuan || "-"} />
          <Field label="Gelombang" value={batch.gelombang || "-"} />
          <Field label="Principle" value={batch.principleName || "-"} />
          <Field label="Kode Principle" value={batch.principleCode || "-"} />
          <Field label="Supervisor" value={batch.supervisorName || "-"} />
          <Field
            label="Bulan/Tahun"
            value={
              batch.bulan && batch.tahun ? `${batch.bulan}/${batch.tahun}` : "-"
            }
          />
          <Field
            label="Status Utama"
            value={displayStatusLabel(batch.status)}
          />
          <Field label="Status SM" value={displayStatusLabel(batch.smStatus)} />
          <Field
            label="Status Claim"
            value={displayStatusLabel(batch.claimStatus)}
          />
          <Field label="Status OM" value={displayStatusLabel(batch.omStatus)} />
          <Field
            label="Status Keuangan"
            value={displayStatusLabel(batch.financeStatus)}
          />
          <Field
            label="Status Final"
            value={displayStatusLabel(batch.finalStatus)}
          />
          <Field label="No Claim" value={batch.noClaim || "-"} />
          <Field
            label="Tanggal Diajukan Claim"
            value={formatDateDisplay(batch.claimSubmittedDate)}
          />
          <Field
            label="Deadline Claim"
            value={formatDateDisplay(batch.claimDeadline)}
          />
          <Field
            label="Total Nominal"
            value={`Rp ${totalNominal.toLocaleString("id-ID")}`}
          />
          <Field
            label="Total Dibayar"
            value={`Rp ${totalPaid.toLocaleString("id-ID")}`}
          />
          <Field
            label="Sisa Pembayaran"
            value={`Rp ${remainingAmount.toLocaleString("id-ID")}`}
          />
        </div>
        {batch.pdfUrl && (
          <a
            href={batch.pdfUrl}
            target="_blank"
            className="mt-4 inline-flex rounded-xl border border-teal-500/30 bg-teal-500/10 px-4 py-2 text-sm font-bold text-teal-200 hover:bg-teal-500/20"
          >
            Lihat PDF
          </a>
        )}
      </Panel>

      <Panel title="Item Batch" icon={ReceiptText}>
        <div className="overflow-x-auto rounded-xl border border-white/10">
          <table className="w-full min-w-[1250px] text-left text-sm">
            <thead className="border-b border-white/10 bg-black/50 text-xs uppercase tracking-wider text-slate-500">
              <tr>
                {[
                  "No",
                  "No Surat",
                  "Nama Program",
                  "Periode",
                  "Toko",
                  "Barang",
                  "Nominal",
                  "Cara Bayar",
                  "Tipe",
                  "Deadline",
                  "Kelengkapan",
                ].map((header) => (
                  <th key={header} className="px-3 py-3 font-bold">
                    {header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {items.map((item, index) => (
                <tr
                  key={item.id || `${item.noSurat}-${index}`}
                  className="hover:bg-white/[0.03]"
                >
                  <td className="px-3 py-3 font-mono text-slate-300">
                    {item.itemNo || index + 1}
                  </td>
                  <td className="px-3 py-3 font-mono text-slate-200">
                    {item.noSurat || "-"}
                  </td>
                  <td className="min-w-[180px] px-3 py-3 text-slate-200">
                    {item.namaProgram || "-"}
                  </td>
                  <td className="px-3 py-3 text-slate-300">
                    {item.periode || "-"}
                  </td>
                  <td className="min-w-[140px] px-3 py-3 text-slate-300">
                    {item.toko || "-"}
                  </td>
                  <td className="px-3 py-3 text-slate-300">
                    {item.barang || "-"}
                  </td>
                  <td className="px-3 py-3 text-right font-mono text-emerald-300">
                    Rp {Number(item.nominal || 0).toLocaleString("id-ID")}
                  </td>
                  <td className="px-3 py-3 text-slate-300">
                    {item.caraBayar || "-"}
                  </td>
                  <td className="px-3 py-3 text-slate-300">
                    {item.type || "-"}
                  </td>
                  <td className="px-3 py-3 text-slate-300">
                    {formatDateDisplay(item.deadline)}
                  </td>
                  <td className="min-w-[180px] px-3 py-3 text-slate-300">
                    {itemDocsSummary(item)}
                  </td>
                </tr>
              ))}
              {items.length === 0 && (
                <tr>
                  <td
                    colSpan={11}
                    className="px-3 py-6 text-center text-sm text-slate-500"
                  >
                    Tidak ada item batch.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Panel>

      {payments.length > 0 && (
        <Panel title="Riwayat Pembayaran" icon={Wallet}>
          <div className="overflow-x-auto rounded-xl border border-white/10">
            <table className="w-full min-w-[900px] text-left text-sm">
              <thead className="border-b border-white/10 bg-black/50 text-xs uppercase tracking-wider text-slate-500">
                <tr>
                  {[
                    "No Pembayaran",
                    "Tanggal Bayar",
                    "Metode",
                    "Jumlah",
                    "Bank Pengirim",
                    "Bukti Pembayaran",
                    "Catatan",
                  ].map((header) => (
                    <th key={header} className="px-3 py-3 font-bold">
                      {header}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {payments.map((payment) => (
                  <tr key={payment.id} className="hover:bg-white/[0.03]">
                    <td className="px-3 py-3 font-mono text-slate-300">
                      {payment.paymentNo}
                    </td>
                    <td className="px-3 py-3 text-slate-300">
                      {formatDateDisplay(payment.paymentDate)}
                    </td>
                    <td className="px-3 py-3 text-slate-300">
                      {payment.paymentMethod}
                    </td>
                    <td className="px-3 py-3 text-right font-mono text-emerald-300">
                      Rp{" "}
                      {Number(payment.paidAmount || 0).toLocaleString("id-ID")}
                    </td>
                    <td className="px-3 py-3 text-slate-300">
                      {payment.senderBank || "-"}
                    </td>
                    <td className="px-3 py-3">
                      {payment.proofUrl ? (
                        <button
                          type="button"
                          onClick={() =>
                            window.open(payment.proofUrl || "", "_blank")
                          }
                          className="rounded-lg border border-teal-500/30 bg-teal-500/10 px-2 py-1 text-xs font-bold text-teal-300 hover:bg-teal-500/20"
                        >
                          {payment.paymentProofName || "Lihat Bukti"}
                        </button>
                      ) : (
                        <span className="text-slate-500">-</span>
                      )}
                    </td>
                    <td className="px-3 py-3 text-slate-300">
                      {payment.note || "-"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}
    </div>
  );
}

function OverviewTab() {
  const [overviewBatches, setOverviewBatches] = useState<OffApiBatch[]>([]);
  const [overviewSearch, setOverviewSearch] = useState("");
  const [overviewStatusFilter, setOverviewStatusFilter] = useState("");
  const [selectedBatch, setSelectedBatch] = useState<OffApiBatch | null>(null);
  const [selectedItems, setSelectedItems] = useState<OffApiItem[]>([]);
  const [selectedPayments, setSelectedPayments] = useState<OffApiPayment[]>([]);
  const [selectedPaymentSummary, setSelectedPaymentSummary] = useState<
    OffPaymentSummary | undefined
  >(undefined);
  const [isLoading, setIsLoading] = useState(true);
  const [isDetailLoading, setIsDetailLoading] = useState(false);
  const [error, setError] = useState("");

  const loadOverview = async () => {
    setIsLoading(true);
    setError("");
    try {
      const response = await fetch("/api/off-program-control/batches", {
        credentials: "include",
      });
      const data = await parseJsonResponse(response);
      if (!response.ok || !data.ok)
        throw new Error(
          String(data.error || "Gagal mengambil data ringkasan."),
        );
      setOverviewBatches(
        Array.isArray(data.batches) ? (data.batches as OffApiBatch[]) : [],
      );
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : "Gagal mengambil data ringkasan.",
      );
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadOverview();
  }, []);

  const openOverviewDetail = async (batch: OffApiBatch) => {
    setIsDetailLoading(true);
    setError("");
    setSelectedBatch(batch);
    setSelectedItems([]);
    setSelectedPayments([]);
    setSelectedPaymentSummary(undefined);
    try {
      const response = await fetch(
        `/api/off-program-control/batches/${batch.id}`,
        { credentials: "include" },
      );
      const data = await parseJsonResponse(response);
      if (!response.ok || !data.ok)
        throw new Error(
          String(data.error || "Gagal mengambil detail ringkasan."),
        );
      const detailBatch = (data.batch as OffApiBatch) || batch;
      setSelectedBatch({
        ...detailBatch,
        summary: data.summary as BatchQueueSummary | undefined,
        paymentSummary: data.paymentSummary as OffPaymentSummary | undefined,
      });
      setSelectedItems(
        Array.isArray(data.items) ? (data.items as OffApiItem[]) : [],
      );
      setSelectedPayments(
        Array.isArray(data.payments) ? (data.payments as OffApiPayment[]) : [],
      );
      setSelectedPaymentSummary(
        data.paymentSummary as OffPaymentSummary | undefined,
      );
    } catch (detailError) {
      setError(
        detailError instanceof Error
          ? detailError.message
          : "Gagal mengambil detail ringkasan.",
      );
    } finally {
      setIsDetailLoading(false);
    }
  };

  const metrics: MetricItem[] = [
    {
      label: "Total Batch",
      value: String(overviewBatches.length),
      tone: "text-sky-300",
      icon: ClipboardCheck,
    },
    {
      label: "Menunggu Review SM",
      value: String(overviewBatches.filter(isSmActionableBatch).length),
      tone: "text-amber-300",
      icon: Clock3,
    },
    {
      label: "Menunggu Persetujuan OM",
      value: String(overviewBatches.filter(isOmActionableBatch).length),
      tone: "text-purple-300",
      icon: ShieldCheck,
    },
    {
      label: "Selesai",
      value: String(
        overviewBatches.filter(
          (batch) =>
            batch.status === "Completed" || batch.finalStatus === "Completed",
        ).length,
      ),
      tone: "text-emerald-300",
      icon: CheckCircle2,
    },
    {
      label: "Sudah Dibayar Belum Lengkap",
      value: String(
        overviewBatches.filter(
          (batch) =>
            batch.status === "Paid" && batch.finalStatus !== "Completed",
        ).length,
      ),
      tone: "text-rose-300",
      icon: AlertTriangle,
    },
  ];
  const statusOptions = getBatchStatusOptions(overviewBatches).map(
    (status) => ({
      value: status,
      label: displayStatusLabel(status),
    }),
  );
  const filteredBatches = filterBatchesByMainStatus(
    filterBatchesBySearch(overviewBatches, overviewSearch),
    overviewStatusFilter,
  );

  return (
    <div className="space-y-6">
      {isLoading && (
        <div className="rounded-xl border border-white/10 bg-black/30 px-4 py-3 text-sm text-slate-300">
          Memuat data ringkasan...
        </div>
      )}
      {error && (
        <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
          {error}
        </div>
      )}
      {!isLoading && overviewBatches.length === 0 && !error && (
        <div className="rounded-xl border border-white/10 bg-black/30 px-4 py-3 text-sm text-slate-400">
          Belum ada batch OFF Program Control.
        </div>
      )}
      <MetricsGrid metrics={metrics} />
      <WorkflowStepper />
      <LiveQueueSummaryPanel batches={overviewBatches} />
      <div className="grid grid-cols-1 gap-3 xl:grid-cols-[1fr_280px]">
        <MonitoringSearch
          value={overviewSearch}
          onChange={setOverviewSearch}
          placeholder="Cari No Pengajuan, principle, kode, status, atau No Claim..."
        />
        <StatusFilterSelect
          value={overviewStatusFilter}
          onChange={setOverviewStatusFilter}
          options={statusOptions}
        />
      </div>
      <OverviewMonitoringTable
        batches={filteredBatches}
        selectedBatchId={selectedBatch?.id}
        onSelect={openOverviewDetail}
      />
      {isDetailLoading && (
        <div className="rounded-xl border border-white/10 bg-black/30 px-4 py-3 text-sm text-slate-300">
          Memuat detail ringkasan...
        </div>
      )}
      {selectedBatch && !isDetailLoading && (
        <OverviewReadOnlyDetail
          batch={selectedBatch}
          items={selectedItems}
          payments={selectedPayments}
          paymentSummary={selectedPaymentSummary}
        />
      )}
    </div>
  );
}

export default function OffProgramControlPage() {
  const [activeTab, setActiveTab] = useState<TabKey>("overview");
  const [paidIncompleteCount, setPaidIncompleteCount] = useState(0);
  const { data: session } = authClient.useSession();
  const sessionUser = session?.user as
    | {
        name?: string | null;
        email?: string | null;
        role?: unknown;
        userRole?: unknown;
        type?: unknown;
        position?: unknown;
        department?: unknown;
      }
    | undefined;
  const roleInfo = resolveOffRole({
    role: sessionUser?.role,
    userRole: sessionUser?.userRole,
    type: sessionUser?.type,
    position: sessionUser?.position,
    department: sessionUser?.department,
    email: sessionUser?.email,
  });
  const offRole = roleInfo.role;
  const accessibleTabKeys = getOffAccessibleTabs(offRole);
  const accessibleTabs = tabs.filter((tab) =>
    accessibleTabKeys.includes(tab.key),
  );
  const effectiveActiveTab = accessibleTabKeys.includes(activeTab)
    ? activeTab
    : accessibleTabs[0]?.key;
  const mappingSummary = useMemo(
    () => `${PRINCIPLE_OPTIONS.length} mapping principle dimuat`,
    [],
  );
  const shouldShowPaidNotification =
    offRole === "sales_manager" || offRole === "admin";

  useEffect(() => {
    if (!shouldShowPaidNotification) {
      return;
    }

    let isActive = true;
    const loadPaidIncomplete = async () => {
      try {
        const response = await fetch("/api/off-program-control/batches", {
          credentials: "include",
        });
        const data = await parseJsonResponse(response);
        if (!response.ok || !data.ok) return;
        const rows = Array.isArray(data.batches)
          ? (data.batches as OffApiBatch[])
          : [];
        const count = rows.filter(
          (batch) =>
            batch.status === "Paid" && batch.finalStatus !== "Completed",
        ).length;
        if (isActive) setPaidIncompleteCount(count);
      } catch {
        if (isActive) setPaidIncompleteCount(0);
      }
    };

    loadPaidIncomplete();
    const interval = window.setInterval(loadPaidIncomplete, 60000);
    return () => {
      isActive = false;
      window.clearInterval(interval);
    };
  }, [shouldShowPaidNotification]);

  return (
    <div className="max-w-[1800px] mx-auto pb-12">
      <div className="mb-6 flex flex-col lg:flex-row lg:items-end justify-between gap-4">
        <div>
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full border border-teal-500/30 bg-teal-500/10 text-teal-300 text-xs font-bold uppercase tracking-widest mb-4">
            <ClipboardCheck size={14} /> Alur OFF
          </div>
          <h1 className="text-3xl font-black text-white tracking-tight flex items-center gap-3">
            OFF Program Control
          </h1>
          <p className="text-slate-400 mt-2 text-lg">
            Dashboard Keuangan Korporat untuk OFF Program / Faktur Beban
            Principle
          </p>
          <p className="text-xs text-slate-500 mt-2">{mappingSummary}</p>
          <div className="mt-3 flex flex-wrap gap-2 text-xs">
            <span className="rounded-lg border border-white/10 bg-black/30 px-3 py-1.5 text-slate-300">
              Login sebagai:{" "}
              <b className="text-slate-100">
                {sessionUser?.name ||
                  sessionUser?.email ||
                  "User Tidak Dikenal"}
              </b>
            </span>
            <span className="rounded-lg border border-teal-500/20 bg-teal-500/10 px-3 py-1.5 text-teal-200">
              Role OFF:{" "}
              <b>
                {offRole}
                {roleInfo.source === "email"
                  ? " (dari domain email)"
                  : roleInfo.isFallback
                    ? " (fallback pengembangan)"
                    : ""}
              </b>
            </span>
          </div>
        </div>
        <div className="flex items-center gap-3 rounded-2xl border border-white/10 bg-[#1a1c23]/60 px-4 py-3">
          <CalendarClock className="text-teal-300" size={20} />
          <div>
            <p className="text-xs uppercase tracking-wider text-slate-500 font-bold">
              Siklus
            </p>
            <p className="text-sm text-slate-200 font-semibold">
              Monitoring Mei 2026
            </p>
          </div>
        </div>
      </div>

      {offRole === "sales" && accessibleTabs.length === 0 && (
        <Panel title="OFF Program Control" icon={ClipboardCheck}>
          <p className="text-sm text-slate-400">
            Role Sales belum dikonfigurasi untuk OFF Program Control.
          </p>
        </Panel>
      )}

      {offRole !== "sales" && accessibleTabs.length === 0 && (
        <Panel title="OFF Program Control" icon={ClipboardCheck}>
          <p className="text-sm text-slate-400">
            Anda belum memiliki akses OFF Program Control. Hubungi admin.
          </p>
        </Panel>
      )}

      {accessibleTabs.length > 0 && (
        <>
          {shouldShowPaidNotification && paidIncompleteCount > 0 && (
            <div className="mb-6 rounded-2xl border border-amber-500/30 bg-amber-500/10 px-5 py-4 text-sm font-semibold text-amber-100">
              Ada {paidIncompleteCount} Pengajuan Sudah Dibayar yang belum
              lengkap datanya, mohon segera ditindaklanjuti.
            </div>
          )}

          <div className="mb-6 overflow-x-auto rounded-2xl border border-white/10 bg-[#1a1c23]/60 p-2 shadow-xl">
            <div className="flex min-w-max gap-2">
              {accessibleTabs.map((tab) => (
                <button
                  key={tab.key}
                  onClick={() => setActiveTab(tab.key)}
                  className={`rounded-xl px-4 py-2.5 text-sm font-bold transition-colors ${
                    effectiveActiveTab === tab.key
                      ? "bg-teal-500/20 text-teal-200 border border-teal-500/30"
                      : "text-slate-400 hover:text-white hover:bg-white/5 border border-transparent"
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          </div>

          {effectiveActiveTab === "overview" && <OverviewTab />}
          {effectiveActiveTab === "supervisor" && (
            <SupervisorDashboard offRole={offRole} />
          )}
          {effectiveActiveTab === "sales" && (
            <SalesManagerDashboard offRole={offRole} />
          )}
          {effectiveActiveTab === "claim" && (
            <ClaimDashboard offRole={offRole} />
          )}
          {effectiveActiveTab === "om" && (
            <OperationalManagerDashboard offRole={offRole} />
          )}
          {effectiveActiveTab === "finance" && (
            <FinanceDashboard offRole={offRole} />
          )}
          {effectiveActiveTab === "audit" && <AuditTimeline />}
        </>
      )}
    </div>
  );
}
