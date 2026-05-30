"use client";

/*
 * Tujuan: Dashboard OFF Program Control untuk input, review, approval, pembayaran, dan audit program off invoice.
 * Caller: App Router dashboard `app/(dashboard)/off-program-control/page.tsx`.
 * Dependensi: `authClient`, helper akses OFF, workflow OFF, constants OFF, `DatePickerField`, route API OFF Program Control.
 * Main Functions: `OffProgramControlPage`, `OffDashboard`, `DateField`, form/table workflow per role.
 * Side Effects: HTTP read/write ke API OFF Program Control, baca session Better Auth, mutasi state workflow dan filter UI.
 */

import {
  useEffect,
  useMemo,
  useRef,
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
  ChevronDown,
  ClipboardCheck,
  Clock3,
  FileCheck2,
  FileText,
  ListChecks,
  Mail,
  Percent,
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
import {
  OFF_KWITANSI_DISABLED,
  OFF_KWITANSI_DISABLED_MESSAGE,
} from "@/lib/off-program-control/constants";
import {
  OFF_PROGRAM_TYPES,
  resolveProgramType,
} from "@/lib/off-program-control/program-type";
import {
  normalizeSearchText,
  matchesSearch,
} from "@/lib/off-program-control/search";
import {
  computeBatchProgress,
  hasMinimalFinalChecklist,
} from "@/lib/off-program-control/workflow";
import { authClient } from "@/lib/auth-client";
import {
  canPerformOffAction,
  getOffAccessibleTabs,
  resolveOffRole,
  type OffRole,
} from "@/lib/off-program-control/access";
import DatePickerField from "@/components/ui/DatePickerField";

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
  originalType: string;
  typeIsLegacy: boolean;
  pphExempt: boolean;
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
  receiptPdfUrl?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  summary?: BatchQueueSummary;
  paymentSummary?: OffPaymentSummary;
  payments?: OffApiPayment[];
  // Revisi D: haystack pencarian precomputed (termasuk item/toko nested).
  searchText?: string | null;
  // Revisi C: tanggal per jenis untuk filter periode konsisten.
  periodDates?: {
    program?: string[];
    pengajuan?: string[];
    claim?: string[];
    bayar?: string[];
  } | null;
};

type OffApiPayment = {
  id: string;
  batchId: string;
  paymentNo: number;
  paymentDate: string;
  paymentMethod: string;
  paidAmount: number;
  senderBank?: string | null;
  paymentProofName?: string | null;
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
  normalizedType?: string | null;
  originalType?: string | null;
  typeIsLegacy?: boolean | null;
  pphExempt?: boolean | null;
  pphAmount?: number | null;
  adjustmentPph?: number | null;
  deadline: string | null;
  kwt: boolean;
  skp: boolean;
  fp: boolean;
  pc: boolean;
  foto: boolean;
  rekap: boolean;
  others: boolean;
  othersText: string | null;
  finalKwt?: boolean | null;
  finalSkp?: boolean | null;
  finalFp?: boolean | null;
  finalPc?: boolean | null;
  finalFoto?: boolean | null;
  finalRekap?: boolean | null;
  finalOthers?: boolean | null;
  finalOthersText?: string | null;
  finalCompletenessNote?: string | null;
};

type OffNotificationPreview = {
  to: string;
  subject: string;
  message: string;
  status?: string;
};

type OffNoSuratConflict = {
  noSurat: string;
  batchId: string;
  noPengajuan: string;
  principleCode: string;
  principleName: string;
  status: string;
};

