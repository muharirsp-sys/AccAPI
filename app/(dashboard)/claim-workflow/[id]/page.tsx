"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import {
  claimWorkflowStatuses,
  displayClaimStatusLabel,
  isLegacyPekaStatus,
} from "@/lib/claim-workflow/constants";
import {
  type NoClaimRule,
  buildNoClaimFromRule,
  getNoClaimRuleVariants,
  resolveNoClaimRule,
} from "@/lib/claim-workflow/no-claim-rules";

type TransitionAction =
  | "mark_ready"
  | "return_to_draft"
  | "submit_to_principal";

type Workflow = {
  id: string;
  claimWorkflowNo: string;
  offBatchId: string;
  offNoPengajuan?: string | null;
  principleCode: string;
  principleName: string;
  status: string;
  // R7a — Multi No Claim: source type / aggregate status optional pada
  // detail response. Fallback ke "off_program" / status workflow saat
  // field belum ada di payload.
  sourceType?: string | null;
  aggregateStatus?: string | null;
  totalDpp: number;
  totalPpn: number;
  totalPph: number;
  totalClaim: number;
  totalPaid: number;
  remainingAmount: number;
  submittedToPrincipalAt?: string | Date | null;
  claimLetterPdfPath?: string | null;
  claimLetterGeneratedAt?: string | Date | null;
  claimLetterGeneratedBy?: string | null;
  summaryPdfPath?: string | null;
  summaryGeneratedAt?: string | Date | null;
  summaryGeneratedBy?: string | null;
  receiptPdfPath?: string | null;
  receiptGeneratedAt?: string | Date | null;
  receiptGeneratedBy?: string | null;
  noClaim?: string | null;
  noClaimAssignedAt?: string | Date | null;
  noClaimAssignedBy?: string | null;
  noClaimAssignedByName?: string | null;
  closedAt?: string | Date | null;
  closedBy?: string | null;
  closeNote?: string | null;
  paymentDerivedStatus?: string;
  statusDriftWarning?: boolean;
  createdAt: string | Date;
};

type WorkflowItem = {
  id: string;
  noSurat?: string | null;
  jenisPromosi?: string | null;
  periode?: string | null;
  outlet?: string | null;
  dpp: number;
  ppnRate: number;
  ppnAmount: number;
  pphRate: number;
  pphAmount: number;
  nilaiKlaim: number;
  status: string;
  note?: string | null;
  // Phase R7b — Multi No Claim: item dapat di-link ke claim_submission.
  claimSubmissionId?: string | null;
};

// Phase R7b — Multi No Claim: minimal type untuk daftar submission.
type Submission = {
  id: string;
  claimWorkflowId: string;
  noClaim?: string | null;
  scope: string;
  scopeLabel?: string | null;
  status: string;
  totalClaim: number;
  totalPaid: number;
  remainingAmount: number;
  itemCount?: number;
  createdAt: string | Date;
  updatedAt: string | Date;
  // Phase R7c — Documents per submission:
  claimLetterPdfPath?: string | null;
  claimLetterGeneratedAt?: string | Date | null;
  summaryPdfPath?: string | null;
  summaryGeneratedAt?: string | Date | null;
  receiptPdfPath?: string | null;
  receiptGeneratedAt?: string | Date | null;
};

type StaffViewMode = "simple" | "berkas";

const SUBMISSION_SCOPE_OPTIONS: { value: string; label: string }[] = [
  { value: "per_pengajuan", label: "Per Pengajuan" },
  { value: "per_program", label: "Per Program" },
  { value: "per_toko", label: "Per Toko" },
  { value: "per_item", label: "Per Baris / Item" },
  { value: "custom", label: "Custom" },
];

type AuditRow = {
  id: string;
  actorName?: string | null;
  actorRole?: string | null;
  action: string;
  note?: string | null;
  createdAt: string | Date;
};

type Payment = {
  id: string;
  claimSubmissionId?: string | null;
  paymentDate: string;
  paymentAmount: number;
  paymentType?: string | null;
  paymentNote?: string | null;
  createdBy?: string | null;
  voidedAt?: string | Date | null;
  voidedBy?: string | null;
  voidReason?: string | null;
  createdAt: string | Date;
};

type PaymentSummary = {
  totalClaim: number;
  totalPaid: number;
  remainingAmount: number;
  paymentStatus: string;
  persistedStatus?: string;
  paymentDerivedStatus?: string;
  statusDriftWarning?: boolean;
  paymentCount: number;
  activePaymentCount: number;
  voidedPaymentCount: number;
};

type DetailResult = {
  ok?: boolean;
  error?: string;
  workflow?: Workflow;
  items?: WorkflowItem[];
  payments?: Payment[];
  activePayments?: Payment[];
  voidedPayments?: Payment[];
  paymentSummary?: PaymentSummary;
  // Phase R7b — Multi No Claim
  submissions?: Submission[];
  submissionCount?: number;
  hasMultipleSubmissions?: boolean;
  noClaimList?: string[];
  noClaimDisplay?: string | null;
  canEditItems?: boolean;
  isReadOnly?: boolean; // BLOCKER FIX #3: Flag read-only eksplisit
  canGenerateClaimLetter?: boolean;
  canGenerateSummary?: boolean;
  canGenerateReceipt?: boolean;
  canAssignNoClaim?: boolean;
  canGenerateNoClaim?: boolean;
  noClaimGateReason?: string | null;
  offFinanceStatus?: string | null;
  offStatus?: string | null;
  offPaymentSummary?: {
    totalNominal: number;
    totalPaid: number;
    isFullyPaid: boolean;
  } | null;
  activeSubmissionMissingNoClaimCount?: number;
  canRecordPayment?: boolean;
  canVoidPayment?: boolean;
  canClose?: boolean;
  closeBlockers?: string[];
};

type EditDraft = {
  dpp: string;
  ppnRate: string;
  pphRate: string;
  note: string;
};

function rupiah(value: number) {
  return `Rp ${Number(value || 0).toLocaleString("id-ID")}`;
}

