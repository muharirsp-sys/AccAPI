"use client";

/*
 * Tujuan: Dashboard OFF Program Control bergaya warm luxury untuk cockpit admin, pengajuan, tinjauan, persetujuan, klaim, pembayaran, audit, dan tutup periode.
 * Caller: App Router dashboard `app/(dashboard)/off-program-control/page.tsx`.
 * Dependensi: `authClient`, helper akses OFF, workflow OFF, constants OFF, `DatePickerField`, route API OFF Program Control/periods.
 * Main Functions: `OffProgramControlPage`, `OverviewTab`, `AdminViewSelector`, `AdminHealthPanel`, `CompactFilterToolbar`, `CompactSubmissionTable`, `SummaryStrip`, `SupportTogglePanel`, `OverviewDetailDrawer`, form/table workflow per role.
 * Side Effects: HTTP read/write ke API OFF Program Control, baca session Better Auth, mutasi state workflow/filter/drawer/tutup periode UI.
 */

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ElementType,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  ArrowRight,
  Bell,
  CalendarClock,
  ChevronDown,
  CheckCircle2,
  ClipboardCheck,
  Clock3,
  Download,
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
  X,
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
  OFF_CLM_PROGRAM_TYPES,
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
import OffBreadcrumb from "@/components/off-program-control/OffBreadcrumb";
import OffNotificationBell from "@/components/off-program-control/OffNotificationBell";
import OffGlobalSearch, { type OffSearchableItem } from "@/components/off-program-control/OffGlobalSearch";
import { detectProblematicBatches, getProblemsForRole, type ProblemDetectionBatch } from "@/lib/off-program-control/problematic";

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
  supervisorDisplayName?: string;
  // Id user yang sedang login — dipakai SupervisorDashboard untuk filter defensif
  // agar SPV hanya melihat pengajuan miliknya (createdBy === sessionUserId).
  sessionUserId?: string;
};

type Principle = (typeof offPrinciples)[number];

const PRINCIPLE_OPTIONS: Principle[] = offPrinciples;

const tabs: Array<{ key: TabKey; label: string }> = [
  { key: "overview", label: "Ringkasan" },
  { key: "supervisor", label: "Supervisor" },
  { key: "sales", label: "Sales Manager" },
  { key: "claim", label: "Klaim" },
  { key: "om", label: "Operational Manager" },
  { key: "finance", label: "Keuangan" },
  { key: "audit", label: "Log Audit" },
];

const adminViewGroups: Array<{
  title: string;
  tabs: TabKey[];
}> = [
  {
    title: "Monitoring",
    tabs: ["overview", "audit"],
  },
  {
    title: "Approval Flow",
    tabs: ["supervisor", "sales", "om"],
  },
  {
    title: "Financial & Claim",
    tabs: ["claim", "finance"],
  },
];