type SupervisorDuplicatePrompt = {
  mode: "draft" | "submit";
  principleName: string;
  conflicts: OffNoSuratConflict[];
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
    type: "Display",
    originalType: "Display",
    typeIsLegacy: false,
    pphExempt: false,
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
    originalType: "Visibility",
    typeIsLegacy: false,
    pphExempt: false,
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
    type: "Sample",
    originalType: "Sampling",
    typeIsLegacy: true,
    pphExempt: false,
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
    originalType: "",
    typeIsLegacy: false,
    pphExempt: false,
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

function indonesianMonthLabel(month: number | string) {
  const names = [
    "Januari",
    "Februari",
    "Maret",
    "April",
    "Mei",
    "Juni",
    "Juli",
    "Agustus",
    "September",
    "Oktober",
    "November",
    "Desember",
  ];
  const index = Number(month) - 1;
  return names[index] || String(month);
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
  // Revisi A: normalisasi tipe lama saat dimuat ke editor Supervisor.
  // Data lama yang tidak cocok dropdown otomatis dipetakan (forced ke Sample).
  const resolved = resolveProgramType(
    item.normalizedType ?? item.type ?? item.originalType,
  );
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
    // Bila forcedToFallback, biarkan kosong agar Supervisor wajib memilih ulang.
    type: resolved.forcedToFallback ? "" : resolved.normalizedType,
    originalType: item.originalType || String(item.type || ""),
    typeIsLegacy: Boolean(item.typeIsLegacy) || resolved.typeIsLegacy,
    pphExempt: Boolean(item.pphExempt),
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

function computeUiBatchProgress(batch: OffApiBatch): number {
  // OffApiBatch is a public DTO; computeBatchProgress only needs workflow status fields.
  return computeBatchProgress(batch);
}

function ProgressBar({
  value,
  showLabel = true,
}: {
  value: number;
  showLabel?: boolean;
}) {
  const color =
    value === 0
      ? "bg-slate-500"
      : value === 100
        ? "bg-emerald-500"
        : value >= 75
          ? "bg-sky-500"
          : value >= 50
            ? "bg-purple-500"
            : "bg-amber-500";

  return (
    <div className="flex items-center gap-2">
      <div className="h-2 flex-1 rounded-full bg-white/10 overflow-hidden">
        <div
          className={`h-full rounded-full transition-all ${color}`}
          style={{ width: `${Math.max(0, Math.min(100, value))}%` }}
        />
      </div>
      {showLabel && (
        <span className="text-xs font-mono font-bold text-slate-300 min-w-[36px] text-right">
          {value}%
        </span>
      )}
    </div>
  );
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
  // Gunakan haystack precomputed dari backend (termasuk item/toko nested) bila
  // tersedia; fallback ke field batch level untuk kompatibilitas.
  if (batch.searchText) return batch.searchText;
  return normalizeSearchText(
    [
      batch.noPengajuan,
      batch.principleName,
      batch.principleCode,
      batch.supervisorName,
      batch.status,
      batch.smStatus,
      batch.claimStatus,
      batch.omStatus,
      batch.financeStatus,
      batch.finalStatus,
      batch.noClaim,
    ].join(" "),
  );
}

function filterBatchesBySearch(batches: OffApiBatch[], query: string) {
  const normalized = normalizeSearchText(query);
  if (!normalized) return batches;
  // matchesSearch mendukung sebagian kata + typo ringan Visibility/Visibilty.
  return batches.filter((batch) =>
    matchesSearch(batchSearchText(batch), normalized),
  );
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

function hasPassedSalesManager(batch: OffApiBatch) {
  return (
    batch.smStatus !== "Not Started" ||
    [
      "Submitted to SM",
      "Waiting Review",
      "Approved by SM",
      "Returned by SM",
    ].includes(batch.status)
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
  placeholder = "Cari No Pengajuan, principle, toko, no surat, no claim, user, atau status...",
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  // Revisi D: debounce agar hasil berubah setelah user berhenti mengetik ~300ms.
  const [draft, setDraft] = useState(value);

  useEffect(() => {
    setDraft(value);
  }, [value]);

  useEffect(() => {
    if (draft === value) return;
    const timer = setTimeout(() => onChange(draft), 300);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft]);

  return (
    <input
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      placeholder={placeholder}
      className="w-full rounded-xl border border-white/10 bg-black/40 px-4 py-2.5 text-sm text-slate-200 outline-none placeholder:text-slate-600 focus:border-teal-500/50"
    />
  );
}

// --- Filter periode (revisi C) ---
type OffPeriodFilterValue = {
  periodType: "program" | "pengajuan" | "claim" | "bayar";
  mode: "month" | "range";
  month: string;
  year: string;
  dateFrom: string;
  dateTo: string;
};

function createEmptyPeriodFilter(): OffPeriodFilterValue {
  return {
    periodType: "pengajuan",
    mode: "month",
    month: "",
    year: "",
    dateFrom: "",
    dateTo: "",
  };
}

const periodTypeLabels: Record<OffPeriodFilterValue["periodType"], string> = {
  program: "Periode Program",
  pengajuan: "Tanggal Pengajuan",
  claim: "Tanggal Diajukan Claim",
  bayar: "Tanggal Bayar",
};

function isPeriodFilterActive(filter: OffPeriodFilterValue): boolean {
  if (filter.mode === "month") return Boolean(filter.month || filter.year);
  return Boolean(filter.dateFrom || filter.dateTo);
}

function dateWithinPeriodWindow(
  date: string,
  filter: OffPeriodFilterValue,
): boolean {
  if (filter.mode === "range") {
    if (filter.dateFrom && date < filter.dateFrom) return false;
    if (filter.dateTo && date > filter.dateTo) return false;
    return true;
  }
  const [yy, mm] = date.split("-");
  if (filter.year && yy !== filter.year) return false;
  if (filter.month && mm !== String(filter.month).padStart(2, "0")) return false;
  return true;
}

// Default tidak aktif: kembalikan semua batch (tidak mengosongkan data tiba-tiba).
function filterBatchesByPeriod(
  batches: OffApiBatch[],
  filter: OffPeriodFilterValue,
): OffApiBatch[] {
  if (!isPeriodFilterActive(filter)) return batches;
  return batches.filter((batch) => {
    const dates = batch.periodDates?.[filter.periodType] || [];
    if (dates.length === 0) return false;
    return dates.some((date) => dateWithinPeriodWindow(date, filter));
  });
}

function PeriodFilter({
  value,
  onChange,
}: {
  value: OffPeriodFilterValue;
  onChange: (value: OffPeriodFilterValue) => void;
}) {
  // Filter periode tersembunyi secara default; muncul ke bawah saat header diklik.
  const [open, setOpen] = useState(false);
  const isActive = isPeriodFilterActive(value);
  const months = [
    { value: "", label: "Semua Bulan" },
    ...Array.from({ length: 12 }, (_, index) => ({
      value: String(index + 1).padStart(2, "0"),
      label: indonesianMonthLabel(index + 1),
    })),
  ];
  return (
    <div className="rounded-xl border border-white/10 bg-black/30">
      <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5">
        <button
          type="button"
          onClick={() => setOpen((prev) => !prev)}
          aria-expanded={open}
          className="flex items-center gap-2 text-xs font-semibold text-slate-300 hover:text-white"
        >
          <ChevronDown
            size={16}
            className={`text-slate-400 transition-transform duration-200 ${
              open ? "rotate-180" : ""
            }`}
          />
          Filter Periode
          {isActive && (
            <span className="rounded-full bg-teal-500/20 px-2 py-0.5 text-[10px] font-bold text-teal-300">
              Aktif
            </span>
          )}
        </button>
        {isActive && (
          <button
            type="button"
            onClick={() => onChange(createEmptyPeriodFilter())}
            className="rounded-md border border-white/10 px-2 py-0.5 text-[11px] text-slate-400 hover:bg-white/5"
          >
            Reset
          </button>
        )}
      </div>
      {open && (
      <div className="grid grid-cols-1 gap-2 border-t border-white/10 p-3 sm:grid-cols-2 lg:grid-cols-4">
        <label className="block">
          <span className="mb-1 block text-[11px] font-semibold text-slate-500">
            Jenis Tanggal
          </span>
          <select
            value={value.periodType}
            onChange={(event) =>
              onChange({
                ...value,
                periodType: event.target
                  .value as OffPeriodFilterValue["periodType"],
              })
            }
            className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-slate-200 outline-none focus:border-teal-500/50"
          >
            {(
              Object.keys(periodTypeLabels) as Array<
                OffPeriodFilterValue["periodType"]
              >
            ).map((key) => (
              <option key={key} value={key} className="bg-[#1a1c23]">
                {periodTypeLabels[key]}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-[11px] font-semibold text-slate-500">
            Mode
          </span>
          <select
            value={value.mode}
            onChange={(event) =>
              onChange({
                ...value,
                mode: event.target.value as OffPeriodFilterValue["mode"],
              })
            }
            className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-slate-200 outline-none focus:border-teal-500/50"
          >
            <option value="month" className="bg-[#1a1c23]">
              Bulan-Tahun
            </option>
            <option value="range" className="bg-[#1a1c23]">
              Rentang Tanggal
            </option>
          </select>
        </label>

        {value.mode === "month" ? (
          <>
            <label className="block">
              <span className="mb-1 block text-[11px] font-semibold text-slate-500">
                Bulan
              </span>
              <select
                value={value.month}
                onChange={(event) =>
                  onChange({ ...value, month: event.target.value })
                }
                className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-slate-200 outline-none focus:border-teal-500/50"
              >
                {months.map((month) => (
                  <option
                    key={month.value}
                    value={month.value}
                    className="bg-[#1a1c23]"
                  >
                    {month.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-[11px] font-semibold text-slate-500">
                Tahun
              </span>
              <input
                value={value.year}
                onChange={(event) =>
                  onChange({
                    ...value,
                    year: event.target.value.replace(/[^\d]/g, "").slice(0, 4),
                  })
                }
                placeholder="cth: 2026"
                inputMode="numeric"
                className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-slate-200 outline-none placeholder:text-slate-600 focus:border-teal-500/50"
              />
            </label>
          </>
        ) : (
          <>
            <label className="block">
              <span className="mb-1 block text-[11px] font-semibold text-slate-500">
                Dari Tanggal
              </span>
              <input
                type="date"
                value={value.dateFrom}
                onChange={(event) =>
                  onChange({ ...value, dateFrom: event.target.value })
                }
                className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-slate-200 outline-none [color-scheme:dark] focus:border-teal-500/50"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-[11px] font-semibold text-slate-500">
                Sampai Tanggal
              </span>
              <input
                type="date"
                value={value.dateTo}
                onChange={(event) =>
                  onChange({ ...value, dateTo: event.target.value })
                }
                className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-slate-200 outline-none [color-scheme:dark] focus:border-teal-500/50"
              />
            </label>
          </>
        )}
      </div>
      )}
    </div>
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
  onPrintReceipt,
  printingReceiptBatchId,
  actionLabel,
  emptyText = "Belum ada batch yang cocok.",
  stickyAction = false,
}: {
  batches: OffApiBatch[];
  selectedBatchId?: string | null;
  onSelect: (batch: OffApiBatch) => void;
  onPrintReceipt?: (batch: OffApiBatch) => void;
  printingReceiptBatchId?: string;
  actionLabel: (batch: OffApiBatch) => string;
  emptyText?: string;
  stickyAction?: boolean;
}) {
  const headers = [
    "No Pengajuan",
    "Principle",
    "Kode Principle",
    "Total",
    "Progress",
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
      <table className="w-full min-w-[1800px] text-left text-sm">
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

              <td className="px-3 py-3 min-w-[120px]">
                <ProgressBar value={computeUiBatchProgress(batch)} />
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
                    ? "sticky right-0 z-20 min-w-[170px] bg-[#0f1115] shadow-[-12px_0_18px_rgba(0,0,0,0.45)]"
                    : ""
                }`}
              >
                <button
                  onClick={() => onSelect(batch)}
                  className="w-full rounded-lg border border-teal-500/30 bg-teal-500/10 px-3 py-2 text-xs font-bold text-teal-200 hover:bg-teal-500/20"
                >
                  {actionLabel(batch)}
                </button>
                {onPrintReceipt && (
                  <button
                    onClick={() =>
                      OFF_KWITANSI_DISABLED ? undefined : onPrintReceipt(batch)
                    }
                    disabled={
                      OFF_KWITANSI_DISABLED ||
                      printingReceiptBatchId === batch.id
                    }
                    title={
                      OFF_KWITANSI_DISABLED
                        ? OFF_KWITANSI_DISABLED_MESSAGE
                        : undefined
                    }
                    className="mt-2 w-full rounded-lg border border-indigo-500/30 bg-indigo-500/10 px-3 py-2 text-xs font-bold text-indigo-200 hover:bg-indigo-500/20 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {OFF_KWITANSI_DISABLED
                      ? OFF_KWITANSI_DISABLED_MESSAGE
                      : printingReceiptBatchId === batch.id
                        ? "Membuat..."
                        : "Print Kwitansi"}
                  </button>
                )}
              </td>
            </tr>
          ))}

          {batches.length === 0 && (
            <tr>
              <td colSpan={13} className="px-3 py-6 text-center text-slate-500">
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
      <DatePickerField
        value={value}
        onChange={onChange}
        ariaLabel={label}
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
    "Progress",
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
                  <td className="px-4 py-4 min-w-[120px]">
                    <ProgressBar value={computeUiBatchProgress(batch)} />
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
                  colSpan={14}
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
    "Principle",
    "Kode Principle",
    "Total Nominal",
    "Status SM",
    "Status Claim",
    "Status OM",
    "Status Finance",
    "Status Final",
    "Progress %",
    "Updated At",
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

                  <td className="px-4 py-4 text-slate-300 min-w-[260px]">
                    {batch.principleName}
                  </td>

                  <td className="px-4 py-4 font-mono text-teal-300">
                    {batch.principleCode}
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

                  <td className="px-4 py-4 min-w-[120px]">
                    <ProgressBar value={computeUiBatchProgress(batch)} />
                  </td>

                  <td className="px-4 py-4 whitespace-nowrap text-slate-300">
                    {batch.updatedAt
                      ? new Date(batch.updatedAt).toLocaleString("id-ID")
                      : "-"}
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
                  colSpan={12}
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

function IncompleteDocumentsReminderPanel({
  batches,
}: {
  batches: OffApiBatch[];
}) {
  const reminders = batches.filter(
    (batch) => batch.finalStatus === "Incomplete Documents",
  );

  if (reminders.length === 0) return null;

  return (
    <Panel title="Pengingat Kelengkapan Belum Lengkap" icon={AlertTriangle}>
      <p className="mb-4 text-sm text-amber-100">
        Claim menandai kelengkapan belum lengkap dan meminta koordinasi
        real-life dengan Claim. Panel ini hanya pengingat web, bukan email.
      </p>
      <div className="overflow-x-auto rounded-xl border border-white/10">
        <table className="w-full min-w-[1050px] text-left text-sm">
          <thead className="border-b border-white/10 bg-black/50 text-xs uppercase tracking-wider text-slate-500">
            <tr>
              {[
                "No Pengajuan",
                "Principle",
                "Kode Principle",
                "Catatan Claim",
                "Status Final",
                "Diperbarui",
              ].map((header) => (
                <th key={header} className="px-3 py-3 font-bold">
                  {header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5">
            {reminders.map((batch) => (
              <tr key={batch.id} className="hover:bg-white/[0.03]">
                <td className="whitespace-nowrap px-3 py-3 font-mono font-bold text-white">
                  {batch.noPengajuan}
                </td>
                <td className="min-w-[240px] px-3 py-3 text-slate-300">
                  {batch.principleName}
                </td>
                <td className="px-3 py-3 font-mono text-teal-300">
                  {batch.principleCode}
                </td>
                <td className="min-w-[280px] px-3 py-3 text-amber-100">
                  {batch.finalClaimNote || "-"}
                </td>
                <td className="px-3 py-3">
                  <span
                    className={`inline-flex rounded-md border px-2 py-1 text-xs font-bold ${statusClass(batch.finalStatus)}`}
                  >
                    {displayStatusLabel(batch.finalStatus)}
                  </span>
                </td>
                <td className="px-3 py-3 text-slate-400">
                  {formatDateDisplay(batch.updatedAt)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function DuplicateNoSuratPrompt({
  prompt,
  isSubmitting,
  onCancel,
  onConfirm,
}: {
  prompt: SupervisorDuplicatePrompt;
  isSubmitting: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const conflictsByNoSurat = prompt.conflicts.reduce<
    Record<string, OffNoSuratConflict[]>
  >((acc, conflict) => {
    const key = conflict.noSurat;
    if (!acc[key]) acc[key] = [];
    acc[key].push(conflict);
    return acc;
  }, {});
  const noSuratList = Object.keys(conflictsByNoSurat);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
      <div className="w-full max-w-3xl rounded-2xl border border-amber-400/20 bg-[#15161f] shadow-2xl overflow-hidden">
        <div className="px-6 py-4 border-b border-white/10 bg-amber-500/10 flex items-start gap-3">
          <AlertTriangle className="text-amber-300 mt-0.5" size={22} />
          <div>
            <h3 className="text-lg font-semibold text-white">
              No Surat Sudah Pernah Dipakai
            </h3>
            <p className="text-sm text-amber-100/80 mt-1">
              Pada principle {prompt.principleName}, beberapa No Surat di batch ini sudah
              tercatat di pengajuan lain. Pastikan ini bukan pengajuan ganda.
            </p>
          </div>
        </div>
        <div className="max-h-[55vh] overflow-auto">
          <table className="w-full text-left text-sm text-slate-200">
            <thead className="sticky top-0 bg-[#1b1c26] border-b border-white/10 text-xs uppercase tracking-wider text-white/70">
              <tr>
                <th className="px-4 py-3">No Surat</th>
                <th className="px-4 py-3">Dipakai di Batch</th>
                <th className="px-4 py-3">Status Batch</th>
              </tr>
            </thead>
            <tbody>
              {noSuratList.map((noSurat) => {
                const items = conflictsByNoSurat[noSurat] || [];
                return items.map((conflict, index) => (
                  <tr
                    key={`${noSurat}-${conflict.batchId}-${index}`}
                    className="border-b border-white/5"
                  >
                    {index === 0 ? (
                      <td
                        className="px-4 py-3 align-top font-mono font-bold text-white"
                        rowSpan={items.length}
                      >
                        {noSurat}
                      </td>
                    ) : null}
                    <td className="px-4 py-3 font-mono text-teal-200">
                      {conflict.noPengajuan}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex rounded-md border px-2 py-1 text-xs font-bold ${statusClass(conflict.status)}`}
                      >
                        {displayStatusLabel(conflict.status)}
                      </span>
                    </td>
                  </tr>
                ));
              })}
            </tbody>
          </table>
        </div>
        <div className="px-6 py-4 border-t border-white/10 bg-black/30 flex flex-col gap-3 sm:flex-row sm:justify-end">
          <button
            type="button"
            onClick={onCancel}
            disabled={isSubmitting}
            className="rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm font-bold text-slate-200 transition-colors hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Batalkan dan Cek Ulang
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={isSubmitting}
            className="rounded-xl border border-amber-500 bg-amber-600 px-4 py-2.5 text-sm font-bold text-white transition-colors hover:bg-amber-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isSubmitting ? "Memproses..." : "Saya Yakin, Lanjutkan"}
          </button>
        </div>
      </div>
    </div>
  );
}

function SupervisorDashboard({ offRole }: OffDashboardProps) {
  const canSubmitSupervisor = canPerformOffAction(offRole, "submit_batch");
  const canEditSupervisor = canPerformOffAction(offRole, "edit_returned_batch");
  const [supervisorMenu, setSupervisorMenu] = useState<
    "pengajuan" | "monitoring" | "diskon"
  >("pengajuan");
  const [supervisorName, setSupervisorName] = useState("Supervisor Area 1");
  const [batchPrinciple, setBatchPrinciple] = useState("RECKITT BENCKISER, PT");
  const [gelombangInput, setGelombangInput] = useState("001");
  const [bulanInput, setBulanInput] = useState("05");
  const [tahunInput, setTahunInput] = useState("2026");
  const [submitStatus, setSubmitStatus] = useState("");
  const [receiptStatus, setReceiptStatus] = useState("");
  const [printingReceiptBatchId, setPrintingReceiptBatchId] = useState("");
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
  const [monitoringPeriod, setMonitoringPeriod] = useState(createEmptyPeriodFilter());
  const [returnedBatches, setReturnedBatches] = useState<OffApiBatch[]>([]);
  const [returnedSummaries, setReturnedSummaries] = useState<
    Record<string, BatchQueueSummary>
  >({});
  const [editingBatchId, setEditingBatchId] = useState("");
  const [editingLocked, setEditingLocked] = useState(false);
  const [returnNote, setReturnNote] = useState("");
  const [returnedStatus, setReturnedStatus] = useState("");
  const [duplicatePrompt, setDuplicatePrompt] =
    useState<SupervisorDuplicatePrompt | null>(null);
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

  // Revisi A: pilih tipe baru saat memilih dropdown. Begitu Supervisor memilih
  // tipe valid, penanda legacy "Data Lama" dilepas agar data dianggap diperbaiki.
  const updateRowType = (rowId: string, value: string) => {
    if (editingLocked) return;
    setRows((currentRows) =>
      currentRows.map((row) =>
        row.id === rowId
          ? {
              ...row,
              type: value,
              typeIsLegacy: false,
            }
          : row,
      ),
    );
  };

  // Mengembalikan nomor baris pertama (1-based) yang tipenya belum valid, atau 0.
  const findInvalidTypeRowNumber = () => {
    const validTypes = OFF_PROGRAM_TYPES as readonly string[];
    const index = rows.findIndex((row) => !validTypes.includes(row.type));
    return index === -1 ? 0 : index + 1;
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
      // Audit legacy: kirim nilai asli agar backend menyimpan originalType.
      originalType: row.originalType || row.type,
      // PPh masih HOLD; hanya kirim penanda exempt. Tidak memblokir submit.
      pphExempt: row.pphExempt,
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

  const saveDraft = async (options?: { forceDuplicateNoSurat?: boolean }) => {
    if (editingLocked) {
      setSubmitStatus("Batch baca-saja dan tidak bisa disimpan sebagai draf.");
      return;
    }
    // Revisi A.6: wajib pilih tipe valid (termasuk data lama yang dipaksa perbaiki).
    const invalidTypeRow = findInvalidTypeRowNumber();
    if (invalidTypeRow) {
      setSubmitStatus(
        `Tipe program pada baris ${invalidTypeRow} wajib dipilih dari dropdown (Display/Visibility/Promo On Store/Event/Sample) sebelum disimpan.`,
      );
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
            forceDuplicateNoSurat: options?.forceDuplicateNoSurat === true,
          }),
        },
      );
      const data = await parseJsonResponse(response);
      if (
        response.status === 409 &&
        data.code === "DUPLICATE_NO_SURAT" &&
        Array.isArray((data as { conflicts?: unknown }).conflicts)
      ) {
        setDuplicatePrompt({
          mode: "draft",
          principleName: String(
            (data as { principleName?: string }).principleName || batchPrinciple,
          ),
          conflicts: ((data as { conflicts?: unknown }).conflicts ||
            []) as OffNoSuratConflict[],
        });
        setSubmitStatus(
          "Beberapa No Surat sudah pernah dipakai pada principle yang sama. Mohon konfirmasi.",
        );
        return;
      }
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

  const handleSubmitBatch = async (options?: {
    forceDuplicateNoSurat?: boolean;
  }) => {
    if (editingLocked) {
      setSubmitStatus(
        "Batch sudah disetujui oleh SM dan terkunci untuk Supervisor.",
      );
      return;
    }
    // Revisi A.6: wajib pilih tipe valid sebelum kirim ke SM.
    const invalidTypeRow = findInvalidTypeRowNumber();
    if (invalidTypeRow) {
      setSubmitStatus(
        `Tipe program pada baris ${invalidTypeRow} wajib dipilih dari dropdown (Display/Visibility/Promo On Store/Event/Sample) sebelum dikirim ke Sales Manager.`,
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
            forceDuplicateNoSurat: options?.forceDuplicateNoSurat === true,
          }),
        },
      );
      const saveData = await parseJsonResponse(saveRes);
      if (
        saveRes.status === 409 &&
        saveData.code === "DUPLICATE_NO_SURAT" &&
        Array.isArray((saveData as { conflicts?: unknown }).conflicts)
      ) {
        setDuplicatePrompt({
          mode: "submit",
          principleName: String(
            (saveData as { principleName?: string }).principleName ||
              batchPrinciple,
          ),
          conflicts: ((saveData as { conflicts?: unknown }).conflicts ||
            []) as OffNoSuratConflict[],
        });
        setSubmitStatus(
          "Beberapa No Surat sudah pernah dipakai pada principle yang sama. Mohon konfirmasi sebelum dikirim ke SM.",
        );
        return;
      }
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

  const handlePrintKwitansi = async (batch: OffApiBatch) => {
    setPrintingReceiptBatchId(batch.id);
    setReceiptStatus(`Membuat PDF kwitansi ${batch.noPengajuan}...`);
    try {
      const response = await fetch(
        `/api/off-program-control/batches/${batch.id}/kwitansi`,
        {
          method: "POST",
          credentials: "include",
        },
      );
      if (!response.ok) {
        const data = await parseJsonResponse(response);
        throw new Error(String(data.error || "Gagal membuat PDF kwitansi."));
      }
      if (!response.headers.get("content-type")?.includes("application/pdf")) {
        throw new Error("Response kwitansi bukan dokumen PDF.");
      }
      const pdfBlob = await response.blob();
      const blobUrl = URL.createObjectURL(pdfBlob);
      window.open(blobUrl, "_blank");
      window.setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
      setReceiptStatus(`PDF kwitansi ${batch.noPengajuan} berhasil dibuat.`);
      await loadReturnedBatches();
    } catch (error) {
      setReceiptStatus(
        error instanceof Error
          ? error.message
          : "Gagal membuat PDF kwitansi.",
      );
    } finally {
      setPrintingReceiptBatchId("");
    }
  };

  const supervisorMonitoringStatusOptions =
    getBatchStatusOptions(allSupervisorBatches);

  const filteredSupervisorMonitoringBatches = filterBatchesByMainStatus(
    filterBatchesByPeriod(
      filterBatchesBySearch(allSupervisorBatches, monitoringSearch),
      monitoringPeriod,
    ),
    monitoringStatusFilter,
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap gap-2 rounded-2xl border border-white/10 bg-[#1a1c23]/60 p-2">
        {[
          ["pengajuan", "Pengajuan"],
          ["monitoring", "Monitoring Semua Status"],
          ["diskon", "Dashboard Diskon SPV"],
        ].map(([key, label]) => (
          <button
            key={key}
            onClick={() =>
              setSupervisorMenu(key as "pengajuan" | "monitoring" | "diskon")
            }
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

      <IncompleteDocumentsReminderPanel batches={allSupervisorBatches} />

      {receiptStatus && (
        <div className="rounded-xl border border-indigo-500/20 bg-indigo-500/10 px-4 py-3 text-sm text-indigo-100">
          {receiptStatus}
        </div>
      )}

      {supervisorMenu === "diskon" && (
        <DiscountDashboard offRole={offRole} />
      )}

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

          <div className="mb-4">
            <PeriodFilter value={monitoringPeriod} onChange={setMonitoringPeriod} />
          </div>

          <BatchMonitoringTable
            batches={filteredSupervisorMonitoringBatches}
            selectedBatchId={editingBatchId}
            stickyAction
            onSelect={openReturnedBatch}
            onPrintReceipt={handlePrintKwitansi}
            printingReceiptBatchId={printingReceiptBatchId}
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
                      <div className="flex flex-col gap-2">
                        {canEditSupervisor && (
                          <button
                            onClick={() => openReturnedBatch(batch)}
                            className="inline-flex items-center justify-center rounded-xl border border-teal-500/30 bg-teal-500/10 px-4 py-2 text-sm font-bold text-teal-200 hover:bg-teal-500/20"
                          >
                            Buka Revisi
                          </button>
                        )}
                        <button
                          onClick={() =>
                            OFF_KWITANSI_DISABLED
                              ? undefined
                              : handlePrintKwitansi(batch)
                          }
                          disabled={
                            OFF_KWITANSI_DISABLED ||
                            printingReceiptBatchId === batch.id
                          }
                          title={
                            OFF_KWITANSI_DISABLED
                              ? OFF_KWITANSI_DISABLED_MESSAGE
                              : undefined
                          }
                          className="inline-flex items-center justify-center rounded-xl border border-indigo-500/30 bg-indigo-500/10 px-4 py-2 text-sm font-bold text-indigo-200 hover:bg-indigo-500/20 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {OFF_KWITANSI_DISABLED
                            ? OFF_KWITANSI_DISABLED_MESSAGE
                            : printingReceiptBatchId === batch.id
                              ? "Membuat..."
                              : "Print Kwitansi"}
                        </button>
                      </div>
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
                      "PPh",
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
                        <DatePickerField
                          disabled={editingLocked}
                          value={row.periodeAwal}
                          onChange={(value) => updateRow(row.id, "periodeAwal", value)}
                          ariaLabel="Periode awal"
                          className="w-full min-w-[150px] rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-slate-200 outline-none [color-scheme:dark] focus:border-teal-500/50"
                        />
                      </td>
                      <td className="px-3 py-3">
                        <DatePickerField
                          disabled={editingLocked}
                          value={row.periodeAkhir}
                          onChange={(value) => updateRow(row.id, "periodeAkhir", value)}
                          ariaLabel="Periode akhir"
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
                        <div className="min-w-[180px] space-y-1.5">
                          <select
                            disabled={editingLocked}
                            value={row.type}
                            onChange={(event) =>
                              updateRowType(row.id, event.target.value)
                            }
                            className={`w-full rounded-lg border bg-black/40 px-3 py-2 text-sm text-slate-200 outline-none focus:border-teal-500/50 disabled:opacity-70 ${
                              row.type
                                ? "border-white/10"
                                : "border-amber-500/60"
                            }`}
                          >
                            <option value="" className="bg-[#1a1c23]">
                              Pilih tipe...
                            </option>
                            {OFF_PROGRAM_TYPES.map((type) => (
                              <option
                                key={type}
                                className="bg-[#1a1c23]"
                                value={type}
                              >
                                {type}
                              </option>
                            ))}
                          </select>
                          {row.typeIsLegacy && row.type ? (
                            <span className="inline-flex items-center gap-1 rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[10px] font-bold text-amber-300">
                              Data Lama
                              {row.originalType
                                ? ` (${row.originalType})`
                                : ""}
                            </span>
                          ) : null}
                          {!row.type && row.originalType ? (
                            <span className="block text-[10px] font-semibold text-amber-300">
                              Tipe lama &quot;{row.originalType}&quot; perlu
                              dipilih ulang.
                            </span>
                          ) : null}
                        </div>
                      </td>
                      <td className="px-3 py-3">
                        {/* NOTE: PPh disiapkan nullable di level item/toko, tetapi
                            perhitungan final ditahan karena masih terkait format
                            kwitansi setelah pembayaran. */}
                        <label className="flex min-w-[150px] items-center gap-2 rounded-lg border border-white/10 bg-black/40 px-2 py-2 text-xs text-slate-300">
                          <input
                            type="checkbox"
                            checked={row.pphExempt}
                            onChange={(event) =>
                              updateRow(
                                row.id,
                                "pphExempt",
                                event.target.checked,
                              )
                            }
                            disabled={editingLocked}
                            className="rounded border-white/10 bg-black/50 text-teal-500"
                          />
                          Tidak kena PPh
                        </label>
                      </td>
                      <td className="px-3 py-3">
                        <DatePickerField
                          disabled={editingLocked}
                          value={row.deadline}
                          onChange={(value) => updateRow(row.id, "deadline", value)}
                          ariaLabel="Deadline"
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
                onClick={() => saveDraft()}
                disabled={isSubmitting || editingLocked}
                className="inline-flex items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm font-bold text-slate-200 transition-colors hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Simpan Draf Massal
              </button>
              {canSubmitSupervisor ? (
                <button
                  onClick={() => handleSubmitBatch()}
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

      {duplicatePrompt && (
        <DuplicateNoSuratPrompt
          prompt={duplicatePrompt}
          isSubmitting={isSubmitting}
          onCancel={() => {
            const mode = duplicatePrompt.mode;
            setDuplicatePrompt(null);
            setSubmitStatus(
              mode === "submit"
                ? "Pengiriman dibatalkan oleh Supervisor."
                : "Penyimpanan draf dibatalkan oleh Supervisor.",
            );
          }}
          onConfirm={() => {
            const mode = duplicatePrompt.mode;
            setDuplicatePrompt(null);
            if (mode === "submit") {
              void handleSubmitBatch({ forceDuplicateNoSurat: true });
            } else {
              void saveDraft({ forceDuplicateNoSurat: true });
            }
          }}
        />
      )}
    </div>
  );
}

function SalesManagerDashboard({ offRole }: OffDashboardProps) {
  const canReviewSm =
    canPerformOffAction(offRole, "sm_approve") ||
    canPerformOffAction(offRole, "sm_return");
  const [batches, setBatches] = useState<OffApiBatch[]>([]);
  const [smSearch, setSmSearch] = useState("");
  const [smStatusFilter, setSmStatusFilter] = useState("");
  const [smPeriod, setSmPeriod] = useState(createEmptyPeriodFilter());
  const [selectedBatch, setSelectedBatch] = useState<OffApiBatch | null>(null);
  const [selectedItems, setSelectedItems] = useState<OffApiItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isActionLoading, setIsActionLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [actionMessage, setActionMessage] = useState("");
  const [smNote, setSmNote] = useState("");
  const [notificationPreview, setNotificationPreview] =
    useState<OffNotificationPreview | null>(null);
  const smReviewDetailRef = useRef<HTMLDivElement | null>(null);
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
        ? (listData.batches as OffApiBatch[]).filter(hasPassedSalesManager)
        : [];
      setBatches(rows);
      const nextBatch = preferredBatchId
        ? rows.find((row) => row.id === preferredBatchId) || null
        : selectedBatch
          ? rows.find((row) => row.id === selectedBatch.id) || null
          : null;
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
          ? (listData.batches as OffApiBatch[]).filter(hasPassedSalesManager)
          : [];
        if (!isActive) return;
        setBatches(rows);
        setSelectedBatch(null);
        setSelectedItems([]);
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
    } finally {
      setTimeout(() => {
        smReviewDetailRef.current?.scrollIntoView({
          behavior: "smooth",
          block: "start",
        });
      }, 50);
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

  const closeDetail = () => {
    setSelectedBatch(null);
    setSelectedItems([]);
    setSmNote("");
    setActionMessage("");
    setNotificationPreview(null);
  };

  const smStatusOptions = getBatchStatusOptions(batches);

  const filteredSmBatches = filterBatchesByMainStatus(
    filterBatchesByPeriod(filterBatchesBySearch(batches, smSearch), smPeriod),
    smStatusFilter,
  );

  const smMetrics: MetricItem[] = [
    {
      label: "Total Batch",
      value: String(batches.length),
      tone: "text-sky-300",
      icon: ClipboardCheck,
    },
    {
      label: "Menunggu Review SM",
      value: String(batches.filter(isSmActionableBatch).length),
      tone: "text-amber-300",
      icon: Clock3,
    },
    {
      label: "Disetujui SM",
      value: String(
        batches.filter((batch) => batch.smStatus === "Approved by SM").length,
      ),
      tone: "text-emerald-300",
      icon: CheckCircle2,
    },
    {
      label: "Dikembalikan SM",
      value: String(
        batches.filter((batch) => batch.smStatus === "Returned").length,
      ),
      tone: "text-rose-300",
      icon: XCircle,
    },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-black text-white">
          Monitoring Batch Pengajuan
        </h2>
        <p className="mt-1 text-sm text-slate-400">
          Monitoring-first: pilih batch pada tabel untuk membuka detail review
          Sales Manager di bawah tabel.
        </p>
      </div>

      <MetricsGrid metrics={smMetrics} />

      <IncompleteDocumentsReminderPanel batches={batches} />

      <div className="space-y-4">
        <div className="grid grid-cols-1 gap-3 xl:grid-cols-[1fr_280px]">
          <MonitoringSearch value={smSearch} onChange={setSmSearch} />

          <StatusFilterSelect
            value={smStatusFilter}
            onChange={setSmStatusFilter}
            options={smStatusOptions}
          />
        </div>

        <PeriodFilter value={smPeriod} onChange={setSmPeriod} />

        {isLoading && (
          <p className="text-sm text-slate-400">Memuat data Sales Manager...</p>
        )}

        <BatchOverviewActionTable
          batches={filteredSmBatches}
          selectedBatchId={selectedBatch?.id}
          onSelect={selectBatch}
          actionLabel={(batch) =>
            isSmActionableBatch(batch) ? "Proses Review" : "Lihat"
          }
        />
      </div>

      {selectedBatch && (
        <div ref={smReviewDetailRef} className="space-y-6 scroll-mt-6">
          <Panel title="Review Batch Sales Manager" icon={ShieldCheck}>
            <div className="mb-4 flex justify-end">
              <button
                onClick={closeDetail}
                className="rounded-xl border border-white/10 bg-black/30 px-4 py-2 text-sm font-bold text-slate-300 hover:bg-white/5 hover:text-white"
              >
                Tutup Detail
              </button>
            </div>
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
            {canReviewSm && isSmActionableBatch(selectedBatch) ? (
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
                {isSmActionableBatch(selectedBatch)
                  ? "Baca-saja: role ini tidak bisa menyetujui/mengembalikan data Sales Manager."
                  : "Batch sudah diproses Sales Manager. Detail ditampilkan dalam mode baca-saja."}
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
                        {selectedBatch
                          ? "Belum ada item batch yang bisa ditampilkan."
                          : "Pilih batch dari Monitoring Batch Pengajuan untuk melihat item."}
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
  const [allClaimBatches, setAllClaimBatches] = useState<OffApiBatch[]>([]);
  const [claimBatches, setClaimBatches] = useState<OffApiBatch[]>([]);
  const [claimSearch, setClaimSearch] = useState("");
  const [claimPeriod, setClaimPeriod] = useState(createEmptyPeriodFilter());
  const [finalBatches, setFinalBatches] = useState<OffApiBatch[]>([]);
  const [finalClaimSearch, setFinalClaimSearch] = useState("");
  const [finalClaimPeriod, setFinalClaimPeriod] = useState(createEmptyPeriodFilter());
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
  const [finalChecklist, setFinalChecklist] = useState<
    Record<
      string,
      {
        finalKwt: boolean;
        finalSkp: boolean;
        finalFp: boolean;
        finalPc: boolean;
        finalFoto: boolean;
        finalRekap: boolean;
        finalOthers: boolean;
        finalOthersText: string;
        finalCompletenessNote: string;
      }
    >
  >({});
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
      !["Approved", "Returned", "Returned by Claim"].includes(claimStatus) &&
      ![
        "Cancelled",
        "Completed",
        "Claim Approved",
        "Returned by Claim",
      ].includes(status)
    );
  };

  const isClaimInitialProcessableBatch = (batch: OffApiBatch) =>
    isClaimQueueBatch(batch);

  const isClaimInitialMonitoringBatch = (batch: OffApiBatch) => {
    const claimStatus = String(batch.claimStatus || "");
    const status = String(batch.status || "");
    const wasProcessedByClaim =
      ["Approved", "Returned", "Returned by Claim"].includes(claimStatus) ||
      ["Claim Approved", "Returned by Claim", "Completed"].includes(status);

    return isClaimInitialProcessableBatch(batch) || wasProcessedByClaim;
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
    setFinalChecklist(
      Object.fromEntries(
        items.map((item) => [
          item.id,
          {
            finalKwt: Boolean(item.finalKwt),
            finalSkp: Boolean(item.finalSkp),
            finalFp: Boolean(item.finalFp),
            finalPc: Boolean(item.finalPc),
            finalFoto: Boolean(item.finalFoto),
            finalRekap: Boolean(item.finalRekap),
            finalOthers: Boolean(item.finalOthers),
            finalOthersText: item.finalOthersText || "",
            finalCompletenessNote: item.finalCompletenessNote || "",
          },
        ]),
      ),
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
      setAllClaimBatches(rows);
      const queue = rows.filter(isClaimQueueBatch);
      const finalQueue = rows.filter(isFinalQueueBatch);
      setClaimBatches(queue);
      setFinalBatches(finalQueue);

      setSelectedBatch(null);
      setSelectedFinalBatch(null);
      setSelectedItems([]);
      setClaimSubmittedDate("");
      setClaimDeadline("");
      setClaimNote("");
      setSelectedFinalItems([]);
      setFinalClaimRefs({});
      setFinalChecklist({});
      setSelectedFinalPayments([]);
      setFinalClaimNote("");
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
    setSelectedBatch(null);
    setSelectedItems([]);
    setClaimSubmittedDate("");
    setClaimDeadline("");
    setClaimNote("");
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
    setSelectedFinalBatch(null);
    setSelectedFinalItems([]);
    setSelectedFinalPayments([]);
    setFinalClaimRefs({});
    setFinalChecklist({});
    setFinalClaimNote("");
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

  const remindIncompleteDocuments = async () => {
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
            action: "remind_incomplete_documents",
            note: finalClaimNote,
          }),
        },
      );
      const data = await parseJsonResponse(response);
      if (!response.ok || !data.ok)
        throw new Error(
          String(
            data.error ||
              data.message ||
              "Gagal mengirim pengingat kelengkapan.",
          ),
        );
      setClaimMessage(
        String(
          data.message ||
            "Pengingat kelengkapan berhasil ditampilkan untuk SM dan Supervisor.",
        ),
      );
      await loadClaimBatches();
    } catch (error) {
      setClaimMessage(
        error instanceof Error
          ? error.message
          : "Gagal mengirim pengingat kelengkapan.",
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

    const missingChecklist = selectedFinalItems
      .filter((item) => item.noSurat)
      .filter((item) => {
        const cl = finalChecklist[item.id];
        if (!cl) return true;
        return !hasMinimalFinalChecklist({
          finalKwt: cl.finalKwt,
          finalSkp: cl.finalSkp,
          finalFp: cl.finalFp,
          finalPc: cl.finalPc,
          finalFoto: cl.finalFoto,
          finalRekap: cl.finalRekap,
          finalOthers: cl.finalOthers,
        });
      });

    if (missingChecklist.length > 0) {
      setClaimMessage(
        `Checklist kelengkapan final wajib diisi minimal satu untuk No Surat: ${missingChecklist
          .map((item) => item.noSurat)
          .join(", ")}`,
      );
      return;
    }

    const claimRefs = selectedFinalItems
      .filter((item) => item.noSurat)
      .map((item) => {
        const cl = finalChecklist[item.id] || {};
        return {
          itemId: item.id,
          noSurat: item.noSurat,
          noClaim: String(finalClaimRefs[item.id] || "").trim(),
          finalKwt: cl.finalKwt || false,
          finalSkp: cl.finalSkp || false,
          finalFp: cl.finalFp || false,
          finalPc: cl.finalPc || false,
          finalFoto: cl.finalFoto || false,
          finalRekap: cl.finalRekap || false,
          finalOthers: cl.finalOthers || false,
          finalOthersText: cl.finalOthersText || "",
          finalCompletenessNote: cl.finalCompletenessNote || "",
        };
      });

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

  const claimInitialMonitoringBatches = filterBatchesByPeriod(
    allClaimBatches.filter(
      (batch) =>
        isClaimInitialMonitoringBatch(batch) &&
        filterBatchesBySearch([batch], claimSearch).length > 0,
    ),
    claimPeriod,
  );

  const isFinalClaimProcessable = (batch: OffApiBatch) =>
    batch.financeStatus === "Paid" &&
    ["Waiting Claim Final Verification", "Incomplete Documents"].includes(
      batch.finalStatus,
    );

  const finalClaimMonitoringBatches = filterBatchesByPeriod(
    allClaimBatches.filter((batch) => {
      const isRelevant =
        (batch.financeStatus === "Paid" &&
          batch.finalStatus === "Waiting Claim Final Verification") ||
        batch.finalStatus === "Incomplete Documents" ||
        batch.finalStatus === "Completed";
      return (
        isRelevant && filterBatchesBySearch([batch], finalClaimSearch).length > 0
      );
    }),
    finalClaimPeriod,
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
              Cek data yang sudah dibayar Keuangan, input No Claim per No Surat,
              verifikasi bukti bayar dan jumlah pembayaran. Jika kelengkapan
              belum lengkap, gunakan pengingat web untuk SM & SPV.
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
      <div className="flex flex-wrap gap-3">
        <button
          onClick={() => setClaimView("hub")}
          className="inline-flex rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm font-bold text-slate-200 hover:bg-white/10"
        >
          Kembali ke Dashboard Claim
        </button>
        <button
          onClick={() => setClaimView("after-sm")}
          className={`rounded-xl border px-4 py-2.5 text-sm font-bold ${claimView === "after-sm" ? "border-teal-500 bg-teal-600 text-white" : "border-white/10 bg-white/5 text-slate-200 hover:bg-white/10"}`}
        >
          Validasi Setelah SM
        </button>
        <button
          onClick={() => setClaimView("after-finance")}
          className={`rounded-xl border px-4 py-2.5 text-sm font-bold ${claimView === "after-finance" ? "border-teal-500 bg-teal-600 text-white" : "border-white/10 bg-white/5 text-slate-200 hover:bg-white/10"}`}
        >
          Validasi Setelah Keuangan
        </button>
      </div>
      <div className="rounded-2xl border border-white/10 bg-[#1a1c23]/60 p-5 shadow-xl">
        <h2 className="text-xl font-black text-white">
          {claimView === "after-sm"
            ? "Validasi Setelah SM"
            : "Validasi Setelah Keuangan"}
        </h2>
        <p className="mt-1 text-sm text-slate-400">
          {claimView === "after-sm"
            ? "Cek batch yang sudah disetujui Sales Manager dan lakukan validasi Claim awal."
            : "Cek pembayaran Keuangan, input No Claim per No Surat, verifikasi bukti bayar dan jumlah. Jika kelengkapan belum lengkap, gunakan pengingat web."}
        </p>
      </div>
      <InfoNote>
        Checklist Supervisor bukan persetujuan. Claim wajib melakukan verifikasi
        nyata sebelum menyetujui.
      </InfoNote>
      {claimView === "after-sm" && (
        <>
          <Panel title="Monitoring Validasi Setelah SM" icon={ScrollText}>
            <div className="mb-4">
              <MonitoringSearch
                value={claimSearch}
                onChange={setClaimSearch}
                placeholder="Cari No Pengajuan, principle, kode, atau status Claim..."
              />
            </div>
            <div className="mb-4">
              <PeriodFilter value={claimPeriod} onChange={setClaimPeriod} />
            </div>
            <div className="overflow-x-auto rounded-xl border border-white/10">
              <table className="w-full min-w-[1300px] text-left text-sm">
                <thead className="bg-black/50 text-xs uppercase tracking-wider text-slate-500">
                  <tr>
                    {[
                      "No Pengajuan",
                      "Principle",
                      "Kode Principle",
                      "Total Nominal",
                      "Status Claim",
                      "Status OM",
                      "Status Finance",
                      "Status Final",
                      "Progress %",
                      "Claim Note",
                      "Updated At",
                      "Aksi",
                    ].map((header) => (
                      <th key={header} className="px-3 py-3 font-bold">
                        {header}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                  {claimInitialMonitoringBatches.map((batch) => {
                    const canProcess = isClaimInitialProcessableBatch(batch);
                    return (
                      <tr key={batch.id} className="hover:bg-white/[0.03]">
                        <td className="px-3 py-3 font-mono text-slate-200">
                          {batch.noPengajuan}
                        </td>
                        <td className="px-3 py-3 text-slate-300">
                          {batch.principleName}
                        </td>
                        <td className="px-3 py-3 font-mono text-teal-300">
                          {batch.principleCode}
                        </td>
                        <td className="px-3 py-3 text-right font-mono text-emerald-300">
                          Rp{" "}
                          {Number(
                            batch.summary?.totalNominal || 0,
                          ).toLocaleString("id-ID")}
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
                        <td className="px-3 py-3 min-w-[130px]">
                          <ProgressBar value={computeUiBatchProgress(batch)} />
                        </td>
                        <td className="px-3 py-3 text-slate-400">
                          {batch.claimNote || "-"}
                        </td>
                        <td className="px-3 py-3 text-slate-400">
                          {formatDateDisplay(batch.updatedAt)}
                        </td>
                        <td className="px-3 py-3">
                          <button
                            onClick={() => selectClaimBatch(batch)}
                            className={`rounded-lg border px-3 py-1.5 text-xs font-bold ${canProcess ? "border-teal-500 bg-teal-600 text-white hover:bg-teal-500" : "border-white/10 bg-white/5 text-slate-200 hover:bg-white/10"}`}
                          >
                            {canProcess ? "Proses" : "Lihat"}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                  {!isLoading && claimInitialMonitoringBatches.length === 0 && (
                    <tr>
                      <td
                        colSpan={12}
                        className="px-3 py-6 text-center text-sm text-slate-500"
                      >
                        Belum ada data validasi Claim awal untuk ditampilkan.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </Panel>

          {selectedBatch && (
            <div className="space-y-6">
              <div className="flex justify-end">
                <button
                  onClick={() => {
                    setSelectedBatch(null);
                    setSelectedItems([]);
                    setClaimSubmittedDate("");
                    setClaimDeadline("");
                    setClaimNote("");
                  }}
                  className="rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-sm font-bold text-slate-200 hover:bg-white/10"
                >
                  Tutup Detail
                </button>
              </div>
              <Panel title="Detail Validasi Claim" icon={FileCheck2}>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <Field
                    label="No Pengajuan"
                    value={selectedBatch.noPengajuan}
                  />
                  <Field
                    label="Principle"
                    value={selectedBatch.principleName}
                  />
                  <Field
                    label="Kode Principle"
                    value={selectedBatch.principleCode}
                  />
                  <Field
                    label="Status Claim"
                    value={displayStatusLabel(selectedBatch.claimStatus)}
                  />
                  <Field
                    label="Total Nominal"
                    value={`Rp ${totalNominal.toLocaleString("id-ID")}`}
                  />
                </div>
                <div className="mt-5 overflow-x-auto rounded-xl border border-white/10">
                  <table className="w-full min-w-[900px] text-left text-sm">
                    <thead className="border-b border-white/10 bg-black/50 text-xs uppercase tracking-wider text-slate-500">
                      <tr>
                        {[
                          "No",
                          "No Surat",
                          "Nama Program",
                          "Toko",
                          "Nominal",
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
                        <tr key={item.id} className="hover:bg-white/[0.03]">
                          <td className="px-3 py-3 font-mono text-slate-300">
                            {item.itemNo || index + 1}
                          </td>
                          <td className="px-3 py-3 font-mono text-slate-200">
                            {item.noSurat || "-"}
                          </td>
                          <td className="px-3 py-3 text-slate-200">
                            {item.namaProgram || "-"}
                          </td>
                          <td className="px-3 py-3 text-slate-300">
                            {item.toko || "-"}
                          </td>
                          <td className="px-3 py-3 text-right font-mono text-emerald-300">
                            Rp{" "}
                            {Number(item.nominal || 0).toLocaleString("id-ID")}
                          </td>
                          <td className="px-3 py-3 text-slate-300">
                            {item.deadline || "-"}
                          </td>
                        </tr>
                      ))}
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
                {canReviewClaim && isClaimQueueBatch(selectedBatch) ? (
                  <div className="mt-5 flex flex-wrap gap-3">
                    <button
                      onClick={returnByClaim}
                      disabled={isActionLoading}
                      className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-2.5 text-sm font-bold text-rose-300 disabled:opacity-50"
                    >
                      Kembalikan untuk Koreksi
                    </button>
                    <button
                      onClick={approveByClaim}
                      disabled={isActionLoading}
                      className="rounded-xl border border-emerald-500 bg-emerald-600 px-4 py-2.5 text-sm font-bold text-white disabled:opacity-50"
                    >
                      Setujui Claim
                    </button>
                  </div>
                ) : (
                  <div className="mt-5 rounded-xl border border-white/10 bg-black/30 px-4 py-3 text-sm text-slate-400">
                    Baca-saja atau batch sudah diproses.
                  </div>
                )}
              </Panel>
            </div>
          )}
        </>
      )}

      {claimView === "after-finance" && (
        <>
          <Panel title="Monitoring Final Claim" icon={Wallet}>
            <p className="mb-4 text-sm text-slate-400">
              Lihat data yang menunggu verifikasi final dan data yang sudah
              diproses Claim Final.
            </p>
            <div className="mb-4">
              <MonitoringSearch
                value={finalClaimSearch}
                onChange={setFinalClaimSearch}
                placeholder="Cari No Pengajuan, principle, kode, status pembayaran, atau No Surat..."
              />
            </div>
            <div className="mb-4">
              <PeriodFilter value={finalClaimPeriod} onChange={setFinalClaimPeriod} />
            </div>
            <div className="overflow-x-auto rounded-xl border border-white/10">
              <table className="w-full min-w-[1200px] text-left text-sm">
                <thead className="bg-black/50 text-xs uppercase tracking-wider text-slate-500">
                  <tr>
                    {[
                      "No Pengajuan",
                      "Principle",
                      "Kode Principle",
                      "Total Nominal",
                      "Status Finance",
                      "Status Final",
                      "Progress %",
                      "Final Claim Note",
                      "Updated At",
                      "Aksi",
                    ].map((header) => (
                      <th key={header} className="px-3 py-3 font-bold">
                        {header}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                  {finalClaimMonitoringBatches.map((batch) => {
                    const canProcessFinal = isFinalClaimProcessable(batch);
                    return (
                      <tr key={batch.id} className="hover:bg-white/[0.03]">
                        <td className="px-3 py-3 font-mono text-slate-200">
                          {batch.noPengajuan}
                        </td>
                        <td className="px-3 py-3 text-slate-300">
                          {batch.principleName}
                        </td>
                        <td className="px-3 py-3 font-mono text-teal-300">
                          {batch.principleCode}
                        </td>
                        <td className="px-3 py-3 text-right font-mono text-emerald-300">
                          Rp{" "}
                          {Number(
                            batch.summary?.totalNominal || 0,
                          ).toLocaleString("id-ID")}
                        </td>
                        <td className="px-3 py-3 text-slate-300">
                          {displayStatusLabel(batch.financeStatus)}
                        </td>
                        <td className="px-3 py-3 text-slate-300">
                          {displayStatusLabel(batch.finalStatus)}
                        </td>
                        <td className="px-3 py-3 min-w-[130px]">
                          <ProgressBar value={computeUiBatchProgress(batch)} />
                        </td>
                        <td className="px-3 py-3 text-slate-400">
                          {batch.finalClaimNote || "-"}
                        </td>
                        <td className="px-3 py-3 text-slate-400">
                          {formatDateDisplay(batch.updatedAt)}
                        </td>
                        <td className="px-3 py-3">
                          <button
                            onClick={() => selectFinalBatch(batch)}
                            className={`rounded-lg border px-3 py-1.5 text-xs font-bold ${canProcessFinal ? "border-teal-500 bg-teal-600 text-white hover:bg-teal-500" : "border-white/10 bg-white/5 text-slate-200 hover:bg-white/10"}`}
                          >
                            {canProcessFinal ? "Proses Final" : "Lihat"}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                  {!isLoading && finalClaimMonitoringBatches.length === 0 && (
                    <tr>
                      <td
                        colSpan={10}
                        className="px-3 py-6 text-center text-sm text-slate-500"
                      >
                        Belum ada data final Claim untuk ditampilkan.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </Panel>

          {selectedFinalBatch && (
            <div className="space-y-6">
              <div className="flex justify-end">
                <button
                  onClick={() => {
                    setSelectedFinalBatch(null);
                    setSelectedFinalItems([]);
                    setSelectedFinalPayments([]);
                    setFinalClaimRefs({});
                    setFinalChecklist({});
                    setFinalClaimNote("");
                  }}
                  className="rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-sm font-bold text-slate-200 hover:bg-white/10"
                >
                  Tutup Detail
                </button>
              </div>
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
                    value={displayStatusLabel(
                      selectedFinalBatch?.financeStatus,
                    )}
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
                                    window.open(
                                      payment.proofUrl || "",
                                      "_blank",
                                    )
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
                  <table className="w-full min-w-[1900px] text-sm text-left">
                    <thead className="bg-black/50 text-xs uppercase tracking-wider text-slate-500 border-b border-white/10">
                      <tr>
                        {[
                          "No",
                          "No Surat",
                          "No Claim",
                          "Checklist Final",
                          "Others Text",
                          "Catatan Kelengkapan Final",
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
                        const checklist = finalChecklist[item.id] || {
                          finalKwt: false,
                          finalSkp: false,
                          finalFp: false,
                          finalPc: false,
                          finalFoto: false,
                          finalRekap: false,
                          finalOthers: false,
                          finalOthersText: "",
                          finalCompletenessNote: "",
                        };
                        const updateChecklist = (
                          patch: Partial<typeof checklist>,
                        ) => {
                          setFinalChecklist((current) => ({
                            ...current,
                            [item.id]: {
                              ...checklist,
                              ...current[item.id],
                              ...patch,
                            },
                          }));
                        };
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
                            <td className="px-3 py-3 min-w-[300px]">
                              <div className="grid grid-cols-4 gap-2 text-xs text-slate-300">
                                {[
                                  ["finalKwt", "KWT"],
                                  ["finalSkp", "SKP"],
                                  ["finalFp", "FP"],
                                  ["finalPc", "PC"],
                                  ["finalFoto", "Foto"],
                                  ["finalRekap", "Rekap"],
                                  ["finalOthers", "Others"],
                                ].map(([key, label]) => (
                                  <label
                                    key={key}
                                    className="inline-flex items-center gap-1.5"
                                  >
                                    <input
                                      type="checkbox"
                                      checked={Boolean(
                                        checklist[
                                          key as keyof typeof checklist
                                        ],
                                      )}
                                      onChange={(event) =>
                                        updateChecklist({
                                          [key]: event.target.checked,
                                        } as Partial<typeof checklist>)
                                      }
                                      className="h-4 w-4 rounded border-white/20 bg-black/40 accent-teal-500"
                                    />
                                    {label}
                                  </label>
                                ))}
                              </div>
                            </td>
                            <td className="px-3 py-3">
                              <input
                                value={checklist.finalOthersText || ""}
                                onChange={(event) =>
                                  updateChecklist({
                                    finalOthersText: event.target.value,
                                  })
                                }
                                disabled={!checklist.finalOthers}
                                placeholder="Jika Others dicentang"
                                className="w-full min-w-[180px] rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-slate-200 outline-none placeholder:text-slate-600 focus:border-teal-500/50 disabled:opacity-50"
                              />
                            </td>
                            <td className="px-3 py-3">
                              <textarea
                                value={checklist.finalCompletenessNote || ""}
                                onChange={(event) =>
                                  updateChecklist({
                                    finalCompletenessNote: event.target.value,
                                  })
                                }
                                rows={2}
                                placeholder="Catatan per item"
                                className="w-full min-w-[220px] resize-none rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-slate-200 outline-none placeholder:text-slate-600 focus:border-teal-500/50"
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
                              {Number(item.nominal || 0).toLocaleString(
                                "id-ID",
                              )}
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
                  Claim mengecek bukti pembayaran, kesesuaian total pembayaran,
                  dan mengisi No Claim per No Surat. Jika kelengkapan belum
                  lengkap, gunakan pengingat web untuk SM & SPV. Jika sesuai,
                  selesaikan pengajuan.
                </InfoNote>
                <div className="mt-4">
                  <label className="block">
                    <span className="text-xs text-slate-500 font-semibold">
                      Catatan Final Claim
                    </span>
                    <textarea
                      value={finalClaimNote}
                      onChange={(event) =>
                        setFinalClaimNote(event.target.value)
                      }
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

                {canFinalClaim &&
                selectedFinalBatch &&
                isFinalClaimProcessable(selectedFinalBatch) ? (
                  <div className="mt-5 flex flex-wrap gap-3">
                    <button
                      onClick={remindIncompleteDocuments}
                      disabled={!selectedFinalBatch || isActionLoading}
                      className="inline-flex items-center justify-center rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-2.5 text-sm font-bold text-amber-300 hover:bg-amber-500/20 disabled:opacity-50"
                    >
                      Ingatkan SM & SPV kelengkapan belum lengkap
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
          )}
        </>
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
  const [omPeriod, setOmPeriod] = useState(createEmptyPeriodFilter());
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
    filterBatchesByPeriod(filterBatchesBySearch(omBatches, omSearch), omPeriod),
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

            <PeriodFilter value={omPeriod} onChange={setOmPeriod} />

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
  const [financePeriod, setFinancePeriod] = useState(createEmptyPeriodFilter());
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
      // Revisi B: bukti pembayaran tidak wajib untuk Tunai. Untuk Transfer tetap wajib.
      const isTunai = normalizeUiPaymentMethod(paymentMethod) === "Tunai";
      if (!isTunai && !paymentProofFile) {
        setFinanceMessage("Bukti pembayaran wajib diupload untuk pembayaran Transfer.");
        return;
      }
      if (paymentProofFile) {
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
      }
      const formData = new FormData();
      formData.append("paymentDate", paymentDate);
      formData.append("paidAmount", paidAmount);
      formData.append("paymentMethod", paymentMethod);
      formData.append("senderBank", senderBank);
      formData.append("note", financeNote);
      if (paymentProofFile) {
        formData.append("paymentProof", paymentProofFile);
      }
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
        paymentProofName: paymentProofFile?.name || "",
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
    filterBatchesByPeriod(
      filterBatchesBySearch(financeBatches, financeSearch),
      financePeriod,
    ),
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
          <div className="mb-4">
            <PeriodFilter value={financePeriod} onChange={setFinancePeriod} />
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
              <div className="space-y-2">
                <EditableField
                  label="Jumlah Dibayar oleh Keuangan"
                  value={paidAmount}
                  onChange={setPaidAmount}
                />

                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() =>
                      setPaidAmount(
                        `Rp ${remainingAmount.toLocaleString("id-ID")}`,
                      )
                    }
                    className="rounded-lg border border-teal-500/30 bg-teal-500/10 px-3 py-1.5 text-xs font-bold text-teal-200 hover:bg-teal-500/20"
                  >
                    Bayar Sisa
                  </button>

                  <button
                    type="button"
                    onClick={() =>
                      setPaidAmount(
                        `Rp ${Math.min(transfer, remainingAmount).toLocaleString("id-ID")}`,
                      )
                    }
                    disabled={transfer <= 0}
                    className="rounded-lg border border-sky-500/30 bg-sky-500/10 px-3 py-1.5 text-xs font-bold text-sky-200 hover:bg-sky-500/20 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Bayar Transfer
                  </button>

                  <button
                    type="button"
                    onClick={() =>
                      setPaidAmount(
                        `Rp ${Math.min(tunai, remainingAmount).toLocaleString("id-ID")}`,
                      )
                    }
                    disabled={tunai <= 0}
                    className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-xs font-bold text-amber-200 hover:bg-amber-500/20 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Bayar Tunai
                  </button>

                  <button
                    type="button"
                    onClick={() => setPaidAmount("")}
                    className="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-bold text-slate-300 hover:bg-white/10"
                  >
                    Kosongkan
                  </button>
                </div>
              </div>
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
                  {normalizeUiPaymentMethod(paymentMethod) === "Tunai" ? (
                    <span className="ml-1 font-normal text-emerald-300">
                      (opsional untuk Tunai)
                    </span>
                  ) : (
                    <span className="ml-1 font-normal text-slate-500">
                      (wajib untuk Transfer)
                    </span>
                  )}
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
                  {normalizeUiPaymentMethod(paymentMethod) === "Tunai"
                    ? "Pembayaran Tunai boleh tanpa bukti. Bukti tetap boleh diupload bila ada. PDF/PNG/JPG/JPEG, maks 5MB."
                    : "PDF, PNG, JPG, atau JPEG. Maksimal 5MB."}
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

type OffDiscountSubmissionRow = {
  id: string;
  toko: string;
  principleCode?: string | null;
  principleName?: string | null;
  program?: string | null;
  nominal: number;
  alasan?: string | null;
  tanggal?: string | null;
  status: string;
  catatan?: string | null;
  documentUrl?: string | null;
  documentName?: string | null;
  createdByName?: string | null;
  createdAt?: number | string | null;
};

// Revisi I: Dashboard Diskon SPV — jejak digital, BELUM approval resmi.
function DiscountDashboard({ offRole }: OffDashboardProps) {
  // Hanya Supervisor yang dapat membuat pengajuan (selaras backend). Admin
  // read-only + note, walau admin superuser di action lain.
  const canManage = offRole === "supervisor";
  const isAdmin = offRole === "admin";

  const [submissions, setSubmissions] = useState<OffDiscountSubmissionRow[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [search, setSearch] = useState("");
  const [period, setPeriod] = useState(createEmptyPeriodFilter());
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Form pengajuan diskon
  const [toko, setToko] = useState("");
  const [principleName, setPrincipleName] = useState("");
  const [program, setProgram] = useState("");
  const [nominal, setNominal] = useState("");
  const [alasan, setAlasan] = useState("");
  const [tanggal, setTanggal] = useState("");
  const [catatan, setCatatan] = useState("");
  const [docFile, setDocFile] = useState<File | null>(null);

  const loadSubmissions = async () => {
    setIsLoading(true);
    setError("");
    try {
      const params = new URLSearchParams();
      if (search.trim()) params.set("search", search.trim());
      if (period.mode === "range") {
        if (period.dateFrom) params.set("dateFrom", period.dateFrom);
        if (period.dateTo) params.set("dateTo", period.dateTo);
      } else if (period.year || period.month) {
        const year = period.year || String(new Date().getFullYear());
        const month = period.month || "01";
        const lastDay = new Date(Number(year), Number(month), 0).getDate();
        params.set("dateFrom", `${year}-${month}-01`);
        params.set(
          "dateTo",
          `${year}-${month}-${String(lastDay).padStart(2, "0")}`,
        );
      }
      const query = params.toString();
      const response = await fetch(
        `/api/off-program-control/discount${query ? `?${query}` : ""}`,
        { credentials: "include" },
      );
      const data = await parseJsonResponse(response);
      if (!response.ok || !data.ok)
        throw new Error(String(data.error || "Gagal memuat pengajuan diskon."));
      setSubmissions(
        Array.isArray(data.submissions)
          ? (data.submissions as OffDiscountSubmissionRow[])
          : [],
      );
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : "Gagal memuat pengajuan diskon.",
      );
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadSubmissions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, period]);

  const resetForm = () => {
    setToko("");
    setPrincipleName("");
    setProgram("");
    setNominal("");
    setAlasan("");
    setTanggal("");
    setCatatan("");
    setDocFile(null);
  };

  const submitDiscount = async () => {
    if (!toko.trim()) {
      setMessage("Toko/customer wajib diisi.");
      return;
    }
    if (!nominal.trim()) {
      setMessage("Nominal diskon wajib diisi.");
      return;
    }
    setIsSubmitting(true);
    setMessage("");
    try {
      const formData = new FormData();
      formData.append("toko", toko.trim());
      formData.append("principleName", principleName);
      formData.append("principleCode", getPrincipleCode(principleName));
      formData.append("program", program);
      formData.append("nominal", nominal);
      formData.append("alasan", alasan);
      formData.append("tanggal", tanggal);
      formData.append("catatan", catatan);
      if (docFile) formData.append("document", docFile);
      const response = await fetch("/api/off-program-control/discount", {
        method: "POST",
        credentials: "include",
        body: formData,
      });
      const data = await parseJsonResponse(response);
      if (!response.ok || !data.ok)
        throw new Error(String(data.error || "Gagal menyimpan pengajuan diskon."));
      setMessage("Pengajuan diskon tercatat sebagai jejak digital.");
      resetForm();
      await loadSubmissions();
    } catch (submitError) {
      setMessage(
        submitError instanceof Error
          ? submitError.message
          : "Gagal menyimpan pengajuan diskon.",
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="space-y-6">
      <InfoNote>
        {isAdmin
          ? "Halaman ini adalah jejak digital pengajuan diskon SPV dan belum menjadi workflow approval resmi."
          : "Modul ini hanya jejak digital pengajuan diskon. Workflow approval belum aktif dan data tidak memengaruhi alur OFF Program Control."}
      </InfoNote>

      {canManage && (
        <Panel title="Buat Pengajuan Diskon" icon={Percent}>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            <label className="block">
              <span className="mb-1 block text-xs font-semibold text-slate-500">
                Toko / Customer
              </span>
              <input
                value={toko}
                onChange={(event) => setToko(event.target.value)}
                className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-slate-200 outline-none focus:border-teal-500/50"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-semibold text-slate-500">
                Principle
              </span>
              <select
                value={principleName}
                onChange={(event) => setPrincipleName(event.target.value)}
                className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-slate-200 outline-none focus:border-teal-500/50"
              >
                <option value="" className="bg-[#1a1c23]">
                  Pilih principle...
                </option>
                {PRINCIPLE_OPTIONS.map((principle) => (
                  <option
                    key={principle.code}
                    value={principle.name}
                    className="bg-[#1a1c23]"
                  >
                    {principle.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-semibold text-slate-500">
                Program
              </span>
              <input
                value={program}
                onChange={(event) => setProgram(event.target.value)}
                className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-slate-200 outline-none focus:border-teal-500/50"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-semibold text-slate-500">
                Nominal Diskon
              </span>
              <input
                value={nominal}
                onChange={(event) => setNominal(event.target.value)}
                placeholder="Rp 0"
                className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-slate-200 outline-none focus:border-teal-500/50"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-semibold text-slate-500">
                Tanggal
              </span>
              <DatePickerField
                value={tanggal}
                onChange={setTanggal}
                ariaLabel="Tanggal pengajuan diskon"
                className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-slate-200 outline-none [color-scheme:dark] focus:border-teal-500/50"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-semibold text-slate-500">
                Dokumen Pendukung (opsional)
              </span>
              <input
                type="file"
                accept="application/pdf,image/png,image/jpeg"
                onChange={(event) => setDocFile(event.target.files?.[0] || null)}
                className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-slate-200 file:mr-3 file:rounded-md file:border-0 file:bg-teal-600 file:px-3 file:py-1.5 file:text-xs file:font-bold file:text-white outline-none focus:border-teal-500/50"
              />
            </label>
          </div>
          <label className="mt-3 block">
            <span className="mb-1 block text-xs font-semibold text-slate-500">
              Alasan
            </span>
            <textarea
              value={alasan}
              onChange={(event) => setAlasan(event.target.value)}
              rows={2}
              className="w-full resize-none rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-slate-200 outline-none focus:border-teal-500/50"
            />
          </label>
          <label className="mt-3 block">
            <span className="mb-1 block text-xs font-semibold text-slate-500">
              Catatan
            </span>
            <textarea
              value={catatan}
              onChange={(event) => setCatatan(event.target.value)}
              rows={2}
              className="w-full resize-none rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-slate-200 outline-none focus:border-teal-500/50"
            />
          </label>
          {message && (
            <div className="mt-3 rounded-xl border border-white/10 bg-black/30 px-4 py-3 text-sm text-slate-200">
              {message}
            </div>
          )}
          <div className="mt-4 flex justify-end">
            <button
              type="button"
              onClick={submitDiscount}
              disabled={isSubmitting}
              className="rounded-xl border border-teal-500/30 bg-teal-500/20 px-5 py-2.5 text-sm font-bold text-teal-100 hover:bg-teal-500/30 disabled:opacity-50"
            >
              {isSubmitting ? "Menyimpan..." : "Catat Pengajuan Diskon"}
            </button>
          </div>
        </Panel>
      )}

      <Panel title="Daftar Pengajuan Diskon" icon={ListChecks}>
        <div className="mb-4">
          <MonitoringSearch
            value={search}
            onChange={setSearch}
            placeholder="Cari toko, principle, program, atau alasan diskon..."
          />
        </div>
        <div className="mb-4">
          <PeriodFilter value={period} onChange={setPeriod} />
        </div>
        {error && (
          <div className="mb-4 rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
            {error}
          </div>
        )}
        {isLoading && (
          <p className="mb-3 text-sm text-slate-400">Memuat pengajuan diskon...</p>
        )}
        <div className="overflow-x-auto rounded-xl border border-white/10">
          <table className="w-full min-w-[1000px] text-left text-sm">
            <thead className="border-b border-white/10 bg-black/50 text-xs uppercase tracking-wider text-slate-500">
              <tr>
                {[
                  "Tanggal",
                  "Toko/Customer",
                  "Principle",
                  "Program",
                  "Nominal",
                  "Alasan",
                  "Status",
                  "User",
                  "Dokumen",
                ].map((header) => (
                  <th key={header} className="px-3 py-3 font-bold">
                    {header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {submissions.map((row) => (
                <tr key={row.id} className="hover:bg-white/[0.03]">
                  <td className="whitespace-nowrap px-3 py-3 text-slate-400">
                    {formatDateDisplay(row.tanggal) === "-"
                      ? formatAuditTimestamp(row.createdAt)
                      : formatDateDisplay(row.tanggal)}
                  </td>
                  <td className="px-3 py-3 font-semibold text-white">
                    {row.toko}
                  </td>
                  <td className="px-3 py-3 text-slate-300">
                    {row.principleName || "-"}
                  </td>
                  <td className="px-3 py-3 text-slate-300">
                    {row.program || "-"}
                  </td>
                  <td className="px-3 py-3 text-right font-mono text-emerald-300">
                    Rp {Number(row.nominal || 0).toLocaleString("id-ID")}
                  </td>
                  <td className="px-3 py-3 text-slate-400">{row.alasan || "-"}</td>
                  <td className="px-3 py-3">
                    <span className="inline-flex rounded-md border border-slate-500/30 bg-slate-500/10 px-2 py-1 text-xs font-bold text-slate-300">
                      {row.status}
                    </span>
                  </td>
                  <td className="px-3 py-3 text-slate-400">
                    {row.createdByName || "-"}
                  </td>
                  <td className="px-3 py-3">
                    {row.documentUrl ? (
                      <a
                        href={row.documentUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="text-teal-300 underline hover:text-teal-200"
                      >
                        {row.documentName || "Lihat"}
                      </a>
                    ) : (
                      <span className="text-xs text-slate-600">-</span>
                    )}
                  </td>
                </tr>
              ))}
              {submissions.length === 0 && !isLoading && (
                <tr>
                  <td
                    colSpan={9}
                    className="px-3 py-6 text-center text-slate-500"
                  >
                    Belum ada pengajuan diskon.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}

type OffAuditLogRow = {
  id: string;
  batchId: string;
  noPengajuan?: string | null;
  principleName?: string | null;
  itemId?: string | null;
  actorName?: string | null;
  actorRole?: string | null;
  action: string;
  fromStatus?: string | null;
  toStatus?: string | null;
  note?: string | null;
  correctionReason?: string | null;
  parentAuditLogId?: string | null;
  createdAt?: number | string | null;
};

function formatAuditTimestamp(value: number | string | null | undefined) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("id-ID", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Makassar",
  }).format(date);
}

const AUDIT_CORRECTION_WARNING =
  "PERINGATAN: Perubahan pada audit log akan tercatat sebagai riwayat koreksi. Pastikan perubahan hanya dilakukan untuk memperbaiki kesalahan pencatatan, bukan menghapus jejak aktivitas.";

function AuditTimeline({ offRole }: OffDashboardProps) {
  const canCorrect = canPerformOffAction(offRole, "audit_correct");
  const canExport = canPerformOffAction(offRole, "audit_export");
  const isAdmin = offRole === "admin";

  const [logs, setLogs] = useState<OffAuditLogRow[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [period, setPeriod] = useState(createEmptyPeriodFilter());
  const [correctionTarget, setCorrectionTarget] = useState<OffAuditLogRow | null>(
    null,
  );
  const [correctionReason, setCorrectionReason] = useState("");
  const [correctionNote, setCorrectionNote] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [message, setMessage] = useState("");

  const loadLogs = async () => {
    setIsLoading(true);
    setError("");
    try {
      const params = new URLSearchParams();
      if (search.trim()) params.set("search", search.trim());
      // Audit memakai mode rentang tanggal untuk filter periode createdAt.
      if (period.mode === "range") {
        if (period.dateFrom) params.set("dateFrom", period.dateFrom);
        if (period.dateTo) params.set("dateTo", period.dateTo);
      } else if (period.year || period.month) {
        const year = period.year || String(new Date().getFullYear());
        const month = period.month || "01";
        const lastDay = new Date(Number(year), Number(month), 0).getDate();
        params.set("dateFrom", `${year}-${month}-01`);
        params.set("dateTo", `${year}-${month}-${String(lastDay).padStart(2, "0")}`);
      }
      const query = params.toString();
      const response = await fetch(
        `/api/off-program-control/audit${query ? `?${query}` : ""}`,
        { credentials: "include" },
      );
      const data = await parseJsonResponse(response);
      if (!response.ok || !data.ok)
        throw new Error(String(data.error || "Gagal memuat audit log."));
      setLogs(Array.isArray(data.audit) ? (data.audit as OffAuditLogRow[]) : []);
    } catch (loadError) {
      setError(
        loadError instanceof Error ? loadError.message : "Gagal memuat audit log.",
      );
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadLogs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, period]);

  const handleExport = () => {
    const params = new URLSearchParams();
    params.set("format", "csv");
    if (search.trim()) params.set("search", search.trim());
    if (period.mode === "range") {
      if (period.dateFrom) params.set("dateFrom", period.dateFrom);
      if (period.dateTo) params.set("dateTo", period.dateTo);
    }
    window.open(`/api/off-program-control/audit?${params.toString()}`, "_blank");
  };

  const openCorrection = (log: OffAuditLogRow) => {
    setCorrectionTarget(log);
    setCorrectionReason("");
    setCorrectionNote(log.note || "");
    setMessage("");
  };

  const submitCorrection = async () => {
    if (!correctionTarget) return;
    if (!correctionReason.trim()) {
      setMessage("Alasan koreksi wajib diisi.");
      return;
    }
    setIsSubmitting(true);
    setMessage("");
    try {
      const response = await fetch(
        `/api/off-program-control/audit/${correctionTarget.id}/correction`,
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            correctionReason: correctionReason.trim(),
            note: correctionNote,
          }),
        },
      );
      const data = await parseJsonResponse(response);
      if (!response.ok || !data.ok)
        throw new Error(String(data.error || "Gagal menyimpan koreksi."));
      setMessage(
        "Koreksi tercatat sebagai riwayat baru tanpa menghapus jejak lama.",
      );
      setCorrectionTarget(null);
      await loadLogs();
    } catch (correctionError) {
      setMessage(
        correctionError instanceof Error
          ? correctionError.message
          : "Gagal menyimpan koreksi.",
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Panel title="Log Audit OFF Program Control" icon={ScrollText}>
      <InfoNote>
        Claim dapat membaca, mengekspor, dan mengoreksi audit log. Koreksi bersifat
        non-destruktif: jejak lama tidak dihapus dan setiap koreksi tercatat sebagai
        riwayat baru. {isAdmin ? "Admin dapat melihat histori sebelum dan sesudah perubahan." : ""}
      </InfoNote>

      <div className="mb-4 grid grid-cols-1 gap-3 xl:grid-cols-[1fr_auto]">
        <MonitoringSearch
          value={search}
          onChange={setSearch}
          placeholder="Cari No Pengajuan, principle, user, aksi, atau catatan..."
        />
        {canExport && (
          <button
            type="button"
            onClick={handleExport}
            className="rounded-xl border border-teal-500/30 bg-teal-500/10 px-4 py-2.5 text-sm font-bold text-teal-200 hover:bg-teal-500/20"
          >
            Export CSV
          </button>
        )}
      </div>

      <div className="mb-4">
        <PeriodFilter value={period} onChange={setPeriod} />
      </div>

      {message && (
        <div className="mb-4 rounded-xl border border-white/10 bg-black/30 px-4 py-3 text-sm text-slate-200">
          {message}
        </div>
      )}
      {error && (
        <div className="mb-4 rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
          {error}
        </div>
      )}
      {isLoading && (
        <p className="mb-3 text-sm text-slate-400">Memuat audit log...</p>
      )}

      <div className="overflow-x-auto rounded-xl border border-white/10">
        <table className="w-full min-w-[1100px] text-left text-sm">
          <thead className="border-b border-white/10 bg-black/50 text-xs uppercase tracking-wider text-slate-500">
            <tr>
              {[
                "Waktu",
                "No Pengajuan",
                "Aksi",
                "Dari",
                "Ke",
                "User",
                "Role",
                "Catatan",
                "Koreksi",
              ].map((header) => (
                <th key={header} className="px-3 py-3 font-bold">
                  {header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5">
            {logs.map((log) => {
              const isCorrection = Boolean(log.parentAuditLogId);
              return (
                <tr
                  key={log.id}
                  className={isCorrection ? "bg-amber-500/[0.06]" : "hover:bg-white/[0.03]"}
                >
                  <td className="whitespace-nowrap px-3 py-3 font-mono text-xs text-slate-400">
                    {formatAuditTimestamp(log.createdAt)}
                  </td>
                  <td className="px-3 py-3 font-mono text-xs text-white">
                    {log.noPengajuan || "-"}
                  </td>
                  <td className="px-3 py-3 text-slate-200">
                    {log.action}
                    {isCorrection && (
                      <span className="ml-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[10px] font-bold text-amber-300">
                        Koreksi
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-3 text-slate-400">
                    {displayStatusLabel(log.fromStatus) || "-"}
                  </td>
                  <td className="px-3 py-3 text-slate-400">
                    {displayStatusLabel(log.toStatus) || "-"}
                  </td>
                  <td className="px-3 py-3 text-slate-300">
                    {log.actorName || "-"}
                  </td>
                  <td className="px-3 py-3 text-slate-400">
                    {log.actorRole || "-"}
                  </td>
                  <td className="px-3 py-3 text-slate-400">
                    {log.correctionReason ? (
                      <span>
                        <span className="font-semibold text-amber-300">
                          Alasan koreksi:
                        </span>{" "}
                        {log.correctionReason}
                        {log.note ? ` — ${log.note}` : ""}
                      </span>
                    ) : (
                      log.note || "-"
                    )}
                  </td>
                  <td className="px-3 py-3">
                    {canCorrect && !isCorrection ? (
                      <button
                        type="button"
                        onClick={() => openCorrection(log)}
                        className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-xs font-bold text-amber-200 hover:bg-amber-500/20"
                      >
                        Koreksi
                      </button>
                    ) : (
                      <span className="text-xs text-slate-600">-</span>
                    )}
                  </td>
                </tr>
              );
            })}
            {logs.length === 0 && !isLoading && (
              <tr>
                <td colSpan={9} className="px-3 py-6 text-center text-slate-500">
                  Belum ada audit log yang cocok.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {correctionTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-lg rounded-2xl border border-white/10 bg-[#1a1c23] p-6 shadow-2xl">
            <h3 className="text-lg font-black text-white">Koreksi Audit Log</h3>
            <div className="mt-3 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-xs text-amber-200">
              {AUDIT_CORRECTION_WARNING}
            </div>
            <div className="mt-4 space-y-3">
              <div className="rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-xs text-slate-400">
                <div>
                  Aksi asal:{" "}
                  <span className="font-mono text-slate-200">
                    {correctionTarget.action}
                  </span>
                </div>
                <div>
                  No Pengajuan:{" "}
                  <span className="font-mono text-slate-200">
                    {correctionTarget.noPengajuan || "-"}
                  </span>
                </div>
              </div>
              <label className="block">
                <span className="mb-1 block text-xs font-semibold text-slate-500">
                  Alasan Koreksi (wajib)
                </span>
                <textarea
                  value={correctionReason}
                  onChange={(event) => setCorrectionReason(event.target.value)}
                  rows={3}
                  className="w-full resize-none rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-slate-200 outline-none focus:border-amber-500/50"
                  placeholder="Jelaskan kesalahan pencatatan yang diperbaiki..."
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-semibold text-slate-500">
                  Catatan Baru (opsional)
                </span>
                <textarea
                  value={correctionNote}
                  onChange={(event) => setCorrectionNote(event.target.value)}
                  rows={2}
                  className="w-full resize-none rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-slate-200 outline-none focus:border-teal-500/50"
                />
              </label>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setCorrectionTarget(null)}
                className="rounded-lg border border-white/10 px-4 py-2 text-sm font-bold text-slate-300 hover:bg-white/5"
              >
                Batal
              </button>
              <button
                type="button"
                onClick={submitCorrection}
                disabled={isSubmitting}
                className="rounded-lg border border-amber-500/30 bg-amber-500/20 px-4 py-2 text-sm font-bold text-amber-100 hover:bg-amber-500/30 disabled:opacity-50"
              >
                {isSubmitting ? "Menyimpan..." : "Simpan Koreksi"}
              </button>
            </div>
          </div>
        </div>
      )}
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
  const [overviewPeriod, setOverviewPeriod] = useState(createEmptyPeriodFilter());
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
    filterBatchesByPeriod(
      filterBatchesBySearch(overviewBatches, overviewSearch),
      overviewPeriod,
    ),
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
      <PeriodFilter value={overviewPeriod} onChange={setOverviewPeriod} />
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
  const accessibleTabKeys =
    offRole === "sales_manager"
      ? getOffAccessibleTabs(offRole).filter((key) => key === "sales")
      : getOffAccessibleTabs(offRole);
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
          {effectiveActiveTab === "audit" && <AuditTimeline offRole={offRole} />}
        </>
      )}
    </div>
  );
}