function dateText(value: string | Date) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return new Intl.DateTimeFormat("id-ID", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

// Legacy PEKA statuses are displayed in the same tone as Submitted to
// Principal because the PEKA workflow has been retired. The detail page
// must not crash on legacy rows but also must not expose any PEKA action.
function statusTone(status: string) {
  if (status === claimWorkflowStatuses.paid || status === claimWorkflowStatuses.closed) {
    return "border-emerald-500/30 bg-emerald-500/10 text-emerald-300";
  }
  if (status === claimWorkflowStatuses.needRevision || status === claimWorkflowStatuses.cancelled) {
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

const TRANSITION_LABEL: Record<TransitionAction, string> = {
  mark_ready: "Mark Ready",
  return_to_draft: "Return to Draft",
  submit_to_principal: "Submit to Principal",
};

// =============================================================================
// R7 — UX Experiment Helpers (frontend only)
// =============================================================================
// Helpers berikut tidak menyentuh backend. Mereka hanya membantu UI
// merangkum status submission menjadi label step-guidance yang ramah staff.
//
// Aturan tone:
// - warning  → kuning/amber (butuh aksi user)
// - info     → indigo/sky (langkah normal selanjutnya)
// - success  → emerald (selesai / OK)
// - neutral  → slate (informasi netral)

type GuidanceTone = "warning" | "info" | "success" | "neutral";

const SCOPE_DISPLAY_LABEL: Record<string, string> = {
  per_pengajuan: "Per Pengajuan",
  per_program: "Per Program",
  per_toko: "Per Toko",
  per_item: "Per Baris / Item",
  custom: "Custom",
};

const SCOPE_HELPER_TEXT: Record<string, string> = {
  per_pengajuan: "Satu paket untuk seluruh pengajuan.",
  per_program: "Pisahkan klaim berdasarkan program.",
  per_toko: "Pisahkan klaim berdasarkan toko.",
  per_item:
    "Satu item/baris klaim menjadi satu No Claim. Ini paling mirip sheet BASE di Excel.",
  custom: "Pengelompokan manual sesuai kebutuhan.",
};

const SOURCE_TYPE_LABEL: Record<string, string> = {
  off_program: "OFF Program",
  direct_kwitansi: "Direct Kwitansi",
  manual: "Manual",
};

function getScopeDisplayLabel(scope: string | null | undefined): string {
  if (!scope) return "Claim";
  return SCOPE_DISPLAY_LABEL[scope] || scope;
}

function getScopeHelper(scope: string | null | undefined): string {
  if (!scope) return "";
  return SCOPE_HELPER_TEXT[scope] || "";
}

// =============================================================================
// R7g — Excel-style No Claim Generator helpers
// =============================================================================
// Pola Excel Godrej: No Claim = sequence + "/" + distributor + "-" + principal
// + "/" + month(2 digit) + "/" + year(4 digit). Contoh: 01/SUPER-GCPI/02/2026.
//
// Default month/year diambil dari zona Asia/Makassar (UTC+08:00) supaya tidak
// bergantung timezone browser/server.

/**
 * Hasilkan komponen tanggal (year/month/day, 2 digit untuk month/day, 4 digit
 * untuk year) menurut zona Asia/Makassar. Berfungsi di browser dan Node modern
 * via Intl.DateTimeFormat.
 */
function getMakassarDateParts(date: Date = new Date()): {
  year: string;
  month: string;
  day: string;
} {
  try {
    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Makassar",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    const parts = formatter.formatToParts(date);
    const get = (type: string) =>
      parts.find((p) => p.type === type)?.value ?? "";
    const year = get("year").padStart(4, "0");
    const month = get("month").padStart(2, "0");
    const day = get("day").padStart(2, "0");
    if (year && month && day) return { year, month, day };
  } catch {
    // Intl tidak tersedia; fallback di bawah.
  }
  // Fallback aman tanpa timezone (tidak ideal, tetapi mencegah crash).
  const yyyy = String(date.getFullYear()).padStart(4, "0");
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return { year: yyyy, month: mm, day: dd };
}

/**
 * Format sequence sesuai pola Excel: angka 1-9 di-pad jadi 2 digit ("01"),
 * angka 10+ apa adanya, dan string non-numeric apa adanya (trim). Tidak
 * memaksa 3 digit.
 */
function formatNoClaimSequence(value: string): string {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return "";
  if (/^\d+$/.test(trimmed)) {
    const n = Number(trimmed);
    if (Number.isFinite(n) && n >= 1 && n <= 9) {
      return String(n).padStart(2, "0");
    }
    // 10+ → as typed (tetapi buang leading zero ganda kalau ada).
    return String(Number(trimmed));
  }
  return trimmed;
}

type NoClaimGeneratorDraft = {
  sequence: string;
  distributorCode: string;
  principalCode: string;
  month: string;
  year: string;
};

/**
 * Validasi draft generator. Return error message pertama (string) atau null.
 */
function validateNoClaimGenerator(
  draft: NoClaimGeneratorDraft,
): string | null {
  if (!draft.sequence.trim()) return "Nomor urut wajib diisi.";
  if (!draft.distributorCode.trim()) return "Kode distributor wajib diisi.";
  if (!draft.principalCode.trim()) return "Kode principal wajib diisi.";
  const month = draft.month.trim();
  if (!/^\d{2}$/.test(month)) return "Bulan harus 2 digit (01-12).";
  const monthNum = Number(month);
  if (monthNum < 1 || monthNum > 12) return "Bulan harus 01-12.";
  if (!/^\d{4}$/.test(draft.year.trim())) return "Tahun harus 4 digit.";
  return null;
}

/**
 * Build preview string dari draft. Tidak melakukan validasi; caller pakai
 * `validateNoClaimGenerator` terlebih dulu jika ingin tahu valid atau tidak.
 */
function buildNoClaimPreview(draft: NoClaimGeneratorDraft): string {
  const sequence = formatNoClaimSequence(draft.sequence);
  const distributor = draft.distributorCode.trim();
  const principal = draft.principalCode.trim();
  const month = draft.month.trim();
  const year = draft.year.trim();
  if (!sequence || !distributor || !principal || !month || !year) return "";
  return `${sequence}/${distributor}-${principal}/${month}/${year}`;
}

/**
 * Resolve No Claim key from DB principleCode using no-claim-rules mapping.
 * Returns the Excel-style key (e.g. "GCPI" for GDI, "KN" for KINO) or
 * empty string if not mapped.
 */
function resolveNoClaimKeyFromRule(principleCode: string): string {
  const rule = resolveNoClaimRule(principleCode);
  return rule?.noClaimKey ?? "";
}

/**
 * R7h — parse komponen No Claim Excel-style dari string `noClaim`. Pattern:
 * `{sequence}/{distributor}-{principal}/{MM}/{YYYY}`. Bila format tidak
 * cocok, return null. Caller pakai null untuk fallback default Makassar +
 * SUPER/GCPI saat menampilkan No.2 dan Bulan kosong di table.
 */
function parseNoClaimComponents(value: string | null | undefined): {
  sequence: string;
  distributorCode: string;
  principalCode: string;
  month: string;
  year: string;
} | null {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return null;
  const match = trimmed.match(
    /^([A-Za-z0-9]+)\/([A-Za-z0-9]+)-([A-Za-z0-9]+)\/(\d{2})\/(\d{4})$/,
  );
  if (!match) return null;
  return {
    sequence: match[1],
    distributorCode: match[2],
    principalCode: match[3],
    month: match[4],
    year: match[5],
  };
}

function getSubmissionTitle(submission: Submission): string {
  const label = (submission.scopeLabel || "").trim();
  if (label) return label;
  return getScopeDisplayLabel(submission.scope);
}

function getSubmissionDocumentsCompletedCount(submission: Submission): number {
  let count = 0;
  if (submission.claimLetterPdfPath) count += 1;
  if (submission.summaryPdfPath) count += 1;
  if (submission.receiptPdfPath) count += 1;
  return count;
}

function isSubmissionDocumentsComplete(submission: Submission): boolean {
  return getSubmissionDocumentsCompletedCount(submission) >= 3;
}

function isSubmissionClosed(submission: Submission): boolean {
  return submission.status === claimWorkflowStatuses.closed;
}

function getSubmissionRemainingAmount(submission: Submission): number {
  return Number(submission.remainingAmount || 0);
}

function getSubmissionNextAction(submission: Submission): {
  label: string;
  tone: GuidanceTone;
} {
  const noClaimEmpty = !submission.noClaim || !String(submission.noClaim).trim();
  const docsIncomplete = !isSubmissionDocumentsComplete(submission);
  const status = submission.status;
  const remaining = getSubmissionRemainingAmount(submission);

  if (status === claimWorkflowStatuses.closed) {
    return { label: "Selesai", tone: "neutral" };
  }
  if (noClaimEmpty) {
    return { label: "Isi No Claim", tone: "warning" };
  }
  if (docsIncomplete) {
    return { label: "Lengkapi dokumen", tone: "warning" };
  }
  if (
    status === claimWorkflowStatuses.draft ||
    status === claimWorkflowStatuses.needRevision
  ) {
    return { label: "Siap diproses", tone: "info" };
  }
  if (status === claimWorkflowStatuses.readyToSubmit) {
    return { label: "Submit ke principal", tone: "info" };
  }
  if (status === claimWorkflowStatuses.submittedToPrincipal && remaining > 0) {
    return { label: "Menunggu pembayaran", tone: "warning" };
  }
  if (status === claimWorkflowStatuses.partiallyPaid) {
    return { label: "Follow up outstanding", tone: "warning" };
  }
  if (status === claimWorkflowStatuses.paid) {
    return { label: "Close baris", tone: "success" };
  }
  return { label: "Cek detail baris", tone: "neutral" };
}

function getWorkflowGuidance(submissions: Submission[]): {
  message: string;
  tone: GuidanceTone;
} {
  if (submissions.length === 0) {
    return {
      message: "Buat baris claim pertama untuk mulai mengelompokkan item klaim.",
      tone: "info",
    };
  }
  const allClosed = submissions.every((s) => isSubmissionClosed(s));
  if (allClosed) {
    return { message: "Semua baris selesai.", tone: "success" };
  }
  const missingNoClaim = submissions.filter(
    (s) => !s.noClaim || !String(s.noClaim).trim(),
  ).length;
  if (missingNoClaim > 0) {
    return {
      message: `${missingNoClaim} baris belum punya No Claim.`,
      tone: "warning",
    };
  }
  const docsIncomplete = submissions.filter(
    (s) => !isSubmissionDocumentsComplete(s) && !isSubmissionClosed(s),
  ).length;
  if (docsIncomplete > 0) {
    return {
      message: `${docsIncomplete} baris dokumennya belum lengkap.`,
      tone: "warning",
    };
  }
  const outstanding = submissions.filter(
    (s) =>
      !isSubmissionClosed(s) &&
      getSubmissionRemainingAmount(s) > 0 &&
      (s.status === claimWorkflowStatuses.submittedToPrincipal ||
        s.status === claimWorkflowStatuses.partiallyPaid),
  ).length;
  if (outstanding > 0) {
    return {
      message: `${outstanding} baris masih outstanding.`,
      tone: "warning",
    };
  }
  return {
    message: "Pilih baris claim untuk melanjutkan proses.",
    tone: "info",
  };
}

function getGuidanceClass(tone: GuidanceTone): string {
  switch (tone) {
    case "warning":
      return "border-amber-500/30 bg-amber-500/10 text-amber-200";
    case "success":
      return "border-emerald-500/30 bg-emerald-500/10 text-emerald-200";
    case "info":
      return "border-indigo-500/30 bg-indigo-500/10 text-indigo-200";
    default:
      return "border-white/10 bg-white/5 text-slate-300";
  }
}

// R7j — Layout mode dihapus. Halaman hanya punya satu tampilan: Daftar
// Claim (Staff Excel Mode). Konstanta SUBMISSION_LAYOUT_* dan helper
// isAdvancedSubmode/readStoredLayoutMode telah dihapus karena tidak
// dipakai lagi. localStorage key lama (claimWorkflowSubmissionLayoutMode)
// dibiarkan apa adanya — tidak dibaca, tidak ditulis. Boleh dibersihkan
// di phase berikut bila ingin.

// R7 UX experiment — group submissions ke 3 lifecycle stage besar agar
// Status Board mudah dipahami staff non-teknis. Tahap apapun yang butuh
// input user → "needs_action"; sudah jalan tapi belum selesai →
// "in_progress"; sudah closed → "done".
type SubmissionLifecycleStage = "needs_action" | "in_progress" | "done";

function getSubmissionLifecycleStage(
  submission: Submission,
): SubmissionLifecycleStage {
  if (isSubmissionClosed(submission)) return "done";
  const noClaimEmpty =
    !submission.noClaim || !String(submission.noClaim).trim();
  const docsIncomplete = !isSubmissionDocumentsComplete(submission);
  if (noClaimEmpty || docsIncomplete) return "needs_action";
  if (
    submission.status === claimWorkflowStatuses.draft ||
    submission.status === claimWorkflowStatuses.needRevision
  ) {
    return "needs_action";
  }
  if (submission.status === claimWorkflowStatuses.paid) {
    return "needs_action";
  }
  return "in_progress";
}

const LIFECYCLE_STAGES: Array<{
  key: SubmissionLifecycleStage;
  title: string;
  description: string;
  badgeClass: string;
  cardClass: string;
}> = [
  {
    key: "needs_action",
    title: "Butuh Aksi",
    description: "Baris yang menunggu input atau dokumen dari kamu.",
    badgeClass:
      "border-amber-500/30 bg-amber-500/10 text-amber-200",
    cardClass:
      "border-amber-500/20 bg-amber-500/5",
  },
  {
    key: "in_progress",
    title: "Sedang Diproses",
    description: "Baris yang sudah berjalan dan menunggu pembayaran.",
    badgeClass:
      "border-indigo-500/30 bg-indigo-500/10 text-indigo-200",
    cardClass:
      "border-indigo-500/20 bg-indigo-500/5",
  },
  {
    key: "done",
    title: "Selesai",
    description: "Baris yang sudah closed.",
    badgeClass:
      "border-emerald-500/30 bg-emerald-500/10 text-emerald-200",
    cardClass:
      "border-emerald-500/20 bg-emerald-500/5",
  },
];

// =============================================================================
// R7 UX experiment — Shared card render helpers (Single Source of Truth)
// =============================================================================
// Master Detail / Accordion / Kartu / Status Board semuanya menampilkan
// ringkasan paket dengan field yang sama (scope badge, status badge,
// No Claim, totals, dokumen X/3, outstanding, next action). Helper di
// bawah dipakai oleh keempat mode supaya kalau bisnis menambah field
// wajib baru, perubahan cukup di satu tempat.
//
// Tetap pure functions yang return JSX agar tidak menyentuh state komponen
// utama. Caller bertanggung jawab atas wrapper layout (grid/flex/padding).

function SubmissionScopeStatusBadges({
  submission,
}: {
  submission: Submission;
}) {
  return (
    <>
      <span className="rounded-full border border-indigo-500/30 bg-indigo-500/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-indigo-200">
        {getScopeDisplayLabel(submission.scope)}
      </span>
      <span
        className={`rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${statusTone(submission.status)}`}
      >
        {displayClaimStatusLabel(submission.status)}
      </span>
    </>
  );
}

function SubmissionNoClaimLine({
  submission,
  className,
}: {
  submission: Submission;
  className?: string;
}) {
  const noClaimEmpty =
    !submission.noClaim || !String(submission.noClaim).trim();
  if (noClaimEmpty) {
    return (
      <p
        className={`${className ?? ""} font-semibold text-amber-200`.trim()}
      >
        Belum ada No Claim
      </p>
    );
  }
  return (
    <p className={`${className ?? ""} font-mono text-emerald-200`.trim()}>
      {submission.noClaim}
    </p>
  );
}

function SubmissionNextActionBadge({
  submission,
}: {
  submission: Submission;
}) {
  const next = getSubmissionNextAction(submission);
  return (
    <span
      className={`rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${getGuidanceClass(next.tone)}`}
    >
      {next.label}
    </span>
  );
}

function SubmissionMetaRow({
  submission,
  showItems = true,
  abbreviated = false,
}: {
  submission: Submission;
  showItems?: boolean;
  abbreviated?: boolean;
}) {
  const docsCount = getSubmissionDocumentsCompletedCount(submission);
  const remaining = getSubmissionRemainingAmount(submission);
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-400">
      <span>{rupiah(submission.totalClaim)}</span>
      {showItems && (
        <>
          <span className="text-slate-600">·</span>
          <span>{submission.itemCount ?? 0} item</span>
        </>
      )}
      <span className="text-slate-600">·</span>
      <span
        className={
          docsCount === 3 ? "text-emerald-300" : "text-amber-300"
        }
      >
        {abbreviated ? `Dok ${docsCount}/3` : `Dokumen ${docsCount}/3`}
      </span>
      {remaining > 0 && (
        <>
          <span className="text-slate-600">·</span>
          <span className="text-amber-300">
            {abbreviated
              ? rupiah(remaining)
              : `Outstanding ${rupiah(remaining)}`}
          </span>
        </>
      )}
    </div>
  );
}

export default function ClaimWorkflowDetailPage() {
  const params = useParams<{ id: string }>();
  const searchParams = useSearchParams();
  const id = String(params.id || "");
  const focusNoClaim = searchParams.get("focus") === "no-claim";
  const noClaimSectionRef = useRef<HTMLDivElement>(null);
  const [workflow, setWorkflow] = useState<Workflow | null>(null);
  const [items, setItems] = useState<WorkflowItem[]>([]);
  const [audit, setAudit] = useState<AuditRow[]>([]);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [paymentSummary, setPaymentSummary] = useState<PaymentSummary | null>(null);
  const [canEditItems, setCanEditItems] = useState(false);
  const [isReadOnly, setIsReadOnly] = useState(false);
  const [canGenerateClaimLetter, setCanGenerateClaimLetter] = useState(false);
  const [canGenerateSummary, setCanGenerateSummary] = useState(false);
  const [canGenerateReceipt, setCanGenerateReceipt] = useState(false);
  const [canAssignNoClaim, setCanAssignNoClaim] = useState(false);
  const [canRecordPayment, setCanRecordPayment] = useState(false);
  const [canVoidPayment, setCanVoidPayment] = useState(false);
  const [canClose, setCanClose] = useState(false);
  const [closeBlockers, setCloseBlockers] = useState<string[]>([]);
  const [canGenerateNoClaim, setCanGenerateNoClaim] = useState(false);
  const [noClaimGateReason, setNoClaimGateReason] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [auditError, setAuditError] = useState("");
  const [message, setMessage] = useState("");
  const [editingId, setEditingId] = useState("");
  const [savingId, setSavingId] = useState("");
  const [draft, setDraft] = useState<EditDraft | null>(null);
  const [transitionLoading, setTransitionLoading] = useState<TransitionAction | "">("");
  const [generatingLetter, setGeneratingLetter] = useState(false);
  const [generatingSummary, setGeneratingSummary] = useState(false);
  const [generatingReceipt, setGeneratingReceipt] = useState(false);
  const [noClaimDraft, setNoClaimDraft] = useState("");
  const [noClaimSaving, setNoClaimSaving] = useState(false);
  const [noClaimEditing, setNoClaimEditing] = useState(false);
  const [paymentDraft, setPaymentDraft] = useState({
    paymentDate: new Date().toISOString().slice(0, 10),
    paymentAmount: "",
    paymentType: "Transfer",
    paymentNote: "",
  });
  const [paymentSaving, setPaymentSaving] = useState(false);
  const [voidingId, setVoidingId] = useState("");
  const [closeNote, setCloseNote] = useState("");
  const [closeSaving, setCloseSaving] = useState(false);
  // Phase R7b — Multi No Claim:
  // State minimal untuk section Submissions. Mark Ready / dokumen /
  // payment masih di workflow-level sampai R7c/R7d.
  const [submissions, setSubmissions] = useState<Submission[]>([]);
  const [submissionCount, setSubmissionCount] = useState(0);
  const [hasMultipleSubmissions, setHasMultipleSubmissions] = useState(false);
  const [createSubmissionScope, setCreateSubmissionScope] = useState("per_pengajuan");
  const [createSubmissionLabel, setCreateSubmissionLabel] = useState("");
  const [createSubmissionNoClaim, setCreateSubmissionNoClaim] = useState("");
  const [creatingSubmission, setCreatingSubmission] = useState(false);
  const [movingItemId, setMovingItemId] = useState("");
  // Phase R7c — Documents per submission: state generate per submission +
  // type. Key = `${submissionId}:${type}` supaya tombol per kombinasi
  // bisa disabled secara independen.
  const [generatingDocKey, setGeneratingDocKey] = useState("");
  // R7j — Layout mode dihilangkan total. Halaman hanya punya satu
  // tampilan: Daftar Claim. Konstanta `submissionLayoutMode` tetap
  // disediakan dengan nilai "excel" supaya beberapa branching kondisional
  // (mis. tombol "Kelola Detail" yang sebelumnya pindah mode) bisa
  // ditangani sebagai no-op tanpa harus menghapus seluruh referensinya
  // di sesi ini. Tidak ada localStorage read/write.
  const submissionLayoutMode = "excel" as const;
  const setSubmissionLayoutMode = (_mode: string) => {
    // no-op: layout mode dihapus di R7j; "Kelola Detail" tetap ada tapi
    // diarahkan ke Detail Claim panel inline.
    void _mode;
  };
  const [selectedSubmissionId, setSelectedSubmissionId] = useState<string | null>(
    null,
  );
  const [openSubmissionIds, setOpenSubmissionIds] = useState<string[]>([]);
  const [showCreateSubmissionForm, setShowCreateSubmissionForm] = useState(false);
  // R7j — Detail Claim row inline. Hanya satu row bisa expand pada satu
  // waktu. Klik "Detail" / "Kelola Detail" toggle expansion.
  const [excelDetailRowId, setExcelDetailRowId] = useState<string>("");
  const [staffViewMode, setStaffViewMode] = useState<StaffViewMode>("simple");
  // R7j — Panduan Kerja Claim collapsible help. Default collapsed.
  const [showPanduan, setShowPanduan] = useState(false);
  // R7j corrective — Riwayat / Audit collapsible untuk detail internal.
  // dipindah ke section ini agar default view fokus ke tabel Daftar
  // Claim. Default collapsed.
  const [showTechnical, setShowTechnical] = useState(false);
  // Per-submission No Claim editor state. Map submissionId → draft value.
  // Editor aktif ditandai oleh `submissionNoClaimEditingId`. Saving id
  // mencegah double click.
  const [submissionNoClaimDraft, setSubmissionNoClaimDraft] = useState<
    Record<string, string>
  >({});
  const [submissionNoClaimEditingId, setSubmissionNoClaimEditingId] =
    useState<string>("");
  const [submissionNoClaimSavingId, setSubmissionNoClaimSavingId] =
    useState<string>("");
  // R7g — Excel-style No Claim generator state.
  // Per submission: mode (manual | generate) + draft komponen generator.
  // Default month/year diambil dari Asia/Makassar saat mount; user boleh
  // menggantinya. Tidak dikirim ke backend; preview murni di-derive.
  const [submissionGeneratorMode, setSubmissionGeneratorMode] = useState<
    Record<string, "manual" | "generate">
  >({});
  const [submissionGeneratorDraft, setSubmissionGeneratorDraft] = useState<
    Record<string, NoClaimGeneratorDraft>
  >({});
  // R7g — Per Item action state.
  const [creatingPerItem, setCreatingPerItem] = useState(false);
  // R7h — Excel Input Mode state. Draft per item (No.2 + Bulan + DPP/PPN/PPH).
  // Tax (DPP/PPN/PPH) inline edit ke PATCH /items/[itemId] yang sudah ada
  // (ppnRate/pphRate). No Claim tetap di-save lewat PATCH submission.
  // Toolbar punya global generator settings (distributor/principal/year)
  // supaya kolom No.2 + Bulan per row tetap ringkas.
  const [excelDistributorCode, setExcelDistributorCode] = useState("SUPER");
  const [excelPrincipalCode, setExcelPrincipalCode] = useState("");
  const [excelVariantKey, setExcelVariantKey] = useState<string>("");
  const [excelYear, setExcelYear] = useState("2026");
  const [excelDefaultMonth, setExcelDefaultMonth] = useState("01");
  const [excelSearch, setExcelSearch] = useState("");
  const [excelStatusFilter, setExcelStatusFilter] = useState<
    "all" | "needs_no_claim" | "needs_docs" | "outstanding" | "paid" | "closed"
  >("all");
  type ExcelRowDraft = {
    sequence: string;
    month: string;
    noClaimDraft: string;
    dpp: string;
    ppnRate: string;
    pphRate: string;
    initialNoClaim: string;
    initialDpp: string;
    initialPpnRate: string;
    initialPphRate: string;
  };
  const [excelRowDrafts, setExcelRowDrafts] = useState<
    Record<string, ExcelRowDraft>
  >({});
  const [excelRowSavingId, setExcelRowSavingId] = useState<string>("");
  // Track items yang sudah pernah di-init agar perubahan default toolbar
  // (year/month) tidak menimpa draft user yang aktif.
  const excelInitializedItemsRef = useRef<Set<string>>(new Set());

  const loadDetail = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError("");
    setAuditError("");
    try {
      const response = await fetch(`/api/claim-workflow/${id}`, {
        cache: "no-store",
      });
      const result = (await response.json()) as DetailResult;
      if (!response.ok || !result.ok || !result.workflow) {
        throw new Error(result.error || "Gagal memuat detail Claim Workflow.");
      }
      setWorkflow(result.workflow);
      setItems(result.items || []);
      setPayments(result.payments || []);
      setPaymentSummary(result.paymentSummary || null);
      setCanEditItems(Boolean(result.canEditItems));
      setIsReadOnly(Boolean(result.isReadOnly)); // BLOCKER FIX #3: Flag read-only eksplisit dari backend
      setCanGenerateClaimLetter(Boolean(result.canGenerateClaimLetter));
      setCanGenerateSummary(Boolean(result.canGenerateSummary));
      setCanGenerateReceipt(Boolean(result.canGenerateReceipt));
      setCanAssignNoClaim(Boolean(result.canAssignNoClaim));
      setCanRecordPayment(Boolean(result.canRecordPayment));
      setCanVoidPayment(Boolean(result.canVoidPayment));
      setCanClose(Boolean(result.canClose));
      setCloseBlockers(result.closeBlockers || []);
      setCanGenerateNoClaim(Boolean(result.canGenerateNoClaim));
      setNoClaimGateReason(result.noClaimGateReason ?? null);
      // Phase R7b — Multi No Claim: populate submissions list.
      setSubmissions(result.submissions || []);
      setSubmissionCount(result.submissionCount ?? (result.submissions?.length ?? 0));
      setHasMultipleSubmissions(Boolean(result.hasMultipleSubmissions));
      // Sinkronkan draft input dengan nilai No Claim terbaru, kecuali user
      // sedang mengetik (noClaimEditing true).
      if (!noClaimEditing) {
        setNoClaimDraft(result.workflow.noClaim || "");
      }

      const auditResponse = await fetch(`/api/claim-workflow/${id}/audit`, {
        cache: "no-store",
      });
      const auditResult = (await auditResponse.json()) as {
        ok?: boolean;
        error?: string;
        audit?: AuditRow[];
      };
      if (auditResponse.ok && auditResult.ok) {
        setAudit(auditResult.audit || []);
      } else {
        setAudit([]);
        setAuditError(auditResult.error || "Audit tidak tersedia untuk role ini.");
      }
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : "Gagal memuat detail Claim Workflow.",
      );
    } finally {
      setLoading(false);
    }
  }, [id, noClaimEditing]);

  useEffect(() => {
    void loadDetail();
  }, [loadDetail]);

  // Auto-scroll to No Claim section when ?focus=no-claim is present
  useEffect(() => {
    if (focusNoClaim && !loading && noClaimSectionRef.current) {
      noClaimSectionRef.current.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [focusNoClaim, loading]);

  // R7j — Layout mode dihapus. useEffect hidrasi dan persist
  // localStorage untuk submissionLayoutMode tidak dibutuhkan lagi.

  // R7 UX experiment — sinkronkan selected submission setelah submissions
  // berubah (load awal, create, delete, dsb).
  useEffect(() => {
    if (submissions.length === 0) {
      if (selectedSubmissionId !== null) setSelectedSubmissionId(null);
      return;
    }
    const stillExists = submissions.some((s) => s.id === selectedSubmissionId);
    if (!selectedSubmissionId || !stillExists) {
      setSelectedSubmissionId(submissions[0].id);
    }
  }, [submissions, selectedSubmissionId]);

  // R7j — accordion default open effect dihapus karena layout Accordion
  // tidak ada lagi. State openSubmissionIds masih ada untuk type
  // backward-compat tapi tidak dirender di mana pun.

  // R7h — initial default toolbar month/year dari Asia/Makassar saat mount.
  // Setelah itu user boleh ganti, tidak di-overwrite ulang.
  const excelToolbarInitializedRef = useRef(false);
  useEffect(() => {
    if (excelToolbarInitializedRef.current) return;
    excelToolbarInitializedRef.current = true;
    const parts = getMakassarDateParts();
    setExcelDefaultMonth(parts.month);
    setExcelYear(parts.year);
  }, []);

  // Resolve current No Claim rule from toolbar principal code + variant.
  const excelCurrentRule: NoClaimRule | undefined = excelPrincipalCode
    ? resolveNoClaimRule(excelPrincipalCode, excelVariantKey || undefined)
    : undefined;
  const excelVariants = excelPrincipalCode
    ? getNoClaimRuleVariants(excelPrincipalCode)
    : [];
  const excelHasVariants = excelVariants.length > 0;

  // R7h — sinkronkan principal default dari workflow.principleCode (via rule).
  useEffect(() => {
    if (!workflow) return;
    const key = resolveNoClaimKeyFromRule(workflow.principleCode);
    setExcelPrincipalCode((prev) => (prev === "" || prev === "GCPI") ? key : prev);
    // Set default variant jika rule punya variants.
    const variants = getNoClaimRuleVariants(workflow.principleCode);
    if (variants.length > 0 && !excelVariantKey) {
      setExcelVariantKey(variants[0].variantKey);
    }
  }, [workflow]);

  // R7h — initialize draft per item saat items berubah. Item baru / belum
  // pernah ter-init akan diisi dari current data + parsing No Claim.
  // Item yang sudah ter-init tidak dipaksa reset (preserve user editing).
  useEffect(() => {
    if (items.length === 0) {
      excelInitializedItemsRef.current = new Set();
      setExcelRowDrafts({});
      return;
    }
    const submissionByItem = new Map<string, Submission>();
    for (const sub of submissions) {
      // do nothing here; lookup by item.claimSubmissionId below
      void sub;
    }
    setExcelRowDrafts((prev) => {
      const next: Record<string, ExcelRowDraft> = { ...prev };
      const seen = new Set<string>();
      for (const item of items) {
        seen.add(item.id);
        if (excelInitializedItemsRef.current.has(item.id)) continue;
        const sub = submissions.find((s) => s.id === item.claimSubmissionId) ||
          null;
        const noClaim = sub?.noClaim || "";
        const parsed = parseNoClaimComponents(noClaim);
        next[item.id] = {
          sequence: parsed?.sequence ?? "",
          month: parsed?.month ?? excelDefaultMonth,
          noClaimDraft: noClaim,
          dpp: String(item.dpp ?? 0),
          ppnRate: String(item.ppnRate ?? 0),
          pphRate: String(item.pphRate ?? 0),
          initialNoClaim: noClaim,
          initialDpp: String(item.dpp ?? 0),
          initialPpnRate: String(item.ppnRate ?? 0),
          initialPphRate: String(item.pphRate ?? 0),
        };
        excelInitializedItemsRef.current.add(item.id);
      }
      // Drop drafts untuk item yang sudah hilang.
      for (const draftId of Object.keys(next)) {
        if (!seen.has(draftId)) {
          delete next[draftId];
          excelInitializedItemsRef.current.delete(draftId);
        }
      }
      // Bila server me-refresh data (mis. setelah save), sync initial
      // baseline tanpa overwrite draft text yang masih dirty.
      for (const item of items) {
        const draft = next[item.id];
        if (!draft) continue;
        const sub = submissions.find((s) => s.id === item.claimSubmissionId) ||
          null;
        const noClaim = sub?.noClaim || "";
        next[item.id] = {
          ...draft,
          initialNoClaim: noClaim,
          initialDpp: String(item.dpp ?? 0),
          initialPpnRate: String(item.ppnRate ?? 0),
          initialPphRate: String(item.pphRate ?? 0),
        };
      }
      return next;
    });
  }, [items, submissions, excelDefaultMonth]);

  // BLOCKER FIX #3: Editable hanya jika bukan read-only dan status Draft/Need Revision
  const editable =
    canEditItems &&
    !isReadOnly &&
    (workflow?.status === claimWorkflowStatuses.draft ||
      workflow?.status === claimWorkflowStatuses.needRevision);
  const noClaimEditable =
    canAssignNoClaim &&
    (workflow?.status === claimWorkflowStatuses.draft ||
      workflow?.status === claimWorkflowStatuses.needRevision);
  const noClaimLockedReason = !canAssignNoClaim
    ? "Role Anda tidak dapat mengubah No Claim."
    : workflow?.status && !noClaimEditable
      ? "No Claim hanya bisa diisi saat status Draft atau Need Revision."
      : "";

  const startEdit = (item: WorkflowItem) => {
    setMessage("");
    setEditingId(item.id);
    setDraft({
      dpp: String(item.dpp),
      ppnRate: String(item.ppnRate),
      pphRate: String(item.pphRate),
      note: item.note || "",
    });
  };

  const saveEdit = async (itemId: string) => {
    if (!draft) return;
    setSavingId(itemId);
    setMessage("");
    try {
      const response = await fetch(`/api/claim-workflow/${id}/items/${itemId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draft),
      });
      const result = (await response.json()) as { ok?: boolean; error?: string };
      if (!response.ok || !result.ok) {
        throw new Error(result.error || "Gagal menyimpan perubahan pajak item.");
      }
      setEditingId("");
      setDraft(null);
      setMessage("Nilai pajak item tersimpan dan total Claim Workflow telah dihitung ulang.");
      await loadDetail();
    } catch (saveError) {
      setMessage(
        saveError instanceof Error
          ? saveError.message
          : "Gagal menyimpan perubahan pajak item.",
      );
    } finally {
      setSavingId("");
    }
  };

  const runTransition = useCallback(
    async (action: TransitionAction) => {
      if (!workflow) return;
      let note: string | undefined;
      if (action === "submit_to_principal") {
        const confirmed =
          typeof window !== "undefined"
            ? window.confirm(
                "Submit Claim Workflow ini ke Principal? Item pajak akan dikunci setelah ini.",
              )
            : true;
        if (!confirmed) return;
      } else if (action === "return_to_draft") {
        // Backend mewajibkan note non-kosong untuk return_to_draft karena
        // aksi ini menginvalidasi tiga dokumen aktif (Claim Letter, Summary,
        // Kwitansi) dan membuka kembali tax editing. Tolak input kosong di
        // sisi UI sebelum hit API.
        if (typeof window === "undefined") return;
        const reason = window.prompt(
          "Alasan mengembalikan Claim Workflow ke Draft (wajib diisi):",
          "",
        );
        if (reason === null) return;
        const trimmed = reason.trim();
        if (!trimmed) {
          const blankMessage = "Alasan wajib diisi saat mengembalikan Claim Workflow ke Draft.";
          toast.error(blankMessage);
          setMessage(blankMessage);
          return;
        }
        note = trimmed;
      }
      setTransitionLoading(action);
      setMessage("");
      try {
        const response = await fetch(`/api/claim-workflow/${id}/status`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(note ? { action, note } : { action }),
        });
        const result = (await response.json()) as {
          ok?: boolean;
          error?: string;
          workflow?: { status?: string };
        };
        if (!response.ok || !result.ok) {
          throw new Error(result.error || "Gagal mengubah status Claim Workflow.");
        }
        const successMessage =
          action === "mark_ready"
            ? "Status diubah menjadi Ready to Submit."
            : action === "return_to_draft"
              ? "Status dikembalikan ke Draft."
              : "Claim Workflow berhasil disubmit ke Principal.";
        toast.success(successMessage);
        setMessage(successMessage);
        await loadDetail();
      } catch (transitionError) {
        const errorMessage =
          transitionError instanceof Error
            ? transitionError.message
            : "Gagal mengubah status Claim Workflow.";
        toast.error(errorMessage);
        setMessage(errorMessage);
      } finally {
        setTransitionLoading("");
      }
    },
    [id, loadDetail, workflow],
  );

  const generateClaimLetter = async () => {
    setGeneratingLetter(true);
    setMessage("");
    try {
      const response = await fetch(`/api/claim-workflow/${id}/claim-letter`, {
        method: "POST",
      });
      const result = (await response.json()) as { ok?: boolean; error?: string };
      if (!response.ok || !result.ok) {
        throw new Error(result.error || "Gagal membuat Claim Letter PDF.");
      }
      const successMessage = "Claim Letter PDF berhasil dibuat.";
      toast.success(successMessage);
      setMessage(successMessage);
      await loadDetail();
    } catch (generateError) {
      const errorMessage =
        generateError instanceof Error
          ? generateError.message
          : "Gagal membuat Claim Letter PDF.";
      toast.error(errorMessage);
      setMessage(errorMessage);
    } finally {
      setGeneratingLetter(false);
    }
  };

  const generateClaimSummary = async () => {
    setGeneratingSummary(true);
    setMessage("");
    try {
      const response = await fetch(`/api/claim-workflow/${id}/summary`, {
        method: "POST",
      });
      const result = (await response.json()) as { ok?: boolean; error?: string };
      if (!response.ok || !result.ok) {
        throw new Error(result.error || "Gagal membuat Claim Summary PDF.");
      }
      const successMessage = "Claim Summary PDF berhasil dibuat.";
      toast.success(successMessage);
      setMessage(successMessage);
      await loadDetail();
    } catch (generateError) {
      const errorMessage =
        generateError instanceof Error
          ? generateError.message
          : "Gagal membuat Claim Summary PDF.";
      toast.error(errorMessage);
      setMessage(errorMessage);
    } finally {
      setGeneratingSummary(false);
    }
  };

  const generateClaimReceipt = async () => {
    setGeneratingReceipt(true);
    setMessage("");
    try {
      const response = await fetch(`/api/claim-workflow/${id}/receipt`, {
        method: "POST",
      });
      const result = (await response.json()) as { ok?: boolean; error?: string };
      if (!response.ok || !result.ok) {
        throw new Error(result.error || "Gagal membuat Kwitansi Claim PDF.");
      }
      const successMessage = "Kwitansi Claim PDF berhasil dibuat.";
      toast.success(successMessage);
      setMessage(successMessage);
      await loadDetail();
    } catch (generateError) {
      const errorMessage =
        generateError instanceof Error
          ? generateError.message
          : "Gagal membuat Kwitansi Claim PDF.";
      toast.error(errorMessage);
      setMessage(errorMessage);
    } finally {
      setGeneratingReceipt(false);
    }
  };

  const submitNoClaim = async () => {
    const trimmed = noClaimDraft.trim();
    if (!trimmed) {
      const blankMessage = "No Claim tidak boleh kosong.";
      toast.error(blankMessage);
      setMessage(blankMessage);
      return;
    }
    setNoClaimSaving(true);
    setMessage("");
    try {
      const response = await fetch(`/api/claim-workflow/${id}/no-claim`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ noClaim: trimmed }),
      });
      const result = (await response.json()) as {
        ok?: boolean;
        error?: string;
        sync?: { syncedItemCount?: number };
      };
      if (!response.ok || !result.ok) {
        throw new Error(result.error || "Gagal menyimpan No Claim.");
      }
      const syncedItemCount = result.sync?.syncedItemCount ?? 0;
      const successMessage = `No Claim tersimpan dan sync ke ${syncedItemCount} OFF item.`;
      toast.success(successMessage);
      setMessage(successMessage);
      setNoClaimEditing(false);
      await loadDetail();
    } catch (saveError) {
      const errorMessage =
        saveError instanceof Error
          ? saveError.message
          : "Gagal menyimpan No Claim.";
      toast.error(errorMessage);
      setMessage(errorMessage);
    } finally {
      setNoClaimSaving(false);
    }
  };

  const submitPayment = async () => {
    const amount = Number(paymentDraft.paymentAmount);
    if (!paymentDraft.paymentDate || !/^\d{4}-\d{2}-\d{2}$/.test(paymentDraft.paymentDate)) {
      toast.error("Tanggal bayar wajib diisi (YYYY-MM-DD).");
      return;
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      toast.error("Nominal bayar harus lebih dari 0.");
      return;
    }

    let paymentUrl = `/api/claim-workflow/${id}/payments`;
    if (hasMultipleSubmissions) {
      const targetSubmissionId =
        selectedDetailSubmission?.id ||
        selectedSubmissionId ||
        null;
      if (!targetSubmissionId) {
        toast.error("Pilih Berkas Claim terlebih dahulu.");
        return;
      }
      paymentUrl = `/api/claim-workflow/${id}/submissions/${targetSubmissionId}/payments`;
    }

    setPaymentSaving(true);
    setMessage("");
    try {
      const response = await fetch(paymentUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          paymentDate: paymentDraft.paymentDate,
          paymentAmount: amount,
          paymentType: paymentDraft.paymentType.trim() || null,
          paymentNote: paymentDraft.paymentNote.trim() || null,
        }),
      });
      const result = (await response.json()) as {
        ok?: boolean;
        error?: string;
        statusChanged?: boolean;
        workflow?: { status?: string };
      };
      if (!response.ok || !result.ok) {
        throw new Error(result.error || "Gagal mencatat pembayaran.");
      }
      const successMessage = result.statusChanged
        ? `Pembayaran tersimpan. Status berubah menjadi ${result.workflow?.status || ""}.`
        : "Pembayaran tersimpan.";
      toast.success(successMessage);
      setMessage(successMessage);
      setPaymentDraft({
        paymentDate: new Date().toISOString().slice(0, 10),
        paymentAmount: "",
        paymentType: paymentDraft.paymentType,
        paymentNote: "",
      });
      await loadDetail();
    } catch (saveError) {
      const errorMessage = saveError instanceof Error
        ? saveError.message
        : "Gagal mencatat pembayaran.";
      toast.error(errorMessage);
      setMessage(errorMessage);
    } finally {
      setPaymentSaving(false);
    }
  };

  const voidPayment = async (payment: Payment) => {
    if (typeof window === "undefined") return;
    const reason = window.prompt(
      "Alasan void pembayaran (wajib diisi):",
      "",
    );
    if (reason === null) return;
    const trimmed = reason.trim();
    if (!trimmed) {
      toast.error("Alasan void wajib diisi.");
      return;
    }

    let voidUrl = `/api/claim-workflow/${id}/payments/${payment.id}/void`;
    if (hasMultipleSubmissions) {
      const targetSubmissionId =
        payment.claimSubmissionId ||
        selectedDetailSubmission?.id ||
        selectedSubmissionId ||
        null;
      if (!targetSubmissionId) {
        toast.error("Pilih Berkas Claim terlebih dahulu.");
        return;
      }
      voidUrl = `/api/claim-workflow/${id}/submissions/${targetSubmissionId}/payments/${payment.id}/void`;
    }

    setVoidingId(payment.id);
    setMessage("");
    try {
      const response = await fetch(
        voidUrl,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reason: trimmed }),
        },
      );
      const result = (await response.json()) as {
        ok?: boolean;
        error?: string;
        statusChanged?: boolean;
        workflow?: { status?: string };
      };
      if (!response.ok || !result.ok) {
        throw new Error(result.error || "Gagal void pembayaran.");
      }
      const successMessage = result.statusChanged
        ? `Pembayaran di-void. Status kembali ke ${result.workflow?.status || ""}.`
        : "Pembayaran di-void.";
      toast.success(successMessage);
      setMessage(successMessage);
      await loadDetail();
    } catch (voidError) {
      const errorMessage = voidError instanceof Error
        ? voidError.message
        : "Gagal void pembayaran.";
      toast.error(errorMessage);
      setMessage(errorMessage);
    } finally {
      setVoidingId("");
    }
  };

  // Phase R7b - Multi No Claim: handler create submission baru.
  const submitCreateSubmission = async () => {
    if (!workflow) return;
    setCreatingSubmission(true);
    setMessage("");
    try {
      const body: Record<string, string> = { scope: createSubmissionScope };
      const labelTrimmed = createSubmissionLabel.trim();
      if (labelTrimmed) body.scopeLabel = labelTrimmed;
      const noClaimTrimmed = createSubmissionNoClaim.trim();
      if (noClaimTrimmed) body.noClaim = noClaimTrimmed;
      const response = await fetch(`/api/claim-workflow/${id}/submissions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = (await response.json()) as {
        ok?: boolean;
        error?: string;
        submission?: { id?: string };
      };
      if (!response.ok || !result.ok) {
        throw new Error(result.error || "Gagal menyiapkan baris claim.");
      }
      const successMessage = "Baris claim baru tersimpan.";
      toast.success(successMessage);
      setMessage(successMessage);
      setCreateSubmissionLabel("");
      setCreateSubmissionNoClaim("");
      setCreateSubmissionScope("per_pengajuan");
      setShowCreateSubmissionForm(false);
      // R7 UX — pilih submission baru di Master Detail jika response
      // membawa id. Tanpa id, useEffect sync akan fallback ke first.
      if (result.submission?.id) {
        setSelectedSubmissionId(result.submission.id);
      }
      await loadDetail();
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Gagal menyiapkan baris claim.";
      toast.error(errorMessage);
      setMessage(errorMessage);
    } finally {
      setCreatingSubmission(false);
    }
  };

  // R7 UX experiment — handler save No Claim per submission. Pakai
  // endpoint PATCH submission yang sudah ada (R7b). Validasi non-empty
  // di client; backend menolak empty dengan code submission-specific.
  const submitSubmissionNoClaim = async (submissionId: string) => {
    const draft = submissionNoClaimDraft[submissionId] ?? "";
    const trimmed = draft.trim();
    if (!trimmed) {
      const blankMessage = "No Claim wajib diisi.";
      toast.error(blankMessage);
      setMessage(blankMessage);
      return;
    }
    setSubmissionNoClaimSavingId(submissionId);
    setMessage("");
    try {
      const response = await fetch(
        `/api/claim-workflow/${id}/submissions/${submissionId}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ noClaim: trimmed }),
        },
      );
      const result = (await response.json()) as { ok?: boolean; error?: string };
      if (!response.ok || !result.ok) {
        throw new Error(result.error || "Gagal menyimpan No Claim.");
      }
      toast.success("No Claim tersimpan.");
      setMessage("No Claim tersimpan.");
      setSubmissionNoClaimEditingId("");
      await loadDetail();
    } catch (err) {
      const errorMessage =
        err instanceof Error ? err.message : "Gagal menyimpan No Claim.";
      toast.error(errorMessage);
      setMessage(errorMessage);
    } finally {
      setSubmissionNoClaimSavingId("");
    }
  };

  // R7g — Handler initialize generator draft + mode untuk satu submission.
  // Dipanggil saat user pertama kali switch ke mode "Generate dari Excel".
  // Default month/year dari Asia/Makassar; principal code dari rule mapping.
  const ensureGeneratorDraft = (submissionId: string) => {
    if (submissionGeneratorDraft[submissionId]) return;
    const parts = getMakassarDateParts();
    const principal = workflow?.principleCode
      ? resolveNoClaimKeyFromRule(workflow.principleCode)
      : "";
    setSubmissionGeneratorDraft((prev) => ({
      ...prev,
      [submissionId]: {
        sequence: "",
        distributorCode: "SUPER",
        principalCode: principal,
        month: parts.month,
        year: parts.year,
      },
    }));
  };

  // R7g — Handler "Siapkan Baris Claim": panggil endpoint
  // submissions/from-items mode all_unassigned. Tidak menghapus baris lama.
  // Tidak auto-generate No Claim.
  const submitCreatePerItem = async () => {
    if (!workflow) return;
    const confirmed =
      typeof window !== "undefined"
        ? window.confirm(
            "Siapkan satu baris claim untuk setiap item yang belum siap? Baris lama tidak akan dihapus.",
          )
        : true;
    if (!confirmed) return;
    setCreatingPerItem(true);
    setMessage("");
    try {
      const response = await fetch(
        `/api/claim-workflow/${id}/submissions/from-items`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mode: "all_unassigned" }),
        },
      );
      const result = (await response.json()) as {
        ok?: boolean;
        error?: string;
        createdCount?: number;
        skippedCount?: number;
      };
      if (!response.ok || !result.ok) {
        throw new Error(result.error || "Gagal menyiapkan baris claim.");
      }
      const createdCount = result.createdCount ?? 0;
      const successMessage = createdCount > 0
        ? `${createdCount} baris claim disiapkan.`
        : "Semua baris claim sudah siap.";
      toast.success(successMessage);
      setMessage(successMessage);
      await loadDetail();
    } catch (err) {
      const errorMessage = err instanceof Error
        ? err.message
        : "Gagal menyiapkan baris claim.";
      toast.error(errorMessage);
      setMessage(errorMessage);
    } finally {
      setCreatingPerItem(false);
    }
  };

  // R7h — Excel Input Mode handler: simpan satu row table.
  // Memanggil PATCH item (DPP/PPN/PPH) bila tax dirty, dan PATCH submission
  // (noClaim) bila No Claim dirty. Mengambil endpoint existing R7b/R7c
  // tanpa membuat API baru. Tidak auto-save; dipanggil dari tombol "Simpan".
  const saveExcelRow = async (item: WorkflowItem) => {
    const draft = excelRowDrafts[item.id];
    if (!draft) return;
    const submission = submissions.find(
      (s) => s.id === item.claimSubmissionId,
    );
    const taxDirty =
      String(draft.dpp) !== String(draft.initialDpp) ||
      String(draft.ppnRate) !== String(draft.initialPpnRate) ||
      String(draft.pphRate) !== String(draft.initialPphRate);
    const noClaimTrimmed = draft.noClaimDraft.trim();
    const noClaimDirty = noClaimTrimmed !== String(draft.initialNoClaim || "");

    if (!taxDirty && !noClaimDirty) {
      toast.info?.("Tidak ada perubahan untuk disimpan.");
      return;
    }

    // Validasi tax (mirror backend route).
    if (taxDirty) {
      const dpp = Number(draft.dpp);
      const ppn = Number(draft.ppnRate);
      const pph = Number(draft.pphRate);
      if (!Number.isFinite(dpp) || dpp < 0) {
        toast.error("DPP harus angka >= 0.");
        return;
      }
      if (!Number.isFinite(ppn) || ppn < 0 || ppn > 100) {
        toast.error("PPN % harus angka 0-100.");
        return;
      }
      if (!Number.isFinite(pph) || pph < 0 || pph > 100) {
        toast.error("PPH % harus angka 0-100.");
        return;
      }
    }
    // Validasi No Claim.
    if (noClaimDirty) {
      if (!noClaimTrimmed) {
        toast.error("No Claim wajib diisi.");
        return;
      }
      if (!submission) {
        toast.error(
          "Baris ini belum memiliki assignment. Hubungi admin untuk menyiapkan data.",
        );
        return;
      }
    }

    setExcelRowSavingId(item.id);
    setMessage("");
    try {
      if (taxDirty) {
        const response = await fetch(
          `/api/claim-workflow/${id}/items/${item.id}`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              dpp: draft.dpp,
              ppnRate: draft.ppnRate,
              pphRate: draft.pphRate,
            }),
          },
        );
        const result = (await response.json()) as {
          ok?: boolean;
          error?: string;
        };
        if (!response.ok || !result.ok) {
          throw new Error(result.error || "Gagal menyimpan tax item.");
        }
      }
      if (noClaimDirty && submission) {
        const response = await fetch(
          `/api/claim-workflow/${id}/submissions/${submission.id}`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ noClaim: noClaimTrimmed }),
          },
        );
        const result = (await response.json()) as {
          ok?: boolean;
          error?: string;
        };
        if (!response.ok || !result.ok) {
          throw new Error(result.error || "Gagal menyimpan No Claim.");
        }
      }
      toast.success("Baris klaim tersimpan.");
      setMessage("Baris klaim tersimpan.");
      await loadDetail();
    } catch (err) {
      const errorMessage = err instanceof Error
        ? err.message
        : "Gagal menyimpan baris.";
      toast.error(errorMessage);
      setMessage(errorMessage);
    } finally {
      setExcelRowSavingId("");
    }
  };

  // Phase R7b - Multi No Claim: handler pindahkan item ke submission lain.
  const moveItemToSubmission = async (itemId: string, targetSubmissionId: string) => {
    if (!targetSubmissionId) return;
    setMovingItemId(itemId);
    setMessage("");
    try {
      const response = await fetch(
        `/api/claim-workflow/${id}/submissions/${targetSubmissionId}/items`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ itemIds: [itemId] }),
        },
      );
      const result = (await response.json()) as { ok?: boolean; error?: string };
      if (!response.ok || !result.ok) {
        throw new Error(result.error || "Gagal memindahkan item.");
      }
      toast.success("Item dipindahkan. Totals di-recalc.");
      await loadDetail();
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Gagal memindahkan item.";
      toast.error(errorMessage);
      setMessage(errorMessage);
    } finally {
      setMovingItemId("");
    }
  };

  // Phase R7c - Documents per submission: generate Claim Letter / Summary
  // / Kwitansi PDF per submission via endpoint per-submission. Setelah
  // sukses detail di-reload supaya pdfPath terbaru muncul.
  const generateSubmissionDocument = async (
    submissionId: string,
    type: "claim-letter" | "summary" | "receipt",
  ) => {
    const key = `${submissionId}:${type}`;
    setGeneratingDocKey(key);
    setMessage("");
    try {
      const response = await fetch(
        `/api/claim-workflow/${id}/submissions/${submissionId}/${type}`,
        { method: "POST" },
      );
      const result = (await response.json()) as { ok?: boolean; error?: string };
      if (!response.ok || !result.ok) {
        throw new Error(result.error || "Gagal generate dokumen.");
      }
      const label = type === "claim-letter"
        ? "Claim Letter"
        : type === "summary"
          ? "Summary"
          : "Kwitansi";
      const successMessage = `${label} PDF berhasil dibuat.`;
      toast.success(successMessage);
      setMessage(successMessage);
      await loadDetail();
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Gagal generate dokumen.";
      toast.error(errorMessage);
      setMessage(errorMessage);
    } finally {
      setGeneratingDocKey("");
    }
  };

  const submitClose = async () => {
    const trimmed = closeNote.trim();
    if (!trimmed) {
      toast.error("Catatan close wajib diisi.");
      return;
    }

    let closeUrl = `/api/claim-workflow/${id}/close`;
    if (hasMultipleSubmissions) {
      const targetSubmissionId =
        selectedDetailSubmission?.id ||
        selectedSubmissionId ||
        null;
      if (!targetSubmissionId) {
        toast.error("Pilih Berkas Claim terlebih dahulu.");
        return;
      }
      closeUrl = `/api/claim-workflow/${id}/submissions/${targetSubmissionId}/close`;
    }

    if (typeof window !== "undefined") {
      const confirmed = window.confirm(
        "Tutup Claim Workflow ini? Setelah Closed, payment dan transisi status tidak dapat lagi dilakukan.",
      );
      if (!confirmed) return;
    }
    setCloseSaving(true);
    setMessage("");
    try {
      const response = await fetch(closeUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note: trimmed }),
      });
      const result = (await response.json()) as {
        ok?: boolean;
        error?: string;
        workflow?: { status?: string };
      };
      if (!response.ok || !result.ok) {
        throw new Error(result.error || "Gagal menutup Claim Workflow.");
      }
      const successMessage = `Claim Workflow ditutup. Status: ${result.workflow?.status || "Closed"}.`;
      toast.success(successMessage);
      setMessage(successMessage);
      setCloseNote("");
      await loadDetail();
    } catch (closeError) {
      const errorMessage = closeError instanceof Error
        ? closeError.message
        : "Gagal menutup Claim Workflow.";
      toast.error(errorMessage);
      setMessage(errorMessage);
    } finally {
      setCloseSaving(false);
    }
  };

  if (loading) {
    return <div className="px-5 py-12 text-sm text-slate-400">Memuat detail Claim Workflow...</div>;
  }
  if (error || !workflow) {
    return <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 p-5 text-sm text-rose-200">{error || "Claim Workflow tidak ditemukan."}</div>;
  }

  // Status setelah Submitted to Principal belum punya transisi UI di phase
  // ini — Partially Paid / Paid akan otomatis ditulis lewat payment workflow
  // (R3). Closed akan diatur lewat close endpoint terpisah (R4). Status
  // legacy PEKA tidak menyediakan transisi apapun supaya tidak menghidupkan
  // kembali alur PEKA.
  const transitions: TransitionAction[] =
    workflow.status === claimWorkflowStatuses.draft ||
    workflow.status === claimWorkflowStatuses.needRevision
      ? ["mark_ready"]
      : workflow.status === claimWorkflowStatuses.readyToSubmit
        ? ["return_to_draft", "submit_to_principal"]
        : [];

  const showLegacyNotice = isLegacyPekaStatus(workflow.status);
  const showCloseSection =
    workflow.status === claimWorkflowStatuses.closed ||
    workflow.status === claimWorkflowStatuses.paid ||
    workflow.status === claimWorkflowStatuses.partiallyPaid ||
    (workflow.status === claimWorkflowStatuses.submittedToPrincipal &&
      (paymentSummary?.totalPaid ?? 0) > 0);

  const selectedDetailItem =
    items.find((item) => item.id === excelDetailRowId) || null;
  const selectedDetailSubmission = selectedDetailItem
    ? submissions.find((s) => s.id === selectedDetailItem.claimSubmissionId) ||
      null
    : null;
  const submissionItemCountById = new Map<string, number>();
  for (const item of items) {
    if (!item.claimSubmissionId) continue;
    submissionItemCountById.set(
      item.claimSubmissionId,
      (submissionItemCountById.get(item.claimSubmissionId) ?? 0) + 1,
    );
  }
  const berkasClaimRows = submissions.map((submission) => {
    const itemCount =
      submission.itemCount ?? submissionItemCountById.get(submission.id) ?? 0;
    const totalClaim = Number(submission.totalClaim || 0);
    const isActive = itemCount > 0 || totalClaim > 0;
    return {
      submission,
      itemCount,
      totalClaim,
      docsCount: getSubmissionDocumentsCompletedCount(submission),
      isActive,
    };
  });
  const activeBerkasCount = berkasClaimRows.filter((row) => row.isActive).length;
  const activeNoClaimCount = berkasClaimRows.filter(
    (row) => row.isActive && String(row.submission.noClaim || "").trim(),
  ).length;
  const emptyBerkasCount = berkasClaimRows.filter((row) => !row.isActive).length;
  const closeTargetSubmission =
    selectedDetailSubmission ||
    (selectedSubmissionId
      ? submissions.find((submission) => submission.id === selectedSubmissionId) || null
      : null) ||
    (berkasClaimRows.length === 1 ? berkasClaimRows[0].submission : null);
  const closeTargetPayments = closeTargetSubmission
    ? payments.filter((payment) => payment.claimSubmissionId === closeTargetSubmission.id)
    : [];
  const closeTargetActivePayments = closeTargetPayments.filter(
    (payment) => payment.voidedAt === null || payment.voidedAt === undefined,
  );
  const fallbackActivePayments = payments.filter(
    (payment) => payment.voidedAt === null || payment.voidedAt === undefined,
  );
  const closeTargetActivePaymentCount = closeTargetSubmission
    ? closeTargetActivePayments.length > 0 || hasMultipleSubmissions
      ? closeTargetActivePayments.length
      : fallbackActivePayments.length
    : 0;
  const closeTargetTotalClaim = closeTargetSubmission
    ? Number(closeTargetSubmission.totalClaim || 0)
    : paymentSummary?.totalClaim ?? 0;
  const closeTargetTotalPaid = closeTargetSubmission
    ? Number(closeTargetSubmission.totalPaid || 0)
    : paymentSummary?.totalPaid ?? 0;
  const closeTargetRemaining = closeTargetSubmission
    ? Number(closeTargetSubmission.remainingAmount || 0)
    : paymentSummary?.remainingAmount ?? 0;
  const closeChecks = closeTargetSubmission
    ? [
      { label: "Status Paid", ok: closeTargetSubmission.status === claimWorkflowStatuses.paid },
      { label: "Outstanding = 0", ok: closeTargetRemaining === 0 },
      { label: "Total Paid >= Total Claim", ok: closeTargetTotalPaid >= closeTargetTotalClaim && closeTargetTotalClaim > 0 },
      { label: "Active payment >= 1", ok: closeTargetActivePaymentCount > 0 },
      { label: "No Claim ter-assign", ok: Boolean(closeTargetSubmission.noClaim && String(closeTargetSubmission.noClaim).trim()) },
      { label: "Claim Letter PDF", ok: Boolean(closeTargetSubmission.claimLetterPdfPath) },
      { label: "Summary PDF", ok: Boolean(closeTargetSubmission.summaryPdfPath) },
      { label: "Kwitansi Claim PDF", ok: Boolean(closeTargetSubmission.receiptPdfPath) },
    ]
    : [
      { label: "Pilih Berkas Claim", ok: false },
    ];
  const localCloseBlockers = closeTargetSubmission
    ? closeChecks.filter((check) => !check.ok).map((check) => check.label)
    : ["Pilih Berkas Claim terlebih dahulu."];
  const displayedCloseBlockers = hasMultipleSubmissions || closeTargetSubmission
    ? localCloseBlockers
    : closeBlockers;
  const canCloseEffective = canEditItems &&
    Boolean(closeTargetSubmission) &&
    closeTargetSubmission?.status !== claimWorkflowStatuses.closed &&
    displayedCloseBlockers.length === 0;

  // R7j — getSubmissionItems dihapus karena renderSubmissionDetailPanel
  // (advanced layout lama) sudah tidak ada. Detail Claim panel inline
  // hanya butuh item itu sendiri.


  return (
    <div className="w-full space-y-6 pb-12 pt-2">
      <Link href="/claim-workflow" className="text-sm font-semibold text-indigo-300 hover:text-indigo-200">
        Kembali ke Claim Workflow
      </Link>

      <section className="rounded-2xl border border-white/10 bg-[#1a1c23] p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-2">
            <p className="text-xs font-bold uppercase tracking-[0.22em] text-indigo-300">Daftar Claim</p>
            <h1 className="text-2xl font-black text-white">{workflow.claimWorkflowNo}</h1>
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <span
                className={`rounded-full border px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider ${statusTone(workflow.status)}`}
                title={showLegacyNotice ? "Legacy PEKA status — diperlakukan sebagai Submitted to Principal" : undefined}
              >
                {displayClaimStatusLabel(workflow.status)}
              </span>
            </div>
            <p className="pt-2 text-[11px] text-slate-500">
              Setiap baris claim dapat memiliki No Claim sendiri.
            </p>
          </div>
          <div className="flex flex-col items-end gap-3">
            <div className="rounded-xl border border-white/10 bg-black/20 p-1">
              <div className="flex items-center gap-1">
                <span className="px-2 text-[10px] font-bold uppercase tracking-wider text-slate-500">
                  Tampilan
                </span>
                {(["simple", "berkas"] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => setStaffViewMode(mode)}
                    className={`rounded-lg px-3 py-1.5 text-xs font-bold transition ${
                      staffViewMode === mode
                        ? "bg-indigo-600 text-white shadow-sm shadow-indigo-950/60"
                        : "text-slate-300 hover:bg-white/10 hover:text-white"
                    }`}
                  >
                    {mode === "simple" ? "Simple" : "Dengan Berkas Claim"}
                  </button>
                ))}
              </div>
            </div>
            {canEditItems && transitions.length > 0 && (
              <div className="flex flex-wrap justify-end gap-2">
                {transitions.map((action) => {
                  const isPrimary = action === "submit_to_principal" || action === "mark_ready";
                  const className = isPrimary
                    ? "rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-indigo-500 disabled:opacity-50"
                    : "rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-bold text-slate-200 hover:bg-white/10 disabled:opacity-50";
                  return (
                    <button
                      key={action}
                      type="button"
                      disabled={transitionLoading !== ""}
                      onClick={() => void runTransition(action)}
                      className={className}
                    >
                      {transitionLoading === action ? "Memproses..." : TRANSITION_LABEL[action]}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
        <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {[
            { key: "workflowNo", label: "Claim Workflow No", value: workflow.claimWorkflowNo },
            { key: "principle", label: "Principle", value: workflow.principleName },
            { key: "status", label: "Status", value: displayClaimStatusLabel(workflow.status) },
            { key: "totalClaim", label: "Total Claim", value: rupiah(workflow.totalClaim) },
            { key: "totalPaid", label: "Total Paid", value: rupiah(workflow.totalPaid) },
            { key: "remainingAmount", label: "Outstanding", value: rupiah(workflow.remainingAmount) },
            { key: "items", label: "Baris Claim", value: String(items.length) },
            { key: "activeNoClaim", label: "No Claim Aktif", value: String(activeNoClaimCount) },
            { key: "activeBerkas", label: "Berkas Aktif", value: String(activeBerkasCount) },
          ].map((card) => (
            <div key={card.key} className="rounded-xl border border-white/10 bg-black/20 p-3">
              <p className="text-xs font-semibold text-slate-500">{card.label}</p>
              <p className="mt-2 whitespace-nowrap text-sm font-bold text-white">{card.value}</p>
            </div>
          ))}
        </div>
        {showLegacyNotice && (
          <p className="mt-4 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-xs text-amber-200">
            Workflow ini masih memiliki status legacy PEKA ({workflow.status}). Alur PEKA/EC/CN sudah retired; status ini sekarang diperlakukan sebagai Submitted to Principal. Pembayaran principal akan ditangani via Principal Payment workflow (R3).
          </p>
        )}
      </section>

      {message && (
        <div className="rounded-xl border border-indigo-500/30 bg-indigo-500/10 px-4 py-3 text-sm text-indigo-100">
          {message}
        </div>
      )}

      {/* No Claim Gate Info Section — scroll target for ?focus=no-claim */}
      <div ref={noClaimSectionRef}>
        {!canGenerateNoClaim && noClaimGateReason && (
          <div className="rounded-2xl border border-amber-500/20 bg-amber-500/5 p-4">
            <p className="text-xs font-bold uppercase tracking-wider text-amber-300">
              No Claim — Belum Bisa Generate
            </p>
            <p className="mt-2 text-sm text-amber-200">
              {noClaimGateReason}
            </p>
          </div>
        )}
        {canGenerateNoClaim && focusNoClaim && (
          <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/5 p-4">
            <p className="text-xs font-bold uppercase tracking-wider text-emerald-300">
              No Claim — Siap Generate
            </p>
            <p className="mt-2 text-sm text-emerald-200">
              Finance OFF sudah Paid. Anda dapat mengisi No Claim pada baris claim di bawah.
            </p>
          </div>
        )}
      </div>

      {staffViewMode === "berkas" && (
        <section className="rounded-2xl border border-white/10 bg-[#1a1c23] p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="font-bold text-white">Berkas Claim</h2>
              <p className="mt-1 max-w-3xl text-sm text-slate-400">
                Satu Berkas Claim = satu No Claim. Dokumen, pembayaran,
                outstanding, dan close diproses per Berkas Claim.
              </p>
              <p className="mt-2 text-xs text-slate-500">
                Mark Ready seharusnya mengecek semua Berkas Claim aktif:
                No Claim ada dan dokumen 3/3. Berkas kosong diabaikan.
              </p>
            </div>
            {emptyBerkasCount > 0 && (
              <span className="rounded-full border border-slate-600/50 bg-slate-900/60 px-3 py-1 text-[11px] font-bold text-slate-300">
                {emptyBerkasCount} berkas kosong diabaikan
              </span>
            )}
          </div>
          <div className="mt-4 grid gap-2 xl:grid-cols-3">
            {berkasClaimRows.length === 0 ? (
              <p className="rounded-lg border border-white/10 bg-black/20 px-3 py-4 text-sm text-slate-500">
                Belum ada Berkas Claim.
              </p>
            ) : (
              berkasClaimRows.map((row) => {
                const submission = row.submission;
                const remaining = Number(submission.remainingAmount || 0);
                return (
                  <div
                    key={submission.id}
                    className={`rounded-lg border p-3 ${
                      row.isActive
                        ? "border-white/10 bg-black/30"
                        : "border-slate-700/40 bg-slate-950/40 opacity-70"
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate font-mono text-xs font-bold text-emerald-200">
                          {submission.noClaim || "Belum ada No Claim"}
                        </p>
                        <p className="mt-1 truncate text-xs text-slate-400">
                          {submission.scopeLabel || "Berkas Claim"}
                        </p>
                      </div>
                      <span
                        className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${
                          row.isActive
                            ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
                            : "border-slate-600/50 bg-slate-800/40 text-slate-400"
                        }`}
                      >
                        {row.isActive ? "Aktif" : "Kosong"}
                      </span>
                    </div>
                    <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
                      <div>
                        <p className="text-slate-500">Item</p>
                        <p className="font-bold text-white">{row.itemCount}</p>
                      </div>
                      <div>
                        <p className="text-slate-500">Dokumen</p>
                        <p className={row.docsCount === 3 ? "font-bold text-emerald-300" : "font-bold text-amber-300"}>
                          {row.docsCount}/3
                        </p>
                      </div>
                      <div>
                        <p className="text-slate-500">Nilai Claim</p>
                        <p className="font-bold text-white">{rupiah(row.totalClaim)}</p>
                      </div>
                      <div>
                        <p className="text-slate-500">Paid</p>
                        <p className="font-bold text-emerald-200">{rupiah(submission.totalPaid)}</p>
                      </div>
                      <div>
                        <p className="text-slate-500">Outstanding</p>
                        <p className={remaining > 0 ? "font-bold text-amber-200" : "font-bold text-emerald-300"}>
                          {remaining > 0 ? rupiah(remaining) : "Lunas"}
                        </p>
                      </div>
                      <div>
                        <p className="text-slate-500">Status</p>
                        <span className={`mt-1 inline-flex rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${statusTone(submission.status)}`}>
                          {displayClaimStatusLabel(submission.status)}
                        </span>
                      </div>
                    </div>
                    {!row.isActive && (
                      <p className="mt-3 rounded-md border border-slate-700/40 bg-black/20 px-2 py-1.5 text-[11px] text-slate-400">
                        Berkas kosong - tidak punya item, jadi diabaikan saat Mark Ready.
                      </p>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </section>
      )}


      <section
        id="daftar-claim-section"
        className="rounded-2xl border border-indigo-500/20 bg-[#1a1c23] p-5"
      >
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="font-bold text-white">Daftar Claim</h2>
            <p className="mt-1 text-sm text-slate-400">
              Input No Claim, DPP, PPN, dan PPH seperti sheet BASE.
            </p>
          </div>
        </div>

        {/* R7j — Single Staff Excel Mode. Hanya satu render path: tabel
            Daftar Claim mirip sheet BASE Godrej. Layout eksperimen lama
            layout eksperimen lama telah dihapus. Source-of-truth tetap
            claim_submission.noClaim di backend; UI staff memakai istilah
            baris claim. */}
        {(() => {
            const filteredItems = items.filter((it) => {
              const sub = submissions.find((s) => s.id === it.claimSubmissionId);
              const noClaim = sub?.noClaim || "";
              const haystack = `${it.noSurat || ""} ${it.outlet || ""} ${it.jenisPromosi || ""} ${noClaim}`.toLowerCase();
              const search = excelSearch.trim().toLowerCase();
              if (search && !haystack.includes(search)) return false;
              if (excelStatusFilter === "needs_no_claim") {
                if (noClaim) return false;
              } else if (excelStatusFilter === "needs_docs") {
                if (!sub) return false;
                if (isSubmissionDocumentsComplete(sub)) return false;
              } else if (excelStatusFilter === "outstanding") {
                if (!sub) return false;
                if (Number(sub.remainingAmount || 0) <= 0) return false;
              } else if (excelStatusFilter === "paid") {
                if (!sub) return false;
                if (sub.status !== claimWorkflowStatuses.paid) return false;
              } else if (excelStatusFilter === "closed") {
                if (!sub || !isSubmissionClosed(sub)) return false;
              }
              return true;
            });
            const totalRows = items.length;
            return (
              <div className="mt-5 space-y-4">
                {/* Toolbar */}
                <div className="rounded-xl border border-white/10 bg-black/20 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-[11px] text-slate-400">
                      {totalRows} baris ditampilkan. Ketik No Claim langsung di kolom, lalu klik Simpan.
                      {noClaimLockedReason ? ` ${noClaimLockedReason}` : ""}
                    </p>
                    <button
                      type="button"
                      onClick={() => void loadDetail()}
                      className="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-bold text-slate-200 hover:bg-white/10"
                    >
                      Refresh
                    </button>
                  </div>
                </div>

                {/* Table */}
                {totalRows === 0 ? (
                  <div className="rounded-xl border border-white/10 bg-black/20 p-6 text-center text-sm text-slate-400">
                    Belum ada item klaim untuk workflow ini.
                  </div>
                ) : (
                  <div className="overflow-auto rounded-xl border border-white/10">
                    <div className="sticky left-0 top-0 z-10 border-b border-white/10 bg-[#141820] px-3 py-2 text-[11px] text-slate-300">
                      Alur cepat: isi <span className="font-bold text-indigo-200">No. Urut</span> dan <span className="font-bold text-indigo-200">Bulan Claim</span> di sebelah <span className="font-bold text-indigo-200">No Claim</span>, klik <span className="font-bold text-indigo-200">Generate</span>, lalu <span className="font-bold text-indigo-200">Simpan</span>.
                    </div>
                    <table className="min-w-[1700px] text-left text-sm">
                      <thead className="bg-black/40 text-[11px] uppercase tracking-wider text-slate-500">
                        <tr>
                          <th className="px-3 py-2 font-semibold">No.</th>
                          <th className="px-3 py-2 font-semibold">No Claim</th>
                          <th className="px-3 py-2 font-semibold text-indigo-200">No. Urut</th>
                          <th className="px-3 py-2 font-semibold text-indigo-200">Bulan Claim</th>
                          <th className="px-3 py-2 font-semibold">Perihal</th>
                          <th className="px-3 py-2 font-semibold">Periode</th>
                          <th className="px-3 py-2 font-semibold">Surat Program</th>
                          <th className="px-3 py-2 font-semibold">Outlet</th>
                          <th className="px-3 py-2 text-right font-semibold">DPP</th>
                          <th className="px-3 py-2 text-right font-semibold">PPN %</th>
                          <th className="px-3 py-2 text-right font-semibold">PPN Value</th>
                          <th className="px-3 py-2 text-right font-semibold">PPH %</th>
                          <th className="px-3 py-2 text-right font-semibold">PPH Value</th>
                          <th className="px-3 py-2 text-right font-semibold">Nilai Klaim</th>
                          <th className="px-3 py-2 font-semibold">Dokumen</th>
                          <th className="px-3 py-2 text-right font-semibold">Paid</th>
                          <th className="px-3 py-2 text-right font-semibold">Outstanding</th>
                          <th className="px-3 py-2 font-semibold">Status</th>
                          <th className="px-3 py-2 font-semibold">Aksi</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-white/5">
                        {filteredItems.map((item, idx) => {
                          const sub = submissions.find(
                            (s) => s.id === item.claimSubmissionId,
                          );
                          const fallbackNoClaim = sub?.noClaim || "";
                          const fallbackParsed = parseNoClaimComponents(fallbackNoClaim);
                          const draft = excelRowDrafts[item.id] ?? {
                            sequence: fallbackParsed?.sequence ?? "",
                            month: fallbackParsed?.month ?? excelDefaultMonth,
                            noClaimDraft: fallbackNoClaim,
                            dpp: String(item.dpp ?? 0),
                            ppnRate: String(item.ppnRate ?? 0),
                            pphRate: String(item.pphRate ?? 0),
                            initialNoClaim: fallbackNoClaim,
                            initialDpp: String(item.dpp ?? 0),
                            initialPpnRate: String(item.ppnRate ?? 0),
                            initialPphRate: String(item.pphRate ?? 0),
                          };
                          const dppNum = Number(draft.dpp || 0) || 0;
                          const ppnNum = Number(draft.ppnRate || 0) || 0;
                          const pphNum = Number(draft.pphRate || 0) || 0;
                          const ppnValue = +(dppNum * ppnNum / 100).toFixed(2);
                          const pphValue = +(dppNum * pphNum / 100).toFixed(2);
                          const nilaiKlaim = +(dppNum + ppnValue - pphValue).toFixed(2);
                          const taxDirty =
                            String(draft.dpp) !== String(draft.initialDpp) ||
                            String(draft.ppnRate) !== String(draft.initialPpnRate) ||
                            String(draft.pphRate) !== String(draft.initialPphRate);
                          const noClaimDirty =
                            draft.noClaimDraft.trim() !==
                            String(draft.initialNoClaim || "");
                          const dirty = taxDirty || noClaimDirty;
                          const docsCount = sub
                            ? getSubmissionDocumentsCompletedCount(sub)
                            : 0;
                          const remaining = sub
                            ? Number(sub.remainingAmount || 0)
                            : 0;
                          const paid = sub ? Number(sub.totalPaid || 0) : 0;
                          const saveBlockedByMissingSubmission =
                            noClaimDirty && !sub;
                          const updateDraft = (
                            patch:
                              | Partial<ExcelRowDraft>
                              | ((current: ExcelRowDraft) => Partial<ExcelRowDraft>),
                          ) => {
                            setExcelRowDrafts((prev) => ({
                              ...prev,
                              [item.id]: {
                                ...(prev[item.id] ?? draft),
                                ...(typeof patch === "function"
                                  ? patch(prev[item.id] ?? draft)
                                  : patch),
                              },
                            }));
                          };
                          const generateNoClaim = () => {
                            const currentDraft = excelRowDrafts[item.id] ?? draft;
                            const seq = currentDraft.sequence.trim();
                            const month = (currentDraft.month.trim() || excelDefaultMonth);
                            const year = excelYear;

                            if (!seq) {
                              toast.error("Nomor urut wajib diisi.");
                              return;
                            }
                            if (!month) {
                              toast.error("Bulan wajib diisi.");
                              return;
                            }
                            if (!year) {
                              toast.error("Tahun wajib diisi.");
                              return;
                            }

                            let generated = "";
                            if (excelCurrentRule) {
                              generated = buildNoClaimFromRule(excelCurrentRule, {
                                sequence: seq,
                                month,
                                year,
                                variantKey: excelVariantKey || undefined,
                              });
                            }
                            // Fallback: jika rule tidak tersedia atau pattern
                            // tidak menghasilkan output, pakai format legacy.
                            if (!generated) {
                              const principal = excelPrincipalCode.trim();
                              const distributor = excelDistributorCode.trim();
                              if (!principal || !distributor) {
                                toast.error("Principal dan Distributor wajib diisi.");
                                return;
                              }
                              const mm = month.padStart(2, "0");
                              generated = `${formatNoClaimSequence(seq)}/${distributor}-${principal}/${mm}/${year}`;
                            }

                            updateDraft({
                              sequence: formatNoClaimSequence(seq),
                              month: month.trim(),
                              noClaimDraft: generated,
                            });
                          };
                          const inputClass =
                            "w-full rounded-md border border-white/10 bg-black/40 px-2 py-1 text-sm text-white outline-none focus:border-indigo-500/60";
                          const numberInputClass =
                            "w-24 rounded-md border border-white/10 bg-black/40 px-2 py-1 text-right tabular-nums text-sm text-white outline-none focus:border-indigo-500/60";
                          const tinyInputClass =
                            "w-16 rounded-md border border-white/10 bg-black/40 px-2 py-1 text-right tabular-nums text-sm text-white outline-none focus:border-indigo-500/60";
                          return (
                            <tr
                              key={item.id}
                              className={`text-slate-300 ${dirty ? "bg-amber-500/5" : ""}`}
                            >
                              <td className="whitespace-nowrap px-3 py-2 text-xs text-slate-500">
                                {idx + 1}
                              </td>
                              <td className="px-3 py-2">
                                {sub ? (
                                  noClaimEditable ? (
                                    <input
                                      type="text"
                                      value={draft.noClaimDraft}
                                      onChange={(event) =>
                                        updateDraft({
                                          noClaimDraft: event.target.value,
                                        })
                                      }
                                      placeholder="01/SUPER-GCPI/02/2026"
                                      className="w-44 rounded-md border-2 border-indigo-500/40 bg-indigo-500/10 px-2 py-1 font-mono text-xs text-emerald-200 outline-none transition focus:border-indigo-400 focus:bg-indigo-500/20"
                                    />
                                  ) : (
                                    <span className="font-mono text-xs text-emerald-200">
                                      {draft.noClaimDraft || "—"}
                                    </span>
                                  )
                                ) : (
                                  <span className="text-[11px] italic text-amber-300">
                                    Belum siap
                                  </span>
                                )}
                              </td>
                              <td className="px-3 py-2">
                                {noClaimEditable ? (
                                  <input
                                    type="text"
                                    inputMode="numeric"
                                    value={draft.sequence}
                                    onChange={(event) =>
                                      updateDraft({ sequence: event.target.value })
                                    }
                                    placeholder="01"
                                    className={`${inputClass} w-16 border-indigo-500/40 bg-indigo-500/10 font-mono`}
                                  />
                                ) : (
                                  <span className="font-mono text-xs text-slate-400">
                                    {draft.sequence || "-"}
                                  </span>
                                )}
                              </td>
                              <td className="px-3 py-2">
                                {noClaimEditable ? (
                                  <input
                                    type="text"
                                    inputMode="numeric"
                                    maxLength={2}
                                    value={draft.month}
                                    onChange={(event) =>
                                      updateDraft({ month: event.target.value })
                                    }
                                    placeholder={excelDefaultMonth}
                                    className={`${inputClass} w-14 border-indigo-500/40 bg-indigo-500/10 font-mono`}
                                  />
                                ) : (
                                  <span className="font-mono text-xs text-slate-400">
                                    {draft.month || "-"}
                                  </span>
                                )}
                              </td>
                              <td className="px-3 py-2 text-xs">
                                {item.jenisPromosi || "-"}
                              </td>
                              <td className="px-3 py-2 text-xs">
                                {item.periode || "-"}
                              </td>
                              <td className="whitespace-nowrap px-3 py-2 font-mono text-xs">
                                {item.noSurat || "-"}
                              </td>
                              <td className="px-3 py-2 text-xs">
                                {item.outlet || "-"}
                              </td>
                              <td className="px-3 py-2 text-right tabular-nums">
                                {editable ? (
                                  <input
                                    type="number"
                                    min="0"
                                    step="any"
                                    value={draft.dpp}
                                    onChange={(event) =>
                                      updateDraft({ dpp: event.target.value })
                                    }
                                    className={numberInputClass}
                                  />
                                ) : (
                                  rupiah(item.dpp)
                                )}
                              </td>
                              <td className="px-3 py-2 text-right tabular-nums">
                                {editable ? (
                                  <input
                                    type="number"
                                    min="0"
                                    max="100"
                                    step="any"
                                    value={draft.ppnRate}
                                    onChange={(event) =>
                                      updateDraft({ ppnRate: event.target.value })
                                    }
                                    className={tinyInputClass}
                                  />
                                ) : (
                                  `${item.ppnRate}%`
                                )}
                              </td>
                              <td className="px-3 py-2 text-right tabular-nums text-slate-400">
                                {rupiah(ppnValue)}
                              </td>
                              <td className="px-3 py-2 text-right tabular-nums">
                                {editable ? (
                                  <input
                                    type="number"
                                    min="0"
                                    max="100"
                                    step="any"
                                    value={draft.pphRate}
                                    onChange={(event) =>
                                      updateDraft({ pphRate: event.target.value })
                                    }
                                    className={tinyInputClass}
                                  />
                                ) : (
                                  `${item.pphRate}%`
                                )}
                              </td>
                              <td className="px-3 py-2 text-right tabular-nums text-slate-400">
                                {rupiah(pphValue)}
                              </td>
                              <td className="px-3 py-2 text-right font-semibold tabular-nums text-white">
                                {rupiah(nilaiKlaim)}
                              </td>
                              <td className="px-3 py-2">
                                {sub ? (
                                  <span
                                    className={`text-xs font-bold ${docsCount === 3 ? "text-emerald-300" : "text-amber-300"}`}
                                    title="Letter / Summary / Kwitansi"
                                  >
                                    {docsCount}/3
                                  </span>
                                ) : (
                                  <span className="text-xs text-slate-500">
                                    —
                                  </span>
                                )}
                              </td>
                              <td className="px-3 py-2 text-right tabular-nums">
                                {sub ? rupiah(paid) : "—"}
                              </td>
                              <td className="px-3 py-2 text-right tabular-nums">
                                {sub
                                  ? remaining > 0
                                    ? (
                                      <span className="text-amber-200">
                                        {rupiah(remaining)}
                                      </span>
                                    )
                                    : (
                                      <span className="text-emerald-300">
                                        Lunas
                                      </span>
                                    )
                                  : "—"}
                              </td>
                              <td className="px-3 py-2">
                                {sub ? (
                                  <span
                                    className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${statusTone(sub.status)}`}
                                  >
                                    {displayClaimStatusLabel(sub.status)}
                                  </span>
                                ) : (
                                  <span className="text-xs text-slate-500">
                                    —
                                  </span>
                                )}
                              </td>
                              <td className="px-3 py-2">
                                <div className="flex flex-wrap gap-1.5">
                                  {noClaimEditable && (
                                    <button
                                      type="button"
                                      onClick={generateNoClaim}
                                      className="rounded-md border border-indigo-500/30 bg-indigo-500/10 px-2 py-1 text-[10px] font-bold text-indigo-200 hover:bg-indigo-500/20"
                                      title={
                                        sub
                                          ? "Generate No Claim dari No. Urut, Bulan Claim, Distributor, Principal, dan Tahun"
                                          : "Generate preview No Claim."
                                      }
                                    >
                                      Generate
                                    </button>
                                  )}
                                  {editable && (
                                    <button
                                      type="button"
                                      disabled={
                                        !dirty ||
                                        saveBlockedByMissingSubmission ||
                                        excelRowSavingId === item.id ||
                                        excelRowSavingId !== ""
                                      }
                                      onClick={() => void saveExcelRow(item)}
                                      className="rounded-md bg-indigo-600 px-2 py-1 text-[10px] font-bold text-white hover:bg-indigo-500 disabled:opacity-40"
                                      title={
                                        saveBlockedByMissingSubmission
                                          ? "Baris ini belum memiliki assignment untuk No Claim."
                                          : undefined
                                      }
                                    >
                                      {excelRowSavingId === item.id
                                        ? "Menyimpan…"
                                        : "Simpan"}
                                    </button>
                                  )}
                                  {sub && (
                                    <button
                                      type="button"
                                      onClick={() => {
                                        setExcelDetailRowId((prev) =>
                                          prev === item.id ? "" : item.id,
                                        );
                                        setSelectedSubmissionId(sub.id);
                                      }}
                                      className="rounded-md border border-white/10 bg-white/5 px-2 py-1 text-[10px] font-bold text-slate-200 hover:bg-white/10"
                                      title="Buka detail claim untuk dokumen, payment, dan close"
                                    >
                                      {excelDetailRowId === item.id
                                        ? "Tutup Detail"
                                        : "Detail"}
                                    </button>
                                  )}
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            );
          })()}
      </section>

      {selectedDetailItem && selectedDetailSubmission && (
        <section className="rounded-2xl border border-indigo-500/20 bg-[#1a1c23] p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="font-bold text-white">Detail Claim</h2>
              <p className="mt-1 text-sm text-slate-400">
                {selectedDetailItem.outlet || selectedDetailItem.jenisPromosi || "Baris claim"}
              </p>
              <p className="mt-1 text-xs text-slate-500">
                Berkas Claim adalah satu pengajuan No Claim ke principal.
              </p>
              <p className="mt-2 font-mono text-xs text-emerald-200">
                {selectedDetailSubmission.noClaim || "Belum ada No Claim"}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setExcelDetailRowId("")}
              className="rounded-md border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-bold text-slate-200 hover:bg-white/10"
            >
              Tutup
            </button>
          </div>

          <div className="mt-4 grid gap-3 md:grid-cols-3">
            <div className="rounded-lg border border-white/10 bg-black/30 p-3">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                Ringkasan Baris Claim
              </p>
              <p className="mt-1 text-sm font-bold text-white">
                {selectedDetailItem.jenisPromosi || selectedDetailItem.outlet || "Baris claim"}
              </p>
            </div>
            <div className="rounded-lg border border-white/10 bg-black/30 p-3">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                Berkas Claim
              </p>
              <p className="mt-1 font-mono text-xs font-bold text-emerald-200">
                {selectedDetailSubmission.noClaim || "Belum ada No Claim"}
              </p>
            </div>
            <div className="rounded-lg border border-white/10 bg-black/30 p-3">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                Status Close
              </p>
              <span className={`mt-1 inline-flex rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${statusTone(selectedDetailSubmission.status)}`}>
                {displayClaimStatusLabel(selectedDetailSubmission.status)}
              </span>
            </div>
          </div>

          <div className="mt-4 grid gap-3 sm:grid-cols-4">
            {[
              { label: "DPP", value: rupiah(selectedDetailItem.dpp), tone: "text-white" },
              { label: "PPN Value", value: rupiah(selectedDetailItem.ppnAmount), tone: "text-white" },
              { label: "PPH Value", value: rupiah(selectedDetailItem.pphAmount), tone: "text-white" },
              { label: "Nilai Klaim", value: rupiah(selectedDetailItem.nilaiKlaim), tone: "text-emerald-200" },
            ].map((metric) => (
              <div key={metric.label} className="rounded-lg border border-white/10 bg-black/30 p-3">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">{metric.label}</p>
                <p className={`mt-1 text-sm font-bold ${metric.tone}`}>{metric.value}</p>
              </div>
            ))}
          </div>

          <div className="mt-4 grid gap-3 lg:grid-cols-3">
            <div className="lg:col-span-2">
              <p className="text-[11px] font-bold uppercase tracking-wider text-slate-400">Dokumen</p>
              <div className="mt-2 grid gap-2 sm:grid-cols-3">
                {([
                  { key: "claim-letter" as const, title: "Letter", path: selectedDetailSubmission.claimLetterPdfPath },
                  { key: "summary" as const, title: "Summary", path: selectedDetailSubmission.summaryPdfPath },
                  { key: "receipt" as const, title: "Kwitansi", path: selectedDetailSubmission.receiptPdfPath },
                ]).map((doc) => {
                  const generating = generatingDocKey === `${selectedDetailSubmission.id}:${doc.key}`;
                  const generated = Boolean(doc.path);
                  const canGen =
                    canEditItems &&
                    !isSubmissionClosed(selectedDetailSubmission) &&
                    (selectedDetailSubmission.itemCount ?? 0) > 0 &&
                    Number(selectedDetailSubmission.totalClaim || 0) > 0;
                  return (
                    <div key={doc.key} className="rounded-lg border border-white/10 bg-black/30 p-3">
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-xs font-semibold text-white">{doc.title}</p>
                        <span className={`rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${generated ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300" : "border-amber-500/30 bg-amber-500/10 text-amber-300"}`}>
                          {generated ? "Sudah" : "Belum"}
                        </span>
                      </div>
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {generated && (
                          <a
                            href={`/api/claim-workflow/${id}/submissions/${selectedDetailSubmission.id}/${doc.key}`}
                            target="_blank"
                            rel="noreferrer"
                            className="rounded-md border border-white/10 bg-white/5 px-2 py-0.5 text-[10px] font-bold text-slate-200 hover:bg-white/10"
                          >
                            Buka PDF
                          </a>
                        )}
                        {canGen && (
                          <button
                            type="button"
                            disabled={generating || generatingDocKey !== ""}
                            onClick={() => void generateSubmissionDocument(selectedDetailSubmission.id, doc.key)}
                            className="rounded-md bg-indigo-600 px-2 py-0.5 text-[10px] font-bold text-white hover:bg-indigo-500 disabled:opacity-50"
                          >
                            {generating ? "..." : generated ? "Regenerate" : "Generate"}
                          </button>
                        )}
                        {!generated && !canGen && (
                          <span className="text-[10px] italic text-slate-500">
                            Lengkapi No Claim dan nilai klaim sebelum generate.
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="space-y-3">
              <p className="text-[11px] font-bold uppercase tracking-wider text-slate-400">Payment Summary</p>
              <div className="grid gap-2">
                <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3">
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-emerald-300">Total Paid</p>
                  <p className="mt-1 text-sm font-bold text-emerald-200">{rupiah(selectedDetailSubmission.totalPaid)}</p>
                </div>
                <div className={`rounded-lg border p-3 ${Number(selectedDetailSubmission.remainingAmount || 0) > 0 ? "border-amber-500/30 bg-amber-500/5" : "border-emerald-500/30 bg-emerald-500/5"}`}>
                  <p className={`text-[10px] font-semibold uppercase tracking-wider ${Number(selectedDetailSubmission.remainingAmount || 0) > 0 ? "text-amber-300" : "text-emerald-300"}`}>Outstanding</p>
                  <p className={`mt-1 text-sm font-bold ${Number(selectedDetailSubmission.remainingAmount || 0) > 0 ? "text-amber-200" : "text-emerald-200"}`}>
                    {Number(selectedDetailSubmission.remainingAmount || 0) > 0 ? rupiah(selectedDetailSubmission.remainingAmount) : "Lunas"}
                  </p>
                </div>
                <div className="rounded-lg border border-white/10 bg-black/30 p-3">
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Close Status</p>
                  <p className="mt-1">
                    <span className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${statusTone(selectedDetailSubmission.status)}`}>
                      {displayClaimStatusLabel(selectedDetailSubmission.status)}
                    </span>
                  </p>
                </div>
              </div>
            </div>
          </div>

          <div className="mt-4 rounded-lg border border-white/10 bg-black/20 p-3">
            <p className="text-[11px] font-bold uppercase tracking-wider text-slate-400">Riwayat Ringkas</p>
            {audit.length === 0 ? (
              <p className="mt-2 text-xs text-slate-500">Belum ada riwayat yang dapat ditampilkan.</p>
            ) : (
              <div className="mt-2 grid gap-2 md:grid-cols-3">
                {audit.slice(0, 3).map((entry) => (
                  <div key={entry.id} className="rounded-md border border-white/10 bg-black/30 px-3 py-2 text-xs">
                    <p className="font-semibold text-white">{entry.action}</p>
                    <p className="mt-1 text-slate-500">{dateText(entry.createdAt)}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>
      )}

      <section className="rounded-2xl border border-white/10 bg-[#1a1c23]">
        <button
          type="button"
          onClick={() => setShowPanduan((v) => !v)}
          aria-expanded={showPanduan}
          className="flex w-full items-center justify-between gap-2 px-5 py-3 text-left"
        >
          <span className="text-sm font-bold text-white">Panduan Kerja Claim</span>
          <span className="text-xs text-slate-400">{showPanduan ? "Tutup" : "Buka"}</span>
        </button>
        {showPanduan && (
          <div className="space-y-3 border-t border-white/10 p-5 text-xs text-slate-300">
            <p>
              Setiap baris di Daftar Claim mengikuti pola kerja sheet BASE: isi No. Urut dan Bulan Claim, generate No Claim, cek DPP/PPN/PPH, lalu Simpan.
            </p>
            <div className="rounded-lg border border-white/10 bg-black/30 p-3">
              <p className="font-bold text-white">Apa itu Berkas Claim?</p>
              <ul className="mt-2 space-y-1">
                <li>Berkas Claim adalah satu pengajuan No Claim ke principal.</li>
                <li>Satu Berkas Claim punya No Claim, item claim, dokumen, pembayaran, outstanding, dan status close.</li>
                <li>Biasanya satu baris claim menjadi satu Berkas Claim.</li>
                <li>Jika ada Berkas Claim kosong, itu tidak diproses.</li>
              </ul>
            </div>
            <div className="grid gap-3 lg:grid-cols-2">
              <div className="rounded-lg border border-white/10 bg-black/30 p-3">
                <p className="font-bold text-white">Urutan Kerja</p>
                <ol className="mt-2 list-decimal space-y-1 pl-5">
                  <li>Isi No Claim secara manual di kolom No Claim.</li>
                  <li>Opsional: isi No. Urut dan Bulan Claim, lalu klik Generate untuk preview format.</li>
                  <li>Cek/edit DPP, PPN %, dan PPH %, lalu klik Simpan.</li>
                  <li>Klik Detail untuk dokumen, payment summary, outstanding, dan status close.</li>
                </ol>
              </div>
              <div className="rounded-lg border border-white/10 bg-black/30 p-3">
                <p className="font-bold text-white">Rumus</p>
                <ul className="mt-2 space-y-1 font-mono">
                  <li>PPN Value = DPP x PPN%</li>
                  <li>PPH Value = DPP x PPH%</li>
                  <li>Nilai Klaim = DPP + PPN Value - PPH Value</li>
                  <li>Outstanding = Nilai Klaim - Paid</li>
                </ul>
              </div>
            </div>
          </div>
        )}
      </section>



      {/* R7j corrective - Riwayat / Audit. Default collapsed agar fokus default ada di tabel Daftar Claim. */}
      <div className="rounded-2xl border border-white/10 bg-[#1a1c23]">
        <button
          type="button"
          onClick={() => setShowTechnical((v) => !v)}
          aria-expanded={showTechnical}
          className="flex w-full items-center justify-between gap-2 px-5 py-3 text-left"
        >
          <span className="text-sm font-bold text-white">Riwayat / Audit</span>
          <span className="text-xs text-slate-400">
            {showTechnical ? "Tutup" : "Buka"}
          </span>
        </button>
        {showTechnical && (
          <div className="space-y-6 border-t border-white/10 p-5">
      <section className="overflow-hidden rounded-2xl border border-white/10 bg-[#1a1c23] shadow-lg shadow-black/20">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 px-5 py-4">
          <div>
            <h2 className="font-bold text-white">Detail Baris Claim</h2>
            <p className="mt-1 text-xs text-slate-400">
              DPP, PPN Rate, PPH Rate, dan catatan dapat diedit hanya saat Draft atau Need Revision.
            </p>
          </div>
          <p className="text-xs text-slate-500">
            {items.length} item
          </p>
        </div>
        {items.length === 0 ? (
          <div className="px-5 py-12 text-center text-sm text-slate-500">
            Tidak ada item Claim Workflow.
          </div>
        ) : (
          <div className="max-h-[640px] overflow-auto">
            <table className="min-w-[1450px] text-left text-sm">
              <thead className="sticky top-0 z-20 bg-[#1a1c23]/95 text-xs uppercase tracking-wider text-slate-500 backdrop-blur supports-[backdrop-filter]:bg-[#1a1c23]/70">
                <tr className="border-b border-white/10">
                  <th scope="col" className="sticky left-0 z-30 bg-[#1a1c23]/95 px-4 py-3 font-semibold backdrop-blur supports-[backdrop-filter]:bg-[#1a1c23]/70">No Surat</th>
                  <th scope="col" className="px-4 py-3 font-semibold">Jenis Promosi</th>
                  <th scope="col" className="px-4 py-3 font-semibold">Periode</th>
                  <th scope="col" className="px-4 py-3 font-semibold">Outlet</th>
                  <th scope="col" className="px-4 py-3 text-right font-semibold">DPP</th>
                  <th scope="col" className="px-4 py-3 text-right font-semibold">PPN Rate</th>
                  <th scope="col" className="px-4 py-3 text-right font-semibold">PPN Amount</th>
                  <th scope="col" className="px-4 py-3 text-right font-semibold">PPH Rate</th>
                  <th scope="col" className="px-4 py-3 text-right font-semibold">PPH Amount</th>
                  <th scope="col" className="px-4 py-3 text-right font-semibold">Nilai Klaim</th>
                  <th scope="col" className="px-4 py-3 font-semibold">Status</th>
                  <th scope="col" className="px-4 py-3 font-semibold">No Claim Internal</th>
                  <th scope="col" className="px-4 py-3 font-semibold">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {items.map((item) => {
                  const isEditing = editable && editingId === item.id && draft;
                  const inputClass = "w-full rounded-lg border border-white/10 bg-black/40 px-2 py-1.5 text-right tabular-nums text-white outline-none transition focus:border-indigo-500/60 focus:ring-2 focus:ring-indigo-500/40";
                  return (
                    <tr key={item.id} className="text-slate-300 transition-colors hover:bg-white/[0.03]">
                      <td className="sticky left-0 z-10 whitespace-nowrap bg-[#1a1c23] px-4 py-3 font-mono text-slate-100 group-hover:bg-[#1d2027]">
                        {item.noSurat || "-"}
                      </td>
                      <td className="px-4 py-3 text-slate-200">{item.jenisPromosi || "-"}</td>
                      <td className="whitespace-nowrap px-4 py-3 text-slate-300">{item.periode || "-"}</td>
                      <td className="px-4 py-3 text-slate-300">{item.outlet || "-"}</td>
                      <td className="px-4 py-3 text-right tabular-nums">
                        {isEditing ? (
                          <input
                            type="number"
                            min="0"
                            step="any"
                            value={draft.dpp}
                            onChange={(event) => setDraft({ ...draft, dpp: event.target.value })}
                            className={`${inputClass} w-32`}
                          />
                        ) : (
                          rupiah(item.dpp)
                        )}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums">
                        {isEditing ? (
                          <input
                            type="number"
                            min="0"
                            max="100"
                            step="any"
                            value={draft.ppnRate}
                            onChange={(event) => setDraft({ ...draft, ppnRate: event.target.value })}
                            className={`${inputClass} w-20`}
                          />
                        ) : (
                          `${item.ppnRate}%`
                        )}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums text-slate-300">{rupiah(item.ppnAmount)}</td>
                      <td className="px-4 py-3 text-right tabular-nums">
                        {isEditing ? (
                          <input
                            type="number"
                            min="0"
                            max="100"
                            step="any"
                            value={draft.pphRate}
                            onChange={(event) => setDraft({ ...draft, pphRate: event.target.value })}
                            className={`${inputClass} w-20`}
                          />
                        ) : (
                          `${item.pphRate}%`
                        )}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums text-slate-300">{rupiah(item.pphAmount)}</td>
                      <td className="px-4 py-3 text-right font-semibold tabular-nums text-white">{rupiah(item.nilaiKlaim)}</td>
                      <td className="px-4 py-3">
                        <span className="inline-flex items-center rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-xs font-semibold text-slate-300">
                          {item.status}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        {editable && submissions.length > 1 ? (
                          <select
                            value={item.claimSubmissionId || ""}
                            disabled={movingItemId === item.id}
                            onChange={(event) => {
                              const target = event.target.value;
                              if (target && target !== item.claimSubmissionId) {
                                void moveItemToSubmission(item.id, target);
                              }
                            }}
                            className="rounded-lg border border-white/10 bg-black/40 px-2 py-1 text-xs text-white outline-none focus:border-indigo-500/60 disabled:opacity-50"
                          >
                            {!item.claimSubmissionId && (
                              <option value="">- pilih baris -</option>
                            )}
                            {submissions.map((s) => (
                              <option key={s.id} value={s.id}>
                                {s.scopeLabel || s.scope}
                                {s.noClaim ? ` | ${s.noClaim}` : ""}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <span className="text-xs text-slate-400">
                            {(() => {
                              const sub = submissions.find((s) => s.id === item.claimSubmissionId);
                              if (!sub) return "-";
                              return sub.noClaim || sub.scopeLabel || sub.scope;
                            })()}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        {isEditing ? (
                          <div className="min-w-[240px] space-y-2">
                            <input
                              value={draft.note}
                              onChange={(event) => setDraft({ ...draft, note: event.target.value })}
                              placeholder="Catatan"
                              className="w-full rounded-lg border border-white/10 bg-black/40 px-2 py-1.5 text-white outline-none transition focus:border-indigo-500/60 focus:ring-2 focus:ring-indigo-500/40"
                            />
                            <div className="flex gap-2">
                              <button
                                type="button"
                                disabled={savingId === item.id}
                                onClick={() => void saveEdit(item.id)}
                                className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-bold text-white transition hover:bg-indigo-500 disabled:opacity-50"
                              >
                                {savingId === item.id ? "Saving..." : "Save"}
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  setEditingId("");
                                  setDraft(null);
                                }}
                                className="rounded-lg border border-white/10 px-3 py-1.5 text-xs font-bold text-slate-300 transition hover:bg-white/5"
                              >
                                Cancel
                              </button>
                            </div>
                          </div>
                        ) : editable ? (
                          <button
                            type="button"
                            onClick={() => startEdit(item)}
                            className="rounded-lg border border-indigo-500/30 bg-indigo-500/10 px-3 py-1.5 text-xs font-bold text-indigo-200 transition hover:bg-indigo-500/20"
                          >
                            Edit Tax
                          </button>
                        ) : (
                          <span className="text-slate-600">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <section className="rounded-2xl border border-white/10 bg-[#1a1c23] p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="font-bold text-white">Riwayat Pembayaran</h2>
            <p className="mt-1 text-sm text-slate-400">
              Catat pembayaran yang masuk dari principal. Dukungan partial
              payment, tidak boleh overpayment. Void dipakai untuk koreksi tanpa hard-delete.
            </p>
          </div>
        </div>

        {paymentSummary && (
          <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <div className="rounded-xl border border-white/10 bg-black/20 p-3">
              <p className="text-xs font-semibold text-slate-500">Total Claim</p>
              <p className="mt-2 text-sm font-bold text-white">{rupiah(paymentSummary.totalClaim)}</p>
            </div>
            <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-3">
              <p className="text-xs font-semibold text-emerald-300">Total Paid</p>
              <p className="mt-2 text-sm font-bold text-emerald-200">{rupiah(paymentSummary.totalPaid)}</p>
            </div>
            <div className={`rounded-xl border p-3 ${paymentSummary.remainingAmount > 0 ? "border-amber-500/30 bg-amber-500/5" : "border-emerald-500/30 bg-emerald-500/5"}`}>
              <p className={`text-xs font-semibold ${paymentSummary.remainingAmount > 0 ? "text-amber-300" : "text-emerald-300"}`}>Remaining / Outstanding</p>
              <p className={`mt-2 text-sm font-bold ${paymentSummary.remainingAmount > 0 ? "text-amber-200" : "text-emerald-200"}`}>{rupiah(paymentSummary.remainingAmount)}</p>
            </div>
            <div className="rounded-xl border border-white/10 bg-black/20 p-3">
              <p className="text-xs font-semibold text-slate-500">Payment Status</p>
              <p className="mt-2 text-sm font-bold text-white">{displayClaimStatusLabel(paymentSummary.paymentStatus)}</p>
              <p className="mt-1 text-[10px] uppercase tracking-wider text-slate-500">
                {paymentSummary.activePaymentCount} active · {paymentSummary.voidedPaymentCount} voided
              </p>
            </div>
          </div>
        )}

        {canRecordPayment ? (
          <div className="mt-5 rounded-xl border border-white/10 bg-black/20 p-4">
            <h3 className="text-sm font-semibold text-white">Catat Pembayaran Baru</h3>
            <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <label className="flex flex-col gap-1 text-xs font-semibold text-slate-300">
                Tanggal Bayar
                <input
                  type="date"
                  value={paymentDraft.paymentDate}
                  onChange={(event) => setPaymentDraft({ ...paymentDraft, paymentDate: event.target.value })}
                  disabled={paymentSaving}
                  className="rounded-lg border border-white/10 bg-black/40 px-3 py-2 font-mono text-sm text-white outline-none transition focus:border-indigo-500/60 focus:ring-2 focus:ring-indigo-500/40 disabled:opacity-50"
                />
              </label>
              <label className="flex flex-col gap-1 text-xs font-semibold text-slate-300">
                Nominal Bayar
                <input
                  type="number"
                  min="0"
                  step="any"
                  value={paymentDraft.paymentAmount}
                  onChange={(event) => setPaymentDraft({ ...paymentDraft, paymentAmount: event.target.value })}
                  disabled={paymentSaving}
                  placeholder={paymentSummary ? String(paymentSummary.remainingAmount) : "0"}
                  className="rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-right font-mono text-sm text-white outline-none transition focus:border-indigo-500/60 focus:ring-2 focus:ring-indigo-500/40 disabled:opacity-50"
                />
              </label>
              <label className="flex flex-col gap-1 text-xs font-semibold text-slate-300">
                Jenis Pembayaran
                <input
                  type="text"
                  value={paymentDraft.paymentType}
                  onChange={(event) => setPaymentDraft({ ...paymentDraft, paymentType: event.target.value })}
                  disabled={paymentSaving}
                  placeholder="Transfer / Tunai / Giro"
                  className="rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-white outline-none transition focus:border-indigo-500/60 focus:ring-2 focus:ring-indigo-500/40 disabled:opacity-50"
                />
              </label>
              <label className="flex flex-col gap-1 text-xs font-semibold text-slate-300">
                Catatan
                <input
                  type="text"
                  value={paymentDraft.paymentNote}
                  onChange={(event) => setPaymentDraft({ ...paymentDraft, paymentNote: event.target.value })}
                  disabled={paymentSaving}
                  placeholder="Optional"
                  className="rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-white outline-none transition focus:border-indigo-500/60 focus:ring-2 focus:ring-indigo-500/40 disabled:opacity-50"
                />
              </label>
            </div>
            <div className="mt-3 flex justify-end">
              <button
                type="button"
                disabled={paymentSaving}
                onClick={() => void submitPayment()}
                className="rounded-lg bg-indigo-600 px-4 py-2 text-xs font-bold text-white transition hover:bg-indigo-500 disabled:opacity-50"
              >
                {paymentSaving ? "Menyimpan..." : "Catat Pembayaran"}
              </button>
            </div>
          </div>
        ) : (
          <p className="mt-4 text-xs text-slate-500">
            {workflow.status === claimWorkflowStatuses.paid
              ? "Klaim sudah lunas."
              : workflow.status === claimWorkflowStatuses.closed
                ? "Workflow sudah closed."
                : workflow.status === claimWorkflowStatuses.submittedToPrincipal ||
                  workflow.status === claimWorkflowStatuses.partiallyPaid
                  ? "View-only. Hanya admin atau claim yang dapat mencatat pembayaran."
                  : "Pembayaran hanya bisa diinput setelah Submitted to Principal."}
          </p>
        )}

        <div className="mt-5 overflow-x-auto rounded-xl border border-white/10">
          <table className="min-w-full text-left text-sm">
            <thead className="bg-black/40 text-xs uppercase tracking-wider text-slate-500">
              <tr>
                <th scope="col" className="px-4 py-2 font-semibold">Tanggal</th>
                <th scope="col" className="px-4 py-2 text-right font-semibold">Nominal</th>
                <th scope="col" className="px-4 py-2 font-semibold">Jenis</th>
                <th scope="col" className="px-4 py-2 font-semibold">Catatan</th>
                <th scope="col" className="px-4 py-2 font-semibold">Status</th>
                <th scope="col" className="px-4 py-2 font-semibold">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {payments.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-6 text-center text-sm text-slate-500">
                    Belum ada pembayaran tercatat.
                  </td>
                </tr>
              ) : (
                payments.map((payment) => {
                  const voided = payment.voidedAt !== null && payment.voidedAt !== undefined;
                  return (
                    <tr key={payment.id} className={voided ? "text-slate-500" : "text-slate-300"}>
                      <td className="whitespace-nowrap px-4 py-2 font-mono">{payment.paymentDate}</td>
                      <td className={`whitespace-nowrap px-4 py-2 text-right font-semibold tabular-nums ${voided ? "line-through" : "text-white"}`}>
                        {rupiah(Number(payment.paymentAmount || 0))}
                      </td>
                      <td className="px-4 py-2">{payment.paymentType || "-"}</td>
                      <td className="px-4 py-2">
                        {payment.paymentNote || "-"}
                        {voided && payment.voidReason && (
                          <p className="mt-1 text-xs text-rose-300">Void: {payment.voidReason}</p>
                        )}
                      </td>
                      <td className="px-4 py-2">
                        <span className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${
                          voided
                            ? "border-rose-500/30 bg-rose-500/10 text-rose-300"
                            : "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
                        }`}>
                          {voided ? "Voided" : "Active"}
                        </span>
                      </td>
                      <td className="px-4 py-2">
                        {!voided && canVoidPayment ? (
                          <button
                            type="button"
                            disabled={voidingId === payment.id}
                            onClick={() => void voidPayment(payment)}
                            className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-2.5 py-1 text-xs font-bold text-rose-200 transition hover:bg-rose-500/20 disabled:opacity-50"
                          >
                            {voidingId === payment.id ? "Memproses..." : "Void"}
                          </button>
                        ) : (
                          <span className="text-slate-600">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </section>

      {showCloseSection && (
      <section className="rounded-2xl border border-white/10 bg-[#1a1c23] p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="font-bold text-white">Close Claim</h2>
            <p className="mt-1 text-sm text-slate-400">
              Tutup Berkas Claim ketika klaim sudah lunas dan dokumen
              sudah lengkap. Claim yang sudah Closed bersifat read-only.
            </p>
          </div>
        </div>

        {workflow.status === claimWorkflowStatuses.closed ? (
          <div className="mt-4 rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-4">
            <p className="text-sm font-bold text-emerald-200">Closed</p>
            {workflow.closedAt && (
              <p className="mt-1 text-xs text-emerald-300">
                Closed at {dateText(workflow.closedAt)}
                {workflow.closedBy ? ` oleh ${workflow.closedBy}` : ""}
              </p>
            )}
            {workflow.closeNote && (
              <p className="mt-2 text-sm text-slate-200">
                Catatan: <span className="italic">{workflow.closeNote}</span>
              </p>
            )}
          </div>
        ) : (
          <>
            {closeTargetSubmission && (
              <p className="mt-4 text-xs text-slate-400">
                Syarat close mengikuti Berkas Claim: <span className="font-semibold text-slate-200">{closeTargetSubmission.noClaim || closeTargetSubmission.scopeLabel || "Berkas Claim"}</span>
              </p>
            )}
            <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {closeChecks.map((check) => (
                <div
                  key={check.label}
                  className={`flex items-center justify-between rounded-lg border px-3 py-2 text-xs font-semibold ${
                    check.ok
                      ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-200"
                      : "border-amber-500/30 bg-amber-500/10 text-amber-200"
                  }`}
                >
                  <span>{check.label}</span>
                  <span className="font-mono uppercase tracking-wider">{check.ok ? "OK" : "PENDING"}</span>
                </div>
              ))}
            </div>

            {displayedCloseBlockers.length > 0 && (
              <div className="mt-4 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-200">
                <p className="font-bold">Belum bisa Close:</p>
                <ul className="mt-1 list-inside list-disc space-y-0.5">
                  {displayedCloseBlockers.map((blocker) => (
                    <li key={blocker}>{blocker}</li>
                  ))}
                </ul>
              </div>
            )}

            <div className="mt-4 rounded-xl border border-white/10 bg-black/20 p-4">
              <label className="block text-xs font-semibold text-slate-300">
                Catatan Close (wajib)
                <textarea
                  value={closeNote}
                  onChange={(event) => setCloseNote(event.target.value)}
                  placeholder="Catatan final verifikasi, mis: dokumen lengkap, payment penuh per ..."
                  rows={3}
                  disabled={!canCloseEffective || closeSaving}
                  className="mt-2 w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-white outline-none transition focus:border-indigo-500/60 focus:ring-2 focus:ring-indigo-500/40 disabled:opacity-50"
                />
              </label>
              <div className="mt-3 flex items-center justify-between gap-3">
                <p className="text-[11px] italic text-slate-500">
                  {canCloseEffective
                    ? "Semua syarat terpenuhi. Pastikan catatan terisi sebelum Close."
                    : "Lengkapi syarat di atas untuk mengaktifkan tombol Close."}
                </p>
                <button
                  type="button"
                  disabled={!canCloseEffective || closeSaving || !closeNote.trim()}
                  onClick={() => void submitClose()}
                  className="rounded-lg bg-emerald-600 px-4 py-2 text-xs font-bold text-white transition hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {closeSaving ? "Menutup..." : "Close Workflow"}
                </button>
              </div>
            </div>
          </>
        )}
      </section>
      )}

      <section className="rounded-2xl border border-white/10 bg-[#1a1c23] p-5">
        <h2 className="font-bold text-white">Riwayat / Audit</h2>
        {auditError ? (
          <p className="mt-4 text-sm text-slate-400">{auditError}</p>
        ) : audit.length === 0 ? (
          <p className="mt-4 text-sm text-slate-500">Belum ada audit log.</p>
        ) : (
          <div className="mt-4 space-y-3">
            {audit.map((entry) => (
              <div key={entry.id} className="rounded-xl border border-white/10 bg-black/20 px-4 py-3 text-sm">
                <div className="flex flex-wrap justify-between gap-2">
                  <span className="font-semibold text-white">{entry.action}</span>
                  <span className="text-xs text-slate-500">{dateText(entry.createdAt)}</span>
                </div>
                <p className="mt-1 text-slate-400">
                  {entry.actorName || "System"}{entry.actorRole ? ` (${entry.actorRole})` : ""}
                  {entry.note ? ` | ${entry.note}` : ""}
                </p>
              </div>
            ))}
          </div>
        )}
      </section>
          </div>
        )}
      </div>
    </div>
  );
}