const workflowSteps = [
  "Input Batch Supervisor",
  "Tinjauan Data Sales Manager",
  "Validasi Klaim",
  "Persetujuan Operational Manager",
  "Pembayaran Keuangan",
  "Verifikasi Final Pembayaran Klaim",
  "Pengembalian Selisih (jika ada)",
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
  noRekening: string;
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
  // #1-3: penanda asal pengajuan ("supervisor" | "claim").
  createdByRole?: string | null;
  // Pemilik pengajuan (id user pembuat) — dipakai untuk isolasi tampilan per-supervisor.
  createdBy?: string | null;
  // #17: status dan jumlah refund dari alur selisih.
  refundStatus?: string | null;
  refundAmount?: number | null;
  totalRefunded?: number | null;
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
  noRekening?: string | null;
  financePaymentStatus?: string | null;
  financePaymentId?: string | null;
  financePaidAmount?: number | null;
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

// --- Dummy Batches untuk fallback ketika API belum tersedia ---
const dummyBatches: OffApiBatch[] = [
  {
    id: "demo-batch-1",
    noPengajuan: "001/RB/06/2026",
    gelombang: "001",
    principleName: "RECKITT BENCKISER, PT",
    principleCode: "RB",
    bulan: "06",
    tahun: "2026",
    supervisorName: "Supervisor Area 1",
    status: "Submitted to SM",
    smStatus: "Waiting Review",
    claimStatus: "Not Started",
    omStatus: "Not Started",
    financeStatus: "Not Started",
    finalStatus: "Not Started",
    locked: false,
    createdAt: "2026-06-01T08:00:00.000Z",
    updatedAt: "2026-06-02T10:00:00.000Z",
    summary: { totalNominal: 12500000, totalRows: 3, transfer: 8100000, tunai: 4400000 },
  },
  {
    id: "demo-batch-2",
    noPengajuan: "002/GDI/06/2026",
    gelombang: "002",
    principleName: "GODREJ DISTRIBUSI INDONESIA, PT",
    principleCode: "GDI",
    bulan: "06",
    tahun: "2026",
    supervisorName: "Supervisor Area 2",
    status: "Approved by SM",
    smStatus: "Approved by SM",
    claimStatus: "Not Started",
    omStatus: "Not Started",
    financeStatus: "Not Started",
    finalStatus: "Not Started",
    locked: true,
    createdAt: "2026-05-28T09:00:00.000Z",
    updatedAt: "2026-06-03T14:00:00.000Z",
    summary: { totalNominal: 5150000, totalRows: 2, transfer: 5150000, tunai: 0 },
  },
  {
    id: "demo-batch-3",
    noPengajuan: "001/GDI/05/2026",
    gelombang: "001",
    principleName: "GODREJ DISTRIBUSI INDONESIA, PT",
    principleCode: "GDI",
    bulan: "05",
    tahun: "2026",
    supervisorName: "Supervisor Area 1",
    status: "Paid",
    smStatus: "Approved by SM",
    claimStatus: "Approved",
    omStatus: "Approved",
    financeStatus: "Paid",
    finalStatus: "Waiting Claim Final Verification",
    locked: true,
    paidAmount: 100000000,
    verifiedAmount: 80000000,
    noClaim: "CLM/GDI/05/001",
    createdAt: "2026-05-10T09:00:00.000Z",
    updatedAt: "2026-06-01T16:00:00.000Z",
    summary: { totalNominal: 100000000, totalRows: 5, transfer: 100000000, tunai: 0 },
    paymentSummary: { totalNominal: 100000000, totalPaid: 100000000, remainingAmount: 0, isFullyPaid: true },
  },
  {
    id: "demo-batch-4",
    noPengajuan: "003/RB/06/2026",
    gelombang: "003",
    principleName: "RECKITT BENCKISER, PT",
    principleCode: "RB",
    bulan: "06",
    tahun: "2026",
    supervisorName: "Supervisor Area 3",
    status: "Draft",
    smStatus: "Not Started",
    claimStatus: "Not Started",
    omStatus: "Not Started",
    financeStatus: "Not Started",
    finalStatus: "Not Started",
    locked: false,
    createdAt: "2026-06-04T07:30:00.000Z",
    updatedAt: "2026-06-04T07:30:00.000Z",
    summary: { totalNominal: 4775000, totalRows: 2, transfer: 2500000, tunai: 2275000 },
  },
  {
    id: "demo-batch-5",
    noPengajuan: "001/RB/05/2026",
    gelombang: "001",
    principleName: "RECKITT BENCKISER, PT",
    principleCode: "RB",
    bulan: "05",
    tahun: "2026",
    supervisorName: "Supervisor Area 1",
    status: "Overpaid - Pending Refund",
    smStatus: "Approved by SM",
    claimStatus: "Approved",
    omStatus: "Approved",
    financeStatus: "Paid",
    finalStatus: "Pending Refund",
    locked: true,
    paidAmount: 50000000,
    verifiedAmount: 42000000,
    noClaim: "CLM/RB/05/001",
    createdAt: "2026-05-05T08:00:00.000Z",
    updatedAt: "2026-06-03T11:00:00.000Z",
    summary: { totalNominal: 50000000, totalRows: 4, transfer: 50000000, tunai: 0 },
    paymentSummary: { totalNominal: 50000000, totalPaid: 50000000, remainingAmount: 0, isFullyPaid: true },
  },
];

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
    noRekening: "1234567890 BCA Toko Makmur",
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
    noRekening: "",
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
    noRekening: "",
    // #13: Perbaikan data sample — pakai tipe baku agar tidak memunculkan badge "Data Lama".
    type: "Sample",
    originalType: "Sample",
    typeIsLegacy: false,
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

function getGelombangFromNoPengajuan(noPengajuan: string) {
  const firstPart = String(noPengajuan || "").split("/")[0] || "";
  return /^\d+$/.test(firstPart) ? firstPart.padStart(3, "0") : "";
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
    noRekening: "",
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
  "Waiting Review": "Menunggu Tinjauan",
  "Returned by SM": "Dikembalikan oleh Sales Manager",
  "Returned by Claim": "Dikembalikan oleh Klaim",
  Returned: "Dikembalikan",
  "Approved by SM": "Disetujui Sales Manager",
  "Approved by SM - Locked": "Disetujui Sales Manager - Terkunci",
  "Waiting Claim": "Menunggu Klaim",
  "Claim Approved": "Disetujui Klaim",
  "Waiting Approval": "Menunggu Persetujuan",
  "Ready for OM": "Siap Diproses OM",
  "Waiting OM": "Menunggu OM",
  "OM Approved": "Disetujui OM",
  "Cancelled by OM": "Dibatalkan OM",
  "Waiting Payment": "Menunggu Pembayaran",
  "Partial Paid": "Dibayar Sebagian",
  "Need Correction": "Perlu Koreksi",
  Paid: "Sudah Dibayar",
  "Waiting Claim Final Verification": "Menunggu Verifikasi Final Klaim",
  "Incomplete Documents": "Kelengkapan Belum Lengkap",
  Completed: "Selesai",
  "Not Started": "Belum Dimulai",
  Approved: "Disetujui",
  Cancelled: "Dibatalkan",
  Ready: "Siap",
  Aman: "Aman",
  Lengkap: "Lengkap",
  Kurang: "Kurang",
  "Perlu Revisi": "Perlu Revisi",
  Revisi: "Revisi",
  "Overpaid - Pending Refund": "Kelebihan Dana - Menunggu Pengembalian",
  "Pending Refund": "Menunggu Pengembalian",
  "Partially Refunded": "Sebagian Dikembalikan",
  "Fully Refunded": "Sudah Dikembalikan Penuh",
  "Not Applicable": "Tidak Ada Selisih",
  // #12: "Notify OM" adalah status omStatus sementara saat SM approve sebelum Claim review.
  // Tidak dimasukkan label sebelumnya sehingga muncul teks Inggris mentah di tabel Claim.
  "Notify OM": "Menunggu Tinjauan OM",
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
    noRekening: item.noRekening || "",
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
    status.includes("Aman") ||
    status.includes("Lengkap") ||
    status.includes("Fully Refunded")
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
  if (status.includes("Overpaid") || status.includes("Pending Refund") || status.includes("Partially Refunded"))
    return "bg-orange-500/10 text-orange-300 border-orange-500/30";
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

function filterBatchesByPrincipal(
  batches: OffApiBatch[],
  principalFilter: string,
) {
  if (!principalFilter) return batches;
  return batches.filter((batch) => batch.principleCode === principalFilter);
}

function getPrincipalOptions(batches: OffApiBatch[]) {
  return Array.from(
    new Map(
      batches
        .filter((batch) => batch.principleCode || batch.principleName)
        .map((batch) => [
          batch.principleCode || batch.principleName,
          {
            value: batch.principleCode || batch.principleName,
            label: batch.principleName || batch.principleCode,
          },
        ]),
    ).values(),
  ).sort((a, b) => a.label.localeCompare(b.label));
}

function computeClaimComparison(batches: OffApiBatch[]) {
  const totalSubmitted = batches.reduce(
    (total, batch) => total + Number(batch.summary?.totalNominal || 0),
    0,
  );
  const totalClaimed = batches.reduce(
    (total, batch) =>
      total +
      Number(
        batch.paymentSummary?.totalPaid ||
          batch.verifiedAmount ||
          batch.paidAmount ||
          0,
      ),
    0,
  );
  const submittedCount = batches.length;
  const claimedCount = batches.filter(
    (batch) =>
      String(batch.noClaim || "").trim().length > 0 ||
      Number(batch.paymentSummary?.totalPaid || batch.paidAmount || 0) > 0,
  ).length;
  const difference = totalSubmitted - totalClaimed;
  const isMatched =
    submittedCount > 0 && Math.round(totalSubmitted) === Math.round(totalClaimed);

  return {
    totalSubmitted,
    totalClaimed,
    difference,
    submittedCount,
    claimedCount,
    isMatched,
    status: submittedCount === 0 ? "Belum ada pengajuan" : isMatched ? "Data sudah sesuai" : "Data belum sesuai",
  };
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

function isClaimActionableBatch(batch: OffApiBatch | null) {
  return Boolean(
    batch &&
      batch.smStatus === "Approved by SM" &&
      !["Approved", "Returned"].includes(batch.claimStatus) &&
      !["Cancelled", "Completed", "Claim Approved", "Returned by Claim"].includes(
        batch.status,
      ),
  );
}

function isFinalClaimActionableBatch(batch: OffApiBatch | null) {
  return Boolean(
    batch &&
      batch.status === "Paid" &&
      batch.financeStatus === "Paid" &&
      batch.finalStatus !== "Completed",
  );
}

function isCompletedOrCancelledBatch(batch: OffApiBatch) {
  return (
    batch.status === "Completed" ||
    batch.finalStatus === "Completed" ||
    batch.finalStatus === "Fully Refunded" ||
    batch.status === "Cancelled" ||
    batch.omStatus === "Cancelled"
  );
}

function isReturnedOrCorrectionBatch(batch: OffApiBatch) {
  return (
    batch.status === "Returned by SM" ||
    batch.status === "Returned by Claim" ||
    batch.smStatus === "Returned" ||
    batch.claimStatus === "Returned" ||
    batch.financeStatus === "Need Correction"
  );
}

function batchTimestamp(batch: OffApiBatch) {
  const rawValue =
    batch.updatedAt ||
    batch.createdAt ||
    batch.claimSubmittedDate ||
    batch.paymentDate ||
    "";
  const time = Date.parse(rawValue);
  return Number.isFinite(time) ? time : 0;
}

function batchAgeDays(batch: OffApiBatch) {
  const time = batchTimestamp(batch);
  if (!time) return 0;
  return Math.max(0, Math.floor((Date.now() - time) / 86_400_000));
}

function isOverdueBatch(batch: OffApiBatch) {
  if (!batch.claimDeadline || isCompletedOrCancelledBatch(batch)) return false;
  const deadline = Date.parse(batch.claimDeadline);
  if (!Number.isFinite(deadline)) return false;
  return deadline < Date.now();
}

function buildAdminQueueStats(batches: OffApiBatch[]) {
  return [
    {
      key: "supervisor",
      label: "Supervisor",
      count: batches.filter(isSupervisorEditableBatch).length,
      desc: "Ada pengajuan yang belum selesai atau perlu diperbaiki.",
      icon: FileText,
    },
    {
      key: "sales",
      label: "Sales Manager",
      count: batches.filter(isSmActionableBatch).length,
      desc: "Data menunggu diperiksa oleh Sales Manager.",
      icon: Send,
    },
    {
      key: "claim",
      label: "Klaim",
      count: batches.filter(isClaimActionableBatch).length,
      desc: "Menunggu validasi klaim.",
      icon: FileCheck2,
    },
    {
      key: "om",
      label: "Operational Manager",
      count: batches.filter(isOmActionableBatch).length,
      desc: "Menunggu persetujuan Manajer Operasional.",
      icon: ShieldCheck,
    },
    {
      key: "finance",
      label: "Keuangan",
      count: batches.filter(isFinanceActionableBatch).length,
      desc: "Menunggu pembayaran.",
      icon: Wallet,
    },
    {
      key: "final",
      label: "Final Klaim",
      count: batches.filter(isFinalClaimActionableBatch).length,
      desc: "Sudah dibayar, menunggu konfirmasi dokumen akhir.",
      icon: ListChecks,
    },
  ];
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
  placeholder = "Ketik nama principal, nomor, atau status pengajuan",
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
      className="w-full rounded-xl border border-[#d4ad61]/35 bg-[#fffaf0]/85 px-4 py-2.5 text-sm text-[#2d241b] outline-none placeholder:text-[#8a7558] focus:border-[#c79a3f]"
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
  claim: "Tanggal Pengajuan Klaim",
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
  const months = [
    { value: "", label: "Semua Bulan" },
    ...Array.from({ length: 12 }, (_, index) => ({
      value: String(index + 1).padStart(2, "0"),
      label: indonesianMonthLabel(index + 1),
    })),
  ];
  return (
    <div className="rounded-xl border border-[#d4ad61]/35 bg-[#fffaf0]/70 p-3">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs font-semibold text-slate-400">
          Periode
        </span>
        {isPeriodFilterActive(value) && (
          <button
            type="button"
            onClick={() => onChange(createEmptyPeriodFilter())}
            className="rounded-md border border-[#d4ad61]/35 px-2 py-0.5 text-[11px] font-semibold text-[#7a664c] hover:bg-[#f2d28a]/20"
          >
            Reset Filter
          </button>
        )}
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <label className="block">
          <span className="mb-1 block text-[11px] font-semibold text-slate-500">
            Cari Berdasarkan Tanggal
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
            className="w-full rounded-lg border border-[#d4ad61]/35 bg-[#fffaf0]/85 px-3 py-2 text-sm text-[#2d241b] outline-none focus:border-[#c79a3f]"
          >
            {(
              Object.keys(periodTypeLabels) as Array<
                OffPeriodFilterValue["periodType"]
              >
            ).map((key) => (
              <option key={key} value={key} className="bg-[#fffaf0] text-[#2d241b]">
                {periodTypeLabels[key]}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-[11px] font-semibold text-slate-500">
            Cara Pencarian
          </span>
          <select
            value={value.mode}
            onChange={(event) =>
              onChange({
                ...value,
                mode: event.target.value as OffPeriodFilterValue["mode"],
              })
            }
            className="w-full rounded-lg border border-[#d4ad61]/35 bg-[#fffaf0]/85 px-3 py-2 text-sm text-[#2d241b] outline-none focus:border-[#c79a3f]"
          >
            <option value="month" className="bg-[#fffaf0] text-[#2d241b]">
              Bulan-Tahun
            </option>
            <option value="range" className="bg-[#fffaf0] text-[#2d241b]">
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
                className="w-full rounded-lg border border-[#d4ad61]/35 bg-[#fffaf0]/85 px-3 py-2 text-sm text-[#2d241b] outline-none focus:border-[#c79a3f]"
              >
                {months.map((month) => (
                  <option
                    key={month.value}
                    value={month.value}
                    className="bg-[#fffaf0] text-[#2d241b]"
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
                className="w-full rounded-lg border border-[#d4ad61]/35 bg-[#fffaf0]/85 px-3 py-2 text-sm text-[#2d241b] outline-none placeholder:text-[#8a7558] focus:border-[#c79a3f]"
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
                className="w-full rounded-lg border border-[#d4ad61]/35 bg-[#fffaf0]/85 px-3 py-2 text-sm text-[#2d241b] outline-none [color-scheme:light] focus:border-[#c79a3f]"
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
                className="w-full rounded-lg border border-[#d4ad61]/35 bg-[#fffaf0]/85 px-3 py-2 text-sm text-[#2d241b] outline-none [color-scheme:light] focus:border-[#c79a3f]"
              />
            </label>
          </>
        )}
      </div>
    </div>
  );
}

function StatusFilterSelect({
  value,
  onChange,
  options,
  label = "Status",
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
        className="w-full rounded-xl border border-[#d4ad61]/35 bg-[#fffaf0]/85 px-4 py-2.5 text-sm text-[#2d241b] outline-none focus:border-[#c79a3f]"
      >
        <option value="" className="bg-[#fffaf0] text-[#2d241b]">
          Semua Status
        </option>
        {options.map((option) => {
          const value = typeof option === "string" ? option : option.value;
          const label =
            typeof option === "string"
              ? displayStatusLabel(option)
              : option.label;

          return (
            <option key={value} value={value} className="bg-[#fffaf0] text-[#2d241b]">
              {label}
            </option>
          );
        })}
      </select>
    </label>
  );
}

type FilterChip = {
  label: string;
  value: string;
};

function optionLabel(
  options: Array<string | { value: string; label: string }>,
  value: string,
) {
  const match = options.find((option) =>
    typeof option === "string" ? option === value : option.value === value,
  );
  if (!match) return displayStatusLabel(value);
  return typeof match === "string" ? displayStatusLabel(match) : match.label;
}

function periodFilterLabel(period: OffPeriodFilterValue) {
  if (!isPeriodFilterActive(period)) return "";
  if (period.mode === "range") {
    const from = period.dateFrom ? formatDateDisplay(period.dateFrom) : "awal";
    const to = period.dateTo ? formatDateDisplay(period.dateTo) : "akhir";
    return `${periodTypeLabels[period.periodType]}: ${from} - ${to}`;
  }
  const month = period.month ? indonesianMonthLabel(period.month) : "Semua bulan";
  const year = period.year || "Semua tahun";
  return `${periodTypeLabels[period.periodType]}: ${month} ${year}`;
}

function buildBatchFilterChips({
  principalFilter,
  principalOptions,
  statusFilter,
  statusOptions,
  period,
}: {
  principalFilter?: string;
  principalOptions?: Array<{ value: string; label: string }>;
  statusFilter?: string;
  statusOptions?: Array<string | { value: string; label: string }>;
  period?: OffPeriodFilterValue;
}): FilterChip[] {
  const chips: FilterChip[] = [];
  if (principalFilter) {
    chips.push({
      label: "Principal",
      value:
        principalOptions?.find((option) => option.value === principalFilter)
          ?.label || principalFilter,
    });
  }
  if (statusFilter) {
    chips.push({
      label: "Status",
      value: optionLabel(statusOptions || [], statusFilter),
    });
  }
  if (period) {
    const label = periodFilterLabel(period);
    if (label) chips.push({ label: "Periode", value: label });
  }
  return chips;
}

function EmptyState({
  title = "Belum ada pengajuan pada filter ini.",
  desc = "Coba ubah filter atau reset pencarian.",
  actionLabel,
  onAction,
}: {
  title?: string;
  desc?: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <div className="rounded-2xl bg-black/25 px-5 py-8 text-center">
      <p className="text-sm font-bold text-slate-200">{title}</p>
      <p className="mt-2 text-sm text-slate-500">{desc}</p>
      {actionLabel && onAction && (
        <button
          type="button"
          onClick={onAction}
          className="mt-4 rounded-xl border border-teal-500/30 bg-teal-500/10 px-4 py-2 text-sm font-bold text-teal-200 hover:bg-teal-500/20"
        >
          {actionLabel}
        </button>
      )}
    </div>
  );
}

function CompactFilterToolbar({
  searchValue,
  onSearchChange,
  placeholder,
  activeFilters,
  onReset,
  children,
}: {
  searchValue: string;
  onSearchChange: (value: string) => void;
  placeholder: string;
  activeFilters?: FilterChip[];
  onReset: () => void;
  children: ReactNode;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const hasActiveFilters = Boolean(activeFilters?.length || searchValue.trim());

  return (
    <section className="rounded-2xl border border-[#d4ad61]/30 bg-[#fffaf0]/78 p-4 shadow-[0_18px_46px_rgba(122,78,32,0.10)] backdrop-blur-xl">
      <div className="flex flex-col gap-3 xl:flex-row xl:items-center">
        <div className="min-w-0 flex-1">
          <MonitoringSearch
            value={searchValue}
            onChange={onSearchChange}
            placeholder={placeholder}
          />
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setIsOpen((current) => !current)}
            aria-expanded={isOpen}
            className="inline-flex items-center justify-center gap-2 rounded-xl border border-[#d4ad61]/35 bg-[#fffaf0]/90 px-4 py-2.5 text-sm font-bold text-[#2d241b] hover:bg-[#f2d28a]/20"
          >
            Filter
            <ChevronDown
              size={14}
              className={`transition-transform ${isOpen ? "rotate-180" : ""}`}
            />
          </button>
          <button
            type="button"
            onClick={onReset}
            disabled={!hasActiveFilters}
            className="text-sm font-semibold text-[#7a664c] underline px-2 py-2 hover:text-[#2d241b] disabled:cursor-not-allowed disabled:opacity-40 disabled:no-underline"
          >
            Reset
          </button>
        </div>
      </div>
      {activeFilters && activeFilters.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {activeFilters.map((chip) => (
            <span
              key={`${chip.label}-${chip.value}`}
              className="rounded-lg border border-[#d4ad61]/20 bg-[#f7ead0]/70 px-3 py-1.5 text-xs font-semibold text-[#574839]"
            >
              <span className="text-[#7a664c]">{chip.label}:</span> {chip.value}
            </span>
          ))}
        </div>
      )}
      {isOpen && <div className="mt-4 pt-4">{children}</div>}
    </section>
  );
}

function currentWorkflowStage(batch: OffApiBatch) {
  if (batch.status === "Completed" || batch.finalStatus === "Completed") {
    return "Selesai";
  }
  if (batch.status === "Cancelled" || batch.omStatus === "Cancelled") {
    return "Dibatalkan";
  }
  if (isFinalClaimActionableBatch(batch)) {
    return "Menunggu Verifikasi Final Klaim";
  }
  if (isFinanceActionableBatch(batch)) {
    return "Menunggu Pembayaran Keuangan";
  }
  if (isOmActionableBatch(batch)) {
    return "Menunggu Persetujuan OM";
  }
  if (isClaimActionableBatch(batch)) {
    return "Menunggu Validasi Klaim";
  }
  if (isSmActionableBatch(batch)) {
    return "Menunggu Tinjauan SM";
  }
  if (isSupervisorEditableBatch(batch)) {
    return "Perlu Revisi Supervisor";
  }
  return displayStatusLabel(batch.status);
}

function nextWorkflowPic(batch: OffApiBatch) {
  if (batch.status === "Completed" || batch.finalStatus === "Completed") return "-";
  if (isFinalClaimActionableBatch(batch)) return "Klaim";
  if (isFinanceActionableBatch(batch)) return "Keuangan";
  if (isOmActionableBatch(batch)) return "Operational Manager";
  if (isClaimActionableBatch(batch)) return "Klaim";
  if (isSmActionableBatch(batch)) return "Sales Manager";
  if (isSupervisorEditableBatch(batch)) return "Supervisor";
  return displayStatusLabel(batch.status);
}

function workflowDeadline(batch: OffApiBatch) {
  return batch.claimDeadline || batch.paymentDate || batch.updatedAt || batch.createdAt;
}

function CompactSubmissionTable({
  title = "Daftar Pengajuan",
  batches,
  selectedBatchId,
  onSelect,
  actionLabel,
  emptyText,
  onPrintReceipt,
  printingReceiptBatchId,
}: {
  title?: string;
  batches: OffApiBatch[];
  selectedBatchId?: string | null;
  onSelect: (batch: OffApiBatch) => void;
  actionLabel: (batch: OffApiBatch) => string;
  emptyText: string;
  onPrintReceipt?: (batch: OffApiBatch) => void;
  printingReceiptBatchId?: string;
}) {
  const headers = [
    "Nomor Pengajuan",
    "Principal",
    "Nominal",
    "Status Saat Ini",
    "Penanggung Jawab",
    "Deadline",
    "Aksi",
  ];

  return (
    <section className="rounded-2xl bg-[#1a1c23]/45 p-4 shadow-xl">
      <div className="mb-6 flex items-center gap-3">
        <h3 className="flex items-center gap-2 text-base font-bold text-white">
          <ReceiptText className="text-teal-300" size={18} /> {title}
        </h3>
      </div>
      {batches.length === 0 ? (
        <EmptyState title={emptyText} />
      ) : (
        <>
          <div className="space-y-3 lg:hidden">
            {batches.map((batch) => (
              <article
                key={batch.id}
                className={`rounded-xl p-4 ${
                  selectedBatchId === batch.id
                    ? "bg-teal-500/10"
                    : "bg-black/25"
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate font-mono text-sm font-black text-white">
                      {batch.noPengajuan}
                    </p>
                    <p className="mt-1 line-clamp-2 text-sm text-slate-300">
                      {batch.principleName}
                    </p>
                  </div>
                  <span
                    className={`shrink-0 rounded-md border px-2 py-1 text-[11px] font-bold ${statusClass(batch.status)}`}
                  >
                    {currentWorkflowStage(batch)}
                  </span>
                </div>
                <div className="mt-4 grid grid-cols-2 gap-3 text-xs text-slate-400">
                  <div>
                    <span className="block text-slate-600">Nominal</span>
                    <span className="font-mono font-bold text-emerald-300">
                      Rp{" "}
                      {Number(batch.summary?.totalNominal || 0).toLocaleString(
                        "id-ID",
                      )}
                    </span>
                  </div>
                  <div>
                    <span className="block text-slate-600">PIC berikutnya</span>
                    <span className="font-bold text-slate-200">
                      {nextWorkflowPic(batch)}
                    </span>
                  </div>
                </div>
                <div className="mt-4 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => onSelect(batch)}
                    className="flex-1 rounded-lg bg-teal-600 px-4 py-2 text-xs font-bold text-white hover:bg-teal-500"
                  >
                    {actionLabel(batch)}
                  </button>
                  {onPrintReceipt && (
                    <button
                      type="button"
                      onClick={() =>
                        OFF_KWITANSI_DISABLED ? undefined : onPrintReceipt(batch)
                      }
                      disabled={
                        OFF_KWITANSI_DISABLED ||
                        printingReceiptBatchId === batch.id
                      }
                      title="Cetak Kwitansi"
                      className="rounded-lg border border-white/15 px-2 py-2 text-slate-400 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <ReceiptText size={15} />
                    </button>
                  )}
                </div>
              </article>
            ))}
          </div>
          <div className="hidden overflow-x-auto lg:block">
            <table className="w-full min-w-[1040px] text-left text-sm">
              <thead className="text-xs uppercase tracking-wider text-slate-500">
                <tr>
                  {headers.map((header) => (
                    <th key={header} className="px-4 py-3 font-bold">
                      {header}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {batches.map((batch) => (
                  <tr
                    key={batch.id}
                    className={
                      selectedBatchId === batch.id
                        ? "bg-teal-500/10"
                        : "hover:bg-white/[0.03]"
                    }
                  >
                    <td className="px-4 py-4 font-mono font-bold text-white">
                      {batch.noPengajuan}
                    </td>
                    <td className="min-w-[220px] px-4 py-4">
                      <p className="font-semibold text-slate-200">
                        {batch.principleName}
                      </p>
                      <p className="mt-1 font-mono text-xs text-teal-300">
                        {batch.principleCode}
                      </p>
                    </td>
                    <td className="px-4 py-4 text-right font-mono text-emerald-300">
                      Rp{" "}
                      {Number(batch.summary?.totalNominal || 0).toLocaleString(
                        "id-ID",
                      )}
                    </td>
                    <td className="min-w-[220px] px-4 py-4">
                      <span
                        className={`inline-flex rounded-md border px-2.5 py-1 text-xs font-bold ${statusClass(batch.status)}`}
                      >
                        {currentWorkflowStage(batch)}
                      </span>
                      <div className="mt-2">
                        <ProgressBar
                          value={computeUiBatchProgress(batch)}
                          showLabel={false}
                        />
                      </div>
                    </td>
                    <td className="px-4 py-4 text-slate-300">
                      {nextWorkflowPic(batch)}
                    </td>
                    <td className="px-4 py-4 text-slate-300">
                      {formatDateDisplay(
                        workflowDeadline(batch)?.slice(0, 10),
                      )}
                    </td>
                    <td className="px-4 py-4">
                      <div className="flex min-w-[150px] items-center gap-2">
                        <button
                          type="button"
                          onClick={() => onSelect(batch)}
                          className="rounded-lg bg-teal-600 px-4 py-2 text-xs font-bold text-white hover:bg-teal-500"
                        >
                          {actionLabel(batch)}
                        </button>
                        {onPrintReceipt && (
                          <button
                            type="button"
                            onClick={() =>
                              OFF_KWITANSI_DISABLED
                                ? undefined
                                : onPrintReceipt(batch)
                            }
                            disabled={
                              OFF_KWITANSI_DISABLED ||
                              printingReceiptBatchId === batch.id
                            }
                            title={
                              OFF_KWITANSI_DISABLED
                                ? OFF_KWITANSI_DISABLED_MESSAGE
                                : "Cetak Kwitansi"
                            }
                            className="rounded-lg border border-white/15 px-2 py-2 text-slate-400 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            <ReceiptText size={15} />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}

function BatchMonitoringTable({
  batches,
  selectedBatchId,
  onSelect,
  onPrintReceipt,
  printingReceiptBatchId,
  actionLabel,
  emptyText = "Tidak ada data yang sesuai dengan pencarian atau filter yang dipilih.",
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
  void stickyAction;
  return (
    <CompactSubmissionTable
      batches={batches}
      selectedBatchId={selectedBatchId}
      onSelect={onSelect}
      actionLabel={actionLabel}
      emptyText={emptyText}
      onPrintReceipt={onPrintReceipt}
      printingReceiptBatchId={printingReceiptBatchId}
    />
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
  return (
    <CompactSubmissionTable
      title="Daftar Pembayaran"
      batches={batches}
      selectedBatchId={selectedBatchId}
      onSelect={onSelect}
      actionLabel={financeActionLabel}
      emptyText="Belum ada data pembayaran pada filter ini."
    />
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
    <section className="rounded-2xl border border-white/5 bg-[#1a1c23]/55 p-6 shadow-xl">
      <h2 className="mb-6 flex items-center gap-2 text-lg font-bold text-white">
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

function PrincipalFilterSelect({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-semibold text-slate-500">
        Principal
      </span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="w-full rounded-xl border border-[#d4ad61]/35 bg-[#fffaf0]/85 px-4 py-2.5 text-sm text-[#2d241b] outline-none focus:border-[#c79a3f]"
      >
        <option value="" className="bg-[#fffaf0] text-[#2d241b]">
          Semua Principal
        </option>
        {options.map((option) => (
          <option key={option.value} value={option.value} className="bg-[#fffaf0] text-[#2d241b]">
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function ClaimComparisonSummary({
  comparison,
}: {
  comparison: ReturnType<typeof computeClaimComparison>;
}) {
  const items = [
    { label: "Total Diajukan", value: `Rp ${comparison.totalSubmitted.toLocaleString("id-ID")}` },
    { label: "Total Diklaim", value: `Rp ${comparison.totalClaimed.toLocaleString("id-ID")}` },
    { label: "Selisih", value: `Rp ${Math.abs(comparison.difference).toLocaleString("id-ID")}` },
    { label: "Jumlah Pengajuan", value: String(comparison.submittedCount) },
    { label: "Jumlah Klaim", value: String(comparison.claimedCount) },
    { label: "Status Pencocokan", value: comparison.status },
  ];

  return (
    <section className="rounded-2xl border border-white/10 bg-[#1a1c23]/60 p-4 shadow-xl">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-bold text-white">Perbandingan Pengajuan &amp; Klaim</h2>
        <span
          className={`rounded-md border px-3 py-1 text-xs font-bold ${
            comparison.isMatched
              ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
              : "border-amber-500/30 bg-amber-500/10 text-amber-300"
          }`}
        >
          {comparison.isMatched ? "Sesuai" : "Belum Sesuai"}
        </span>
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-6">
        {items.map((item) => (
          <div key={item.label} className="rounded-xl bg-black/25 px-3 py-3">
            <p className="text-xs font-semibold text-slate-500">{item.label}</p>
            <p className="mt-1 text-sm font-black text-white">{item.value}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function PeriodClosurePanel({
  batches,
  offRole,
  onUpdated,
}: {
  batches: OffApiBatch[];
  offRole: OffRole;
  onUpdated: () => Promise<void>;
}) {
  const principalOptions = getPrincipalOptions(batches);
  const firstBatch = batches[0];
  // BUG FIX: principalCode harus default ke "" agar "Semua Principal" selalu
  // bisa dipilih. Inisialisasi ke firstBatch.principleCode menyebabkan opsi
  // "Semua Principal" tidak pernah menjadi nilai default, dan useEffect lama
  // meng-override pilihan user kembali ke principle pertama setiap kali deps berubah.
  const [principalCode, setPrincipalCode] = useState("");
  const [month, setMonth] = useState(firstBatch?.bulan || "");
  const [year, setYear] = useState(firstBatch?.tahun || "");
  const [status, setStatus] = useState("");
  const [periodStatus, setPeriodStatus] = useState("Terbuka");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [hasUserInteracted, setHasUserInteracted] = useState(false);

  // Hanya auto-set bulan dan tahun saat data pertama tersedia dan user belum interaksi.
  // principalCode TIDAK di-auto-fill: default "Semua Principal" (value="") dipertahankan
  // agar user selalu bisa memilihnya tanpa di-reset oleh effect ini.
  useEffect(() => {
    if (hasUserInteracted) return;
    if (!month && firstBatch?.bulan) setMonth(firstBatch.bulan);
    if (!year && firstBatch?.tahun) setYear(firstBatch.tahun);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firstBatch?.bulan, firstBatch?.tahun]);

  const handlePrincipalChange = (value: string) => {
    setHasUserInteracted(true);
    setPrincipalCode(value);
  };

  const targetBatches = batches.filter(
    (batch) =>
      (!principalCode || batch.principleCode === principalCode) &&
      (!month || batch.bulan === month) &&
      (!year || batch.tahun === year),
  );
  const comparison = computeClaimComparison(targetBatches);
  const canUnlock = offRole === "admin";
  // isBulkMode = true saat "Semua Principal" dipilih (principalCode === "").
  // Tombol aktif di mode bulk asalkan bulan+tahun terisi, ada batch, dan selisih = 0.
  const isBulkMode = !principalCode;
  const canClosePeriod =
    Boolean(month && year) &&
    targetBatches.length > 0 &&
    comparison.isMatched &&
    (isBulkMode || Boolean(principalCode));
  const isPeriodClosed = periodStatus === "Ditutup" || periodStatus === "Dikunci";
  const selectedPeriodLabel =
    month && year
      ? `${principalCode ? (principalOptions.find((option) => option.value === principalCode)?.label || principalCode) : "Semua Principal"} - ${indonesianMonthLabel(month)} ${year}`
      : "Pilih principal dan periode";

  const submitPeriodAction = async (action: "close" | "unlock") => {
    if (!month || !year) {
      setStatus("Bulan dan tahun wajib dipilih.");
      return;
    }

    // ── MODE BULK: Semua Principal ──────────────────────────────────────────
    if (isBulkMode) {
      const uniquePrincipals = [
        ...new Set(
          targetBatches.map((b) => b.principleCode).filter(Boolean),
        ),
      ] as string[];
      if (uniquePrincipals.length === 0) {
        setStatus("Tidak ada principal yang ditemukan untuk periode ini.");
        return;
      }
      if (
        action === "close" &&
        !window.confirm(
          `Tutup semua ${uniquePrincipals.length} principal untuk ${indonesianMonthLabel(month)} ${year}? Data tidak bisa diubah lagi setelah dikunci.`,
        )
      ) {
        return;
      }
      setIsSubmitting(true);
      setStatus("");
      try {
        const results = await Promise.all(
          uniquePrincipals.map(async (pc) => {
            const res = await fetch("/api/off-program-control/periods", {
              method: "POST",
              credentials: "include",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ action, principleCode: pc, bulan: month, tahun: year }),
            });
            const data = await parseJsonResponse(res);
            return { ok: res.ok && Boolean(data.ok), pc };
          }),
        );
        const failed = results.filter((r) => !r.ok);
        if (failed.length > 0) {
          throw new Error(
            `${failed.length} principal gagal diproses: ${failed.map((r) => r.pc).join(", ")}`,
          );
        }
        setPeriodStatus(action === "close" ? "Ditutup" : "Terbuka");
        setStatus(
          `Semua ${uniquePrincipals.length} principal berhasil ${action === "close" ? "ditutup" : "dibuka kunci"} untuk periode ${indonesianMonthLabel(month)} ${year}.`,
        );
        await onUpdated();
      } catch (error) {
        setStatus(
          error instanceof Error ? error.message : "Periode belum berhasil diproses.",
        );
      } finally {
        setIsSubmitting(false);
      }
      return;
    }

    // ── MODE SINGLE: Satu Principal ─────────────────────────────────────────
    if (
      action === "close" &&
      !window.confirm(
        "Tutup periode ini? Setelah dikunci, data tidak bisa diubah lagi.",
      )
    ) {
      return;
    }
    setIsSubmitting(true);
    setStatus("");
    try {
      const response = await fetch("/api/off-program-control/periods", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, principleCode: principalCode, bulan: month, tahun: year }),
      });
      const data = await parseJsonResponse(response);
      if (!response.ok || !data.ok) {
        throw new Error(String(data.error || "Periode belum berhasil diproses."));
      }
      setPeriodStatus(String(data.status || (action === "close" ? "Ditutup" : "Terbuka")));
      setStatus(String(data.message || "Periode berhasil diproses."));
      await onUpdated();
    } catch (error) {
      setStatus(
        error instanceof Error ? error.message : "Periode belum berhasil diproses.",
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <section className="rounded-2xl border border-white/10 bg-[#1a1c23]/60 p-4 shadow-xl">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-bold text-white">Tutup Periode</h2>
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-md border border-white/10 bg-black/30 px-3 py-1 text-xs font-bold text-slate-300">
            {selectedPeriodLabel}
          </span>
          <span className="rounded-md border border-white/10 bg-black/30 px-3 py-1 text-xs font-bold text-slate-300">
            Status Periode: {periodStatus}
          </span>
        </div>
      </div>
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-[minmax(260px,1fr)_180px_180px]">
        <PrincipalFilterSelect
          value={principalCode}
          onChange={handlePrincipalChange}
          options={principalOptions}
        />
        <label className="block">
          <span className="mb-1 block text-xs font-semibold text-slate-500">
            Periode
          </span>
          <select
            value={month}
            onChange={(event) => setMonth(event.target.value)}
            className="w-full rounded-xl border border-white/10 bg-black/40 px-4 py-2.5 text-sm text-slate-200 outline-none focus:border-teal-500/50"
          >
            <option value="" className="bg-[#1a1c23]">Pilih Periode</option>
            {Array.from({ length: 12 }, (_, index) => String(index + 1).padStart(2, "0")).map((value) => (
            <option key={value} value={value} className="bg-[#fffaf0] text-[#2d241b]">
                {indonesianMonthLabel(value)}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-semibold text-slate-500">
            Tahun
          </span>
          <input
            value={year}
            onChange={(event) => setYear(event.target.value.replace(/[^\d]/g, "").slice(0, 4))}
            className="w-full rounded-xl border border-white/10 bg-black/40 px-4 py-2.5 text-sm text-slate-200 outline-none focus:border-teal-500/50"
          />
        </label>
      </div>
      <div className="mt-4 grid grid-cols-1 gap-2 md:grid-cols-4">
        {[
          { label: "Total Diajukan", value: `Rp ${comparison.totalSubmitted.toLocaleString("id-ID")}` },
          { label: "Total Diklaim", value: `Rp ${comparison.totalClaimed.toLocaleString("id-ID")}` },
          { label: "Selisih", value: `Rp ${Math.abs(comparison.difference).toLocaleString("id-ID")}` },
          { label: "Kesesuaian Data", value: comparison.status },
        ].map((item) => (
          <div key={item.label} className="rounded-xl bg-black/25 px-3 py-3">
            <p className="text-xs font-semibold text-slate-500">{item.label}</p>
            <p className="mt-1 text-sm font-black text-white">{item.value}</p>
          </div>
        ))}
      </div>
      <div className="mt-6 flex flex-wrap items-center gap-4">
        <button
          type="button"
          disabled={isSubmitting || !canClosePeriod}
          onClick={() => submitPeriodAction("close")}
          className="rounded-xl bg-emerald-600 px-5 py-2.5 text-sm font-bold text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Tutup Periode
        </button>
        {targetBatches.length > 0 && principalCode && month && year && (
          <button
            type="button"
            onClick={() => {
              const params = new URLSearchParams({ principleCode: principalCode, bulan: month, tahun: year });
              window.open(`/api/off-program-control/periods/reconciliation?${params.toString()}`, "_blank");
            }}
            className="flex items-center gap-2 rounded-xl border border-white/10 bg-black/25 px-4 py-2.5 text-sm font-semibold text-slate-300 hover:bg-black/40 hover:text-white transition-colors"
          >
            <Download size={15} />
            Download Rekonsiliasi
          </button>
        )}
        {canUnlock && isPeriodClosed && (
          <button
            type="button"
            disabled={isSubmitting}
            onClick={() => submitPeriodAction("unlock")}
            className="text-xs font-semibold text-amber-400 underline hover:text-amber-300 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Buka kunci periode ini
          </button>
        )}
      </div>
      {status && (
        <div className="mt-3 rounded-xl border border-white/10 bg-black/30 px-4 py-3 text-sm text-slate-300">
          {status}
        </div>
      )}
      {!comparison.isMatched && targetBatches.length > 0 && (
        <div className="mt-3 rounded-xl border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
          Periode belum dapat ditutup karena total pengajuan dan total klaim belum sesuai.
        </div>
      )}
      {targetBatches.length > 0 && (
        <details className="mt-4 rounded-xl border border-white/10 bg-black/20 overflow-hidden">
          <summary className="cursor-pointer px-4 py-3 text-sm font-semibold text-slate-300 hover:text-white select-none">
            Lihat Detail Rekonsiliasi ({targetBatches.length} pengajuan)
          </summary>
          <div className="overflow-x-auto">
            <table className="w-full text-xs text-left border-t border-white/10">
              <thead className="text-[10px] uppercase text-slate-500 bg-black/30">
                <tr>
                  <th className="px-3 py-2">No</th>
                  <th className="px-3 py-2">No. Pengajuan</th>
                  <th className="px-3 py-2">Nama Toko</th>
                  <th className="px-3 py-2 text-right">Nilai Pengajuan</th>
                  <th className="px-3 py-2">No. Claim</th>
                  <th className="px-3 py-2 text-right">Nilai Claim</th>
                  <th className="px-3 py-2 text-right">Selisih</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {targetBatches.map((batch, idx) => {
                  const nilaiPengajuan = Number(batch.summary?.totalNominal || 0);
                  const nilaiClaim = Number(batch.paymentSummary?.totalPaid || batch.verifiedAmount || batch.paidAmount || 0);
                  const selisih = nilaiPengajuan - nilaiClaim;
                  return (
                    <tr key={batch.id} className="hover:bg-white/5">
                      <td className="px-3 py-2 text-slate-400">{idx + 1}</td>
                      <td className="px-3 py-2 text-slate-200 font-mono">{batch.noPengajuan}</td>
                      <td className="px-3 py-2 text-slate-300">{batch.principleName}</td>
                      <td className="px-3 py-2 text-right text-slate-200">Rp {nilaiPengajuan.toLocaleString("id-ID")}</td>
                      <td className="px-3 py-2 text-slate-300">{batch.noClaim || "-"}</td>
                      <td className="px-3 py-2 text-right text-slate-200">Rp {nilaiClaim.toLocaleString("id-ID")}</td>
                      <td className={`px-3 py-2 text-right font-bold ${selisih !== 0 ? "text-red-400" : "text-emerald-400"}`}>
                        Rp {Math.abs(selisih).toLocaleString("id-ID")}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </section>
  );
}

function SupportTogglePanel({
  title,
  actionLabel,
  icon: Icon,
  children,
}: {
  title: string;
  actionLabel: string;
  icon: ElementType;
  children: ReactNode;
}) {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <section className="rounded-2xl border border-[#d4ad61]/28 bg-[#fffaf0]/78 p-5 shadow-[0_18px_46px_rgba(122,78,32,0.12)] backdrop-blur-xl">
      <button
        type="button"
        onClick={() => setIsOpen((current) => !current)}
        aria-expanded={isOpen}
        className="flex w-full flex-col gap-3 text-left sm:flex-row sm:items-center sm:justify-between"
      >
        <span className="flex items-start gap-3">
          <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-[#d4ad61]/35 bg-[#f7ead0]/80 shadow-[0_8px_22px_rgba(122,78,32,0.10)]">
            <Icon className="text-[#00877b]" size={18} />
          </span>
          <span>
            <span className="block text-sm font-bold text-[#2d241b]">{title}</span>
          </span>
        </span>
        <span className="inline-flex items-center justify-center gap-2 rounded-xl border border-[#d4ad61]/40 bg-gradient-to-r from-[#f7d989]/80 to-[#d6a948]/70 px-3 py-2 text-xs font-bold text-[#006d65] shadow-[0_10px_24px_rgba(183,122,37,0.16)] hover:from-[#f2d28a] hover:to-[#c99631]">
          {isOpen ? "Sembunyikan" : actionLabel}
          <ChevronDown
            size={14}
            className={`transition-transform ${isOpen ? "rotate-180" : ""}`}
          />
        </span>
      </button>
      {isOpen && <div className="mt-5 pt-2">{children}</div>}
    </section>
  );
}

function SummaryStrip({ metrics }: { metrics: MetricItem[] }) {
  const [isExpanded, setIsExpanded] = useState(false);
  const visibleMetrics = isExpanded ? metrics : metrics.slice(0, 3);

  return (
    <section className="rounded-2xl border border-white/10 bg-[#1a1c23]/60 px-4 py-3 shadow-xl">
      <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
        <div className="grid flex-1 grid-cols-1 gap-2 sm:grid-cols-3">
          {visibleMetrics.map((metric) => {
            const Icon = metric.icon;
            return (
              <div
                key={metric.label}
                className="flex min-h-16 items-center justify-between gap-3 rounded-xl bg-black/25 px-4 py-3"
              >
                <div className="min-w-0">
                  <p className="truncate text-xs font-semibold text-slate-500">
                    {metric.label}
                  </p>
                  <p className="mt-0.5 text-xl font-black text-white">
                    {metric.value}
                  </p>
                </div>
                <Icon className={`${metric.tone} shrink-0`} size={18} />
              </div>
            );
          })}
        </div>
        {metrics.length > 3 && (
          <button
            type="button"
            onClick={() => setIsExpanded((current) => !current)}
            aria-expanded={isExpanded}
            className="inline-flex items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs font-bold text-slate-300 hover:bg-white/10"
          >
            {isExpanded ? "Sembunyikan" : "Lihat Lebih Banyak"}
            <ChevronDown
              size={14}
              className={`transition-transform ${isExpanded ? "rotate-180" : ""}`}
            />
          </button>
        )}
      </div>
    </section>
  );
}

function AdminViewSelector({
  activeTab,
  accessibleTabKeys,
  onSelect,
}: {
  activeTab: TabKey | undefined;
  accessibleTabKeys: TabKey[];
  onSelect: (tab: TabKey) => void;
}) {
  return (
    <section className="mb-6 rounded-2xl border border-white/10 bg-[#1a1c23]/60 p-5 shadow-xl">
      <div className="mb-5 flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
        <p className="text-sm font-bold text-white">Tinjau Berdasarkan Bagian</p>
        <span className="inline-flex w-fit items-center gap-2 rounded-xl border border-teal-500/30 bg-teal-500/10 px-3 py-2 text-xs font-bold text-teal-200">
          <ShieldCheck size={14} />
          Anda masuk sebagai Admin
        </span>
      </div>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        {adminViewGroups.map((group) => (
          <div
            key={group.title}
            className="rounded-xl border border-white/10 bg-black/25 p-5"
          >
            <p className="mb-4 text-xs font-bold uppercase tracking-wider text-slate-500">
              {group.title}
            </p>
            <div className="flex flex-wrap gap-3">
              {group.tabs
                .filter((key) => accessibleTabKeys.includes(key))
                .map((key) => {
                  const tab = tabs.find((item) => item.key === key);
                  if (!tab) return null;

                  return (
                    <button
                      key={key}
                      type="button"
                      onClick={() => onSelect(key)}
                      className={`rounded-xl border px-3 py-2 text-xs font-bold transition-colors ${
                        activeTab === key
                          ? "border-teal-500/40 bg-teal-500/20 text-teal-100"
                          : "border-white/10 bg-white/5 text-slate-300 hover:bg-white/10 hover:text-white"
                      }`}
                    >
                      {key === "overview" ? "Admin" : tab.label}
                    </button>
                  );
                })}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function AdminHealthPanel({
  batches,
  comparison,
  error,
  isLoading,
  onSelectBatch,
}: {
  batches: OffApiBatch[];
  comparison: ReturnType<typeof computeClaimComparison>;
  error: string;
  isLoading: boolean;
  onSelectBatch: (batch: OffApiBatch) => void;
}) {
  const activeBatches = batches.filter((batch) => !isCompletedOrCancelledBatch(batch));
  const queueStats = buildAdminQueueStats(batches);
  const bottleneck = [...queueStats].sort((a, b) => b.count - a.count)[0];
  const overdueBatches = batches.filter(isOverdueBatch);
  const agingBatches = activeBatches.filter((batch) => batchAgeDays(batch) >= 7);
  const paidIncompleteBatches = batches.filter(isFinalClaimActionableBatch);
  const returnedBatches = batches.filter(isReturnedOrCorrectionBatch);
  const problemBatches = Array.from(
    new Map(
      [
        ...overdueBatches,
        ...agingBatches,
        ...paidIncompleteBatches,
        ...returnedBatches,
      ].map((batch) => [batch.id, batch]),
    ).values(),
  )
    .sort((a, b) => batchTimestamp(b) - batchTimestamp(a))
    .slice(0, 6);
  const recentBatches = [...batches]
    .sort((a, b) => batchTimestamp(b) - batchTimestamp(a))
    .slice(0, 5);
  const attentionItems = [
    error
      ? {
          title: "Data gagal dimuat",
          desc: error,
          count: "!",
          tone: "text-rose-300",
          border: "border-rose-500/30 bg-rose-500/10",
        }
      : null,
    overdueBatches.length > 0
      ? {
          title: "Melewati Batas Waktu",
          desc: "Deadline klaim sudah lewat.",
          count: String(overdueBatches.length),
          tone: "text-rose-300",
          border: "border-rose-500/30 bg-rose-500/10",
        }
      : null,
    agingBatches.length > 0
      ? {
          title: "Pengajuan Terlalu Lama Diproses",
          desc: "Aktif lebih dari 7 hari sejak update terakhir.",
          count: String(agingBatches.length),
          tone: "text-amber-300",
          border: "border-amber-500/30 bg-amber-500/10",
        }
      : null,
    paidIncompleteBatches.length > 0
      ? {
          title: "Sudah bayar belum final",
          desc: "Menunggu verifikasi final Klaim.",
          count: String(paidIncompleteBatches.length),
          tone: "text-sky-300",
          border: "border-sky-500/30 bg-sky-500/10",
        }
      : null,
    comparison.submittedCount > 0 && !comparison.isMatched
      ? {
          title: "Ketidaksesuaian pengajuan & klaim",
          desc: `Selisih Rp ${Math.abs(comparison.difference).toLocaleString("id-ID")}.`,
          count: String(comparison.submittedCount),
          tone: "text-amber-300",
          border: "border-amber-500/30 bg-amber-500/10",
        }
      : null,
    bottleneck && bottleneck.count > 0
      ? {
          title: "Bottleneck terbesar",
          desc: bottleneck.label,
          count: String(bottleneck.count),
          tone: "text-teal-300",
          border: "border-teal-500/30 bg-teal-500/10",
        }
      : null,
  ].filter(
    (
      item,
    ): item is {
      title: string;
      desc: string;
      count: string;
      tone: string;
      border: string;
    } => Boolean(item),
  );

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-3 xl:grid-cols-[1.1fr_1fr]">
        <section className="rounded-2xl border border-white/10 bg-[#1a1c23]/60 p-5 shadow-xl">
          <div className="mb-4 flex items-start justify-between gap-3">
            <div>
              <h2 className="text-lg font-bold text-white">Admin Overview</h2>
              <p className="mt-1 text-sm text-slate-400">
                Cockpit health system untuk memantau proses aktif sebelum masuk ke role tertentu.
              </p>
            </div>
            {isLoading && (
              <span className="rounded-xl border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-bold text-slate-300">
                Memuat
              </span>
            )}
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="rounded-xl border border-white/10 bg-black/25 p-4">
              <p className="text-xs font-semibold text-slate-500">
                Total Pengajuan Aktif
              </p>
              <p className="mt-2 text-3xl font-black text-white">
                {activeBatches.length}
              </p>
            </div>
            <div className="rounded-xl border border-white/10 bg-black/25 p-4">
              <p className="text-xs font-semibold text-slate-500">
                Bottleneck Terbesar
              </p>
              <p className="mt-2 text-lg font-black text-white">
                {bottleneck?.count ? bottleneck.label : "Tidak ada"}
              </p>
              <p className="mt-1 text-xs text-slate-500">
                {bottleneck?.count || 0} pengajuan
              </p>
            </div>
            <div className="rounded-xl border border-white/10 bg-black/25 p-4">
              <p className="text-xs font-semibold text-slate-500">
                SLA / Overdue
              </p>
              <p className="mt-2 text-3xl font-black text-white">
                {overdueBatches.length}
              </p>
              <p className="mt-1 text-xs text-slate-500">
                {agingBatches.length} tertahan 7+ hari
              </p>
            </div>
          </div>
        </section>

        <section className="rounded-2xl border border-white/10 bg-[#1a1c23]/60 p-5 shadow-xl">
          <h2 className="text-lg font-bold text-white">Butuh Perhatian</h2>
          {attentionItems.length === 0 ? (
            <div className="mt-4 rounded-xl border border-emerald-500/20 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-200">
              Tidak ada masalah prioritas pada data yang sedang dimuat.
            </div>
          ) : (
            <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
              {attentionItems.map((item) => (
                <div
                  key={item.title}
                  className={`rounded-xl border px-4 py-3 ${item.border}`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm font-bold text-white">
                        {item.title}
                      </p>
                      <p className="mt-1 text-xs text-slate-300">
                        {item.desc}
                      </p>
                    </div>
                    <span className={`font-mono text-xl font-black ${item.tone}`}>
                      {item.count}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      <section className="rounded-2xl border border-white/10 bg-[#1a1c23]/60 p-5 shadow-xl">
        <h2 className="text-lg font-bold text-white">Status Per Divisi</h2>
        <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2 2xl:grid-cols-6">
          {queueStats.map((queue) => {
            const Icon = queue.icon;

            return (
              <div
                key={queue.key}
                className="rounded-xl border border-white/10 bg-black/25 p-4"
              >
                <div className="flex items-start justify-between gap-3">
                  <Icon className="text-teal-300" size={18} />
                  <span className="font-mono text-xl font-black text-white">
                    {queue.count}
                  </span>
                </div>
                <p className="mt-3 text-sm font-bold text-white">
                  {queue.label}
                </p>
                <p className="mt-1 text-xs text-slate-500">{queue.desc}</p>
              </div>
            );
          })}
        </div>
      </section>

      {problemBatches.length > 0 && (
        <section className="rounded-2xl border border-white/10 bg-[#1a1c23]/60 p-5 shadow-xl">
          <h2 className="text-lg font-bold text-white">Pengajuan Bermasalah</h2>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-sm text-left">
              <thead className="border-b border-white/10 text-xs uppercase tracking-wider text-slate-500">
                <tr>
                  <th className="px-3 py-3 font-bold">No Pengajuan</th>
                  <th className="px-3 py-3 font-bold">Principle</th>
                  <th className="px-3 py-3 font-bold">No Klaim</th>
                  <th className="px-3 py-3 font-bold">Status Saat Ini</th>
                  <th className="px-3 py-3 font-bold">Keterangan</th>
                  <th className="px-3 py-3 font-bold">Aksi</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {problemBatches.map((batch) => (
                  <tr key={batch.id} className="hover:bg-white/[0.03]">
                    <td className="px-3 py-3">
                      <p className="font-bold text-white">{batch.noPengajuan}</p>
                      <p className="mt-1 text-xs text-slate-500">{batch.supervisorName || "-"}</p>
                    </td>
                    <td className="px-3 py-3 text-sm text-slate-300">
                      {batch.principleName || "-"}
                    </td>
                    <td className="px-3 py-3 text-sm text-slate-300 font-mono">
                      {batch.noClaim || "-"}
                    </td>
                    <td className="px-3 py-3">
                      <span className={`inline-flex rounded-md border px-2 py-1 text-xs font-bold ${statusClass(batch.status)}`}>
                        {displayStatusLabel(batch.status)}
                      </span>
                    </td>
                    <td className="px-3 py-3">
                      <span className="text-xs font-bold text-amber-300">
                        {isOverdueBatch(batch)
                          ? "Overdue"
                          : batchAgeDays(batch) >= 7
                            ? `${batchAgeDays(batch)} hari`
                            : "Perlu cek"}
                      </span>
                    </td>
                    <td className="px-3 py-3">
                      <button
                        type="button"
                        onClick={() => onSelectBatch(batch)}
                        className="inline-flex items-center gap-1 rounded-lg border border-teal-500/30 bg-teal-500/10 px-3 py-1.5 text-xs font-bold text-teal-200 hover:bg-teal-500/20"
                      >
                        Detail
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {recentBatches.length > 0 && (
        <section className="rounded-2xl border border-white/10 bg-[#1a1c23]/60 p-5 shadow-xl">
          <h2 className="text-lg font-bold text-white">Aktivitas Terakhir</h2>
          <div className="mt-4 grid grid-cols-1 gap-2 lg:grid-cols-5">
            {recentBatches.map((batch) => (
              <button
                key={batch.id}
                type="button"
                onClick={() => onSelectBatch(batch)}
                className="rounded-xl border border-white/10 bg-black/25 p-3 text-left hover:bg-white/5"
              >
                <p className="truncate text-sm font-bold text-white">
                  {batch.noPengajuan}
                </p>
                <p className="mt-1 truncate text-xs text-slate-500">
                  {displayStatusLabel(batch.status)}
                </p>
                <p className="mt-2 text-xs text-slate-400">
                  {batch.updatedAt || batch.createdAt
                    ? formatDateDisplay(
                        String(batch.updatedAt || batch.createdAt).slice(0, 10),
                      )
                    : "-"}
                </p>
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function WorkflowStepper() {
  return (
    <div>
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-8 gap-3">
        {workflowSteps.map((step, index) => (
          <div
            key={step}
            className="relative rounded-xl border border-white/10 bg-black/30 p-4"
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
  return (
    <CompactSubmissionTable
      batches={batches}
      selectedBatchId={selectedBatchId}
      onSelect={onSelect}
      actionLabel={() => "Lihat Detail"}
      emptyText="Belum ada pengajuan pada filter ini."
    />
  );
}

function BatchOverviewActionTable({
  batches,
  selectedBatchId,
  onSelect,
  actionLabel,
  emptyText = "Tidak ada data yang sesuai dengan pencarian atau filter yang dipilih.",
}: {
  batches: OffApiBatch[];
  selectedBatchId?: string | null;
  onSelect: (batch: OffApiBatch) => void;
  actionLabel: (batch: OffApiBatch) => string;
  emptyText?: string;
}) {
  return (
    <CompactSubmissionTable
      batches={batches}
      selectedBatchId={selectedBatchId}
      onSelect={onSelect}
      actionLabel={actionLabel}
      emptyText={emptyText}
    />
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
      <div className="overflow-x-auto rounded-xl border border-white/10">
        <table className="w-full min-w-[1050px] text-left text-sm">
          <thead className="border-b border-white/10 bg-black/50 text-xs uppercase tracking-wider text-slate-500">
            <tr>
              {[
                "Nomor Pengajuan",
                "Principal",
                "Kode Principal",
                "Catatan Klaim",
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

function SupervisorDashboard({
  offRole,
  supervisorDisplayName = "",
  sessionUserId = "",
}: OffDashboardProps) {
  const canSubmitSupervisor = canPerformOffAction(offRole, "submit_batch");
  const canEditSupervisor = canPerformOffAction(offRole, "edit_returned_batch");
  const resolvedSupervisorDisplayName = supervisorDisplayName.trim();
  const [supervisorMenu, setSupervisorMenu] = useState<
    "pengajuan" | "monitoring" | "diskon" | "selisih"
  >("pengajuan");
  // #17 Gap b: batch yang dipilih untuk dilihat refund-nya di view Selisih.
  const [selisihBatchId, setSelisihBatchId] = useState("");
  const [supervisorName, setSupervisorName] = useState(
    () => resolvedSupervisorDisplayName,
  );
  const [batchPrinciple, setBatchPrinciple] = useState("RECKITT BENCKISER, PT");
  const [gelombangInput, setGelombangInput] = useState("001");
  const [bulanInput, setBulanInput] = useState(() => String(new Date().getMonth() + 1).padStart(2, "0"));
  const [tahunInput, setTahunInput] = useState(() => String(new Date().getFullYear()));
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
  // #6: SPV hanya bisa cetak PDF Surat setelah pengajuan di-approve CLAIM.
  const [editingClaimStatus, setEditingClaimStatus] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [rows, setRows] = useState<SupervisorBulkRow[]>(initialBulkRows);
  const [allSupervisorBatches, setAllSupervisorBatches] = useState<
    OffApiBatch[]
  >([]);
  const [monitoringSearch, setMonitoringSearch] = useState("");
  const [monitoringPrincipalFilter, setMonitoringPrincipalFilter] = useState("");
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
  const [autoNoPengajuan, setAutoNoPengajuan] = useState("");
  const [autoNumberStatus, setAutoNumberStatus] = useState("");
  const [editingOriginalNumber, setEditingOriginalNumber] = useState<{
    noPengajuan: string;
    gelombang: string;
    principleCode: string;
    bulan: string;
    tahun: string;
  } | null>(null);
  const gelombang = gelombangInput.padStart(3, "0");
  const bulan = bulanInput.padStart(2, "0");
  const tahun = tahunInput;
  const batchCode = getPrincipleCode(batchPrinciple);
  const generatedNo = autoNoPengajuan || `${gelombang}/${batchCode}/${bulan}/${tahun}`;

  useEffect(() => {
    if (!resolvedSupervisorDisplayName) return;
    setSupervisorName((current) => {
      const normalizedCurrent = current.trim();
      if (!normalizedCurrent || normalizedCurrent === "Supervisor Area 1") {
        return resolvedSupervisorDisplayName;
      }
      return current;
    });
  }, [resolvedSupervisorDisplayName]);

  useEffect(() => {
    if (!batchCode || !bulan || !tahun) return;
    if (
      editingOriginalNumber &&
      editingOriginalNumber.principleCode === batchCode &&
      editingOriginalNumber.bulan === bulan &&
      editingOriginalNumber.tahun === tahun
    ) {
      setGelombangInput(editingOriginalNumber.gelombang || getGelombangFromNoPengajuan(editingOriginalNumber.noPengajuan) || "001");
      setAutoNoPengajuan(editingOriginalNumber.noPengajuan);
      setAutoNumberStatus("");
      return;
    }

    const controller = new AbortController();
    setAutoNumberStatus("Memuat No Pengajuan otomatis...");
    const params = new URLSearchParams({
      principleCode: batchCode,
      bulan,
      tahun,
      source: "supervisor",
    });
    if (editingBatchId) params.set("excludeBatchId", editingBatchId);
    fetch(`/api/off-program-control/batches/next-number?${params.toString()}`, {
      credentials: "include",
      signal: controller.signal,
    })
      .then(parseJsonResponse)
      .then((data) => {
        if (!data.ok) throw new Error(String(data.error || "Gagal memuat No Pengajuan otomatis."));
        const nextGelombang = String(data.gelombang || "001");
        const nextNoPengajuan = String(data.noPengajuan || "");
        setGelombangInput(nextGelombang);
        setAutoNoPengajuan(nextNoPengajuan || `${nextGelombang}/${batchCode}/${bulan}/${tahun}`);
        setAutoNumberStatus("");
      })
      .catch((error) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setAutoNumberStatus(error instanceof Error ? error.message : "Gagal memuat No Pengajuan otomatis.");
      });
    return () => controller.abort();
  }, [batchCode, bulan, tahun, editingBatchId, editingOriginalNumber]);

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
      const rawBatches = Array.isArray(data.batches)
        ? (data.batches as OffApiBatch[])
        : [];
      // Guard defensif: backend sudah memfilter, tapi pastikan SPV hanya melihat
      // pengajuan miliknya walau respons API berubah. Role lain tidak difilter.
      const allBatches =
        offRole === "supervisor" && sessionUserId
          ? rawBatches.filter((batch) => batch.createdBy === sessionUserId)
          : rawBatches;
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
      // Fallback: gunakan dummy data dari draf jika API tidak tersedia
      const dummyReturned = dummyBatches.filter(
        (batch) => batch.status === "Draft" || batch.status === "Returned by SM" || batch.status === "Returned by Claim"
      );
      setAllSupervisorBatches(dummyBatches);
      setReturnedBatches(dummyReturned);
      setReturnedSummaries(Object.fromEntries(
        dummyReturned.map((batch) => [batch.id, { rowCount: batch.summary?.totalRows || 2, totalNominal: batch.summary?.totalNominal || 0 }])
      ));
      setReturnedStatus("");
    }
  };

  useEffect(() => {
    loadReturnedBatches();
    // #7: Auto-refresh list-only (fokus tab + interval) tanpa menyentuh form input SPV.
    let active = true;
    const refreshList = async () => {
      try {
        const response = await fetch("/api/off-program-control/batches", {
          credentials: "include",
        });
        const data = await parseJsonResponse(response);
        if (!active || !response.ok || !data.ok) return;
        const allBatches = Array.isArray(data.batches)
          ? (data.batches as OffApiBatch[])
          : [];
        setAllSupervisorBatches(allBatches);
        setReturnedBatches(
          allBatches.filter(
            (batch) =>
              batch.status === "Draft" ||
              batch.status === "Returned by SM" ||
              batch.smStatus === "Returned" ||
              batch.status === "Returned by Claim" ||
              batch.claimStatus === "Returned",
          ),
        );
      } catch {
        /* abaikan error refresh latar */
      }
    };
    const onFocus = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      void refreshList();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    const interval = window.setInterval(() => void refreshList(), 45000);
    return () => {
      active = false;
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
      window.clearInterval(interval);
    };
  }, []);

  const updateBatchPrinciple = (nextValue: string) => {
    setBatchPrinciple(nextValue);
  };

  const openReturnedBatch = async (batch: OffApiBatch) => {
    setReturnedStatus("Memuat batch revisi...");
    setSubmitStatus("");
    setPdfUrl(batch.pdfUrl || "");
    setEditingClaimStatus(String(batch.claimStatus || ""));
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
      // #6: status claim dari detail menentukan apakah PDF boleh dicetak SPV.
      setEditingClaimStatus(String(detailBatch.claimStatus || ""));
      // Pindah ke panel input/Setup agar aksi (termasuk cetak PDF ter-gate) terlihat.
      setSupervisorMenu("pengajuan");
      setReturnNote(detailBatch.claimNote || detailBatch.smNote || "");
      setSupervisorName(
        detailBatch.supervisorName || resolvedSupervisorDisplayName || "Supervisor",
      );
      setGelombangInput(detailBatch.gelombang || "001");
      setAutoNoPengajuan(detailBatch.noPengajuan || "");
      setEditingOriginalNumber({
        noPengajuan: detailBatch.noPengajuan || "",
        gelombang: detailBatch.gelombang || getGelombangFromNoPengajuan(detailBatch.noPengajuan || "") || "001",
        principleCode: detailBatch.principleCode || "",
        bulan: detailBatch.bulan || "",
        tahun: detailBatch.tahun || "",
      });
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
        row.id === rowId
          ? {
              ...row,
              [field]: value,
              ...(field === "caraBayar" && normalizeUiPaymentMethod(String(value)) === "Tunai"
                ? { noRekening: "" }
                : {}),
            }
          : row,
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

  const findMissingTransferRekeningRowNumber = () => {
    const index = rows.findIndex(
      (row) =>
        normalizeUiPaymentMethod(row.caraBayar) === "Transfer" &&
        !row.noRekening.trim(),
    );
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
      noRekening:
        normalizeUiPaymentMethod(row.caraBayar) === "Transfer"
          ? row.noRekening
          : "",
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
    const missingRekeningRow = findMissingTransferRekeningRowNumber();
    if (missingRekeningRow) {
      setSubmitStatus(
        `No Rekening pada baris ${missingRekeningRow} wajib diisi karena Cara Bayar adalah Transfer.`,
      );
      return;
    }
    setIsSubmitting(true);
    setSubmitStatus("Menyimpan draf batch...");
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
      const savedNoPengajuan = String(
        data.noPengajuan ||
          (data.batch as OffApiBatch | undefined)?.noPengajuan ||
          generatedNo,
      );
      const savedGelombang = String(
        data.gelombang ||
          (data.batch as OffApiBatch | undefined)?.gelombang ||
          getGelombangFromNoPengajuan(savedNoPengajuan) ||
          gelombang,
      );
      setEditingBatchId(savedBatchId);
      setGelombangInput(savedGelombang);
      setAutoNoPengajuan(savedNoPengajuan);
      setEditingOriginalNumber({
        noPengajuan: savedNoPengajuan,
        gelombang: savedGelombang,
        principleCode: batchCode,
        bulan,
        tahun,
      });
      setEditingLocked(false);
      setSubmitStatus(
        `Draf ${savedNoPengajuan} berhasil disimpan.`,
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
    const missingRekeningRow = findMissingTransferRekeningRowNumber();
    if (missingRekeningRow) {
      setSubmitStatus(
        `No Rekening pada baris ${missingRekeningRow} wajib diisi karena Cara Bayar adalah Transfer.`,
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
      const savedNoPengajuan = String(
        saveData.noPengajuan ||
          (saveData.batch as OffApiBatch | undefined)?.noPengajuan ||
          generatedNo,
      );
      const savedGelombang = String(
        saveData.gelombang ||
          (saveData.batch as OffApiBatch | undefined)?.gelombang ||
          getGelombangFromNoPengajuan(savedNoPengajuan) ||
          gelombang,
      );
      setGelombangInput(savedGelombang);
      setAutoNoPengajuan(savedNoPengajuan);
      setEditingOriginalNumber({
        noPengajuan: savedNoPengajuan,
        gelombang: savedGelombang,
        principleCode: batchCode,
        bulan,
        tahun,
      });

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
      // #14: reset lock state agar form tidak abu-abu setelah submit berhasil.
      setEditingLocked(false);
      setReturnNote("");
      // #6: Batch baru disubmit belum di-approve CLAIM → cetak PDF belum boleh.
      setEditingClaimStatus("");
      await loadReturnedBatches();
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
  const supervisorPrincipalOptions = getPrincipalOptions(allSupervisorBatches);

  const filteredSupervisorMonitoringBatches = filterBatchesByMainStatus(
    filterBatchesByPrincipal(
      filterBatchesByPeriod(
        filterBatchesBySearch(allSupervisorBatches, monitoringSearch),
        monitoringPeriod,
      ),
      monitoringPrincipalFilter,
    ),
    monitoringStatusFilter,
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap gap-2 rounded-2xl border border-white/10 bg-[#1a1c23]/60 p-2">
        {/* #17 Gap b: tambah menu "Data Selisih" untuk SPV submit refund. */}
        {(
          [
            ["pengajuan", "Pengajuan"],
            ["monitoring", "Monitoring Semua Status"],
            ["diskon", "Dashboard Diskon SPV"],
            ["selisih", "Data Selisih"],
          ] as [string, string][]
        ).map(([key, label]) => {
          const selisihCount =
            key === "selisih"
              ? allSupervisorBatches.filter(
                  (b) =>
                    b.refundStatus === "Pending Refund" ||
                    b.refundStatus === "Partially Refunded",
                ).length
              : 0;
          return (
            <button
              key={key}
              onClick={() =>
                setSupervisorMenu(key as "pengajuan" | "monitoring" | "diskon" | "selisih")
              }
              className={`inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-bold transition-colors ${
                supervisorMenu === key
                  ? "border border-teal-500/30 bg-teal-500/20 text-teal-200"
                  : "border border-transparent text-slate-400 hover:bg-white/5 hover:text-white"
              }`}
            >
              {label}
              {key === "selisih" && selisihCount > 0 && (
                <span className="inline-flex h-5 min-w-[20px] items-center justify-center rounded-full bg-orange-500 px-1.5 text-[10px] font-bold text-white">
                  {selisihCount}
                </span>
              )}
            </button>
          );
        })}
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
          <div className="mb-6">
            <CompactFilterToolbar
              searchValue={monitoringSearch}
              onSearchChange={setMonitoringSearch}
              placeholder="Ketik nama principal, nomor, atau status pengajuan"
              activeFilters={buildBatchFilterChips({
                principalFilter: monitoringPrincipalFilter,
                principalOptions: supervisorPrincipalOptions,
                statusFilter: monitoringStatusFilter,
                statusOptions: supervisorMonitoringStatusOptions,
                period: monitoringPeriod,
              })}
              onReset={() => {
                setMonitoringSearch("");
                setMonitoringPrincipalFilter("");
                setMonitoringStatusFilter("");
                setMonitoringPeriod(createEmptyPeriodFilter());
              }}
            >
              <div className="grid grid-cols-1 gap-3 xl:grid-cols-[260px_260px_1fr]">
                <PrincipalFilterSelect
                  value={monitoringPrincipalFilter}
                  onChange={setMonitoringPrincipalFilter}
                  options={supervisorPrincipalOptions}
                />
                <StatusFilterSelect
                  value={monitoringStatusFilter}
                  onChange={setMonitoringStatusFilter}
                  options={supervisorMonitoringStatusOptions}
                />
                <PeriodFilter
                  value={monitoringPeriod}
                  onChange={setMonitoringPeriod}
                />
              </div>
            </CompactFilterToolbar>
          </div>

          {filteredSupervisorMonitoringBatches.length === 0 ? (
            <EmptyState
              onAction={() => {
                setMonitoringSearch("");
                setMonitoringPrincipalFilter("");
                setMonitoringStatusFilter("");
                setMonitoringPeriod(createEmptyPeriodFilter());
              }}
              actionLabel="Reset Filter"
            />
          ) : (
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
          )}
        </Panel>
      )}

      {/* #17 Gap b: Data Selisih SPV — batch dengan kelebihan dana perlu dikembalikan. */}
      {supervisorMenu === "selisih" && (() => {
        const selisihBatches = allSupervisorBatches.filter(
          (b) =>
            b.refundStatus === "Pending Refund" ||
            b.refundStatus === "Partially Refunded",
        );
        const selectedSelisihBatch = selisihBatches.find((b) => b.id === selisihBatchId) || null;
        return (
          <div className="space-y-6">
            <Panel title="Data Selisih — Perlu Pengembalian Dana" icon={Wallet}>
              <InfoNote>
                Batch di bawah ini memiliki selisih antara nilai pembayaran Keuangan dan realisasi
                klaim. Supervisor wajib mengajukan pengembalian dana agar alur batch dapat ditutup.
              </InfoNote>
              {selisihBatches.length === 0 ? (
                <div className="mt-4 rounded-xl border border-white/10 bg-black/30 px-4 py-6 text-center text-sm text-slate-400">
                  Tidak ada batch dengan selisih yang perlu dikembalikan.
                </div>
              ) : (
                <div className="mt-4 divide-y divide-white/5 rounded-xl border border-white/10 overflow-hidden">
                  {selisihBatches.map((batch) => {
                    const isSelected = batch.id === selisihBatchId;
                    const overpaid = Number(batch.refundAmount || 0);
                    return (
                      <div
                        key={batch.id}
                        className={`flex flex-col gap-3 px-4 py-4 transition-colors cursor-pointer md:flex-row md:items-center md:justify-between ${isSelected ? "bg-orange-500/10" : "hover:bg-white/[0.03]"}`}
                        onClick={() => setSelisihBatchId(isSelected ? "" : batch.id)}
                      >
                        <div className="space-y-1">
                          <p className="font-mono text-sm font-bold text-white">
                            {batch.noPengajuan}
                          </p>
                          <p className="text-xs text-slate-400">
                            {batch.principleName} ({batch.principleCode}) — {batch.bulan}/{batch.tahun}
                          </p>
                          <span className={`inline-flex rounded-md border px-2 py-0.5 text-xs font-bold ${statusClass(batch.refundStatus || batch.status)}`}>
                            {displayStatusLabel(batch.refundStatus || batch.status)}
                          </span>
                        </div>
                        <div className="flex flex-col items-end gap-1">
                          <p className="text-xs text-slate-400 font-semibold">Selisih Perlu Kembali</p>
                          <p className="font-mono text-base font-bold text-orange-300">
                            Rp {overpaid.toLocaleString("id-ID")}
                          </p>
                          <button
                            type="button"
                            className={`mt-1 rounded-lg border px-3 py-1 text-xs font-bold transition-colors ${isSelected ? "border-orange-500 bg-orange-600 text-white" : "border-orange-500/30 bg-orange-500/10 text-orange-300 hover:bg-orange-500/20"}`}
                          >
                            {isSelected ? "Tutup" : "Ajukan Refund"}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </Panel>
            {selectedSelisihBatch && (
              <RefundPanel
                batchId={selectedSelisihBatch.id}
                batch={selectedSelisihBatch}
                offRole={offRole}
                onRefundUpdated={() => {
                  void loadReturnedBatches();
                }}
              />
            )}
          </div>
        );
      })()}

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
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
              {returnedBatches.map((batch) => {
                const summary = returnedSummaries[batch.id] || {
                  rowCount: 0,
                  totalNominal: 0,
                };
                return (
                  <div
                    key={batch.id}
                    className="rounded-xl border border-white/15 bg-[#1a1c23]/80 p-5 shadow-lg"
                  >
                    <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
                      <div className="space-y-2">
                        <p className="font-mono text-base font-bold text-white tracking-wide">
                          {batch.noPengajuan}
                        </p>
                        <p className="text-sm text-slate-200">
                          {batch.principleName}{" "}
                          <span className="font-mono text-teal-300 font-semibold">
                            ({batch.principleCode})
                          </span>
                        </p>
                        <p className="text-sm text-slate-300">
                          Baris: <span className="font-semibold text-white">{summary.rowCount}</span> | Total:{" "}
                          <span className="font-semibold text-white">
                            Rp {summary.totalNominal.toLocaleString("id-ID")}
                          </span>
                        </p>
                        <p className="text-sm text-rose-200 leading-relaxed">
                          {batch.claimNote ||
                            batch.smNote ||
                            "Tidak ada catatan pengembalian."}
                        </p>
                        <span
                          className={`inline-flex rounded-md border px-2.5 py-1 text-xs font-bold ${statusClass(batch.status)}`}
                        >
                          {displayStatusLabel(batch.status)}
                        </span>
                      </div>
                      <div className="flex flex-col gap-2 shrink-0">
                        {canEditSupervisor && (
                          <button
                            onClick={() => openReturnedBatch(batch)}
                            className="inline-flex items-center justify-center rounded-xl border border-teal-500/30 bg-teal-500/10 px-4 py-2.5 text-sm font-bold text-teal-200 hover:bg-teal-500/20"
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
                          className="inline-flex items-center justify-center rounded-xl border border-indigo-500/30 bg-indigo-500/10 px-4 py-2.5 text-sm font-bold text-indigo-200 hover:bg-indigo-500/20 disabled:cursor-not-allowed disabled:opacity-50"
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
              <Field label="Gelombang Otomatis" value={gelombang} />
              <PrincipleSelect
                label="Principle"
                value={batchPrinciple}
                onChange={(value) =>
                  !editingLocked && updateBatchPrinciple(value)
                }
              />
              <Field label="Kode Principle" value={batchCode} />
              <Field label="Bulan" value={bulanInput} />
              <Field label="Tahun" value={tahunInput} />
            </div>
            <div className="mt-4 rounded-xl border border-teal-500/20 bg-teal-500/10 px-4 py-3">
              <p className="text-xs uppercase tracking-wider text-teal-300 font-bold">
                No Pengajuan Otomatis
              </p>
              <p className="mt-1 font-mono text-2xl font-black text-white">
                {generatedNo}
              </p>
              {autoNumberStatus ? (
                <p className="mt-2 text-xs font-semibold text-teal-200">
                  {autoNumberStatus}
                </p>
              ) : null}
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

          <Panel title="Input Batch Pengajuan Supervisor" icon={FileText}>
            <div className="overflow-x-auto rounded-xl border border-white/10">
              <table className="w-full min-w-[2140px] text-sm text-left">
                <thead className="bg-[#1a1c23] text-xs uppercase tracking-wider text-slate-300 border-b border-white/15">
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
                      "No Rekening",
                      "Tipe",
                      "PPh",
                      "Deadline",
                      "Kelengkapan",
                      "Lainnya",
                      "Aksi",
                    ].map((header) => (
                      <th key={header} className="px-3 py-3.5 font-bold whitespace-nowrap">
                        {header}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/10">
                  {rows.map((row) => (
                    <tr
                      key={row.id}
                      className="hover:bg-white/[0.03] align-top"
                    >
                      <td className="px-3 py-3">
                        <input
                          readOnly
                          value={generatedNo}
                          className="w-full min-w-[170px] rounded-lg border border-[#d4ad61]/30 bg-[#f7ead0]/60 px-3 py-2 text-sm font-mono font-bold text-[#2d241b] outline-none"
                        />
                      </td>
                      <td className="px-3 py-3">
                        <input
                          readOnly
                          value={batchPrinciple}
                          className="w-full min-w-[250px] rounded-lg border border-[#d4ad61]/30 bg-[#f7ead0]/60 px-3 py-2 text-sm text-[#2d241b] outline-none"
                        />
                      </td>
                      <td className="px-3 py-3">
                        <input
                          readOnly
                          value={batchCode}
                          className="w-full min-w-[100px] rounded-lg border border-[#d4ad61]/30 bg-[#f7ead0]/60 px-3 py-2 text-sm font-mono font-bold text-[#00877b] outline-none"
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
                        <input
                          readOnly={
                            editingLocked ||
                            normalizeUiPaymentMethod(row.caraBayar) === "Tunai"
                          }
                          value={row.noRekening}
                          onChange={(event) =>
                            updateRow(row.id, "noRekening", event.target.value)
                          }
                          placeholder={
                            normalizeUiPaymentMethod(row.caraBayar) === "Transfer"
                              ? "No rekening tujuan"
                              : "-"
                          }
                          className="w-full min-w-[180px] rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-slate-200 outline-none placeholder:text-slate-600 focus:border-teal-500/50 read-only:opacity-60"
                        />
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
                className="order-3 inline-flex items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm font-bold text-slate-200 transition-colors hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Plus size={16} /> Tambah Baris
              </button>
              <button
                onClick={() => saveDraft()}
                disabled={isSubmitting || editingLocked}
                className="order-2 inline-flex items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm font-bold text-slate-200 transition-colors hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Simpan Draf Batch
              </button>
              {canSubmitSupervisor ? (
                <button
                  onClick={() => handleSubmitBatch()}
                  disabled={isSubmitting || editingLocked}
                  className="order-1 inline-flex items-center justify-center gap-2 rounded-xl border border-emerald-500 bg-emerald-600 px-4 py-2.5 text-sm font-bold text-white transition-colors hover:bg-emerald-500 disabled:opacity-50"
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
            {pdfUrl &&
              (editingClaimStatus === "Approved" ? (
                <a
                  href={pdfUrl}
                  target="_blank"
                  className="mt-3 inline-flex rounded-xl border border-teal-500/30 bg-teal-500/10 px-4 py-2 text-sm font-bold text-teal-200 hover:bg-teal-500/20"
                >
                  Unduh PDF Surat
                </a>
              ) : (
                // #6: Cetak diblokir sampai pengajuan di-approve CLAIM.
                <span className="mt-3 inline-flex rounded-xl border border-[#d4ad61]/40 bg-[#fff7e6] px-4 py-2 text-sm font-semibold text-[#5d4630]">
                  PDF Surat dapat dicetak setelah pengajuan di-approve CLAIM.
                </span>
              ))}
            {submitResult && (
              <div className="mt-4 rounded-xl border border-emerald-600/25 bg-[#fffaf0] p-4 text-xs text-[#5d4630] shadow-sm">
                <p className="mb-2 font-bold uppercase tracking-wider text-emerald-700">
                  Hasil Pengiriman
                </p>
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-2">
                  <p>
                    Batch ID:{" "}
                    <span className="font-mono font-semibold text-[#2d241b]">
                      {submitResult.batchId}
                    </span>
                  </p>
                  <p>
                    No Pengajuan:{" "}
                    <span className="font-mono font-semibold text-[#2d241b]">
                      {submitResult.noPengajuan}
                    </span>
                  </p>
                  <p>
                    Jumlah baris terkirim:{" "}
                    <span className="font-mono font-semibold text-[#2d241b]">
                      {submitResult.rowCount}
                    </span>
                  </p>
                  <p>
                    Total Nominal:{" "}
                    <span className="font-mono font-semibold text-[#2d241b]">
                      Rp {submitResult.total.toLocaleString("id-ID")}
                    </span>
                  </p>
                  <p>
                    Transfer:{" "}
                    <span className="font-mono font-semibold text-[#2d241b]">
                      Rp {submitResult.transfer.toLocaleString("id-ID")}
                    </span>
                  </p>
                  <p>
                    Tunai:{" "}
                    <span className="font-mono font-semibold text-[#2d241b]">
                      Rp {submitResult.tunai.toLocaleString("id-ID")}
                    </span>
                  </p>
                  <p>
                    PDF URL:{" "}
                    <span className="font-mono font-semibold text-emerald-800 break-all">
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
  const [smPrincipalFilter, setSmPrincipalFilter] = useState("");
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

    // #7: Auto-refresh data. `resetSelection` hanya true saat mount/awal agar
    // refresh latar (fokus tab / interval) TIDAK mereset pilihan user atau
    // memunculkan spinner. Status terbaru langsung tampil tanpa refresh manual.
    async function loadInitialData(resetSelection = false) {
      if (resetSelection) setIsLoading(true);
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
        if (resetSelection) {
          setSelectedBatch(null);
          setSelectedItems([]);
        }
      } catch (error) {
        if (!isActive) return;
        if (resetSelection) {
          setLoadError(
            error instanceof Error
              ? error.message
              : "Gagal mengambil data Sales Manager.",
          );
          setSelectedItems([]);
        }
      } finally {
        if (isActive && resetSelection) setIsLoading(false);
      }
    }

    loadInitialData(true);

    const onFocus = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      void loadInitialData(false);
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    const interval = window.setInterval(() => void loadInitialData(false), 45000);

    return () => {
      isActive = false;
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
      window.clearInterval(interval);
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
  const smPrincipalOptions = getPrincipalOptions(batches);

  const filteredSmBatches = filterBatchesByMainStatus(
    filterBatchesByPrincipal(
      filterBatchesByPeriod(filterBatchesBySearch(batches, smSearch), smPeriod),
      smPrincipalFilter,
    ),
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
          Monitoring Pengajuan
        </h2>
      </div>

      <SummaryStrip metrics={smMetrics} />

      <IncompleteDocumentsReminderPanel batches={batches} />

      <div className="space-y-6">
        <CompactFilterToolbar
          searchValue={smSearch}
          onSearchChange={setSmSearch}
          placeholder="Ketik nama principal, nomor, atau status pengajuan"
          activeFilters={buildBatchFilterChips({
            principalFilter: smPrincipalFilter,
            principalOptions: smPrincipalOptions,
            statusFilter: smStatusFilter,
            statusOptions: smStatusOptions,
            period: smPeriod,
          })}
          onReset={() => {
            setSmSearch("");
            setSmPrincipalFilter("");
            setSmStatusFilter("");
            setSmPeriod(createEmptyPeriodFilter());
          }}
        >
          <div className="grid grid-cols-1 gap-3 xl:grid-cols-[260px_260px_1fr]">
            <PrincipalFilterSelect
              value={smPrincipalFilter}
              onChange={setSmPrincipalFilter}
              options={smPrincipalOptions}
            />
            <StatusFilterSelect
              value={smStatusFilter}
              onChange={setSmStatusFilter}
              options={smStatusOptions}
            />
            <PeriodFilter value={smPeriod} onChange={setSmPeriod} />
          </div>
        </CompactFilterToolbar>

        {isLoading && (
          <p className="text-sm text-slate-400">Memuat data Sales Manager...</p>
        )}

        {filteredSmBatches.length === 0 && !isLoading ? (
          <EmptyState
            onAction={() => {
              setSmSearch("");
              setSmPrincipalFilter("");
              setSmStatusFilter("");
              setSmPeriod(createEmptyPeriodFilter());
            }}
            actionLabel="Reset Filter"
          />
        ) : (
          <BatchOverviewActionTable
            batches={filteredSmBatches}
            selectedBatchId={selectedBatch?.id}
            onSelect={selectBatch}
            actionLabel={(batch) =>
              isSmActionableBatch(batch) ? "Proses Tinjauan" : "Lihat"
            }
          />
        )}
      </div>

      {selectedBatch && (
        <div ref={smReviewDetailRef} className="space-y-6 scroll-mt-6">
          <Panel title="Tinjauan Sales Manager" icon={ShieldCheck}>
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
                label="Nomor Pengajuan"
                value={selectedBatch?.noPengajuan || "-"}
              />
              <Field
                label="Gelombang"
                value={selectedBatch?.gelombang || "-"}
              />
              <Field
                label="Principal"
                value={selectedBatch?.principleName || "-"}
              />
              <Field
                label="Kode Principal"
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
          {/* #17 Gap b: SM dapat mengajukan refund untuk batch yang memiliki selisih. */}
          {selectedBatch && (
            <RefundPanel
              batchId={selectedBatch.id}
              batch={selectedBatch}
              offRole={offRole}
              onRefundUpdated={() => void loadSalesBatches(selectedBatch?.id || undefined)}
            />
          )}
        </div>
      )}
    </div>
  );
}

function ClaimDashboard({ offRole }: OffDashboardProps) {
  const canReviewClaim = canPerformOffAction(offRole, "claim_review");
  const canFinalClaim = canPerformOffAction(offRole, "claim_final");
  const [claimView, setClaimView] = useState<
    "hub" | "after-sm" | "after-finance" | "data-claim"
  >("hub");
  // #1-3: state form input pengajuan versi CLAIM.
  const [clmRows, setClmRows] = useState<SupervisorBulkRow[]>([createEmptyBulkRow(1)]);
  const [clmPrinciple, setClmPrinciple] = useState("RECKITT BENCKISER, PT");
  const [clmGelombang, setClmGelombang] = useState("001");
  const [clmAutoNoPengajuan, setClmAutoNoPengajuan] = useState("");
  const [clmAutoNumberStatus, setClmAutoNumberStatus] = useState("");
  const [clmNumberRefreshKey, setClmNumberRefreshKey] = useState(0);
  const [clmBulan, setClmBulan] = useState(() => String(new Date().getMonth() + 1).padStart(2, "0"));
  const [clmTahun, setClmTahun] = useState(() => String(new Date().getFullYear()));
  const [clmSubmitStatus, setClmSubmitStatus] = useState("");
  const [clmIsSubmitting, setClmIsSubmitting] = useState(false);
  const [clmBatches, setClmBatches] = useState<OffApiBatch[]>([]);
  const [allClaimBatches, setAllClaimBatches] = useState<OffApiBatch[]>([]);
  const [claimBatches, setClaimBatches] = useState<OffApiBatch[]>([]);
  const [claimSearch, setClaimSearch] = useState("");
  const [claimPrincipalFilter, setClaimPrincipalFilter] = useState("");
  const [claimStatusFilter, setClaimStatusFilter] = useState("");
  const [claimPeriod, setClaimPeriod] = useState(createEmptyPeriodFilter());
  const [finalBatches, setFinalBatches] = useState<OffApiBatch[]>([]);
  const [finalClaimSearch, setFinalClaimSearch] = useState("");
  const [finalClaimPrincipalFilter, setFinalClaimPrincipalFilter] = useState("");
  const [finalClaimStatusFilter, setFinalClaimStatusFilter] = useState("");
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
  const router = useRouter();
  const [claimSubmittedDate, setClaimSubmittedDate] = useState("");
  const [claimDeadline, setClaimDeadline] = useState("");
  const [completenessStatus, setCompletenessStatus] = useState("Lengkap");
  const [claimNote, setClaimNote] = useState("");
  const [finalClaimNote, setFinalClaimNote] = useState("");
  // Ref ke kontainer detail/form validasi Claim — dipakai auto-scroll saat
  // tombol "Proses" diklik (pola sama dengan smReviewDetailRef di SM Dashboard).
  const claimDetailRef = useRef<HTMLDivElement | null>(null);
  // Ref ke kontainer detail/form Final Claim (view "Validasi Setelah Keuangan").
  const finalDetailRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const clmCode = getPrincipleCode(clmPrinciple);
    const clmBulanPad = clmBulan.padStart(2, "0");
    if (!clmCode || !clmBulanPad || !clmTahun) return;
    const controller = new AbortController();
    setClmAutoNumberStatus("Memuat No Pengajuan CLM otomatis...");
    const params = new URLSearchParams({
      principleCode: clmCode,
      bulan: clmBulanPad,
      tahun: clmTahun,
      source: "claim",
    });
    fetch(`/api/off-program-control/batches/next-number?${params.toString()}`, {
      credentials: "include",
      signal: controller.signal,
    })
      .then(parseJsonResponse)
      .then((data) => {
        if (!data.ok) throw new Error(String(data.error || "Gagal memuat No Pengajuan CLM otomatis."));
        const nextGelombang = String(data.gelombang || "001");
        const nextNoPengajuan = String(data.noPengajuan || "");
        setClmGelombang(nextGelombang);
        setClmAutoNoPengajuan(nextNoPengajuan || `${nextGelombang}/CLM/${clmCode}/${clmBulanPad}/${clmTahun}`);
        setClmAutoNumberStatus("");
      })
      .catch((error) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setClmAutoNumberStatus(error instanceof Error ? error.message : "Gagal memuat No Pengajuan CLM otomatis.");
      });
    return () => controller.abort();
  }, [clmPrinciple, clmBulan, clmTahun, clmNumberRefreshKey]);
  // #17 Gap a: nilai yang bisa di-claim (nilai fix) — default = paidAmount.
  const [finalVerifiedAmount, setFinalVerifiedAmount] = useState("");
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
    // #12: reset status kelengkapan ke default "Lengkap" saat batch baru dibuka,
    // agar nilai lama dari batch sebelumnya tidak tertinggal di form.
    setCompletenessStatus("Lengkap");
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
    // #17 Gap a: isi nilai fix dengan verifiedAmount yang ada, atau kosong (default = paidAmount di payload).
    setFinalVerifiedAmount(
      detailBatch?.verifiedAmount != null ? String(detailBatch.verifiedAmount) : "",
    );
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
    // #7: Auto-refresh list-only (fokus tab + interval) tanpa mereset selection/form.
    let active = true;
    const refreshList = async () => {
      try {
        const response = await fetch("/api/off-program-control/batches", {
          credentials: "include",
        });
        const data = await parseJsonResponse(response);
        if (!active || !response.ok || !data.ok) return;
        const rows = Array.isArray(data.batches)
          ? (data.batches as OffApiBatch[])
          : [];
        setAllClaimBatches(rows);
        setClaimBatches(rows.filter(isClaimQueueBatch));
        setFinalBatches(rows.filter(isFinalQueueBatch));
      } catch {
        /* abaikan error refresh latar */
      }
    };
    const onFocus = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      void refreshList();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    const interval = window.setInterval(() => void refreshList(), 45000);
    return () => {
      active = false;
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
      window.clearInterval(interval);
    };
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
    } finally {
      // Setelah detail dimuat, gulir mulus ke kontainer form validasi Claim
      // supaya user tidak perlu scroll manual mencari form-nya.
      setTimeout(() => {
        claimDetailRef.current?.scrollIntoView({
          behavior: "smooth",
          block: "start",
        });
      }, 50);
    }
  };

  const openOrCreateClaimWorkflow = async (offBatchId: string) => {
    setIsActionLoading(true);
    setClaimMessage("");
    try {
      const response = await fetch(
        `/api/claim-workflow/from-off-batch/${offBatchId}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        },
      );
      const data = await parseJsonResponse(response);
      if (response.ok && data.ok) {
        const wf = data.workflow as { id: string } | undefined;
        if (wf?.id) {
          router.push(`/claim-workflow/${wf.id}?focus=no-claim`);
          return;
        }
      }
      if (
        response.status === 409 &&
        data.code === "CLAIM_WORKFLOW_ALREADY_EXISTS" &&
        data.workflow
      ) {
        const wf = data.workflow as { id: string };
        router.push(`/claim-workflow/${wf.id}?focus=no-claim`);
        return;
      }
      setClaimMessage(String(data.error || "Gagal membuka Claim Workflow."));
    } catch (error) {
      setClaimMessage(
        error instanceof Error ? error.message : "Gagal membuka Claim Workflow.",
      );
    } finally {
      setIsActionLoading(false);
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
    } finally {
      setTimeout(() => {
        finalDetailRef.current?.scrollIntoView({
          behavior: "smooth",
          block: "start",
        });
      }, 50);
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
    if (!claimNote.trim()) {
      setClaimMessage(
        "Keterangan kelengkapan wajib diisi sebelum submit validasi Claim.",
      );
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
            // #17 Gap a: kirim nilai fix jika Claim mengubahnya dari default paidAmount.
            ...(finalVerifiedAmount.trim()
              ? { verifiedAmount: Number(finalVerifiedAmount.replace(/[^\d.]/g, "")) || undefined }
              : {}),
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

  const claimPrincipalOptions = getPrincipalOptions(allClaimBatches);
  const claimStatusOptions = getBatchStatusOptions(allClaimBatches);
  const claimInitialMonitoringBatches = filterBatchesByMainStatus(
    filterBatchesByPrincipal(
      filterBatchesByPeriod(
        allClaimBatches.filter(
          (batch) =>
            isClaimInitialMonitoringBatch(batch) &&
            filterBatchesBySearch([batch], claimSearch).length > 0,
        ),
        claimPeriod,
      ),
      claimPrincipalFilter,
    ),
    claimStatusFilter,
  );

  const isFinalClaimProcessable = (batch: OffApiBatch) =>
    batch.financeStatus === "Paid" &&
    ["Waiting Claim Final Verification", "Incomplete Documents"].includes(
      batch.finalStatus,
    );

  const finalClaimMonitoringBatches = filterBatchesByMainStatus(
    filterBatchesByPrincipal(
      filterBatchesByPeriod(
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
      ),
      finalClaimPrincipalFilter,
    ),
    finalClaimStatusFilter,
  );

  if (claimView === "hub") {
    return (
      <div className="space-y-6">
        <div className="rounded-2xl border border-white/10 bg-[#1a1c23]/60 p-6 shadow-xl">
          <h2 className="text-2xl font-black text-white">Panel Klaim</h2>
        </div>
        <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
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
            <button
              onClick={() => setClaimView("after-sm")}
              className="btn-primary mt-6 text-sm"
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
            <button
              onClick={() => setClaimView("after-finance")}
              className="btn-primary mt-6 text-sm"
            >
              Buka Validasi Setelah Keuangan
            </button>
          </section>
          {/* #1-3: View ketiga Claim — pengajuan versi CLM (data dari direksi). */}
          <section className="rounded-2xl border border-indigo-500/20 bg-[#1a1c23]/60 p-6 shadow-xl">
            <div className="flex items-start justify-between gap-4">
              <div className="w-12 h-12 rounded-xl border border-indigo-500/30 bg-indigo-500/10 flex items-center justify-center">
                <FileText className="text-indigo-300" size={24} />
              </div>
              <span className="rounded-lg border border-indigo-500/30 bg-indigo-500/10 px-3 py-1 text-xs font-bold text-indigo-300">
                {allClaimBatches.filter((b) => b.createdByRole === "claim").length} pengajuan CLM
              </span>
            </div>
            <h3 className="mt-5 text-xl font-black text-white">
              Panel Data Klaim
            </h3>
            <p className="mt-2 text-sm text-slate-400">
              Input pengajuan versi CLAIM (Insentif, Diskon Reguler, Insentif Distributor, Retur) — data dari direksi.
            </p>
            <button
              onClick={() => setClaimView("data-claim")}
              className="btn-primary mt-6 text-sm"
            >
              Buka Panel Data Klaim
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
          ← Panel Klaim
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
        {/* #1-3: tab Data Claim */}
        <button
          onClick={() => setClaimView("data-claim")}
          className={`rounded-xl border px-4 py-2.5 text-sm font-bold ${claimView === "data-claim" ? "border-indigo-500 bg-indigo-600 text-white" : "border-white/10 bg-white/5 text-slate-200 hover:bg-white/10"}`}
        >
          Panel Data Klaim
        </button>
      </div>
      <div className="rounded-2xl border border-white/10 bg-[#1a1c23]/60 p-5 shadow-xl">
        <h2 className="text-xl font-black text-white">
          {claimView === "after-sm"
            ? "Validasi Setelah SM"
            : claimView === "data-claim"
              ? "Panel Data Klaim (Pengajuan Versi CLM)"
              : "Validasi Setelah Keuangan"}
        </h2>
      </div>
      <InfoNote>
        Checklist Supervisor bukan persetujuan. Klaim wajib melakukan verifikasi
        nyata sebelum menyetujui.
      </InfoNote>
      {claimView === "after-sm" && (
        <>
          <Panel title="Monitoring Validasi Setelah SM" icon={ScrollText}>
            <div className="mb-6">
              <CompactFilterToolbar
                searchValue={claimSearch}
                onSearchChange={setClaimSearch}
                placeholder="Ketik nama principal, nomor, atau status pengajuan"
                activeFilters={buildBatchFilterChips({
                  principalFilter: claimPrincipalFilter,
                  principalOptions: claimPrincipalOptions,
                  statusFilter: claimStatusFilter,
                  statusOptions: claimStatusOptions,
                  period: claimPeriod,
                })}
                onReset={() => {
                  setClaimSearch("");
                  setClaimPrincipalFilter("");
                  setClaimStatusFilter("");
                  setClaimPeriod(createEmptyPeriodFilter());
                }}
              >
                <div className="grid grid-cols-1 gap-3 xl:grid-cols-[260px_260px_1fr]">
                  <PrincipalFilterSelect
                    value={claimPrincipalFilter}
                    onChange={setClaimPrincipalFilter}
                    options={claimPrincipalOptions}
                  />
                  <StatusFilterSelect
                    value={claimStatusFilter}
                    onChange={setClaimStatusFilter}
                    options={claimStatusOptions}
                  />
                  <PeriodFilter value={claimPeriod} onChange={setClaimPeriod} />
                </div>
              </CompactFilterToolbar>
            </div>
            <div className="overflow-x-auto rounded-xl border border-white/10">
              {/* table-fixed + colgroup: kolom mengikuti lebar kontainer (w-full)
                  sehingga muat di PC normal tanpa scroll horizontal; teks panjang
                  dipotong (truncate) / dibungkus, tombol Aksi selalu terlihat. */}
              <table className="w-full min-w-[860px] table-fixed text-left text-sm">
                <colgroup>
                  <col className="w-[12%]" />
                  <col className="w-[12%]" />
                  <col className="w-[7%]" />
                  <col className="w-[9%]" />
                  <col className="w-[8%]" />
                  <col className="w-[7%]" />
                  <col className="w-[8%]" />
                  <col className="w-[7%]" />
                  <col className="w-[8%]" />
                  <col className="w-[9%]" />
                  <col className="w-[7%]" />
                  <col className="w-[6%]" />
                </colgroup>
                <thead className="bg-black/50 text-xs uppercase tracking-wider text-slate-500">
                  <tr>
                    {[
                      "Nomor Pengajuan",
                      "Principal",
                      "Kode Principal",
                      "Total Nominal",
                      "Status Klaim",
                      "Status OM",
                      "Status Keuangan",
                      "Status Final",
                      "Progress %",
                      "Catatan Klaim",
                      "Diperbarui",
                      "Aksi",
                    ].map((header) => (
                      <th key={header} className="px-2 py-3 font-bold">
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
                        <td
                          className="truncate px-2 py-3 font-mono text-slate-200"
                          title={batch.noPengajuan}
                        >
                          {batch.noPengajuan}
                        </td>
                        <td
                          className="truncate px-2 py-3 text-slate-300"
                          title={batch.principleName}
                        >
                          {batch.principleName}
                        </td>
                        <td className="truncate px-2 py-3 font-mono text-teal-300">
                          {batch.principleCode}
                        </td>
                        <td className="px-2 py-3 text-right font-mono text-emerald-300">
                          Rp{" "}
                          {Number(
                            batch.summary?.totalNominal || 0,
                          ).toLocaleString("id-ID")}
                        </td>
                        <td className="px-2 py-3 text-slate-300">
                          {displayStatusLabel(batch.claimStatus)}
                        </td>
                        <td className="px-2 py-3 text-slate-300">
                          {displayStatusLabel(batch.omStatus)}
                        </td>
                        <td className="px-2 py-3 text-slate-300">
                          {displayStatusLabel(batch.financeStatus)}
                        </td>
                        <td className="px-2 py-3 text-slate-300">
                          {displayStatusLabel(batch.finalStatus)}
                        </td>
                        <td className="px-2 py-3">
                          <ProgressBar value={computeUiBatchProgress(batch)} />
                        </td>
                        <td
                          className="truncate px-2 py-3 text-slate-400"
                          title={batch.claimNote || "-"}
                        >
                          {batch.claimNote || "-"}
                        </td>
                        <td className="px-2 py-3 text-slate-400 break-words">
                          {formatDateDisplay(batch.updatedAt)}
                        </td>
                        <td className="px-2 py-3">
                          <button
                            onClick={() => selectClaimBatch(batch)}
                            className={`w-full rounded-lg border px-2 py-1.5 text-xs font-bold ${canProcess ? "border-teal-500 bg-teal-600 text-white hover:bg-teal-500" : "border-white/10 bg-white/5 text-slate-200 hover:bg-white/10"}`}
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
            <div ref={claimDetailRef} className="scroll-mt-6 space-y-6">
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
                  {/* #12: tampilkan catatan Sales Manager agar Claim tahu keterangan SM. */}
                  {selectedBatch.smNote && (
                    <div className="md:col-span-2">
                      <span className="block text-xs font-semibold text-slate-500">
                        Catatan Sales Manager
                      </span>
                      <p className="mt-1 rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-sm text-amber-200">
                        {selectedBatch.smNote}
                      </p>
                    </div>
                  )}
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
                      <option className="bg-[#1a1c23]" value="Lengkap">
                        Lengkap
                      </option>
                      <option className="bg-[#1a1c23]" value="Kurang">
                        Kurang
                      </option>
                      <option className="bg-[#1a1c23]" value="Revisi">
                        Revisi
                      </option>
                    </select>
                  </label>
                </div>
                <div className="mt-4">
                  <label className="block">
                    <span className="text-xs text-slate-500 font-semibold">
                      Keterangan Kelengkapan Claim
                    </span>
                    <textarea
                      value={claimNote}
                      onChange={(event) => setClaimNote(event.target.value)}
                      rows={4}
                      className="mt-1 w-full resize-none rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-slate-200 outline-none placeholder:text-slate-600 focus:border-teal-500/50"
                    />
                    <p className="mt-1 text-[11px] text-slate-500">
                      Wajib diisi sebelum Setujui Klaim. Untuk koreksi, isi
                      alasan kelengkapan yang perlu diperbaiki.
                    </p>
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
                      Setujui Klaim
                    </button>
                  </div>
                ) : (
                  <div className="mt-5 rounded-xl border border-white/10 bg-black/30 px-4 py-3 text-sm text-slate-400">
                    Baca-saja atau pengajuan sudah diproses.
                  </div>
                )}
              </Panel>
            </div>
          )}
        </>
      )}

      {claimView === "after-finance" && (
        <>
          <Panel title="Monitoring Final Klaim" icon={Wallet}>
            <div className="mb-6">
              <CompactFilterToolbar
                searchValue={finalClaimSearch}
                onSearchChange={setFinalClaimSearch}
                placeholder="Ketik nama principal, nomor, atau status pengajuan"
                activeFilters={buildBatchFilterChips({
                  principalFilter: finalClaimPrincipalFilter,
                  principalOptions: claimPrincipalOptions,
                  statusFilter: finalClaimStatusFilter,
                  statusOptions: claimStatusOptions,
                  period: finalClaimPeriod,
                })}
                onReset={() => {
                  setFinalClaimSearch("");
                  setFinalClaimPrincipalFilter("");
                  setFinalClaimStatusFilter("");
                  setFinalClaimPeriod(createEmptyPeriodFilter());
                }}
              >
                <div className="grid grid-cols-1 gap-3 xl:grid-cols-[260px_260px_1fr]">
                  <PrincipalFilterSelect
                    value={finalClaimPrincipalFilter}
                    onChange={setFinalClaimPrincipalFilter}
                    options={claimPrincipalOptions}
                  />
                  <StatusFilterSelect
                    value={finalClaimStatusFilter}
                    onChange={setFinalClaimStatusFilter}
                    options={claimStatusOptions}
                  />
                  <PeriodFilter
                    value={finalClaimPeriod}
                    onChange={setFinalClaimPeriod}
                  />
                </div>
              </CompactFilterToolbar>
            </div>
            <div className="overflow-x-auto rounded-xl border border-white/10">
              {/* table-fixed + colgroup: muat di PC normal tanpa scroll horizontal. */}
              <table className="w-full min-w-[920px] table-fixed text-left text-sm">
                <colgroup>
                  <col className="w-[11%]" />
                  <col className="w-[12%]" />
                  <col className="w-[7%]" />
                  <col className="w-[9%]" />
                  <col className="w-[9%]" />
                  <col className="w-[8%]" />
                  <col className="w-[8%]" />
                  <col className="w-[11%]" />
                  <col className="w-[8%]" />
                  <col className="w-[17%]" />
                </colgroup>
                <thead className="bg-black/50 text-xs uppercase tracking-wider text-slate-500">
                  <tr>
                    {[
                      "Nomor Pengajuan",
                      "Principal",
                      "Kode Principal",
                      "Total Nominal",
                      "Status Keuangan",
                      "Status Final",
                      "Progress %",
                      "Catatan Final Klaim",
                      "Diperbarui",
                      "Aksi",
                    ].map((header) => (
                      <th key={header} className="px-2 py-3 font-bold">
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
                        <td
                          className="truncate px-2 py-3 font-mono text-slate-200"
                          title={batch.noPengajuan}
                        >
                          {batch.noPengajuan}
                        </td>
                        <td
                          className="truncate px-2 py-3 text-slate-300"
                          title={batch.principleName}
                        >
                          {batch.principleName}
                        </td>
                        <td className="truncate px-2 py-3 font-mono text-teal-300">
                          {batch.principleCode}
                        </td>
                        <td className="px-2 py-3 text-right font-mono text-emerald-300">
                          Rp{" "}
                          {Number(
                            batch.summary?.totalNominal || 0,
                          ).toLocaleString("id-ID")}
                        </td>
                        <td className="px-2 py-3 text-slate-300">
                          {displayStatusLabel(batch.financeStatus)}
                        </td>
                        <td className="px-2 py-3 text-slate-300">
                          {displayStatusLabel(batch.finalStatus)}
                        </td>
                        <td className="px-2 py-3">
                          <ProgressBar value={computeUiBatchProgress(batch)} />
                        </td>
                        <td
                          className="truncate px-2 py-3 text-slate-400"
                          title={batch.finalClaimNote || "-"}
                        >
                          {batch.finalClaimNote || "-"}
                        </td>
                        <td className="px-2 py-3 text-slate-400">
                          {formatDateDisplay(batch.updatedAt)}
                        </td>
                        <td className="px-2 py-3">
                          <div className="flex flex-wrap gap-2">
                            <button
                              onClick={() => selectFinalBatch(batch)}
                              className={`rounded-lg border px-3 py-1.5 text-xs font-bold ${canProcessFinal ? "border-teal-500 bg-teal-600 text-white hover:bg-teal-500" : "border-white/10 bg-white/5 text-slate-200 hover:bg-white/10"}`}
                            >
                              {canProcessFinal ? "Proses Final" : "Lihat"}
                            </button>
                            <button
                              onClick={() => void openOrCreateClaimWorkflow(batch.id)}
                              disabled={isActionLoading || batch.omStatus !== "Approved"}
                              className="rounded-lg border border-indigo-500 bg-indigo-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-indigo-500 disabled:opacity-40"
                              title="Buka atau buat Claim Workflow untuk batch ini (perlu OM Approved)"
                            >
                              Buka Claim Workflow
                            </button>
                          </div>
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
            <div ref={finalDetailRef} className="scroll-mt-6 space-y-6">
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
                {/* #17 Gap a: input nilai yang dapat di-claim (nilai fix).
                    Default kosong = gunakan totalPaid. Jika diisi dan berbeda,
                    selisih dihitung otomatis dan masuk alur refund. */}
                <div className="mt-4 rounded-xl border border-amber-500/20 bg-amber-500/5 p-4">
                  <p className="mb-3 text-xs font-bold text-amber-300">
                    Nilai yang Dapat Di-Claim (Nilai Fix)
                  </p>
                  <p className="mb-3 text-xs text-slate-400">
                    Isi jika nilai realisasi klaim berbeda dari total yang sudah dibayar Keuangan.
                    Kosongkan jika nilainya sama persis dengan pembayaran.
                    Jika ada selisih, akan masuk ke Data Selisih dan perlu dikembalikan oleh SPV/SM.
                  </p>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <div>
                      <label className="block">
                        <span className="text-xs text-slate-500 font-semibold">
                          Total Dibayar Keuangan
                        </span>
                        <p className="mt-1 font-mono text-base font-bold text-emerald-300">
                          Rp {paidAmount.toLocaleString("id-ID")}
                        </p>
                      </label>
                    </div>
                    <div>
                      <label className="block">
                        <span className="text-xs text-slate-500 font-semibold">
                          Nilai Fix (isi jika berbeda)
                        </span>
                        <input
                          type="number"
                          min={0}
                          value={finalVerifiedAmount}
                          onChange={(e) => setFinalVerifiedAmount(e.target.value)}
                          placeholder={`Kosong = sama dengan Rp ${paidAmount.toLocaleString("id-ID")}`}
                          className="mt-1 w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-slate-200 outline-none placeholder:text-slate-600 focus:border-amber-500/50"
                        />
                      </label>
                    </div>
                  </div>
                  {finalVerifiedAmount.trim() &&
                    !isNaN(Number(finalVerifiedAmount)) &&
                    Number(finalVerifiedAmount) !== paidAmount && (
                      <div className="mt-3 rounded-lg border border-orange-500/30 bg-orange-500/10 px-3 py-2">
                        <p className="text-xs font-bold text-orange-300">
                          Selisih:{" "}
                          Rp {Math.abs(paidAmount - Number(finalVerifiedAmount)).toLocaleString("id-ID")}
                          {paidAmount > Number(finalVerifiedAmount)
                            ? " — akan masuk Data Selisih (perlu refund)"
                            : " — nilai fix lebih besar dari pembayaran"}
                        </p>
                      </div>
                    )}
                </div>
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
                    <button
                      onClick={() =>
                        selectedFinalBatch &&
                        void openOrCreateClaimWorkflow(selectedFinalBatch.id)
                      }
                      disabled={
                        !selectedFinalBatch ||
                        isActionLoading ||
                        selectedFinalBatch.omStatus !== "Approved"
                      }
                      className="inline-flex items-center justify-center rounded-xl border border-indigo-500 bg-indigo-600 px-4 py-2.5 text-sm font-bold text-white hover:bg-indigo-500 disabled:opacity-50"
                    >
                      Buka Claim Workflow
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

      {/* #1-3: Dashboard Data Claim — pengajuan versi CLM dari direksi ke divisi Claim. */}
      {claimView === "data-claim" && (() => {
        const canCreateClm = canPerformOffAction(offRole, "create_batch");
        const canSubmitClm = canPerformOffAction(offRole, "submit_batch");
        const clmPrincipleOptions = getPrincipalOptions(allClaimBatches);
        const clmCode = getPrincipleCode(clmPrinciple);
        const clmGelombangPad = clmGelombang.padStart(3, "0");
        const clmBulanPad = clmBulan.padStart(2, "0");
        const previewNoClm = clmAutoNoPengajuan || `${clmGelombangPad}/CLM/${clmCode}/${clmBulanPad}/${clmTahun}`;
        // Daftar CLM batches milik divisi Claim (bukan SPV)
        const myCLMBatches = allClaimBatches.filter((b) => b.createdByRole === "claim");

        const submitClmBatch = async () => {
          if (!canCreateClm) return;
          if (clmRows.length === 0) { setClmSubmitStatus("Minimal satu baris wajib diisi."); return; }
          const invalidRow = clmRows.findIndex((r) => !(OFF_CLM_PROGRAM_TYPES as readonly string[]).includes(r.type));
          if (invalidRow >= 0) { setClmSubmitStatus(`Tipe program baris ${invalidRow + 1} belum dipilih.`); return; }
          const missingRekeningRow = clmRows.findIndex((r) => normalizeUiPaymentMethod(r.caraBayar) === "Transfer" && !r.noRekening.trim());
          if (missingRekeningRow >= 0) { setClmSubmitStatus(`No Rekening baris ${missingRekeningRow + 1} wajib diisi untuk Transfer.`); return; }
          setClmIsSubmitting(true);
          setClmSubmitStatus("");
          try {
            const res = await fetch("/api/off-program-control/batches", {
              method: "POST",
              credentials: "include",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                principleName: clmPrinciple,
                principleCode: clmCode,
                bulan: clmBulanPad,
                tahun: clmTahun,
                supervisorName: "Divisi Claim",
                items: clmRows.map((r) => ({
                  noSurat: r.noSurat,
                  namaProgram: r.namaProgram,
                  periodeAwal: r.periodeAwal,
                  periodeAkhir: r.periodeAkhir,
                  toko: r.toko,
                  barang: r.barang,
                  nominal: r.nominal,
                  caraBayar: r.caraBayar || "Transfer",
                  noRekening: normalizeUiPaymentMethod(r.caraBayar) === "Transfer" ? r.noRekening : "",
                  type: r.type,
                  originalType: r.type,
                  deadline: r.deadline,
                  kwt: r.kwt, skp: r.skp, fp: r.fp, pc: r.pc,
                  foto: r.foto, rekap: r.rekap, others: r.others,
                  othersText: r.othersText,
                })),
              }),
            });
            const data = await parseJsonResponse(res);
            if (!res.ok || !data.ok) throw new Error(String(data.error || data.message || "Gagal membuat batch CLM."));
            setClmSubmitStatus(`Pengajuan CLM berhasil dibuat: ${String(data.noPengajuan || previewNoClm)}`);
            setClmRows([createEmptyBulkRow(1)]);
            await loadClaimBatches();
            setClmNumberRefreshKey((value) => value + 1);
          } catch (err) {
            setClmSubmitStatus(err instanceof Error ? err.message : "Gagal membuat batch CLM.");
          } finally {
            setClmIsSubmitting(false);
          }
        };

        const submitClmToSM = async (batchId: string, noPengajuan: string) => {
          if (!canSubmitClm) return;
          try {
            const res = await fetch(`/api/off-program-control/batches/${batchId}/submit`, {
              method: "POST", credentials: "include",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({}),
            });
            const data = await parseJsonResponse(res);
            if (!res.ok || !data.ok) throw new Error(String(data.error || "Gagal submit ke SM."));
            setClmSubmitStatus(`${noPengajuan} berhasil disubmit ke SM.`);
            await loadClaimBatches();
          } catch (err) {
            setClmSubmitStatus(err instanceof Error ? err.message : "Gagal submit ke SM.");
          }
        };

        return (
          <div className="space-y-6">
            {/* Daftar CLM Batches */}
            <Panel title="Daftar Pengajuan CLM" icon={FileText}>
              <InfoNote>
                Pengajuan ini dibuat oleh divisi Claim berdasarkan data dari direksi.
                No Pengajuan menggunakan format <span className="font-mono text-teal-300">xxx/CLM/KODE/MM/YYYY</span>.
              </InfoNote>
              {myCLMBatches.length === 0 ? (
                <div className="mt-4 rounded-xl border border-white/10 bg-black/30 px-4 py-6 text-center text-sm text-slate-500">
                  Belum ada pengajuan CLM. Buat pengajuan baru di form di bawah.
                </div>
              ) : (
                <div className="mt-4 overflow-x-auto rounded-xl border border-white/10">
                  <table className="w-full min-w-[700px] text-left text-sm">
                    <thead className="border-b border-white/10 bg-black/50 text-xs uppercase tracking-wider text-slate-500">
                      <tr>
                        {["No Pengajuan", "Principal", "Bulan/Tahun", "Status", "Aksi"].map((h) => (
                          <th key={h} className="px-3 py-3 font-bold">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-white/5">
                      {myCLMBatches.map((b) => (
                        <tr key={b.id} className="hover:bg-white/[0.03]">
                          <td className="px-3 py-3 font-mono text-sm font-bold text-white">{b.noPengajuan}</td>
                          <td className="px-3 py-3 text-slate-300">{b.principleName}</td>
                          <td className="px-3 py-3 text-slate-300">{b.bulan}/{b.tahun}</td>
                          <td className="px-3 py-3">
                            <span className={`inline-flex rounded-md border px-2 py-0.5 text-xs font-bold ${statusClass(b.status)}`}>
                              {displayStatusLabel(b.status)}
                            </span>
                          </td>
                          <td className="px-3 py-3">
                            {canSubmitClm && b.status === "Draft" && (
                              <button
                                type="button"
                                onClick={() => void submitClmToSM(b.id, b.noPengajuan)}
                                className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-1 text-xs font-bold text-emerald-300 hover:bg-emerald-500/20"
                              >
                                Submit ke SM
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Panel>

            {/* Form buat pengajuan CLM baru */}
            {canCreateClm && (
              <Panel title="Buat Pengajuan CLM Baru" icon={FileText}>
                <InfoNote>
                  Isi data pengajuan dari direksi. Tipe program: Insentif, Diskon Reguler, Insentif Distributor, Retur.
                  No Pengajuan akan otomatis menggunakan format CLM.
                </InfoNote>
                <div className="mt-4 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 items-end gap-3">
                  <label className="block">
                    <span className="text-xs text-slate-500 font-semibold">Principal</span>
                    <select
                      value={clmPrinciple}
                      onChange={(e) => setClmPrinciple(e.target.value)}
                      className="mt-1 h-[38px] w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-slate-200 outline-none focus:border-indigo-500/50"
                    >
                      {getPrincipalOptions(allClaimBatches).concat(
                        getPrincipalOptions(allClaimBatches).length === 0
                          ? [{ value: clmPrinciple, label: clmPrinciple }]
                          : []
                      ).map((opt) => (
                        <option key={opt.value} value={opt.value}>{opt.label}</option>
                      ))}
                    </select>
                  </label>
                  <Field label="Gelombang Otomatis" value={clmGelombangPad} />
                  <EditableField label="Bulan (MM)" value={clmBulan} onChange={setClmBulan} />
                  <EditableField label="Tahun (YYYY)" value={clmTahun} onChange={setClmTahun} />
                </div>
                <div className="mt-3 rounded-lg border border-indigo-500/20 bg-indigo-500/5 px-3 py-2">
                  <p className="text-xs text-slate-400">No Pengajuan CLM:
                    <span className="ml-2 font-mono font-bold text-indigo-300">{previewNoClm}</span>
                  </p>
                  {clmAutoNumberStatus ? (
                    <p className="mt-1 text-xs font-semibold text-indigo-200">
                      {clmAutoNumberStatus}
                    </p>
                  ) : null}
                </div>
                {/* Tabel baris CLM */}
                <div className="mt-5 overflow-x-auto rounded-xl border border-white/10">
                  <table className="w-full min-w-[1560px] text-left text-sm">
                    <thead className="border-b border-white/10 bg-black/50 text-xs uppercase tracking-wider text-slate-500">
                      <tr>
                        {["No", "No Surat", "Nama Program", "Periode Awal", "Periode Akhir", "Toko", "Barang", "Nominal", "Cara Bayar", "No Rekening", "Tipe Program (CLM)", "Deadline", ""].map((h) => (
                          <th key={h} className="px-2 py-3 font-bold">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-white/5">
                      {clmRows.map((row, idx) => (
                        <tr key={row.id} className="hover:bg-white/[0.02]">
                          <td className="px-2 py-2 text-slate-500 font-mono text-xs">{idx + 1}</td>
                          <td className="px-2 py-2"><input value={row.noSurat} onChange={(e) => { const r=[...clmRows]; r[idx]={...r[idx],noSurat:e.target.value}; setClmRows(r); }} className="w-28 rounded bg-black/30 border border-white/10 px-2 py-1 text-xs text-slate-200 outline-none focus:border-indigo-500/50" /></td>
                          <td className="px-2 py-2"><input value={row.namaProgram} onChange={(e) => { const r=[...clmRows]; r[idx]={...r[idx],namaProgram:e.target.value}; setClmRows(r); }} className="w-36 rounded bg-black/30 border border-white/10 px-2 py-1 text-xs text-slate-200 outline-none focus:border-indigo-500/50" /></td>
                          <td className="px-2 py-2"><input type="date" value={row.periodeAwal} onChange={(e) => { const r=[...clmRows]; r[idx]={...r[idx],periodeAwal:e.target.value}; setClmRows(r); }} className="w-32 rounded bg-black/30 border border-white/10 px-2 py-1 text-xs text-slate-200 outline-none focus:border-indigo-500/50" /></td>
                          <td className="px-2 py-2"><input type="date" value={row.periodeAkhir} onChange={(e) => { const r=[...clmRows]; r[idx]={...r[idx],periodeAkhir:e.target.value}; setClmRows(r); }} className="w-32 rounded bg-black/30 border border-white/10 px-2 py-1 text-xs text-slate-200 outline-none focus:border-indigo-500/50" /></td>
                          <td className="px-2 py-2"><input value={row.toko} onChange={(e) => { const r=[...clmRows]; r[idx]={...r[idx],toko:e.target.value}; setClmRows(r); }} className="w-28 rounded bg-black/30 border border-white/10 px-2 py-1 text-xs text-slate-200 outline-none focus:border-indigo-500/50" /></td>
                          <td className="px-2 py-2"><input value={row.barang} onChange={(e) => { const r=[...clmRows]; r[idx]={...r[idx],barang:e.target.value}; setClmRows(r); }} className="w-28 rounded bg-black/30 border border-white/10 px-2 py-1 text-xs text-slate-200 outline-none focus:border-indigo-500/50" /></td>
                          <td className="px-2 py-2"><input value={row.nominal} onChange={(e) => { const r=[...clmRows]; r[idx]={...r[idx],nominal:e.target.value}; setClmRows(r); }} className="w-28 rounded bg-black/30 border border-white/10 px-2 py-1 text-xs text-right font-mono text-emerald-300 outline-none focus:border-indigo-500/50" placeholder="0" /></td>
                          <td className="px-2 py-2">
                            <select value={row.caraBayar} onChange={(e) => { const r=[...clmRows]; r[idx]={...r[idx],caraBayar:e.target.value,noRekening:e.target.value === "Tunai" ? "" : r[idx].noRekening}; setClmRows(r); }} className="w-24 rounded bg-black/30 border border-white/10 px-2 py-1 text-xs text-slate-200 outline-none">
                              <option value="Transfer">Transfer</option>
                              <option value="Tunai">Tunai</option>
                            </select>
                          </td>
                          <td className="px-2 py-2"><input value={row.noRekening} readOnly={normalizeUiPaymentMethod(row.caraBayar) === "Tunai"} onChange={(e) => { const r=[...clmRows]; r[idx]={...r[idx],noRekening:e.target.value}; setClmRows(r); }} className="w-36 rounded bg-black/30 border border-white/10 px-2 py-1 text-xs text-slate-200 outline-none focus:border-indigo-500/50 read-only:opacity-60" placeholder={normalizeUiPaymentMethod(row.caraBayar) === "Transfer" ? "No rekening" : "-"} /></td>
                          <td className="px-2 py-2">
                            <select value={row.type} onChange={(e) => { const r=[...clmRows]; r[idx]={...r[idx],type:e.target.value,originalType:e.target.value}; setClmRows(r); }} className={`w-40 rounded border px-2 py-1 text-xs outline-none bg-black/30 ${row.type ? "border-white/10 text-slate-200" : "border-amber-500/40 text-amber-400"}`}>
                              <option value="">Pilih tipe...</option>
                              {OFF_CLM_PROGRAM_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                            </select>
                          </td>
                          <td className="px-2 py-2"><input type="date" value={row.deadline} onChange={(e) => { const r=[...clmRows]; r[idx]={...r[idx],deadline:e.target.value}; setClmRows(r); }} className="w-32 rounded bg-black/30 border border-white/10 px-2 py-1 text-xs text-slate-200 outline-none focus:border-indigo-500/50" /></td>
                          <td className="px-2 py-2">
                            <button type="button" onClick={() => setClmRows((prev) => prev.filter((_, i) => i !== idx))} className="rounded border border-rose-500/30 bg-rose-500/10 px-2 py-1 text-xs font-bold text-rose-300 hover:bg-rose-500/20">✕</button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-3">
                  <button
                    type="button"
                    onClick={() => setClmRows((prev) => [...prev, createEmptyBulkRow(prev.length + 1)])}
                    className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs font-bold text-slate-300 hover:bg-white/10"
                  >
                    + Tambah Baris
                  </button>
                  <div className="flex-1" />
                  {clmSubmitStatus && (
                    <p className="text-xs text-slate-300">{clmSubmitStatus}</p>
                  )}
                  <button
                    type="button"
                    onClick={() => void submitClmBatch()}
                    disabled={clmIsSubmitting || clmRows.length === 0}
                    className="inline-flex items-center gap-2 rounded-xl border border-indigo-500 bg-indigo-600 px-4 py-2.5 text-sm font-bold text-white hover:bg-indigo-500 disabled:opacity-50"
                  >
                    {clmIsSubmitting ? "Menyimpan..." : "Simpan sebagai Draft"}
                  </button>
                </div>
              </Panel>
            )}
          </div>
        );
      })()}
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
  );
}

function OperationalManagerDashboard({ offRole }: OffDashboardProps) {
  const canDecideOm =
    canPerformOffAction(offRole, "om_approve") ||
    canPerformOffAction(offRole, "om_cancel");
  const [omBatches, setOmBatches] = useState<OffApiBatch[]>([]);
  const [omMenu, setOmMenu] = useState<"monitoring" | "approval">("monitoring");
  const [omSearch, setOmSearch] = useState("");
  const [omPrincipalFilter, setOmPrincipalFilter] = useState("");
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
    // #7: Auto-refresh list-only (fokus tab + interval) tanpa mereset selection/form.
    let active = true;
    const refreshList = async () => {
      try {
        const response = await fetch("/api/off-program-control/batches", {
          credentials: "include",
        });
        const data = await parseJsonResponse(response);
        if (!active || !response.ok || !data.ok) return;
        const rows = Array.isArray(data.batches)
          ? (data.batches as OffApiBatch[])
          : [];
        setOmBatches(rows);
      } catch {
        /* abaikan error refresh latar */
      }
    };
    const onFocus = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      void refreshList();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    const interval = window.setInterval(() => void refreshList(), 45000);
    return () => {
      active = false;
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
      window.clearInterval(interval);
    };
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
  const omPrincipalOptions = getPrincipalOptions(omBatches);

  const filteredOmBatches = filterBatchesByMainStatus(
    filterBatchesByPrincipal(
      filterBatchesByPeriod(filterBatchesBySearch(omBatches, omSearch), omPeriod),
      omPrincipalFilter,
    ),
    omStatusFilter,
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap gap-2 rounded-2xl border border-white/10 bg-[#1a1c23]/60 p-2">
        {[
          ["monitoring", "Monitoring Pengajuan"],
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

          <div className="space-y-6">
            <CompactFilterToolbar
              searchValue={omSearch}
              onSearchChange={setOmSearch}
              placeholder="Ketik nama principal, nomor, atau status pengajuan"
              activeFilters={buildBatchFilterChips({
                principalFilter: omPrincipalFilter,
                principalOptions: omPrincipalOptions,
                statusFilter: omStatusFilter,
                statusOptions: omStatusOptions,
                period: omPeriod,
              })}
              onReset={() => {
                setOmSearch("");
                setOmPrincipalFilter("");
                setOmStatusFilter("");
                setOmPeriod(createEmptyPeriodFilter());
              }}
            >
              <div className="grid grid-cols-1 gap-3 xl:grid-cols-[260px_260px_1fr]">
                <PrincipalFilterSelect
                  value={omPrincipalFilter}
                  onChange={setOmPrincipalFilter}
                  options={omPrincipalOptions}
                />
                <StatusFilterSelect
                  value={omStatusFilter}
                  onChange={setOmStatusFilter}
                  options={omStatusOptions}
                />
                <PeriodFilter value={omPeriod} onChange={setOmPeriod} />
              </div>
            </CompactFilterToolbar>

            {isLoading && (
              <p className="text-sm text-slate-400">Memuat data OM...</p>
            )}

            {filteredOmBatches.length === 0 && !isLoading ? (
              <EmptyState
                onAction={() => {
                  setOmSearch("");
                  setOmPrincipalFilter("");
                  setOmStatusFilter("");
                  setOmPeriod(createEmptyPeriodFilter());
                }}
                actionLabel="Reset Filter"
              />
            ) : (
              <BatchOverviewActionTable
                batches={filteredOmBatches}
                selectedBatchId={selectedBatch?.id}
                onSelect={selectOmBatch}
                actionLabel={(batch) =>
                  isOmActionableBatch(batch) ? "Tinjauan OM" : "Lihat Detail"
                }
              />
            )}
          </div>
        </div>
      )}

      {omMenu === "approval" && !selectedBatch && (
        <Panel title="Persetujuan OM" icon={ShieldCheck}>
          <EmptyState
            title="Pilih pengajuan untuk persetujuan OM."
            desc="Buka Monitoring Pengajuan, lalu pilih satu pengajuan agar detail dan aksi OM ditampilkan."
            actionLabel="Buka Monitoring"
            onAction={() => setOmMenu("monitoring")}
          />
        </Panel>
      )}

      {omMenu === "approval" && selectedBatch && (
        <div className="space-y-6">
          <Panel title="Detail Persetujuan OM" icon={ClipboardCheck}>
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
              <Field
                label="Nomor Pengajuan"
                value={selectedBatch?.noPengajuan || "-"}
              />
              <Field
                label="Gelombang"
                value={selectedBatch?.gelombang || "-"}
              />
              <Field
                label="Principal"
                value={selectedBatch?.principleName || "-"}
              />
              <Field
                label="Kode Principal"
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
              <Field label="Nomor Klaim" value={selectedBatch?.noClaim || "-"} />
              <Field
                label="Tanggal Pengajuan Klaim"
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

          {/* #9: Catatan dari submit Claim (setelah tahap SM) selalu tampil untuk OM. */}
          <div className="rounded-2xl border border-indigo-500/20 bg-indigo-500/10 p-4">
            <p className="text-xs font-bold uppercase tracking-wider text-indigo-300">
              Catatan dari Claim
            </p>
            <p className="mt-1 whitespace-pre-wrap text-sm text-indigo-50">
              {selectedBatch?.claimNote?.trim() || "Tidak ada catatan dari Claim."}
            </p>
            {selectedBatch?.smNote?.trim() ? (
              <p className="mt-3 text-xs text-indigo-200/80">
                <span className="font-semibold">Catatan SM:</span>{" "}
                {selectedBatch.smNote}
              </p>
            ) : null}
          </div>

          <SupportTogglePanel
            title="Data Pendukung Approval"
            actionLabel="Tampilkan Data Pendukung"
            icon={ClipboardCheck}
          >
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <div className="rounded-xl bg-black/25 p-4">
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
              <div className="rounded-xl bg-black/25 p-4">
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
                <Field label="Status Kelengkapan Claim" value="Lengkap" />
              </div>
              <div className="mt-3">
                <TextArea
                  label="Catatan Claim"
                  value={selectedBatch?.claimNote || "-"}
                />
              </div>
            </div>
            </div>
          </SupportTogglePanel>

          <SupportTogglePanel
            title="Item Batch untuk Persetujuan OM"
            actionLabel="Tampilkan Item Batch"
            icon={ReceiptText}
          >
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
          </SupportTogglePanel>

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

// --- Refund Panel (Pengembalian Dana Selisih) ---
type OffApiRefund = {
  id: string;
  batchId: string;
  refundNo: number;
  refundAmount: number;
  refundMethod: string;
  refundDate: string;
  senderName?: string | null;
  receiverBank?: string | null;
  proofUrl?: string | null;
  proofName?: string | null;
  note?: string | null;
  status: string;
  verifiedBy?: string | null;
  verifiedAt?: string | null;
  verificationNote?: string | null;
};

type RefundSummary = {
  paidAmount: number;
  verifiedAmount: number;
  overpaidAmount: number;
  totalRefunded: number;
  pendingRefund: number;
  remainingRefund: number;
  isFullyRefunded: boolean;
};

function RefundPanel({
  batchId,
  batch,
  offRole,
  onRefundUpdated,
}: {
  batchId: string;
  batch: OffApiBatch;
  offRole: OffRole;
  onRefundUpdated: () => void;
}) {
  const canSubmitRefund = canPerformOffAction(offRole, "submit_refund") || canPerformOffAction(offRole, "finance_payment");
  const canVerifyRefund = canPerformOffAction(offRole, "finance_payment");
  const [refunds, setRefunds] = useState<OffApiRefund[]>([]);
  const [summary, setSummary] = useState<RefundSummary | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  // Form
  const [refundAmount, setRefundAmount] = useState("");
  const [refundMethod, setRefundMethod] = useState("Transfer");
  const [refundDate, setRefundDate] = useState("");
  const [senderName, setSenderName] = useState("");
  const [receiverBank, setReceiverBank] = useState("");
  const [refundNote, setRefundNote] = useState("");

  const loadRefunds = async () => {
    setIsLoading(true);
    try {
      const response = await fetch(`/api/off-program-control/batches/${batchId}/refund`, { credentials: "include" });
      const data = await parseJsonResponse(response);
      if (!response.ok || !data.ok) throw new Error(String(data.error || "Gagal memuat data refund."));
      setRefunds(Array.isArray(data.refunds) ? (data.refunds as OffApiRefund[]) : []);
      setSummary((data.summary as RefundSummary) || null);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Gagal memuat data refund.");
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => { loadRefunds(); }, [batchId]);

  const submitRefund = async () => {
    setIsSubmitting(true);
    setMessage("");
    try {
      const response = await fetch(`/api/off-program-control/batches/${batchId}/refund`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          refundAmount: parseUiCurrency(refundAmount),
          refundMethod,
          refundDate,
          senderName,
          receiverBank,
          note: refundNote,
        }),
      });
      const data = await parseJsonResponse(response);
      if (!response.ok || !data.ok) throw new Error(String(data.error || data.message || "Gagal submit refund."));
      setMessage(String(data.message || "Refund berhasil disubmit."));
      setRefundAmount("");
      setRefundDate("");
      setSenderName("");
      setReceiverBank("");
      setRefundNote("");
      await loadRefunds();
      onRefundUpdated();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Gagal submit refund.");
    } finally {
      setIsSubmitting(false);
    }
  };

  const verifyRefund = async (refundId: string, action: "verify" | "reject") => {
    setIsSubmitting(true);
    setMessage("");
    try {
      const note = action === "reject" ? window.prompt("Alasan penolakan (opsional):") || "" : "";
      const response = await fetch(`/api/off-program-control/batches/${batchId}/refund`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refundId, action, note }),
      });
      const data = await parseJsonResponse(response);
      if (!response.ok || !data.ok) throw new Error(String(data.error || data.message || "Gagal memproses refund."));
      setMessage(String(data.message || "Berhasil."));
      await loadRefunds();
      onRefundUpdated();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Gagal memproses refund.");
    } finally {
      setIsSubmitting(false);
    }
  };

  // Jangan tampilkan panel jika tidak ada selisih
  if (summary && summary.overpaidAmount <= 0 && refunds.length === 0) return null;

  return (
    <Panel title="Pengembalian Dana Selisih" icon={Wallet}>
      {isLoading ? (
        <p className="text-sm text-slate-400">Memuat data pengembalian...</p>
      ) : (
        <>
          {summary && summary.overpaidAmount > 0 && (
            <div className="mb-5 rounded-xl border border-orange-500/30 bg-orange-500/10 p-4">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
                <div>
                  <p className="text-xs text-slate-400 font-semibold">Dana Dikeluarkan</p>
                  <p className="mt-1 text-lg font-bold text-white">Rp {summary.paidAmount.toLocaleString("id-ID")}</p>
                </div>
                <div>
                  <p className="text-xs text-slate-400 font-semibold">Realisasi Klaim</p>
                  <p className="mt-1 text-lg font-bold text-white">Rp {summary.verifiedAmount.toLocaleString("id-ID")}</p>
                </div>
                <div>
                  <p className="text-xs text-slate-400 font-semibold">Selisih Harus Kembali</p>
                  <p className="mt-1 text-lg font-bold text-orange-300">Rp {summary.overpaidAmount.toLocaleString("id-ID")}</p>
                </div>
                <div>
                  <p className="text-xs text-slate-400 font-semibold">Sudah Dikembalikan</p>
                  <p className="mt-1 text-lg font-bold text-emerald-300">Rp {summary.totalRefunded.toLocaleString("id-ID")}</p>
                  {summary.remainingRefund > 0 && (
                    <p className="mt-1 text-xs text-orange-300">Sisa: Rp {summary.remainingRefund.toLocaleString("id-ID")}</p>
                  )}
                  {summary.isFullyRefunded && (
                    <p className="mt-1 text-xs text-emerald-300 font-bold">Lunas</p>
                  )}
                </div>
              </div>
            </div>
          )}

          {refunds.length > 0 && (
            <div className="mb-5">
              <h3 className="text-sm font-bold text-white mb-3">Riwayat Pengembalian</h3>
              <div className="overflow-x-auto rounded-xl border border-white/10">
                <table className="w-full text-sm text-left">
                  <thead className="bg-black/50 text-xs uppercase tracking-wider text-slate-400 border-b border-white/10">
                    <tr>
                      <th className="px-3 py-2.5">#</th>
                      <th className="px-3 py-2.5">Tanggal</th>
                      <th className="px-3 py-2.5">Jumlah</th>
                      <th className="px-3 py-2.5">Metode</th>
                      <th className="px-3 py-2.5">Pengirim</th>
                      <th className="px-3 py-2.5">Status</th>
                      <th className="px-3 py-2.5">Catatan</th>
                      {canVerifyRefund && <th className="px-3 py-2.5">Aksi</th>}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/5">
                    {refunds.map((refund) => (
                      <tr key={refund.id} className="hover:bg-white/[0.03]">
                        <td className="px-3 py-2.5 font-mono text-slate-300">{refund.refundNo}</td>
                        <td className="px-3 py-2.5 text-slate-300">{formatDateDisplay(refund.refundDate)}</td>
                        <td className="px-3 py-2.5 font-mono font-bold text-white">Rp {refund.refundAmount.toLocaleString("id-ID")}</td>
                        <td className="px-3 py-2.5 text-slate-300">{refund.refundMethod}</td>
                        <td className="px-3 py-2.5 text-slate-300">{refund.senderName || "-"}</td>
                        <td className="px-3 py-2.5">
                          <span className={`inline-flex rounded-md border px-2 py-1 text-xs font-bold ${
                            refund.status === "Verified" ? "bg-emerald-500/10 text-emerald-300 border-emerald-500/30" :
                            refund.status === "Rejected" ? "bg-rose-500/10 text-rose-300 border-rose-500/30" :
                            "bg-amber-500/10 text-amber-300 border-amber-500/30"
                          }`}>
                            {refund.status === "Verified" ? "Terverifikasi" : refund.status === "Rejected" ? "Ditolak" : "Menunggu"}
                          </span>
                        </td>
                        <td className="px-3 py-2.5 text-xs text-slate-400 max-w-[200px] truncate">{refund.note || refund.verificationNote || "-"}</td>
                        {canVerifyRefund && (
                          <td className="px-3 py-2.5">
                            {refund.status === "Pending" && (
                              <div className="flex gap-2">
                                <button
                                  onClick={() => verifyRefund(refund.id, "verify")}
                                  disabled={isSubmitting}
                                  className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-xs font-bold text-emerald-200 hover:bg-emerald-500/20 disabled:opacity-50"
                                >
                                  Verifikasi
                                </button>
                                <button
                                  onClick={() => verifyRefund(refund.id, "reject")}
                                  disabled={isSubmitting}
                                  className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-2.5 py-1 text-xs font-bold text-rose-200 hover:bg-rose-500/20 disabled:opacity-50"
                                >
                                  Tolak
                                </button>
                              </div>
                            )}
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {canSubmitRefund && summary && summary.remainingRefund > 0 && (
            <div className="rounded-xl border border-white/10 bg-black/25 p-4">
              <h3 className="text-sm font-bold text-white mb-4">Submit Pengembalian Dana</h3>
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                <EditableField label="Jumlah Pengembalian" value={refundAmount} onChange={setRefundAmount} />
                <label className="block">
                  <span className="text-xs text-slate-500 font-semibold">Metode</span>
                  <select
                    value={refundMethod}
                    onChange={(e) => setRefundMethod(e.target.value)}
                    className="mt-1 w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2.5 text-sm text-slate-200 outline-none focus:border-teal-500/50"
                  >
                    <option value="Transfer" className="bg-[#1a1c23]">Transfer</option>
                    <option value="Tunai" className="bg-[#1a1c23]">Tunai</option>
                    <option value="Kompensasi Batch Lain" className="bg-[#1a1c23]">Kompensasi Batch Lain</option>
                  </select>
                </label>
                <div>
                  <span className="text-xs text-slate-500 font-semibold">Tanggal Pengembalian</span>
                  <DatePickerField
                    value={refundDate}
                    onChange={setRefundDate}
                    ariaLabel="Tanggal pengembalian"
                    className="mt-1 w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2.5 text-sm text-slate-200 outline-none [color-scheme:dark] focus:border-teal-500/50"
                  />
                </div>
                <EditableField label="Nama Pengirim" value={senderName} onChange={setSenderName} />
                <EditableField label="Bank Penerima" value={receiverBank} onChange={setReceiverBank} />
                <EditableField label="Catatan" value={refundNote} onChange={setRefundNote} />
              </div>
              <button
                onClick={submitRefund}
                disabled={isSubmitting || !refundAmount || !refundDate}
                className="mt-4 inline-flex items-center justify-center gap-2 rounded-xl border border-orange-500 bg-orange-600 px-4 py-2.5 text-sm font-bold text-white transition-colors hover:bg-orange-500 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isSubmitting ? "Mengirim..." : "Submit Pengembalian"}
              </button>
            </div>
          )}

          {summary && summary.isFullyRefunded && (
            <div className="mt-4 rounded-xl border border-emerald-500/20 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-200 font-semibold">
              Selisih dana telah dikembalikan seluruhnya. Batch dapat ditutup sebagai Completed.
            </div>
          )}

          {message && (
            <div className="mt-4 rounded-xl border border-white/10 bg-black/30 px-4 py-3 text-sm text-slate-300">
              {message}
            </div>
          )}
        </>
      )}
    </Panel>
  );
}

function FinanceDashboard({ offRole }: OffDashboardProps) {
  const canPayFinance = canPerformOffAction(offRole, "finance_payment");
  const [financeMenu, setFinanceMenu] = useState<"monitoring" | "payment">(
    "monitoring",
  );
  const [financeBatches, setFinanceBatches] = useState<OffApiBatch[]>([]);
  const [financeSearch, setFinanceSearch] = useState("");
  const [financePrincipalFilter, setFinancePrincipalFilter] = useState("");
  const [financeStatusFilter, setFinanceStatusFilter] = useState("");
  const [financePeriod, setFinancePeriod] = useState(createEmptyPeriodFilter());
  const [selectedBatch, setSelectedBatch] = useState<OffApiBatch | null>(null);
  const [selectedFinanceBatchId, setSelectedFinanceBatchId] = useState<
    string | null
  >(null);
  const [selectedItems, setSelectedItems] = useState<OffApiItem[]>([]);
  const [selectedPaymentItemIds, setSelectedPaymentItemIds] = useState<string[]>([]);
  const [selectedPayments, setSelectedPayments] = useState<OffApiPayment[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isActionLoading, setIsActionLoading] = useState(false);
  const [financeMessage, setFinanceMessage] = useState("");
  const [paymentDate, setPaymentDate] = useState("");
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
    paymentProofUrl?: string | null;
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
  const isFinanceItemPaid = (item: OffApiItem) =>
    item.financePaymentStatus === "paid" || Boolean(item.financePaymentId);
  const selectedPaymentItems = selectedItems.filter((item) =>
    selectedPaymentItemIds.includes(item.id),
  );
  const selectedPaymentMethods = Array.from(
    new Set(
      selectedPaymentItems.map((item) =>
        normalizeUiPaymentMethod(item.caraBayar || ""),
      ),
    ),
  ).filter(Boolean);
  const selectedPaymentTotal = selectedPaymentItems.reduce(
    (total, item) => total + Number(item.nominal || 0),
    0,
  );
  const selectedPaymentMethod =
    selectedPaymentMethods.length === 1 ? selectedPaymentMethods[0] : "";
  const selectedPaymentTotalLabel = `Rp ${selectedPaymentTotal.toLocaleString(
    "id-ID",
  )}`;
  const selectedPaymentMethodLabel = selectedPaymentMethod || "-";

  const syncFinanceItemSelection = () => {
    setSelectedPaymentItemIds([]);
  };

  const toggleFinanceItemSelection = (item: OffApiItem) => {
    if (isFinanceItemPaid(item)) return;
    setSelectedPaymentItemIds((current) => {
      const exists = current.includes(item.id);
      if (exists) return current.filter((id) => id !== item.id);

      const currentItems = selectedItems.filter((row) => current.includes(row.id));
      const currentMethods = Array.from(
        new Set(
          currentItems.map((row) => normalizeUiPaymentMethod(row.caraBayar || "")),
        ),
      ).filter(Boolean);
      const itemMethod = normalizeUiPaymentMethod(item.caraBayar || "");
      if (currentMethods.length > 0 && !currentMethods.includes(itemMethod)) {
        setFinanceMessage("Pilih item dengan cara bayar yang sama.");
        return current;
      }
      setFinanceMessage("");
      return [...current, item.id];
    });
  };

  const isFinanceItemDisabledForSelection = (item: OffApiItem) => {
    if (isFinanceItemPaid(item)) return true;
    if (!selectedPaymentMethod || selectedPaymentItemIds.includes(item.id)) {
      return false;
    }
    return normalizeUiPaymentMethod(item.caraBayar || "") !== selectedPaymentMethod;
  };

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
    const detailItems = Array.isArray(data.items)
      ? (data.items as OffApiItem[])
      : [];
    setSelectedItems(detailItems);
    syncFinanceItemSelection();
    setSelectedPayments(payments);
    setPaymentDate("");
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
        setSelectedPaymentItemIds([]);
        setSelectedPayments([]);
        setPaymentDate("");
        setFinanceNote("");
      }
    } catch (error) {
      // Fallback: gunakan dummy data jika API tidak tersedia
      const monitoringRows = dummyBatches.filter(isFinanceMonitoringBatch);
      setFinanceBatches(monitoringRows.length > 0 ? monitoringRows : dummyBatches);
      setFinanceMessage("");
      setSelectedItems([]);
      setSelectedPaymentItemIds([]);
      setSelectedPayments([]);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadFinanceBatches({ autoSelectFirst: false });
    // #7: Auto-refresh list-only (fokus tab + interval) tanpa mereset selection/form.
    let active = true;
    const refreshList = async () => {
      try {
        const response = await fetch("/api/off-program-control/batches", {
          credentials: "include",
        });
        const data = await parseJsonResponse(response);
        if (!active || !response.ok || !data.ok) return;
        const rows = Array.isArray(data.batches)
          ? (data.batches as OffApiBatch[])
          : [];
        setFinanceBatches(rows.filter(isFinanceMonitoringBatch));
      } catch {
        /* abaikan error refresh latar */
      }
    };
    const onFocus = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      void refreshList();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    const interval = window.setInterval(() => void refreshList(), 45000);
    return () => {
      active = false;
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
      window.clearInterval(interval);
    };
    // Finance queue should load once when this tab component mounts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectFinanceBatch = async (batch: OffApiBatch) => {
    setSelectedBatch(batch);
    setSelectedFinanceBatchId(batch.id);
    setSelectedItems([]);
    setSelectedPaymentItemIds([]);
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
      if (selectedPaymentItemIds.length === 0) {
        setFinanceMessage("Pilih minimal satu item yang akan dibayar.");
        return;
      }
      if (selectedPaymentMethods.length !== 1) {
        setFinanceMessage("Pilih item dengan cara bayar yang sama.");
        return;
      }
      const effectivePaymentMethod = selectedPaymentMethods[0];
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
      formData.append("senderBank", senderBank);
      formData.append("note", financeNote);
      formData.append("itemIds", JSON.stringify(selectedPaymentItemIds));
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
        paidAmount: selectedPaymentTotalLabel,
        paymentMethod: effectivePaymentMethod,
        senderBank,
        paymentProofName: payment?.paymentProofName || "",
        paymentProofUrl: payment?.proofUrl || null,
        remainingAmount: nextPaymentSummary?.remainingAmount,
        isFullyPaid: nextPaymentSummary?.isFullyPaid,
      });
      setPaymentDate("");
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
  const financePrincipalOptions = getPrincipalOptions(financeBatches);

  const filteredFinanceBatches = filterFinanceBatchesByStatus(
    filterBatchesByPrincipal(
      filterBatchesByPeriod(
        filterBatchesBySearch(financeBatches, financeSearch),
        financePeriod,
      ),
      financePrincipalFilter,
    ),
    financeStatusFilter,
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap gap-2 rounded-2xl border border-white/10 bg-[#1a1c23]/60 p-2">
        {[
          ["monitoring", "Monitoring Pembayaran"],
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
        <Panel title="Monitoring Pembayaran" icon={Wallet}>
          <div className="mb-6">
            <CompactFilterToolbar
              searchValue={financeSearch}
              onSearchChange={setFinanceSearch}
              placeholder="Ketik nama principal, nomor, atau status pengajuan"
              activeFilters={buildBatchFilterChips({
                principalFilter: financePrincipalFilter,
                principalOptions: financePrincipalOptions,
                statusFilter: financeStatusFilter,
                statusOptions: financeStatusOptions,
                period: financePeriod,
              })}
              onReset={() => {
                setFinanceSearch("");
                setFinancePrincipalFilter("");
                setFinanceStatusFilter("");
                setFinancePeriod(createEmptyPeriodFilter());
              }}
            >
              <div className="grid grid-cols-1 gap-3 xl:grid-cols-[260px_260px_1fr]">
                <PrincipalFilterSelect
                  value={financePrincipalFilter}
                  onChange={setFinancePrincipalFilter}
                  options={financePrincipalOptions}
                />
                <StatusFilterSelect
                  value={financeStatusFilter}
                  onChange={setFinanceStatusFilter}
                  options={financeStatusOptions}
                />
                <PeriodFilter
                  value={financePeriod}
                  onChange={setFinancePeriod}
                />
              </div>
            </CompactFilterToolbar>
          </div>
          {isLoading && (
            <p className="mb-4 text-sm text-slate-400">
              Memuat data Keuangan...
            </p>
          )}
          {filteredFinanceBatches.length === 0 && !isLoading ? (
            <EmptyState
              onAction={() => {
                setFinanceSearch("");
                setFinancePrincipalFilter("");
                setFinanceStatusFilter("");
                setFinancePeriod(createEmptyPeriodFilter());
              }}
              actionLabel="Reset Filter"
            />
          ) : (
            <FinanceMonitoringTable
              batches={filteredFinanceBatches}
              selectedBatchId={selectedBatch?.id}
              onSelect={selectFinanceBatch}
            />
          )}
        </Panel>
      )}

      {financeMenu === "payment" && !selectedBatch && (
        <Panel title="Pembayaran" icon={Wallet}>
          <p className="text-sm text-slate-400">
            Pilih pengajuan dari Monitoring Pembayaran untuk melihat detail
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
                label="Nomor Pengajuan"
                value={selectedBatch?.noPengajuan || "-"}
              />
              <Field
                label="Principal"
                value={selectedBatch?.principleName || "-"}
              />
              <Field
                label="Kode Principal"
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
              <table className="w-full min-w-[1450px] text-sm text-left">
                <thead className="bg-black/50 text-xs uppercase tracking-wider text-slate-500 border-b border-white/10">
                  <tr>
                    {[
                      "Bayar",
                      "No",
                      "No Surat",
                      "Nama Program",
                      "Periode Awal",
                      "Periode Akhir",
                      "Toko",
                      "Barang",
                      "Nominal",
                      "Cara Bayar",
                      "No Rekening",
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
                        <td className="px-3 py-3">
                          <input
                            type="checkbox"
                            checked={selectedPaymentItemIds.includes(item.id)}
                            disabled={isFinanceItemDisabledForSelection(item)}
                            onChange={() => toggleFinanceItemSelection(item)}
                            className="h-4 w-4 rounded border-white/10 bg-black/50 text-teal-500 disabled:cursor-not-allowed disabled:opacity-40"
                            aria-label={`Pilih item ${item.itemNo || index + 1} untuk dibayar`}
                            title={
                              !isFinanceItemPaid(item) &&
                              isFinanceItemDisabledForSelection(item)
                                ? "Item ini berbeda metode pembayaran dari pilihan saat ini."
                                : undefined
                            }
                          />
                        </td>
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
                        <td className="px-3 py-3 font-mono text-xs text-slate-300">
                          {normalizeUiPaymentMethod(item.caraBayar || "") === "Transfer"
                            ? item.noRekening || "-"
                            : "-"}
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
                        colSpan={13}
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
              <Field
                label="Jumlah Dibayar oleh Keuangan"
                value={selectedPaymentTotalLabel}
              />
              <Field
                label="Metode Pembayaran"
                value={selectedPaymentMethodLabel}
              />
              <Field
                label="Item Dipilih"
                value={`${selectedPaymentItemIds.length} item`}
              />
              <EditableField
                label="Bank Pengirim"
                value={senderBank}
                onChange={setSenderBank}
              />
              <label className="block">
                <span className="text-xs text-slate-500 font-semibold">
                  Lampiran Bank
                  <span className="ml-1 font-normal text-emerald-300">
                    (opsional, PDF bukti dibuat otomatis)
                  </span>
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
                  PDF bukti pembayaran akan dibuat otomatis setelah pembayaran dicatat. Lampiran bank opsional: PDF, PNG, JPG, atau JPEG. Maksimal 5MB.
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
                      {paymentResult.paymentProofName || "-"}
                    </span>
                    {paymentResult.paymentProofUrl && (
                      <button
                        type="button"
                        onClick={() =>
                          window.open(paymentResult.paymentProofUrl || "", "_blank")
                        }
                        className="ml-3 rounded-lg border border-emerald-400/30 bg-emerald-400/10 px-2 py-1 font-bold text-emerald-100 hover:bg-emerald-400/20"
                      >
                        Lihat Bukti
                      </button>
                    )}
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

          {/* Panel Pengembalian Dana Selisih (Refund) */}
          {selectedBatch && (
            <RefundPanel
              batchId={selectedBatch.id}
              batch={selectedBatch}
              offRole={offRole}
              onRefundUpdated={() => loadFinanceBatches({ preserveSelectedId: selectedBatch?.id, autoSelectFirst: false })}
            />
          )}
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

// Revisi I: Dashboard Diskon SPV â€” jejak digital, BELUM approval resmi.
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
        <div className="mb-6">
          <CompactFilterToolbar
            searchValue={search}
            onSearchChange={setSearch}
            placeholder="Cari toko, principle, program, atau alasan diskon..."
            activeFilters={
              isPeriodFilterActive(period)
                ? [{ label: "Periode", value: periodFilterLabel(period) }]
                : []
            }
            onReset={() => {
              setSearch("");
              setPeriod(createEmptyPeriodFilter());
            }}
          >
            <PeriodFilter value={period} onChange={setPeriod} />
          </CompactFilterToolbar>
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
        Klaim dapat membaca, mengekspor, dan mengoreksi audit log. Koreksi bersifat
        non-destruktif: jejak lama tidak dihapus dan setiap koreksi tercatat sebagai
        riwayat baru. {isAdmin ? "Admin dapat melihat histori sebelum dan sesudah perubahan." : ""}
      </InfoNote>

      <div className="mb-6 grid grid-cols-1 gap-3 xl:grid-cols-[1fr_auto]">
        <CompactFilterToolbar
          searchValue={search}
          onSearchChange={setSearch}
          placeholder="Ketik nama principal, nomor, atau catatan"
          activeFilters={
            isPeriodFilterActive(period)
              ? [{ label: "Periode", value: periodFilterLabel(period) }]
              : []
          }
          onReset={() => {
            setSearch("");
            setPeriod(createEmptyPeriodFilter());
          }}
        >
          <PeriodFilter value={period} onChange={setPeriod} />
        </CompactFilterToolbar>
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
                        {log.note ? ` â€” ${log.note}` : ""}
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

function OverviewDetailDrawer({
  batch,
  items,
  payments,
  paymentSummary,
  isLoading,
  onClose,
}: {
  batch: OffApiBatch | null;
  items: OffApiItem[];
  payments: OffApiPayment[];
  paymentSummary?: OffPaymentSummary;
  isLoading: boolean;
  onClose: () => void;
}) {
  if (!batch && !isLoading) return null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/65 backdrop-blur-sm">
      <button
        type="button"
        aria-label="Tutup detail batch"
        className="absolute inset-0 h-full w-full cursor-default"
        onClick={onClose}
      />
      <aside
        aria-modal="true"
        role="dialog"
        className="relative z-10 flex h-full w-full max-w-5xl flex-col border-l border-white/10 bg-[#101219] shadow-2xl"
      >
        <div className="flex items-start justify-between gap-4 border-b border-white/10 px-5 py-4">
          <div className="min-w-0">
            <p className="text-xs font-bold uppercase tracking-wider text-teal-300">
              Detail Batch
            </p>
            <h2 className="mt-1 truncate text-xl font-black text-white">
              {batch?.noPengajuan || "Memuat detail..."}
            </h2>
            <p className="mt-1 text-sm text-slate-500">
              Item, pembayaran, dan status lengkap hanya tampil di drawer ini.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl border border-white/10 bg-white/5 p-2 text-slate-300 hover:bg-white/10 hover:text-white"
            aria-label="Tutup detail batch"
          >
            <X size={18} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-4 sm:p-5">
          {isLoading && (
            <div className="rounded-xl border border-white/10 bg-black/30 px-4 py-3 text-sm text-slate-300">
              Memuat detail ringkasan...
            </div>
          )}
          {batch && !isLoading && (
            <OverviewReadOnlyDetail
              batch={batch}
              items={items}
              payments={payments}
              paymentSummary={paymentSummary}
            />
          )}
        </div>
      </aside>
    </div>
  );
}

function OverviewTab({
  offRole,
  pendingBatchId,
  onPendingBatchHandled,
}: OffDashboardProps & {
  pendingBatchId?: string;
  onPendingBatchHandled?: () => void;
}) {
  const [overviewBatches, setOverviewBatches] = useState<OffApiBatch[]>([]);
  const [overviewSearch, setOverviewSearch] = useState("");
  const [overviewPrincipalFilter, setOverviewPrincipalFilter] = useState("");
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
  const isAdminOverview = offRole === "admin";

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
          String(data.error || "Data pengajuan belum berhasil dimuat. Silakan coba lagi."),
        );
      const batches = Array.isArray(data.batches) ? (data.batches as OffApiBatch[]) : [];
      setOverviewBatches(batches.length > 0 ? batches : dummyBatches);
    } catch (loadError) {
      setError("");
      setOverviewBatches(dummyBatches);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadOverview();
    // #7: Auto-refresh list-only (fokus tab + interval) tanpa memicu spinner.
    let active = true;
    const refreshList = async () => {
      try {
        const response = await fetch("/api/off-program-control/batches", {
          credentials: "include",
        });
        const data = await parseJsonResponse(response);
        if (!active || !response.ok || !data.ok) return;
        const rows = Array.isArray(data.batches)
          ? (data.batches as OffApiBatch[])
          : [];
        if (rows.length > 0) setOverviewBatches(rows);
      } catch {
        /* abaikan error refresh latar */
      }
    };
    const onFocus = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      void refreshList();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    const interval = window.setInterval(() => void refreshList(), 45000);
    return () => {
      active = false;
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
      window.clearInterval(interval);
    };
  }, []);

  // Buka drawer otomatis ketika parent mengirim pendingBatchId dari Global Search.
  useEffect(() => {
    if (!pendingBatchId || overviewBatches.length === 0) return;
    const target = overviewBatches.find((b) => b.id === pendingBatchId);
    if (target) {
      openOverviewDetail(target);
      onPendingBatchHandled?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingBatchId, overviewBatches]);

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
          : "Detail pengajuan belum berhasil dimuat. Silakan coba lagi.",
      );
    } finally {
      setIsDetailLoading(false);
    }
  };

  const closeOverviewDetail = () => {
    setSelectedBatch(null);
    setSelectedItems([]);
    setSelectedPayments([]);
    setSelectedPaymentSummary(undefined);
    setIsDetailLoading(false);
  };

  const metrics: MetricItem[] = [
    {
      label: "Total Pengajuan",
      value: String(overviewBatches.length),
      tone: "text-sky-300",
      icon: ClipboardCheck,
    },
    {
      label: "Menunggu Tinjauan SM",
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
  const principalOptions = getPrincipalOptions(overviewBatches);
  const filteredBatches = filterBatchesByMainStatus(
    filterBatchesByPrincipal(
      filterBatchesByPeriod(
        filterBatchesBySearch(overviewBatches, overviewSearch),
        overviewPeriod,
      ),
      overviewPrincipalFilter,
    ),
    overviewStatusFilter,
  );
  const allComparison = computeClaimComparison(overviewBatches);
  const comparison = computeClaimComparison(filteredBatches);

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
          Tidak ada data yang sesuai dengan pencarian atau filter yang dipilih.
        </div>
      )}
      {isAdminOverview ? (
        <AdminHealthPanel
          batches={overviewBatches}
          comparison={allComparison}
          error={error}
          isLoading={isLoading}
          onSelectBatch={openOverviewDetail}
        />
      ) : (
        <SummaryStrip metrics={metrics} />
      )}
      <CompactFilterToolbar
        searchValue={overviewSearch}
        onSearchChange={setOverviewSearch}
        placeholder="Ketik nama principal, nomor, atau status pengajuan"
        activeFilters={buildBatchFilterChips({
          principalFilter: overviewPrincipalFilter,
          principalOptions,
          statusFilter: overviewStatusFilter,
          statusOptions,
          period: overviewPeriod,
        })}
        onReset={() => {
          setOverviewSearch("");
          setOverviewPrincipalFilter("");
          setOverviewStatusFilter("");
          setOverviewPeriod(createEmptyPeriodFilter());
        }}
      >
        <div className="grid grid-cols-1 gap-3 xl:grid-cols-[280px_280px_1fr]">
          <PrincipalFilterSelect
            value={overviewPrincipalFilter}
            onChange={setOverviewPrincipalFilter}
            options={principalOptions}
          />
          <StatusFilterSelect
            value={overviewStatusFilter}
            onChange={setOverviewStatusFilter}
            options={statusOptions}
          />
          <PeriodFilter value={overviewPeriod} onChange={setOverviewPeriod} />
        </div>
      </CompactFilterToolbar>
      {!isAdminOverview && (
        <ClaimComparisonSummary comparison={comparison} />
      )}
      {isAdminOverview ? (
        <SupportTogglePanel
          title="Semua Status"
          actionLabel="Tampilkan Detail"
          icon={ClipboardCheck}
        >
          <OverviewMonitoringTable
            batches={filteredBatches}
            selectedBatchId={selectedBatch?.id}
            onSelect={openOverviewDetail}
          />
        </SupportTogglePanel>
      ) : (
        <OverviewMonitoringTable
          batches={filteredBatches}
          selectedBatchId={selectedBatch?.id}
          onSelect={openOverviewDetail}
        />
      )}
      {isAdminOverview ? (
        <SupportTogglePanel
          title="Tutup Periode"
          actionLabel="Tampilkan Kontrol"
          icon={CalendarClock}
        >
          <PeriodClosurePanel
            batches={overviewBatches}
            offRole={offRole}
            onUpdated={loadOverview}
          />
        </SupportTogglePanel>
      ) : (
        <PeriodClosurePanel
          batches={overviewBatches}
          offRole={offRole}
          onUpdated={loadOverview}
        />
      )}
      <OverviewDetailDrawer
        batch={selectedBatch}
        items={selectedItems}
        payments={selectedPayments}
        paymentSummary={selectedPaymentSummary}
        isLoading={isDetailLoading}
        onClose={closeOverviewDetail}
      />
    </div>
  );
}

export default function OffProgramControlPage() {
  const [activeTab, setActiveTab] = useState<TabKey>("overview");
  // Cegah hydration mismatch: role berasal dari authClient.useSession() (client-only),
  // sehingga SSR (tanpa sesi) berbeda dgn render klien. Render shell stabil dulu,
  // baru tampilkan UI berbasis role setelah mount.
  const [mounted, setMounted] = useState(false);
  const [paidIncompleteCount, setPaidIncompleteCount] = useState(0);
  const [showAccessDetail, setShowAccessDetail] = useState(false);
  const [pendingBatchId, setPendingBatchId] = useState("");
  const [globalSearchItems, setGlobalSearchItems] = useState<OffSearchableItem[]>([]);
  const { data: session } = authClient.useSession();
  const sessionUser = session?.user as
    | {
        id?: string | null;
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
  const isAdminMode = offRole === "admin";
  useEffect(() => setMounted(true), []);
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

  // --- Deteksi Pengajuan Bermasalah ---
  const [offProblems, setOffProblems] = useState<ReturnType<typeof detectProblematicBatches>>([]);

  useEffect(() => {
    let isActive = true;

    const loadAndDetect = async () => {
      try {
        const response = await fetch("/api/off-program-control/batches", {
          credentials: "include",
        });
        const data = await parseJsonResponse(response);
        if (!response.ok || !data.ok) return;
        const rawRows = Array.isArray(data.batches)
          ? (data.batches as OffApiBatch[])
          : [];
        // Guard defensif: SPV hanya mendeteksi masalah dari pengajuan miliknya
        // (backend sudah memfilter; ini lapis kedua). Role lain tidak difilter.
        const rows =
          offRole === "supervisor" && sessionUser?.id
            ? rawRows.filter((batch) => batch.createdBy === sessionUser.id)
            : rawRows;

        // Map ke format ProblemDetectionBatch
        const detectionBatches: ProblemDetectionBatch[] = rows.map((batch) => ({
          id: batch.id,
          noPengajuan: batch.noPengajuan,
          principleName: batch.principleName,
          status: batch.status,
          smStatus: batch.smStatus,
          claimStatus: batch.claimStatus,
          omStatus: batch.omStatus,
          financeStatus: batch.financeStatus,
          finalStatus: batch.finalStatus,
          locked: batch.locked,
          claimDeadline: batch.claimDeadline,
          submittedAt: (batch as any).submittedAt,
          smApprovedAt: (batch as any).smApprovedAt,
          claimReviewedAt: (batch as any).claimReviewedAt,
          returnedAt: (batch as any).returnedAt,
          paidAt: (batch as any).paidAt,
          createdAt: batch.createdAt,
          updatedAt: batch.updatedAt,
          refundStatus: (batch as any).refundStatus,
          completenessStatus: (batch as any).completenessStatus,
        }));

        const allProblems = detectProblematicBatches(detectionBatches);
        const roleProblems = getProblemsForRole(allProblems, offRole);

        if (isActive) {
          setOffProblems(roleProblems);
          setGlobalSearchItems(
            rows.map((b) => ({
              id: b.id,
              noPengajuan: b.noPengajuan,
              principleName: b.principleName,
              status: b.status,
              supervisorName: b.supervisorName,
            })),
          );
        }
      } catch {
        if (isActive) setOffProblems([]);
      }
    };

    loadAndDetect();
    const interval = window.setInterval(loadAndDetect, 60000);
    return () => {
      isActive = false;
      window.clearInterval(interval);
    };
  }, [offRole, sessionUser?.id]);

  // Shell stabil (SSR === render klien pertama) sampai sesi/role siap di klien.
  if (!mounted) {
    return (
      <div className="max-w-[1800px] mx-auto pb-12">
        <OffBreadcrumb />
        <div className="mb-6">
          <h1 className="text-3xl font-black text-white tracking-tight">
            Program OFF — Pengelolaan Klaim
          </h1>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-[1800px] mx-auto pb-12">
      {/* Breadcrumb */}
      <OffBreadcrumb />

      <div className="mb-6 flex flex-col lg:flex-row lg:items-end justify-between gap-4">
        <div>
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full border border-teal-500/30 bg-teal-500/10 text-teal-300 text-xs font-bold uppercase tracking-widest mb-3">
            <ClipboardCheck size={14} /> OFF Control
          </div>
          <h1 className="text-3xl font-black text-white tracking-tight flex items-center gap-3">
            Program OFF — Pengelolaan Klaim
          </h1>
          <p className="text-slate-400 mt-2 text-sm sm:text-base">
            {isAdminMode
              ? "Pantau health system lebih dulu, lalu drill down ke role tertentu saat perlu."
              : "Pilih antrean, review masalah, lalu ambil aksi sesuai role."}
          </p>
          {isAdminMode && (
            <div className="mt-3 inline-flex items-center gap-2 rounded-xl border border-teal-500/30 bg-teal-500/10 px-3 py-2 text-xs font-bold text-teal-200">
              <ShieldCheck size={14} />
              Mode Admin: Semua akses aktif
            </div>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => setShowAccessDetail((current) => !current)}
            aria-expanded={showAccessDetail}
            className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm font-bold text-slate-200 hover:bg-white/10"
          >
            Detail akses
            <ChevronDown
              size={14}
              className={`transition-transform ${showAccessDetail ? "rotate-180" : ""}`}
            />
          </button>

        </div>
      </div>

      {showAccessDetail && (
        <div className="mb-6 rounded-2xl border border-white/10 bg-[#1a1c23]/60 px-4 py-3 text-xs shadow-xl">
          <div className="flex flex-wrap gap-2">
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
            <span className="rounded-lg border border-white/10 bg-black/30 px-3 py-1.5 text-slate-400">
              {mappingSummary}
            </span>
          </div>
        </div>
      )}

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
          {/* Search bar */}
          <div className="mb-6 max-w-sm">
            <OffGlobalSearch
              items={globalSearchItems}
              onSelect={(id) => {
                setActiveTab("overview");
                setPendingBatchId(id);
              }}
              placeholder="Cari pengajuan..."
            />
          </div>

          {/* Notification Bell - Pengajuan Bermasalah */}
          <OffNotificationBell problems={offProblems} />

          <div className="mb-6">
            <SupportTogglePanel
              title="Alur Persetujuan"
              actionLabel="Tampilkan Alur"
              icon={ArrowRight}
            >
              <WorkflowStepper />
            </SupportTogglePanel>
          </div>

          {/* Mobile: capsule scroll untuk semua user, termasuk admin */}
          <div className="lg:hidden mb-6 overflow-x-auto rounded-2xl border border-white/10 bg-[#1a1c23]/60 p-2 shadow-xl">
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

          {/* Desktop: admin pakai grid selector, non-admin pakai capsule */}
          <div className="hidden lg:block">
            {isAdminMode ? (
              <AdminViewSelector
                activeTab={effectiveActiveTab}
                accessibleTabKeys={accessibleTabKeys}
                onSelect={setActiveTab}
              />
            ) : (
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
            )}
          </div>

          {effectiveActiveTab === "overview" && (
            <OverviewTab
              offRole={offRole}
              pendingBatchId={pendingBatchId}
              onPendingBatchHandled={() => setPendingBatchId("")}
            />
          )}
          {effectiveActiveTab === "supervisor" && (
            <SupervisorDashboard
              offRole={offRole}
              supervisorDisplayName={
                sessionUser?.name || sessionUser?.email || ""
              }
              sessionUserId={sessionUser?.id || ""}
            />
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
