"use client";

import { useEffect, useMemo, useState, type ElementType, type ReactNode } from "react";
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
import { offPaymentMethods, offPrinciples } from "@/lib/off-program-control/constants";
import { authClient } from "@/lib/auth-client";
import { canPerformOffAction, getOffAccessibleTabs, resolveOffRole, type OffRole } from "@/lib/off-program-control/access";

type TabKey = "overview" | "supervisor" | "sales" | "claim" | "om" | "finance" | "audit";

type OffDashboardProps = {
    offRole: OffRole;
};

type Principle = (typeof offPrinciples)[number];

const PRINCIPLE_OPTIONS: Principle[] = offPrinciples;

const tabs: Array<{ key: TabKey; label: string }> = [
    { key: "overview", label: "Overview" },
    { key: "supervisor", label: "Supervisor" },
    { key: "sales", label: "Sales Manager" },
    { key: "claim", label: "Claim" },
    { key: "om", label: "Operational Manager" },
    { key: "finance", label: "Keuangan" },
    { key: "audit", label: "Audit Log" },
];

const metrics = [
    { label: "Total Batch", value: "24", tone: "text-sky-300", icon: ClipboardCheck },
    { label: "Waiting SM Review", value: "7", tone: "text-amber-300", icon: Clock3 },
    { label: "Waiting OM Approval", value: "4", tone: "text-purple-300", icon: ShieldCheck },
    { label: "Completed", value: "9", tone: "text-emerald-300", icon: CheckCircle2 },
];

const workflowSteps = [
    "Supervisor Bulk Input",
    "Sales Manager Data Review",
    "Claim Validation",
    "Operational Manager Approval",
    "Keuangan Payment",
    "Claim Payment Final Check",
    "Completed",
];

const queueSummary = [
    { title: "Supervisor Draft/Returned", count: 6, desc: "Batch masih bisa diedit Supervisor.", icon: FileText },
    { title: "Waiting SM Review", count: 7, desc: "Menunggu validasi benar/salah data batch.", icon: Send },
    { title: "Waiting Claim Validation", count: 5, desc: "Claim cek data dan syarat manual.", icon: FileCheck2 },
    { title: "Waiting OM Approval", count: 4, desc: "Batch approved SM, menunggu OM.", icon: ShieldCheck },
    { title: "Waiting Finance Payment", count: 3, desc: "Sudah approved OM, menunggu bayar.", icon: Wallet },
    { title: "Waiting Claim Final Verification", count: 2, desc: "Sudah dibayar, verifikasi final claim.", icon: ListChecks },
    { title: "Completed", count: 9, desc: "Workflow batch sudah selesai.", icon: CheckCircle2 },
];

const overviewRows = [
    {
        no: "001/RB/05/2026",
        batch: "Gelombang 001",
        principle: "RECKITT BENCKISER, PT",
        code: "RB",
        rows: "3",
        total: "Rp 12.500.000",
        sm: "Approved by SM",
        claim: "Claim Approved",
        om: "Ready",
        status: "Waiting OM",
    },
    {
        no: "002/FKS/05/2026",
        batch: "Gelombang 002",
        principle: "FKS FOOD SEJAHTERA, PT",
        code: "FKS",
        rows: "2",
        total: "Rp 8.200.000",
        sm: "Waiting Review",
        claim: "-",
        om: "-",
        status: "Waiting SM",
    },
    {
        no: "003/KINO/05/2026",
        batch: "Gelombang 003",
        principle: "KINO INDONESIA. TBK, PT",
        code: "KINO",
        rows: "4",
        total: "Rp 18.750.000",
        sm: "Approved by SM",
        claim: "Perlu Revisi",
        om: "Hold",
        status: "Waiting Claim",
    },
    {
        no: "004/UNIBIS/05/2026",
        batch: "Gelombang 004",
        principle: "UNIVERSAL INDOFOOD PRODUCT, PT",
        code: "UNIBIS",
        rows: "1",
        total: "Rp 5.500.000",
        sm: "Approved by SM",
        claim: "Final Verified",
        om: "Approved",
        status: "Completed",
    },
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

const initialBulkRows: SupervisorBulkRow[] = [
    { id: "row-1", noSurat: "SP/OFF/051", namaProgram: "Endcap Support", periodeAwal: "2026-05-01", periodeAkhir: "2026-05-31", toko: "Toko Makmur", barang: "Dettol", nominal: "Rp 4.400.000", caraBayar: "Transfer", type: "OFF Display", deadline: "2026-05-30", kwt: true, skp: false, fp: true, pc: false, foto: true, rekap: false, others: true, othersText: "Surat display tambahan outlet" },
    { id: "row-2", noSurat: "SP/OFF/052", namaProgram: "Area Visibility", periodeAwal: "2026-05-10", periodeAkhir: "2026-05-24", toko: "CV Prima", barang: "Harpic", nominal: "Rp 3.750.000", caraBayar: "Tunai", type: "Visibility", deadline: "2026-06-03", kwt: false, skp: true, fp: true, pc: false, foto: true, rekap: true, others: false, othersText: "" },
    { id: "row-3", noSurat: "SP/OFF/053", namaProgram: "Sampling Area", periodeAwal: "2026-05-15", periodeAkhir: "2026-05-30", toko: "UD Maju", barang: "Vanish", nominal: "Rp 4.350.000", caraBayar: "Tunai", type: "Sampling", deadline: "2026-06-05", kwt: true, skp: false, fp: false, pc: true, foto: true, rekap: false, others: true, othersText: "BA sampling" },
];

const supervisorStatuses = [
    { no: "001/RB/05/2026", status: "Draft", note: "Editable" },
    { no: "002/FKS/05/2026", status: "Submitted to SM", note: "Editable until approved" },
    { no: "003/KINO/05/2026", status: "Returned by SM", note: "Editable with correction" },
    { no: "004/UNIBIS/05/2026", status: "Approved by SM - Locked", note: "Batch and rows are locked" },
];

const documentChecks = ["KWT", "SKP", "FP", "PC", "Foto", "Rekap", "Others"];

const auditLogs = [
    { title: "Supervisor submit", detail: "Supervisor submit batch 001/RB/05/2026 ke Sales Manager", time: "16 May 2026 09:15" },
    { title: "Sales Manager approve", detail: "SM approve batch, status Approved by SM, Notify OM, Locked for Supervisor", time: "16 May 2026 10:05" },
    { title: "Claim input No Claim", detail: "Claim verifikasi syarat, Others, dan input nomor claim untuk batch", time: "16 May 2026 11:20" },
    { title: "OM approve", detail: "Operational Manager approve batch setelah melihat status SM dan Claim", time: "16 May 2026 13:40" },
    { title: "Keuangan upload bukti bayar", detail: "Keuangan membayar dan mengirim batch kembali ke Claim untuk final verification", time: "16 May 2026 15:10" },
    { title: "Claim final check completed", detail: "Claim verifikasi bukti bayar dan jumlah, lalu complete claim", time: "16 May 2026 16:25" },
];

function getPrincipleCode(name: string) {
    return PRINCIPLE_OPTIONS.find((item) => item.name === name)?.code || "";
}

function parseUiCurrency(value: string | number) {
    if (typeof value === "number") return Number.isFinite(value) ? value : 0;
    const cleaned = String(value || "").replace(/[^\d,.-]/g, "");
    if (!cleaned) return 0;
    if (cleaned.includes(".") && cleaned.includes(",")) {
        const decimalSeparator = cleaned.lastIndexOf(",") > cleaned.lastIndexOf(".") ? "," : ".";
        return Number(cleaned.replace(new RegExp(`\\${decimalSeparator === "," ? "." : ","}`, "g"), "").replace(decimalSeparator, ".")) || 0;
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

function computeUiPaymentSummary(items: Array<{ nominal: string | number; caraBayar: string }>) {
    return items.reduce(
        (summary, item) => {
            const nominal = parseUiCurrency(item.nominal);
            summary.total += nominal;
            const method = normalizeUiPaymentMethod(item.caraBayar);
            if (method === "Transfer") summary.transfer += nominal;
            if (method === "Tunai") summary.tunai += nominal;
            return summary;
        },
        { total: 0, transfer: 0, tunai: 0 }
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
    const [periodeAwal = "", periodeAkhir = ""] = String(periode || "").split(" - ");
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

function itemDocsSummary(item: OffApiItem) {
    const docs = [
        item.kwt ? "KWT" : "",
        item.skp ? "SKP" : "",
        item.fp ? "FP" : "",
        item.pc ? "PC" : "",
        item.foto ? "Foto" : "",
        item.rekap ? "Rekap" : "",
        item.others ? "Others" : "",
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
        nominal: item.nominal ? `Rp ${Number(item.nominal).toLocaleString("id-ID")}` : "",
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
    if (status.includes("Completed") || status.includes("Approved") || status.includes("Aman")) return "bg-emerald-500/10 text-emerald-300 border-emerald-500/30";
    if (status.includes("OM") || status.includes("Ready")) return "bg-purple-500/10 text-purple-300 border-purple-500/30";
    if (status.includes("Claim")) return "bg-sky-500/10 text-sky-300 border-sky-500/30";
    if (status.includes("Locked")) return "bg-slate-500/10 text-slate-300 border-slate-500/30";
    if (status.includes("Returned") || status.includes("Kurang") || status.includes("Revisi")) return "bg-rose-500/10 text-rose-300 border-rose-500/30";
    return "bg-amber-500/10 text-amber-300 border-amber-500/30";
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

function EditableField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
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

function DateField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
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
            {label && <span className="text-xs text-slate-500 font-semibold">{label}</span>}
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

function Panel({ title, icon: Icon, children }: { title: string; icon: ElementType; children: ReactNode }) {
    return (
        <section className="rounded-2xl border border-white/10 bg-[#1a1c23]/60 p-5 shadow-xl">
            <h2 className="text-lg font-bold text-white flex items-center gap-2 mb-5">
                <Icon className="text-teal-300" size={20} /> {title}
            </h2>
            {children}
        </section>
    );
}

function ActionButton({ children, tone = "default" }: { children: ReactNode; tone?: "default" | "danger" | "success" }) {
    const className = tone === "danger"
        ? "bg-rose-500/10 border-rose-500/30 text-rose-300 hover:bg-rose-500/20"
        : tone === "success"
            ? "bg-emerald-600 text-white border-emerald-500 hover:bg-emerald-500"
            : "bg-white/5 border-white/10 text-slate-200 hover:bg-white/10";
    return (
        <button className={`inline-flex items-center justify-center gap-2 rounded-xl border px-4 py-2.5 text-sm font-bold transition-colors ${className}`}>
            {children}
        </button>
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

function MetricsGrid() {
    return (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
            {metrics.map((metric) => {
                const Icon = metric.icon;
                return (
                    <div key={metric.label} className="rounded-2xl border border-white/10 bg-[#1a1c23]/60 p-5 shadow-xl">
                        <div className="flex items-start justify-between gap-4">
                            <div>
                                <p className="text-sm text-slate-400">{metric.label}</p>
                                <p className="mt-2 text-3xl font-black text-white">{metric.value}</p>
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
                    <h2 className="text-lg font-bold text-white">Workflow Approval</h2>
                    <p className="text-sm text-slate-400">Flow batch dari bulk input sampai claim payment final check.</p>
                </div>
                <span className="hidden sm:inline-flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-teal-300">
                    <ArrowRight size={14} /> Batch Flow
                </span>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-7 gap-3">
                {workflowSteps.map((step, index) => (
                    <div key={step} className="relative rounded-xl border border-white/10 bg-black/30 p-4 min-h-28">
                        <div className="flex items-center justify-between mb-4">
                            <span className="w-8 h-8 rounded-lg bg-teal-500/10 border border-teal-500/30 text-teal-300 flex items-center justify-center text-sm font-black">
                                {index + 1}
                            </span>
                            {index < workflowSteps.length - 1 && <ArrowRight className="hidden xl:block text-slate-600" size={16} />}
                        </div>
                        <p className="text-sm font-bold text-white leading-snug">{step}</p>
                    </div>
                ))}
            </div>
        </div>
    );
}

function MonitoringTable() {
    const headers = ["No Pengajuan", "Batch", "Principle", "Kode Principle", "Jumlah Row", "Total Nominal", "Status SM", "Status Claim", "Status OM", "Status"];
    return (
        <div className="rounded-2xl border border-white/10 bg-[#1a1c23]/60 overflow-hidden shadow-xl">
            <div className="p-5 border-b border-white/10 bg-black/30">
                <h2 className="text-lg font-bold text-white flex items-center gap-2">
                    <ReceiptText className="text-teal-300" size={20} /> Monitoring Batch Pengajuan
                </h2>
                <p className="text-sm text-slate-400 mt-1">Sample data memakai principle mapping dari sheet DUMMY.</p>
            </div>
            <div className="overflow-x-auto">
                <table className="w-full min-w-[1450px] text-sm text-left">
                    <thead className="bg-black/50 text-xs uppercase tracking-wider text-slate-500 border-b border-white/10">
                        <tr>
                            {headers.map((col) => (
                                <th key={col} className={`px-4 py-3 font-bold ${col === "No Pengajuan" ? "min-w-[180px]" : ""}`}>{col}</th>
                            ))}
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-white/5">
                        {overviewRows.map((row) => (
                            <tr key={row.no} className="hover:bg-white/[0.03]">
                                <td className="px-4 py-4 min-w-[180px] whitespace-nowrap font-mono font-bold text-white">{row.no}</td>
                                <td className="px-4 py-4 text-slate-300">{row.batch}</td>
                                <td className="px-4 py-4 text-slate-300 min-w-[260px]">{row.principle}</td>
                                <td className="px-4 py-4 font-mono text-teal-300">{row.code}</td>
                                <td className="px-4 py-4 text-center text-slate-300">{row.rows}</td>
                                <td className="px-4 py-4 text-right font-mono text-emerald-300">{row.total}</td>
                                <td className="px-4 py-4 text-slate-300">{row.sm}</td>
                                <td className="px-4 py-4 text-slate-300">{row.claim}</td>
                                <td className="px-4 py-4 text-slate-300">{row.om}</td>
                                <td className="px-4 py-4">
                                    <span className={`inline-flex px-2.5 py-1 rounded-md border text-xs font-bold ${statusClass(row.status)}`}>
                                        {row.status}
                                    </span>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );
}

function QueueSummaryPanel() {
    return (
        <Panel title="Queue Summary Per Divisi" icon={ListChecks}>
            <div className="grid grid-cols-1 md:grid-cols-2 2xl:grid-cols-7 gap-3">
                {queueSummary.map((queue) => {
                    const Icon = queue.icon;
                    return (
                        <div key={queue.title} className="rounded-xl border border-white/10 bg-black/30 p-4">
                            <div className="flex items-start justify-between gap-3">
                                <Icon className="text-teal-300 shrink-0" size={20} />
                                <span className="font-mono text-xl font-black text-white">{queue.count}</span>
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

function SupervisorDashboard({ offRole }: OffDashboardProps) {
    const canSubmitSupervisor = canPerformOffAction(offRole, "submit_batch");
    const canEditSupervisor = canPerformOffAction(offRole, "edit_returned_batch");
    const [supervisorName, setSupervisorName] = useState("Supervisor Area 1");
    const [batchPrinciple, setBatchPrinciple] = useState("RECKITT BENCKISER, PT");
    const [gelombangInput, setGelombangInput] = useState("001");
    const [bulanInput, setBulanInput] = useState("05");
    const [tahunInput, setTahunInput] = useState("2026");
    const [submitStatus, setSubmitStatus] = useState("");
    const [submitResult, setSubmitResult] = useState<{ batchId: string; noPengajuan: string; rowCount: number; pdfUrl: string; total: number; transfer: number; tunai: number } | null>(null);
    const [pdfUrl, setPdfUrl] = useState("");
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [rows, setRows] = useState<SupervisorBulkRow[]>(initialBulkRows);
    const [returnedBatches, setReturnedBatches] = useState<OffApiBatch[]>([]);
    const [returnedSummaries, setReturnedSummaries] = useState<Record<string, BatchQueueSummary>>({});
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
            const response = await fetch("/api/off-program-control/batches", { credentials: "include" });
            const data = await parseJsonResponse(response);
            if (!response.ok || !data.ok) throw new Error(String(data.error || "Gagal mengambil batch returned."));
            const allBatches = Array.isArray(data.batches) ? data.batches as OffApiBatch[] : [];
            const returned = allBatches.filter((batch) => batch.status === "Returned by SM" || batch.smStatus === "Returned" || batch.status === "Returned by Claim" || batch.claimStatus === "Returned");
            setReturnedBatches(returned);
            const entries = await Promise.all(returned.map(async (batch) => {
                try {
                    const detailRes = await fetch(`/api/off-program-control/batches/${batch.id}`, { credentials: "include" });
                    const detailData = await parseJsonResponse(detailRes);
                    const items = detailRes.ok && detailData.ok && Array.isArray(detailData.items) ? detailData.items as OffApiItem[] : [];
                    return [batch.id, {
                        rowCount: items.length,
                        totalNominal: items.reduce((total, item) => total + Number(item.nominal || 0), 0),
                    }] as const;
                } catch {
                    return [batch.id, { rowCount: 0, totalNominal: 0 }] as const;
                }
            }));
            setReturnedSummaries(Object.fromEntries(entries));
        } catch (error) {
            setReturnedStatus(error instanceof Error ? error.message : "Gagal mengambil batch returned.");
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
            const response = await fetch(`/api/off-program-control/batches/${batch.id}`, { credentials: "include" });
            const data = await parseJsonResponse(response);
            if (!response.ok || !data.ok) throw new Error(String(data.error || "Gagal membuka detail batch returned."));
            const detailBatch = data.batch as OffApiBatch;
            const detailItems = Array.isArray(data.items) ? data.items as OffApiItem[] : [];
            setEditingBatchId(detailBatch.id);
            setEditingLocked(Boolean(detailBatch.locked) || detailBatch.status === "Approved by SM");
            setReturnNote(detailBatch.claimNote || detailBatch.smNote || "");
            setSupervisorName(detailBatch.supervisorName || "Supervisor Area 1");
            setGelombangInput(detailBatch.gelombang || "001");
            setBatchPrinciple(detailBatch.principleName || "RECKITT BENCKISER, PT");
            setBulanInput(detailBatch.bulan || "05");
            setTahunInput(detailBatch.tahun || "2026");
            setRows(detailItems.length ? detailItems.map(apiItemToBulkRow) : [createEmptyBulkRow(1)]);
            setReturnedStatus(detailBatch.locked || detailBatch.status === "Approved by SM"
                ? "Batch sudah approved oleh SM dan terkunci untuk Supervisor."
                : `Batch ${detailBatch.noPengajuan} siap direvisi.`);
        } catch (error) {
            setReturnedStatus(error instanceof Error ? error.message : "Gagal membuka batch returned.");
        }
    };

    const addRow = () => {
        if (editingLocked) return;
        setRows((currentRows) => [...currentRows, createEmptyBulkRow(currentRows.length + 1)]);
    };

    const deleteRow = (rowId: string) => {
        if (editingLocked) return;
        setRows((currentRows) => currentRows.length > 1 ? currentRows.filter((row) => row.id !== rowId) : currentRows);
    };

    const updateRow = (rowId: string, field: keyof SupervisorBulkRow, value: string | boolean) => {
        if (editingLocked) return;
        setRows((currentRows) => currentRows.map((row) => row.id === rowId ? { ...row, [field]: value } : row));
    };

    const handleSubmitBatch = async () => {
        if (editingLocked) {
            setSubmitStatus("Batch sudah approved oleh SM dan terkunci untuk Supervisor.");
            return;
        }
        setIsSubmitting(true);
        setSubmitStatus(editingBatchId ? "Menyimpan revisi dan resubmit ke Sales Manager..." : "Menyimpan batch dan membuat PDF...");
        setPdfUrl("");
        setSubmitResult(null);
        try {
            const items = rows.map((row) => ({
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
            const localSummary = computeUiPaymentSummary(items);
            const saveRes = await fetch(editingBatchId ? `/api/off-program-control/batches/${editingBatchId}` : "/api/off-program-control/batches", {
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
            });
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
                setSubmitStatus("Pengajuan ini sudah pernah disubmit. Silakan cek PDF atau lanjutkan flow approval.");
                return;
            }
            if (!saveRes.ok || !saveData.ok) throw new Error(String(saveData.message || saveData.error || "Gagal menyimpan batch"));
            const savedBatchId = editingBatchId || String(saveData.batchId || "");

            const submitRes = await fetch(`/api/off-program-control/batches/${savedBatchId}/submit`, {
                method: "POST",
                credentials: "include",
            });
            const submitData = await parseJsonResponse(submitRes);
            if (!submitRes.ok || !submitData.ok) throw new Error(String(submitData.error || "Gagal submit batch"));

            setPdfUrl(String(submitData.pdfUrl || ""));
            setSubmitResult({
                batchId: String(submitData.batchId || savedBatchId),
                noPengajuan: String(submitData.noPengajuan || generatedNo),
                rowCount: items.length,
                total: Number((submitData.summary as { total?: number } | undefined)?.total || localSummary.total),
                transfer: Number((submitData.summary as { transfer?: number } | undefined)?.transfer || localSummary.transfer),
                tunai: Number((submitData.summary as { tunai?: number } | undefined)?.tunai || localSummary.tunai),
                pdfUrl: String(submitData.pdfUrl || ""),
            });
            setSubmitStatus(`Batch ${submitData.noPengajuan} submitted. PDF berhasil dibuat.`);
            setEditingBatchId("");
            setReturnNote("");
            await loadReturnedBatches();
            if (submitData.pdfUrl) window.open(String(submitData.pdfUrl), "_blank");
        } catch (error) {
            setSubmitStatus(error instanceof Error ? error.message : "Gagal submit batch.");
        } finally {
            setIsSubmitting(false);
        }
    };

    return (
        <div className="space-y-6">
            <Panel title="Batch Setup" icon={ClipboardCheck}>
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-6 gap-3">
                    <EditableField label="Supervisor Name" value={supervisorName} onChange={(value) => !editingLocked && setSupervisorName(value)} />
                    <EditableField label="Gelombang Input" value={gelombangInput} onChange={(value) => !editingLocked && setGelombangInput(value)} />
                    <PrincipleSelect label="Principle" value={batchPrinciple} onChange={(value) => !editingLocked && updateBatchPrinciple(value)} />
                    <Field label="Kode Principle" value={batchCode} />
                    <EditableField label="Bulan" value={bulanInput} onChange={(value) => !editingLocked && setBulanInput(value)} />
                    <EditableField label="Tahun" value={tahunInput} onChange={(value) => !editingLocked && setTahunInput(value)} />
                </div>
                <div className="mt-4 rounded-xl border border-teal-500/20 bg-teal-500/10 px-4 py-3">
                    <p className="text-xs uppercase tracking-wider text-teal-300 font-bold">Generated No Pengajuan</p>
                    <p className="mt-1 font-mono text-2xl font-black text-white">{generatedNo}</p>
                </div>
                {editingBatchId && (
                    <div className="mt-4 rounded-xl border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
                        Mode revisi batch returned. {editingLocked ? "Batch sudah approved oleh SM dan terkunci untuk Supervisor." : "Supervisor dapat mengubah data lalu resubmit ke Sales Manager."}
                    </div>
                )}
            </Panel>

            <Panel title="Returned by SM / Perlu Revisi" icon={AlertTriangle}>
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
                        const summary = returnedSummaries[batch.id] || { rowCount: 0, totalNominal: 0 };
                        return (
                            <div key={batch.id} className="rounded-xl border border-white/10 bg-black/30 p-4">
                                <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                                    <div>
                                        <p className="font-mono text-sm font-bold text-white">{batch.noPengajuan}</p>
                                        <p className="mt-1 text-sm text-slate-300">{batch.principleName} <span className="font-mono text-teal-300">({batch.principleCode})</span></p>
                                        <p className="mt-2 text-xs text-slate-500">Row: {summary.rowCount} | Total: Rp {summary.totalNominal.toLocaleString("id-ID")}</p>
                                        <p className="mt-2 text-sm text-rose-200">{batch.claimNote || batch.smNote || "Tidak ada catatan return."}</p>
                                        <span className={`mt-3 inline-flex rounded-md border px-2 py-1 text-xs font-bold ${statusClass(batch.status)}`}>{batch.status}</span>
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
                        <p className="text-sm text-slate-400">Belum ada batch returned dari Sales Manager.</p>
                    )}
                </div>
            </Panel>

            <InfoNote>
                Satu batch hanya boleh memakai satu Principle. Semua row dalam batch ini memakai Principle dan Kode Principle dari Batch Setup.
            </InfoNote>

            <Panel title="Bulk Input Pengajuan Supervisor" icon={FileText}>
                <div className="mb-4 rounded-xl border border-teal-500/20 bg-teal-500/10 px-4 py-3 text-sm text-teal-100">
                    Semua row dalam batch ini memakai Principle <span className="font-bold">{batchPrinciple}</span> dan Kode Principle <span className="font-mono font-bold">{batchCode}</span> dari Batch Setup.
                </div>
                <div className="overflow-x-auto rounded-xl border border-white/10">
                    <table className="w-full min-w-[1980px] text-sm text-left">
                        <thead className="bg-black/50 text-xs uppercase tracking-wider text-slate-500 border-b border-white/10">
                            <tr>
                                {["No Pengajuan", "Principle", "Kode Principle", "No Surat", "Nama Program", "Periode Awal", "Periode Akhir", "Toko", "Barang", "Nominal", "Cara Bayar", "Type", "Deadline", "Kelengkapan", "Others", "Aksi"].map((header) => (
                                    <th key={header} className="px-3 py-3 font-bold">{header}</th>
                                ))}
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-white/5">
                            {rows.map((row) => (
                                <tr key={row.id} className="hover:bg-white/[0.03] align-top">
                                    <td className="px-3 py-3">
                                        <input readOnly value={generatedNo} className="w-full min-w-[170px] rounded-lg border border-white/10 bg-slate-900/80 px-3 py-2 text-sm font-mono font-bold text-white outline-none" />
                                    </td>
                                    <td className="px-3 py-3">
                                        <input readOnly value={batchPrinciple} className="w-full min-w-[250px] rounded-lg border border-white/10 bg-slate-900/80 px-3 py-2 text-sm text-slate-200 outline-none" />
                                    </td>
                                    <td className="px-3 py-3">
                                        <input readOnly value={batchCode} className="w-full min-w-[100px] rounded-lg border border-white/10 bg-slate-900/80 px-3 py-2 text-sm font-mono font-bold text-teal-300 outline-none" />
                                    </td>
                                    <td className="px-3 py-3">
                                        <input readOnly={editingLocked} value={row.noSurat} onChange={(event) => updateRow(row.id, "noSurat", event.target.value)} className="w-full min-w-[130px] rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-slate-200 outline-none focus:border-teal-500/50" />
                                    </td>
                                    <td className="px-3 py-3">
                                        <input readOnly={editingLocked} value={row.namaProgram} onChange={(event) => updateRow(row.id, "namaProgram", event.target.value)} className="w-full min-w-[150px] rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-slate-200 outline-none focus:border-teal-500/50" />
                                    </td>
                                    <td className="px-3 py-3">
                                        <input type="date" readOnly={editingLocked} value={row.periodeAwal} onChange={(event) => updateRow(row.id, "periodeAwal", event.target.value)} className="w-full min-w-[150px] rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-slate-200 outline-none [color-scheme:dark] focus:border-teal-500/50" />
                                    </td>
                                    <td className="px-3 py-3">
                                        <input type="date" readOnly={editingLocked} value={row.periodeAkhir} onChange={(event) => updateRow(row.id, "periodeAkhir", event.target.value)} className="w-full min-w-[150px] rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-slate-200 outline-none [color-scheme:dark] focus:border-teal-500/50" />
                                    </td>
                                    <td className="px-3 py-3">
                                        <input readOnly={editingLocked} value={row.toko} onChange={(event) => updateRow(row.id, "toko", event.target.value)} className="w-full min-w-[130px] rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-slate-200 outline-none focus:border-teal-500/50" />
                                    </td>
                                    <td className="px-3 py-3">
                                        <input readOnly={editingLocked} value={row.barang} onChange={(event) => updateRow(row.id, "barang", event.target.value)} className="w-full min-w-[130px] rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-slate-200 outline-none focus:border-teal-500/50" />
                                    </td>
                                    <td className="px-3 py-3">
                                        <input readOnly={editingLocked} value={row.nominal} onChange={(event) => updateRow(row.id, "nominal", event.target.value)} placeholder="Rp 0" className="w-full min-w-[130px] rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-slate-200 outline-none focus:border-teal-500/50" />
                                    </td>
                                    <td className="px-3 py-3">
                                        <select disabled={editingLocked} value={row.caraBayar} onChange={(event) => updateRow(row.id, "caraBayar", event.target.value)} className="w-full min-w-[150px] rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-slate-200 outline-none focus:border-teal-500/50 disabled:opacity-70">
                                            {offPaymentMethods.map((method) => (
                                                <option key={method} className="bg-[#1a1c23]" value={method}>{method}</option>
                                            ))}
                                        </select>
                                    </td>
                                    <td className="px-3 py-3">
                                        <input readOnly={editingLocked} value={row.type} onChange={(event) => updateRow(row.id, "type", event.target.value)} className="w-full min-w-[130px] rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-slate-200 outline-none focus:border-teal-500/50" />
                                    </td>
                                    <td className="px-3 py-3">
                                        <input type="date" readOnly={editingLocked} value={row.deadline} onChange={(event) => updateRow(row.id, "deadline", event.target.value)} className="w-full min-w-[150px] rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-slate-200 outline-none [color-scheme:dark] focus:border-teal-500/50" />
                                    </td>
                                    <td className="px-3 py-3">
                                        <div className="grid min-w-[260px] grid-cols-2 gap-2">
                                            {documentChecks.filter((item) => item !== "Others").map((item) => (
                                                <label key={item} className="flex items-center gap-2 rounded-lg border border-white/10 bg-black/40 px-2 py-1.5 text-xs text-slate-300">
                                                    <input
                                                        type="checkbox"
                                                        checked={Boolean(row[item.toLowerCase() as keyof SupervisorBulkRow])}
                                                        onChange={(event) => updateRow(row.id, item.toLowerCase() as keyof SupervisorBulkRow, event.target.checked)}
                                                        disabled={editingLocked}
                                                        className="rounded bg-black/50 border-white/10 text-teal-500"
                                                    />
                                                    {item}
                                                </label>
                                            ))}
                                        </div>
                                    </td>
                                    <td className="px-3 py-3">
                                        <div className="min-w-[220px] space-y-2">
                                            <label className="flex items-center gap-2 rounded-lg border border-white/10 bg-black/40 px-2 py-1.5 text-xs text-slate-300">
                                                <input type="checkbox" checked={row.others} onChange={(event) => updateRow(row.id, "others", event.target.checked)} disabled={editingLocked} className="rounded bg-black/50 border-white/10 text-teal-500" />
                                                Others
                                            </label>
                                            <input readOnly={editingLocked} value={row.othersText} onChange={(event) => updateRow(row.id, "othersText", event.target.value)} placeholder="Sebutkan dokumen lainnya" className="w-full rounded-lg border border-white/10 bg-black/40 px-2 py-1.5 text-xs text-slate-200 outline-none placeholder:text-slate-600 focus:border-teal-500/50" />
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
                    <ActionButton>Simpan Draft Massal</ActionButton>
                    {canSubmitSupervisor ? (
                        <button
                            onClick={handleSubmitBatch}
                            disabled={isSubmitting || editingLocked}
                            className="inline-flex items-center justify-center gap-2 rounded-xl border border-emerald-500 bg-emerald-600 px-4 py-2.5 text-sm font-bold text-white transition-colors hover:bg-emerald-500 disabled:opacity-50"
                        >
                            {isSubmitting ? "Submitting..." : editingBatchId ? "Resubmit ke Sales Manager" : "Submit Semua ke Sales Manager"}
                        </button>
                    ) : (
                        <span className="rounded-xl border border-white/10 bg-black/30 px-4 py-2.5 text-sm text-slate-400">Readonly: role ini tidak bisa submit Supervisor.</span>
                    )}
                </div>
                {submitStatus && (
                    <div className="mt-4 rounded-xl border border-white/10 bg-black/30 px-4 py-3 text-sm text-slate-300">
                        {submitStatus}
                    </div>
                )}
                {pdfUrl && (
                    <a href={pdfUrl} target="_blank" className="mt-3 inline-flex rounded-xl border border-teal-500/30 bg-teal-500/10 px-4 py-2 text-sm font-bold text-teal-200 hover:bg-teal-500/20">
                        Download PDF Surat
                    </a>
                )}
                {submitResult && (
                    <div className="mt-4 rounded-xl border border-white/10 bg-[#0f1115]/80 p-4 text-xs text-slate-400">
                        <p className="mb-2 font-bold uppercase tracking-wider text-slate-300">Submit Result</p>
                        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-2">
                            <p>Batch ID: <span className="font-mono text-slate-200">{submitResult.batchId}</span></p>
                            <p>No Pengajuan: <span className="font-mono text-slate-200">{submitResult.noPengajuan}</span></p>
                            <p>Jumlah row terkirim: <span className="font-mono text-slate-200">{submitResult.rowCount}</span></p>
                            <p>Total Nominal: <span className="font-mono text-slate-200">Rp {submitResult.total.toLocaleString("id-ID")}</span></p>
                            <p>Transfer: <span className="font-mono text-slate-200">Rp {submitResult.transfer.toLocaleString("id-ID")}</span></p>
                            <p>Tunai: <span className="font-mono text-slate-200">Rp {submitResult.tunai.toLocaleString("id-ID")}</span></p>
                            <p>PDF URL: <span className="font-mono text-slate-200 break-all">{submitResult.pdfUrl}</span></p>
                        </div>
                    </div>
                )}
                <p className="mt-4 text-sm text-slate-400">
                    Kelengkapan yang diisi Supervisor adalah informasi awal. Validasi aman/tidaknya tetap ditentukan oleh Claim.
                </p>
            </Panel>

            <div className="grid grid-cols-1 xl:grid-cols-[1fr_0.9fr] gap-6">
                <Panel title="Status Batch Supervisor" icon={ClipboardCheck}>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                        {supervisorStatuses.map((item) => (
                            <div key={item.no} className="rounded-xl border border-white/10 bg-black/30 p-4">
                                <p className="font-mono text-sm font-bold text-white">{item.no}</p>
                                <span className={`mt-3 inline-flex rounded-md border px-2 py-1 text-xs font-bold ${statusClass(item.status)}`}>{item.status}</span>
                                <p className="text-xs text-slate-500 mt-2">{item.note}</p>
                            </div>
                        ))}
                    </div>
                </Panel>
                <Panel title="Status Lock" icon={ShieldCheck}>
                    <div className="space-y-3">
                        {["Draft", "Submitted to SM", "Returned by SM", "Approved by SM - Locked"].map((item) => (
                            <span key={item} className={`inline-flex mr-2 rounded-md border px-2.5 py-1 text-xs font-bold ${statusClass(item)}`}>{item}</span>
                        ))}
                    </div>
                    <p className="mt-4 text-sm text-slate-400">
                        Supervisor masih bisa edit saat Draft, Submitted, atau Returned. Setelah Approved by SM, seluruh batch dan row di dalamnya terkunci.
                    </p>
                </Panel>
            </div>
        </div>
    );
}

function SalesManagerDashboard({ offRole }: OffDashboardProps) {
    const canReviewSm = canPerformOffAction(offRole, "sm_approve") || canPerformOffAction(offRole, "sm_return");
    const [batches, setBatches] = useState<OffApiBatch[]>([]);
    const [smHistory, setSmHistory] = useState<OffApiBatch[]>([]);
    const [batchSummaries, setBatchSummaries] = useState<Record<string, BatchQueueSummary>>({});
    const [selectedBatch, setSelectedBatch] = useState<OffApiBatch | null>(null);
    const [selectedItems, setSelectedItems] = useState<OffApiItem[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [isActionLoading, setIsActionLoading] = useState(false);
    const [loadError, setLoadError] = useState("");
    const [actionMessage, setActionMessage] = useState("");
    const [smNote, setSmNote] = useState("");
    const [notificationPreview, setNotificationPreview] = useState<OffNotificationPreview | null>(null);
    const totalNominal = selectedItems.reduce((total, item) => total + Number(item.nominal || 0), 0);

    const loadBatchDetail = async (batch: OffApiBatch) => {
        setLoadError("");
        const detailRes = await fetch(`/api/off-program-control/batches/${batch.id}`, { credentials: "include" });
        const detailData = await parseJsonResponse(detailRes);
        if (!detailRes.ok || !detailData.ok) throw new Error(String(detailData.error || "Gagal mengambil detail batch."));
        setSelectedBatch(detailData.batch as OffApiBatch || batch);
        setSelectedItems(Array.isArray(detailData.items) ? detailData.items as OffApiItem[] : []);
    };

    const loadQueueSummaries = async (rows: OffApiBatch[]) => {
        const entries = await Promise.all(rows.map(async (row) => {
            try {
                const response = await fetch(`/api/off-program-control/batches/${row.id}`, { credentials: "include" });
                const data = await parseJsonResponse(response);
                const items = response.ok && data.ok && Array.isArray(data.items) ? data.items as OffApiItem[] : [];
                return [row.id, {
                    rowCount: items.length,
                    totalNominal: items.reduce((total, item) => total + Number(item.nominal || 0), 0),
                }] as const;
            } catch {
                return [row.id, { rowCount: 0, totalNominal: 0 }] as const;
            }
        }));
        setBatchSummaries(Object.fromEntries(entries));
    };

    const loadSalesBatches = async (preferredBatchId?: string) => {
        setIsLoading(true);
        setLoadError("");
        try {
            const listRes = await fetch("/api/off-program-control/batches", { credentials: "include" });
            const listData = await parseJsonResponse(listRes);
            if (!listRes.ok || !listData.ok) throw new Error(String(listData.error || "Gagal mengambil data batch."));
            const rows = Array.isArray(listData.batches) ? listData.batches as OffApiBatch[] : [];
            const waitingRows = rows.filter((row) => row.status === "Submitted to SM" && row.smStatus === "Waiting Review");
            setSmHistory(rows.filter((row) => row.smStatus === "Approved by SM" || row.smStatus === "Returned"));
            setBatches(waitingRows);
            await loadQueueSummaries(waitingRows);
            const nextBatch = waitingRows.find((row) => row.id === preferredBatchId) || waitingRows[0] || null;
            setSelectedBatch(nextBatch);

            if (!nextBatch) {
                setSelectedItems([]);
                return;
            }

            await loadBatchDetail(nextBatch);
        } catch (error) {
            setLoadError(error instanceof Error ? error.message : "Gagal mengambil data Sales Manager.");
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
                const listRes = await fetch("/api/off-program-control/batches", { credentials: "include" });
                const listData = await parseJsonResponse(listRes);
                if (!listRes.ok || !listData.ok) throw new Error(String(listData.error || "Gagal mengambil data batch."));
                const rows = Array.isArray(listData.batches) ? listData.batches as OffApiBatch[] : [];
                const waitingRows = rows.filter((row) => row.status === "Submitted to SM" && row.smStatus === "Waiting Review");
                const nextBatch = waitingRows[0] || null;
                if (!isActive) return;
                setSmHistory(rows.filter((row) => row.smStatus === "Approved by SM" || row.smStatus === "Returned"));
                setBatches(waitingRows);
                await loadQueueSummaries(waitingRows);
                setSelectedBatch(nextBatch);

                if (!nextBatch) {
                    setSelectedItems([]);
                    return;
                }

                const detailRes = await fetch(`/api/off-program-control/batches/${nextBatch.id}`, { credentials: "include" });
                const detailData = await parseJsonResponse(detailRes);
                if (!detailRes.ok || !detailData.ok) throw new Error(String(detailData.error || "Gagal mengambil detail batch."));
                if (!isActive) return;
                setSelectedBatch(detailData.batch as OffApiBatch || nextBatch);
                setSelectedItems(Array.isArray(detailData.items) ? detailData.items as OffApiItem[] : []);
            } catch (error) {
                if (!isActive) return;
                setLoadError(error instanceof Error ? error.message : "Gagal mengambil data Sales Manager.");
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
            setLoadError(error instanceof Error ? error.message : "Gagal mengambil detail batch.");
        }
    };

    const returnToSupervisor = async () => {
        if (!selectedBatch) return;
        const note = smNote.trim();
        if (!note) {
            setActionMessage("Catatan Sales Manager wajib diisi sebelum return.");
            return;
        }
        setIsActionLoading(true);
        setActionMessage("");
        try {
            const response = await fetch(`/api/off-program-control/batches/${selectedBatch.id}/sm-return`, {
                method: "POST",
                credentials: "include",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ note }),
            });
            const data = await parseJsonResponse(response);
            if (!response.ok || !data.ok) throw new Error(String(data.error || data.message || "Gagal return batch ke Supervisor."));
            setActionMessage(String(data.message || "Pengajuan dikembalikan ke Supervisor."));
            setSmNote("");
            setNotificationPreview(null);
            await loadSalesBatches();
        } catch (error) {
            setActionMessage(error instanceof Error ? error.message : "Gagal return batch ke Supervisor.");
        } finally {
            setIsActionLoading(false);
        }
    };

    const approveBatch = async () => {
        if (!selectedBatch) return;
        setIsActionLoading(true);
        setActionMessage("");
        try {
            const response = await fetch(`/api/off-program-control/batches/${selectedBatch.id}/sm-approve`, {
                method: "POST",
                credentials: "include",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ note: smNote }),
            });
            const data = await parseJsonResponse(response);
            if (!response.ok || !data.ok) throw new Error(String(data.error || data.message || "Gagal approve batch."));
            setActionMessage(String(data.message || "Pengajuan disetujui Sales Manager dan notifikasi OM dibuat."));
            setNotificationPreview(data.notification as OffNotificationPreview || null);
            setSmNote("");
            await loadSalesBatches();
        } catch (error) {
            setActionMessage(error instanceof Error ? error.message : "Gagal approve batch.");
        } finally {
            setIsActionLoading(false);
        }
    };

    return (
        <div className="grid grid-cols-1 xl:grid-cols-[0.75fr_1.25fr] gap-6">
            <Panel title="Queue Waiting SM Batch Review" icon={Clock3}>
                <div className="space-y-3">
                    {isLoading && <p className="text-sm text-slate-400">Memuat batch Sales Manager...</p>}
                    {!isLoading && batches.length === 0 && <p className="text-sm text-slate-400">Belum ada batch submitted untuk direview.</p>}
                    {batches.slice(0, 5).map((row) => {
                        const summary = batchSummaries[row.id] || { rowCount: 0, totalNominal: 0 };
                        return (
                            <button
                                key={row.id}
                                onClick={() => selectBatch(row)}
                                className={`w-full rounded-xl border p-4 text-left transition-colors ${selectedBatch?.id === row.id ? "border-teal-500/40 bg-teal-500/10" : "border-white/10 bg-black/30 hover:bg-white/[0.04]"}`}
                            >
                                <p className="font-mono text-sm font-bold text-white">{row.noPengajuan}</p>
                                <p className="mt-1 text-sm text-slate-300">{row.principleName} <span className="font-mono text-teal-300">({row.principleCode})</span></p>
                                <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-slate-400">
                                    <span>Row: <b className="text-slate-200">{summary.rowCount}</b></span>
                                    <span>Total: <b className="text-emerald-300">Rp {summary.totalNominal.toLocaleString("id-ID")}</b></span>
                                </div>
                                <span className={`mt-3 inline-flex rounded-md border px-2 py-1 text-xs font-bold ${statusClass(row.smStatus || row.status)}`}>{row.smStatus || row.status}</span>
                            </button>
                        );
                    })}
                </div>
                <div className="mt-6 border-t border-white/10 pt-5">
                    <p className="mb-3 text-sm font-bold text-white">Riwayat Review SM</p>
                    <div className="space-y-2">
                        {smHistory.slice(0, 5).map((row) => (
                            <div key={row.id} className="rounded-lg border border-white/10 bg-black/20 p-3">
                                <p className="font-mono text-xs font-bold text-slate-200">{row.noPengajuan}</p>
                                <p className="mt-1 text-xs text-slate-500">{row.principleCode} - {row.principleName}</p>
                                <span className={`mt-2 inline-flex rounded-md border px-2 py-1 text-xs font-bold ${statusClass(row.smStatus)}`}>{row.smStatus}</span>
                            </div>
                        ))}
                        {smHistory.length === 0 && <p className="text-sm text-slate-500">Belum ada history approve/return SM.</p>}
                    </div>
                </div>
            </Panel>
            <div className="space-y-6">
                <InfoNote>
                    Sales Manager mengecek benar/salah data batch. Kelengkapan syarat claim ditentukan oleh divisi Claim, bukan SM.
                </InfoNote>
                <Panel title="Sales Manager Batch Review" icon={ShieldCheck}>
                    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                        <Field label="No Pengajuan Batch" value={selectedBatch?.noPengajuan || "-"} />
                        <Field label="Gelombang" value={selectedBatch?.gelombang || "-"} />
                        <Field label="Principle" value={selectedBatch?.principleName || "-"} />
                        <Field label="Kode Principle" value={selectedBatch?.principleCode || "-"} />
                        <Field label="Bulan/Tahun" value={selectedBatch ? `${selectedBatch.bulan}/${selectedBatch.tahun}` : "-"} />
                        <Field label="Supervisor" value={selectedBatch?.supervisorName || "-"} />
                        <Field label="Jumlah Row dalam Batch" value={String(selectedItems.length || 0)} />
                        <Field label="Total Nominal Batch" value={`Rp ${totalNominal.toLocaleString("id-ID")}`} />
                        <Field label="Status" value={selectedBatch?.status || "-"} />
                        <Field label="Status SM" value={selectedBatch?.smStatus || "-"} />
                    </div>
                    <div className="mt-5 overflow-x-auto rounded-xl border border-white/10">
                        <table className="w-full min-w-[1150px] text-left text-sm">
                            <thead className="border-b border-white/10 bg-black/50 text-xs uppercase tracking-wider text-slate-500">
                                <tr>
                                    {["No", "No Surat", "Nama Program", "Periode", "Toko", "Barang", "Nominal", "Cara Bayar", "Type", "Deadline"].map((header) => (
                                        <th key={header} className="px-3 py-3 font-bold">{header}</th>
                                    ))}
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-white/5">
                                {selectedItems.map((item, index) => (
                                    <tr key={item.id || `${item.noSurat}-${index}`} className="hover:bg-white/[0.03]">
                                        <td className="px-3 py-3 font-mono text-slate-300">{item.itemNo || index + 1}</td>
                                        <td className="px-3 py-3 font-mono text-slate-200">{item.noSurat || "-"}</td>
                                        <td className="px-3 py-3 min-w-[180px] text-slate-200">{item.namaProgram || "-"}</td>
                                        <td className="px-3 py-3 text-slate-300">{item.periode || "-"}</td>
                                        <td className="px-3 py-3 min-w-[140px] text-slate-300">{item.toko || "-"}</td>
                                        <td className="px-3 py-3 text-slate-300">{item.barang || "-"}</td>
                                        <td className="px-3 py-3 text-right font-mono text-emerald-300">Rp {Number(item.nominal || 0).toLocaleString("id-ID")}</td>
                                        <td className="px-3 py-3 text-slate-300">{item.caraBayar || "-"}</td>
                                        <td className="px-3 py-3 text-slate-300">{item.type || "-"}</td>
                                        <td className="px-3 py-3 text-slate-300">{item.deadline || "-"}</td>
                                    </tr>
                                ))}
                                {!isLoading && selectedItems.length === 0 && (
                                    <tr>
                                        <td colSpan={10} className="px-3 py-6 text-center text-sm text-slate-500">
                                            Pilih batch untuk melihat item.
                                        </td>
                                    </tr>
                                )}
                            </tbody>
                        </table>
                    </div>
                    <div className="mt-4">
                        <label className="block">
                            <span className="text-xs text-slate-500 font-semibold">Catatan Sales Manager</span>
                            <textarea
                                value={smNote}
                                onChange={(event) => setSmNote(event.target.value)}
                                placeholder="Isi catatan jika return. Catatan approve boleh dikosongkan."
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
                                disabled={!selectedBatch || isActionLoading}
                                className="inline-flex items-center justify-center gap-2 rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-2.5 text-sm font-bold text-rose-300 transition-colors hover:bg-rose-500/20 disabled:cursor-not-allowed disabled:opacity-50"
                            >
                                Reject / Return to Supervisor
                            </button>
                            <button
                                onClick={approveBatch}
                                disabled={!selectedBatch || isActionLoading}
                                className="inline-flex items-center justify-center gap-2 rounded-xl border border-emerald-500 bg-emerald-600 px-4 py-2.5 text-sm font-bold text-white transition-colors hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50"
                            >
                                <Bell size={16} /> Approve Data & Notify OM
                            </button>
                        </div>
                    ) : (
                        <div className="mt-5 rounded-xl border border-white/10 bg-black/30 px-4 py-3 text-sm text-slate-400">Readonly: role ini tidak bisa approve/return Sales Manager.</div>
                    )}
                </Panel>
                <Panel title="Kelengkapan Awal dari Supervisor" icon={ListChecks}>
                    <p className="mb-4 text-sm text-slate-400">
                        Kelengkapan ini adalah informasi awal dari Supervisor. Validasi kelengkapan tetap dilakukan oleh Claim.
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
                                    {["No", "No Surat", "Nama Program", "Toko", "KWT", "SKP", "FP", "PC", "Foto", "Rekap", "Others", "Keterangan Others"].map((header) => (
                                        <th key={header} className="px-3 py-3 font-bold">{header}</th>
                                    ))}
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-white/5">
                                {selectedItems.map((item, index) => (
                                    <tr key={item.id || `${item.noSurat}-${index}`} className="hover:bg-white/[0.03]">
                                        <td className="px-3 py-3 font-mono text-slate-300">{item.itemNo || index + 1}</td>
                                        <td className="px-3 py-3 font-mono text-slate-200">{item.noSurat || "-"}</td>
                                        <td className="px-3 py-3 min-w-[180px] text-slate-200">{item.namaProgram || "-"}</td>
                                        <td className="px-3 py-3 min-w-[140px] text-slate-300">{item.toko || "-"}</td>
                                        <td className="px-3 py-3"><ReadOnlyPresenceBadge value={item.kwt} /></td>
                                        <td className="px-3 py-3"><ReadOnlyPresenceBadge value={item.skp} /></td>
                                        <td className="px-3 py-3"><ReadOnlyPresenceBadge value={item.fp} /></td>
                                        <td className="px-3 py-3"><ReadOnlyPresenceBadge value={item.pc} /></td>
                                        <td className="px-3 py-3"><ReadOnlyPresenceBadge value={item.foto} /></td>
                                        <td className="px-3 py-3"><ReadOnlyPresenceBadge value={item.rekap} /></td>
                                        <td className="px-3 py-3"><ReadOnlyPresenceBadge value={item.others} /></td>
                                        <td className="px-3 py-3 min-w-[180px] text-slate-300">{item.othersText || "-"}</td>
                                    </tr>
                                ))}
                                {!isLoading && selectedItems.length === 0 && (
                                    <tr>
                                        <td colSpan={12} className="px-3 py-6 text-center text-sm text-slate-500">
                                            Belum ada item batch yang bisa ditampilkan.
                                        </td>
                                    </tr>
                                )}
                            </tbody>
                        </table>
                    </div>
                </Panel>
                <Panel title="Notification Preview" icon={Mail}>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                        <Field label="Email To" value={notificationPreview?.to || "operational.manager@company.local"} />
                        <Field label="Subject" value={notificationPreview?.subject || "Pengajuan OFF Approved by SM"} />
                        <Field label="Status" value={notificationPreview?.status || "Preview mock"} />
                    </div>
                    <div className="mt-4">
                        <TextArea label="Message" value={notificationPreview?.message || "Ada batch pengajuan OFF yang sudah disetujui Sales Manager dan siap ditinjau OM."} />
                    </div>
                </Panel>
            </div>
        </div>
    );
}

function ClaimDashboard({ offRole }: OffDashboardProps) {
    const canReviewClaim = canPerformOffAction(offRole, "claim_review");
    const canFinalClaim = canPerformOffAction(offRole, "claim_final");
    const [claimView, setClaimView] = useState<"hub" | "after-sm" | "after-finance">("hub");
    const [claimBatches, setClaimBatches] = useState<OffApiBatch[]>([]);
    const [claimHistory, setClaimHistory] = useState<OffApiBatch[]>([]);
    const [finalBatches, setFinalBatches] = useState<OffApiBatch[]>([]);
    const [finalHistory, setFinalHistory] = useState<OffApiBatch[]>([]);
    const [selectedBatch, setSelectedBatch] = useState<OffApiBatch | null>(null);
    const [selectedItems, setSelectedItems] = useState<OffApiItem[]>([]);
    const [selectedFinalBatch, setSelectedFinalBatch] = useState<OffApiBatch | null>(null);
    const [selectedFinalItems, setSelectedFinalItems] = useState<OffApiItem[]>([]);
    const [selectedFinalPayments, setSelectedFinalPayments] = useState<OffApiPayment[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [isActionLoading, setIsActionLoading] = useState(false);
    const [claimMessage, setClaimMessage] = useState("");
    const [noClaim, setNoClaim] = useState("");
    const [claimSubmittedDate, setClaimSubmittedDate] = useState("");
    const [claimDeadline, setClaimDeadline] = useState("");
    const [completenessStatus, setCompletenessStatus] = useState("Aman");
    const [claimNote, setClaimNote] = useState("");
    const [finalClaimNote, setFinalClaimNote] = useState("");
    const totalNominal = selectedItems.reduce((total, item) => total + Number(item.nominal || 0), 0);
    const finalSummary = selectedFinalBatch?.summary;
    const finalTotalNominal = Number(finalSummary?.totalNominal || selectedFinalItems.reduce((total, item) => total + Number(item.nominal || 0), 0));
    const finalTransfer = Number(finalSummary?.transfer || selectedFinalItems.filter((item) => normalizeUiPaymentMethod(item.caraBayar || "") === "Transfer").reduce((total, item) => total + Number(item.nominal || 0), 0));
    const finalTunai = Number(finalSummary?.tunai || selectedFinalItems.filter((item) => normalizeUiPaymentMethod(item.caraBayar || "") === "Tunai").reduce((total, item) => total + Number(item.nominal || 0), 0));
    const finalPaymentSummary = selectedFinalBatch?.paymentSummary;
    const paidAmount = Number(finalPaymentSummary?.totalPaid ?? selectedFinalBatch?.paidAmount ?? 0);
    const remainingFinalAmount = Number(finalPaymentSummary?.remainingAmount ?? Math.max(0, finalTotalNominal - paidAmount));

    const isClaimQueueBatch = (batch: OffApiBatch) => {
        const claimStatus = String(batch.claimStatus || "");
        const status = String(batch.status || "");
        return batch.smStatus === "Approved by SM"
            && !["Approved", "Returned"].includes(claimStatus)
            && !["Cancelled", "Completed", "Claim Approved", "Returned by Claim"].includes(status);
    };

    const isFinalQueueBatch = (batch: OffApiBatch) => batch.financeStatus === "Paid"
        && batch.finalStatus === "Waiting Claim Final Verification"
        && batch.status === "Finance Paid"
        && batch.paymentSummary?.isFullyPaid === true;

    const loadClaimDetail = async (batch: OffApiBatch) => {
        const response = await fetch(`/api/off-program-control/batches/${batch.id}`, { credentials: "include" });
        const data = await parseJsonResponse(response);
        if (!response.ok || !data.ok) throw new Error(String(data.error || "Gagal mengambil detail Claim."));
        const detailBatch = data.batch as OffApiBatch;
        const items = Array.isArray(data.items) ? data.items as OffApiItem[] : [];
        setSelectedBatch(detailBatch || batch);
        setSelectedItems(items);
        setNoClaim(detailBatch?.noClaim || "");
        setClaimSubmittedDate(detailBatch?.claimSubmittedDate || "");
        setClaimDeadline(detailBatch?.claimDeadline || "");
        setClaimNote(detailBatch?.claimNote || "");
    };

    const loadFinalDetail = async (batch: OffApiBatch) => {
        const response = await fetch(`/api/off-program-control/batches/${batch.id}`, { credentials: "include" });
        const data = await parseJsonResponse(response);
        if (!response.ok || !data.ok) throw new Error(String(data.error || "Gagal mengambil detail final Claim."));
        const detailBatch = data.batch as OffApiBatch;
        const items = Array.isArray(data.items) ? data.items as OffApiItem[] : [];
        const payments = Array.isArray(data.payments) ? data.payments as OffApiPayment[] : [];
        const paymentSummary = data.paymentSummary as OffPaymentSummary | undefined;
        const batchWithPaymentSummary = { ...(detailBatch || batch), paymentSummary, payments };
        setSelectedFinalBatch(batchWithPaymentSummary);
        setSelectedFinalItems(items);
        setSelectedFinalPayments(payments);
        setFinalClaimNote(detailBatch?.finalClaimNote || "");
    };

    const loadClaimBatches = async () => {
        setIsLoading(true);
        setClaimMessage("");
        try {
            const response = await fetch("/api/off-program-control/batches", { credentials: "include" });
            const data = await parseJsonResponse(response);
            if (!response.ok || !data.ok) throw new Error(String(data.error || "Gagal mengambil queue Claim."));
            const rows = Array.isArray(data.batches) ? data.batches as OffApiBatch[] : [];
            const queue = rows.filter(isClaimQueueBatch);
            const finalQueue = rows.filter(isFinalQueueBatch);
            setClaimBatches(queue);
            setClaimHistory(rows.filter((batch) => batch.claimStatus === "Approved" || batch.claimStatus === "Returned"));
            setFinalBatches(finalQueue);
            setFinalHistory(rows.filter((batch) => batch.finalStatus === "Completed" || batch.finalStatus === "Need Correction from Finance" || batch.status === "Completed" || batch.status === "Returned to Finance"));
            const nextBatch = queue[0] || null;
            const nextFinalBatch = finalQueue[0] || null;
            setSelectedBatch(nextBatch);
            setSelectedFinalBatch(nextFinalBatch);
            if (nextBatch) {
                await loadClaimDetail(nextBatch);
            } else {
                setSelectedItems([]);
                setNoClaim("");
                setClaimSubmittedDate("");
                setClaimDeadline("");
                setClaimNote("");
            }
            if (nextFinalBatch) {
                await loadFinalDetail(nextFinalBatch);
            } else {
                setSelectedFinalItems([]);
                setSelectedFinalPayments([]);
                setFinalClaimNote("");
            }
        } catch (error) {
            setClaimMessage(error instanceof Error ? error.message : "Gagal mengambil queue Claim.");
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
            setClaimMessage(error instanceof Error ? error.message : "Gagal mengambil detail Claim.");
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
            setClaimMessage(error instanceof Error ? error.message : "Gagal mengambil detail final Claim.");
        }
    };

    const returnByClaim = async () => {
        if (!selectedBatch) return;
        if (!claimNote.trim()) {
            setClaimMessage("Catatan Claim wajib diisi untuk return.");
            return;
        }
        setIsActionLoading(true);
        setClaimMessage("");
        try {
            const response = await fetch(`/api/off-program-control/batches/${selectedBatch.id}/claim-review`, {
                method: "POST",
                credentials: "include",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ action: "return", note: claimNote, completenessStatus }),
            });
            const data = await parseJsonResponse(response);
            if (!response.ok || !data.ok) throw new Error(String(data.error || data.message || "Gagal return dari Claim."));
            setClaimMessage(String(data.message || "Pengajuan dikembalikan oleh Claim untuk diperbaiki."));
            await loadClaimBatches();
        } catch (error) {
            setClaimMessage(error instanceof Error ? error.message : "Gagal return dari Claim.");
        } finally {
            setIsActionLoading(false);
        }
    };

    const approveByClaim = async () => {
        if (!selectedBatch) return;
        setIsActionLoading(true);
        setClaimMessage("");
        try {
            const response = await fetch(`/api/off-program-control/batches/${selectedBatch.id}/claim-review`, {
                method: "POST",
                credentials: "include",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ action: "approve", noClaim, claimSubmittedDate, claimDeadline, completenessStatus, note: claimNote }),
            });
            const data = await parseJsonResponse(response);
            if (!response.ok || !data.ok) throw new Error(String(data.error || data.message || "Gagal approve Claim."));
            setClaimMessage(String(data.message || "Claim menyetujui pengajuan dan meneruskan ke OM."));
            await loadClaimBatches();
        } catch (error) {
            setClaimMessage(error instanceof Error ? error.message : "Gagal approve Claim.");
        } finally {
            setIsActionLoading(false);
        }
    };

    const returnToFinance = async () => {
        if (!selectedFinalBatch) return;
        if (!finalClaimNote.trim()) {
            setClaimMessage("Catatan wajib diisi untuk return ke Keuangan.");
            return;
        }
        setIsActionLoading(true);
        setClaimMessage("");
        try {
            const response = await fetch(`/api/off-program-control/batches/${selectedFinalBatch.id}/final-claim`, {
                method: "POST",
                credentials: "include",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ action: "return_to_finance", note: finalClaimNote }),
            });
            const data = await parseJsonResponse(response);
            if (!response.ok || !data.ok) throw new Error(String(data.error || data.message || "Gagal return ke Keuangan."));
            setClaimMessage(String(data.message || "Pengajuan dikembalikan ke Keuangan untuk koreksi."));
            await loadClaimBatches();
        } catch (error) {
            setClaimMessage(error instanceof Error ? error.message : "Gagal return ke Keuangan.");
        } finally {
            setIsActionLoading(false);
        }
    };

    const completeFinalClaim = async () => {
        if (!selectedFinalBatch) return;
        if (remainingFinalAmount > 0) {
            setClaimMessage("Pembayaran belum lunas, belum bisa di-approve Claim.");
            return;
        }
        setIsActionLoading(true);
        setClaimMessage("");
        try {
            const response = await fetch(`/api/off-program-control/batches/${selectedFinalBatch.id}/final-claim`, {
                method: "POST",
                credentials: "include",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ action: "complete", note: finalClaimNote }),
            });
            const data = await parseJsonResponse(response);
            if (!response.ok || !data.ok) throw new Error(String(data.error || data.message || "Gagal complete final Claim."));
            setClaimMessage(String(data.message || "Pengajuan selesai dan status menjadi Completed."));
            await loadClaimBatches();
        } catch (error) {
            setClaimMessage(error instanceof Error ? error.message : "Gagal complete final Claim.");
        } finally {
            setIsActionLoading(false);
        }
    };

    if (claimView === "hub") {
        return (
            <div className="space-y-6">
                <div className="rounded-2xl border border-white/10 bg-[#1a1c23]/60 p-6 shadow-xl">
                    <h2 className="text-2xl font-black text-white">Claim Dashboard</h2>
                    <p className="mt-2 text-sm text-slate-400">Pilih jenis validasi Claim yang ingin diproses.</p>
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
                        <h3 className="mt-5 text-xl font-black text-white">Validasi Setelah SM</h3>
                        <p className="mt-2 text-sm leading-6 text-slate-400">
                            Cek data batch yang sudah disetujui Sales Manager, input No Claim, tanggal diajukan, deadline claim, dan validasi kelengkapan.
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
                        <h3 className="mt-5 text-xl font-black text-white">Validasi Setelah Keuangan</h3>
                        <p className="mt-2 text-sm leading-6 text-slate-400">
                            Cek data yang sudah dibayar Keuangan, verifikasi bukti bayar dan jumlah pembayaran, lalu complete atau return ke Keuangan.
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
                    <div className="rounded-xl border border-white/10 bg-black/30 px-4 py-3 text-sm text-slate-300">{claimMessage}</div>
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
                Kembali ke Claim Dashboard
            </button>
            <div className="rounded-2xl border border-white/10 bg-[#1a1c23]/60 p-5 shadow-xl">
                <h2 className="text-xl font-black text-white">{claimView === "after-sm" ? "Validasi Setelah SM" : "Validasi Setelah Keuangan"}</h2>
                <p className="mt-1 text-sm text-slate-400">
                    {claimView === "after-sm"
                        ? "Cek batch yang sudah disetujui Sales Manager dan lakukan validasi Claim awal."
                        : "Cek pembayaran Keuangan, verifikasi bukti bayar, lalu complete atau return ke Keuangan."}
                </p>
            </div>
            <InfoNote>
                Checklist Supervisor bukan approval. Claim wajib verifikasi real-life sebelum approve.
            </InfoNote>
            {claimView === "after-sm" && <div className="grid grid-cols-1 xl:grid-cols-[0.75fr_1.25fr] gap-6">
                <Panel title="Menunggu Validasi Claim" icon={FileCheck2}>
                    <div className="space-y-3">
                        {isLoading && <p className="text-sm text-slate-400">Memuat queue Claim...</p>}
                        {!isLoading && claimBatches.length === 0 && <p className="text-sm text-slate-400">Belum ada batch approved SM yang menunggu Claim.</p>}
                        {claimBatches.map((batch) => {
                            const summary = batch.summary || { totalRows: 0, totalNominal: 0 };
                            return (
                                <button
                                    key={batch.id}
                                    onClick={() => selectClaimBatch(batch)}
                                    className={`w-full rounded-xl border p-4 text-left transition-colors ${selectedBatch?.id === batch.id ? "border-teal-500/40 bg-teal-500/10" : "border-white/10 bg-black/30 hover:bg-white/[0.04]"}`}
                                >
                                    <p className="font-mono text-sm font-bold text-white">{batch.noPengajuan}</p>
                                    <p className="mt-1 text-sm text-slate-300">{batch.principleName} <span className="font-mono text-teal-300">({batch.principleCode})</span></p>
                                    <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-slate-400">
                                        <span>Row: <b className="text-slate-200">{summary.totalRows || summary.rowCount || 0}</b></span>
                                        <span>Total: <b className="text-emerald-300">Rp {Number(summary.totalNominal || 0).toLocaleString("id-ID")}</b></span>
                                        <span>SM: <b className="text-emerald-300">{batch.smStatus}</b></span>
                                        <span>Claim: <b className="text-sky-300">{batch.claimStatus || "-"}</b></span>
                                        <span>No Claim: <b className="text-slate-200">{batch.noClaim || "-"}</b></span>
                                        <span>Deadline: <b className="text-slate-200">{batch.claimDeadline || "-"}</b></span>
                                    </div>
                                </button>
                            );
                        })}
                    </div>
                    <div className="mt-6 border-t border-white/10 pt-5">
                        <p className="mb-3 text-sm font-bold text-white">Riwayat Validasi Claim</p>
                        <div className="space-y-2">
                            {claimHistory.slice(0, 5).map((batch) => (
                                <div key={batch.id} className="rounded-lg border border-white/10 bg-black/20 p-3">
                                    <p className="font-mono text-xs font-bold text-slate-200">{batch.noPengajuan}</p>
                                    <p className="mt-1 text-xs text-slate-500">{batch.principleCode} - {batch.principleName}</p>
                                    <span className={`mt-2 inline-flex rounded-md border px-2 py-1 text-xs font-bold ${statusClass(batch.claimStatus)}`}>{batch.claimStatus}</span>
                                </div>
                            ))}
                            {claimHistory.length === 0 && <p className="text-sm text-slate-500">Belum ada history Claim.</p>}
                        </div>
                    </div>
                </Panel>

                <div className="space-y-6">
                <Panel title="Detail Validasi Claim" icon={FileCheck2}>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                        <Field label="No Pengajuan" value={selectedBatch?.noPengajuan || "-"} />
                        <Field label="Gelombang" value={selectedBatch?.gelombang || "-"} />
                        <Field label="Principle" value={selectedBatch?.principleName || "-"} />
                        <Field label="Kode Principle" value={selectedBatch?.principleCode || "-"} />
                        <Field label="Bulan/Tahun" value={selectedBatch ? `${selectedBatch.bulan}/${selectedBatch.tahun}` : "-"} />
                        <Field label="Supervisor" value={selectedBatch?.supervisorName || "-"} />
                        <Field label="Total Nominal" value={`Rp ${totalNominal.toLocaleString("id-ID")}`} />
                        <Field label="Status SM" value={selectedBatch?.smStatus || "-"} />
                        <Field label="Status Claim" value={selectedBatch?.claimStatus || "-"} />
                    </div>
                    <div className="mt-5 overflow-x-auto rounded-xl border border-white/10">
                        <table className="w-full min-w-[1150px] text-left text-sm">
                            <thead className="border-b border-white/10 bg-black/50 text-xs uppercase tracking-wider text-slate-500">
                                <tr>
                                    {["No", "No Surat", "Nama Program", "Periode", "Toko", "Barang", "Nominal", "Cara Bayar", "Type", "Deadline"].map((header) => (
                                        <th key={header} className="px-3 py-3 font-bold">{header}</th>
                                    ))}
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-white/5">
                                {selectedItems.map((item, index) => (
                                    <tr key={item.id || `${item.noSurat}-${index}`} className="hover:bg-white/[0.03]">
                                        <td className="px-3 py-3 font-mono text-slate-300">{item.itemNo || index + 1}</td>
                                        <td className="px-3 py-3 font-mono text-slate-200">{item.noSurat || "-"}</td>
                                        <td className="px-3 py-3 min-w-[180px] text-slate-200">{item.namaProgram || "-"}</td>
                                        <td className="px-3 py-3 text-slate-300">{item.periode || "-"}</td>
                                        <td className="px-3 py-3 min-w-[140px] text-slate-300">{item.toko || "-"}</td>
                                        <td className="px-3 py-3 text-slate-300">{item.barang || "-"}</td>
                                        <td className="px-3 py-3 text-right font-mono text-emerald-300">Rp {Number(item.nominal || 0).toLocaleString("id-ID")}</td>
                                        <td className="px-3 py-3 text-slate-300">{item.caraBayar || "-"}</td>
                                        <td className="px-3 py-3 text-slate-300">{item.type || "-"}</td>
                                        <td className="px-3 py-3 text-slate-300">{item.deadline || "-"}</td>
                                    </tr>
                                ))}
                                {!isLoading && selectedItems.length === 0 && (
                                    <tr><td colSpan={10} className="px-3 py-6 text-center text-sm text-slate-500">Pilih batch untuk melihat item.</td></tr>
                                )}
                            </tbody>
                        </table>
                    </div>
                </Panel>

                <Panel title="Kelengkapan Awal dari Supervisor" icon={ListChecks}>
                    <p className="mb-4 text-sm text-slate-400">Kelengkapan dari Supervisor adalah informasi awal. Claim wajib verifikasi real-life sebelum approve.</p>
                    <div className="overflow-x-auto rounded-xl border border-white/10">
                        <table className="w-full min-w-[1200px] text-left text-sm">
                            <thead className="border-b border-white/10 bg-black/50 text-xs uppercase tracking-wider text-slate-500">
                                <tr>
                                    {["No", "No Surat", "Nama Program", "Toko", "KWT", "SKP", "FP", "PC", "Foto", "Rekap", "Others", "Keterangan Others"].map((header) => (
                                        <th key={header} className="px-3 py-3 font-bold">{header}</th>
                                    ))}
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-white/5">
                                {selectedItems.map((item, index) => (
                                    <tr key={item.id || `${item.noSurat}-${index}`} className="hover:bg-white/[0.03]">
                                        <td className="px-3 py-3 font-mono text-slate-300">{item.itemNo || index + 1}</td>
                                        <td className="px-3 py-3 font-mono text-slate-200">{item.noSurat || "-"}</td>
                                        <td className="px-3 py-3 min-w-[180px] text-slate-200">{item.namaProgram || "-"}</td>
                                        <td className="px-3 py-3 min-w-[140px] text-slate-300">{item.toko || "-"}</td>
                                        <td className="px-3 py-3"><ReadOnlyPresenceBadge value={item.kwt} /></td>
                                        <td className="px-3 py-3"><ReadOnlyPresenceBadge value={item.skp} /></td>
                                        <td className="px-3 py-3"><ReadOnlyPresenceBadge value={item.fp} /></td>
                                        <td className="px-3 py-3"><ReadOnlyPresenceBadge value={item.pc} /></td>
                                        <td className="px-3 py-3"><ReadOnlyPresenceBadge value={item.foto} /></td>
                                        <td className="px-3 py-3"><ReadOnlyPresenceBadge value={item.rekap} /></td>
                                        <td className="px-3 py-3"><ReadOnlyPresenceBadge value={item.others} /></td>
                                        <td className="px-3 py-3 min-w-[180px] text-slate-300">{item.othersText || "-"}</td>
                                    </tr>
                                ))}
                                {!isLoading && selectedItems.length === 0 && (
                                    <tr><td colSpan={12} className="px-3 py-6 text-center text-sm text-slate-500">Belum ada item batch yang bisa ditampilkan.</td></tr>
                                )}
                            </tbody>
                        </table>
                    </div>
                </Panel>

                <Panel title="Form Validasi Claim" icon={ClipboardCheck}>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                        <EditableField label="No Claim" value={noClaim} onChange={setNoClaim} />
                        <DateField label="Tanggal Diajukan" value={claimSubmittedDate} onChange={setClaimSubmittedDate} />
                        <DateField label="Deadline Claim" value={claimDeadline} onChange={setClaimDeadline} />
                        <label className="block">
                            <span className="text-xs text-slate-500 font-semibold">Status Kelengkapan Claim</span>
                            <select value={completenessStatus} onChange={(event) => setCompletenessStatus(event.target.value)} className="mt-1 w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2.5 text-sm text-slate-200 outline-none focus:border-teal-500/50">
                                <option className="bg-[#1a1c23]" value="Aman">Aman</option>
                                <option className="bg-[#1a1c23]" value="Kurang">Kurang</option>
                                <option className="bg-[#1a1c23]" value="Perlu Revisi">Perlu Revisi</option>
                            </select>
                        </label>
                    </div>
                    <div className="mt-4">
                        <label className="block">
                            <span className="text-xs text-slate-500 font-semibold">Catatan Claim</span>
                            <textarea value={claimNote} onChange={(event) => setClaimNote(event.target.value)} rows={4} className="mt-1 w-full resize-none rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-slate-200 outline-none placeholder:text-slate-600 focus:border-teal-500/50" />
                        </label>
                    </div>
                    {claimMessage && (
                        <div className="mt-4 rounded-xl border border-white/10 bg-black/30 px-4 py-3 text-sm text-slate-300">{claimMessage}</div>
                    )}
                    {canReviewClaim ? (
                        <div className="mt-5 flex flex-wrap gap-3">
                            <button onClick={returnByClaim} disabled={!selectedBatch || isActionLoading} className="inline-flex items-center justify-center gap-2 rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-2.5 text-sm font-bold text-rose-300 transition-colors hover:bg-rose-500/20 disabled:cursor-not-allowed disabled:opacity-50">
                                Return for Correction
                            </button>
                            <button onClick={approveByClaim} disabled={!selectedBatch || isActionLoading} className="inline-flex items-center justify-center gap-2 rounded-xl border border-emerald-500 bg-emerald-600 px-4 py-2.5 text-sm font-bold text-white transition-colors hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50">
                                Claim Approved
                            </button>
                        </div>
                    ) : (
                        <div className="mt-5 rounded-xl border border-white/10 bg-black/30 px-4 py-3 text-sm text-slate-400">Readonly: role ini tidak bisa memproses Claim.</div>
                    )}
                </Panel>
                </div>
            </div>}

            {claimView === "after-finance" && <div className="grid grid-cols-1 xl:grid-cols-[0.75fr_1.25fr] gap-6">
                <Panel title="Menunggu Final Verification Setelah Pembayaran" icon={Wallet}>
                    <div className="space-y-3">
                        {isLoading && <p className="text-sm text-slate-400">Memuat queue final Claim...</p>}
                        {!isLoading && finalBatches.length === 0 && <p className="text-sm text-slate-400">Belum ada batch Finance Paid yang menunggu final verification.</p>}
                        {finalBatches.map((batch) => {
                            const batchSummary = batch.summary || { totalNominal: 0 };
                            const batchPaymentSummary = batch.paymentSummary || { totalPaid: Number(batch.paidAmount || 0), remainingAmount: Math.max(0, Number(batchSummary.totalNominal || 0) - Number(batch.paidAmount || 0)) };
                            return (
                                <button
                                    key={batch.id}
                                    onClick={() => selectFinalBatch(batch)}
                                    className={`w-full rounded-xl border p-4 text-left transition-colors ${selectedFinalBatch?.id === batch.id ? "border-teal-500/40 bg-teal-500/10" : "border-white/10 bg-black/30 hover:bg-white/[0.04]"}`}
                                >
                                    <p className="font-mono text-sm font-bold text-white">{batch.noPengajuan}</p>
                                    <p className="mt-1 text-sm text-slate-300">{batch.principleName} <span className="font-mono text-teal-300">({batch.principleCode})</span></p>
                                    <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-slate-400">
                                        <span>No Claim: <b className="text-slate-200">{batch.noClaim || "-"}</b></span>
                                        <span>Total: <b className="text-emerald-300">Rp {Number(batchSummary.totalNominal || 0).toLocaleString("id-ID")}</b></span>
                                        <span>Dibayar: <b className="text-emerald-300">Rp {Number(batchPaymentSummary.totalPaid || 0).toLocaleString("id-ID")}</b></span>
                                        <span>Sisa: <b className="text-amber-300">Rp {Number(batchPaymentSummary.remainingAmount || 0).toLocaleString("id-ID")}</b></span>
                                        <span>Tgl Bayar: <b className="text-slate-200">{formatDateDisplay(batch.paymentDate)}</b></span>
                                        <span>Finance: <b className="text-sky-300">{batch.financeStatus}</b></span>
                                        <span>Final: <b className="text-purple-300">{batch.finalStatus}</b></span>
                                    </div>
                                </button>
                            );
                        })}
                    </div>
                    <div className="mt-6 border-t border-white/10 pt-5">
                        <p className="mb-3 text-sm font-bold text-white">Riwayat Final Claim</p>
                        <div className="space-y-2">
                            {finalHistory.slice(0, 5).map((batch) => (
                                <div key={batch.id} className="rounded-lg border border-white/10 bg-black/20 p-3">
                                    <p className="font-mono text-xs font-bold text-slate-200">{batch.noPengajuan}</p>
                                    <p className="mt-1 text-xs text-slate-500">{batch.principleCode} - {batch.principleName}</p>
                                    <span className={`mt-2 inline-flex rounded-md border px-2 py-1 text-xs font-bold ${statusClass(batch.finalStatus)}`}>{batch.finalStatus}</span>
                                </div>
                            ))}
                            {finalHistory.length === 0 && <p className="text-sm text-slate-500">Belum ada history final Claim.</p>}
                        </div>
                    </div>
                </Panel>

                <div className="space-y-6">
                    <Panel title="Detail Final Claim" icon={ListChecks}>
                        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                            <Field label="No Pengajuan" value={selectedFinalBatch?.noPengajuan || "-"} />
                            <Field label="Principle" value={selectedFinalBatch?.principleName || "-"} />
                            <Field label="Kode Principle" value={selectedFinalBatch?.principleCode || "-"} />
                            <Field label="No Claim" value={selectedFinalBatch?.noClaim || "-"} />
                            <Field label="Tanggal Diajukan Claim" value={formatDateDisplay(selectedFinalBatch?.claimSubmittedDate)} />
                            <Field label="Deadline Claim" value={formatDateDisplay(selectedFinalBatch?.claimDeadline)} />
                            <Field label="Total Nominal" value={`Rp ${finalTotalNominal.toLocaleString("id-ID")}`} />
                            <Field label="Status SM" value={selectedFinalBatch?.smStatus || "-"} />
                            <Field label="Status Claim" value={selectedFinalBatch?.claimStatus || "-"} />
                            <Field label="Status OM" value={selectedFinalBatch?.omStatus || "-"} />
                            <Field label="Status Finance" value={selectedFinalBatch?.financeStatus || "-"} />
                            <Field label="Status Final" value={selectedFinalBatch?.finalStatus || "-"} />
                        </div>
                    </Panel>

                    <Panel title="Riwayat Pembayaran dari Keuangan" icon={Wallet}>
                        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                            <Field label="Tanggal Bayar" value={formatDateDisplay(selectedFinalBatch?.paymentDate)} />
                            <Field label="Total Pengajuan" value={`Rp ${finalTotalNominal.toLocaleString("id-ID")}`} />
                            <Field label="Total Dibayar Keuangan" value={`Rp ${paidAmount.toLocaleString("id-ID")}`} />
                            <Field label="Sisa Pembayaran" value={`Rp ${remainingFinalAmount.toLocaleString("id-ID")}`} />
                            <Field label="Jumlah Pembayaran" value={`${selectedFinalPayments.length} pembayaran`} />
                        </div>
                        <div className="mt-4">
                            <TextArea label="Catatan Keuangan" value={selectedFinalBatch?.financeNote || "-"} />
                        </div>
                        <div className="mt-5 overflow-x-auto rounded-xl border border-white/10">
                            <table className="w-full min-w-[900px] text-left text-sm">
                                <thead className="border-b border-white/10 bg-black/50 text-xs uppercase tracking-wider text-slate-500">
                                    <tr>
                                        {["Payment No", "Tanggal Bayar", "Metode", "Jumlah", "Bank Pengirim", "Bukti Pembayaran", "Catatan"].map((header) => (
                                            <th key={header} className="px-3 py-3 font-bold">{header}</th>
                                        ))}
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-white/5">
                                    {selectedFinalPayments.map((payment) => (
                                        <tr key={payment.id} className="hover:bg-white/[0.03]">
                                            <td className="px-3 py-3 font-mono text-slate-300">{payment.paymentNo}</td>
                                            <td className="px-3 py-3 text-slate-300">{formatDateDisplay(payment.paymentDate)}</td>
                                            <td className="px-3 py-3 text-slate-300">{payment.paymentMethod}</td>
                                            <td className="px-3 py-3 text-right font-mono text-emerald-300">Rp {Number(payment.paidAmount || 0).toLocaleString("id-ID")}</td>
                                            <td className="px-3 py-3 text-slate-300">{payment.senderBank || "-"}</td>
                                            <td className="px-3 py-3">
                                                <div className="min-w-[180px] space-y-2">
                                                    <p className="font-mono text-xs text-slate-300">{payment.paymentProofName || "-"}</p>
                                                    {payment.proofUrl && (
                                                        <button type="button" onClick={() => window.open(payment.proofUrl || "", "_blank")} className="rounded-lg border border-teal-500/30 bg-teal-500/10 px-2 py-1 text-xs font-bold text-teal-300 hover:bg-teal-500/20">
                                                            Lihat Bukti
                                                        </button>
                                                    )}
                                                </div>
                                            </td>
                                            <td className="px-3 py-3 text-slate-300">{payment.note || "-"}</td>
                                        </tr>
                                    ))}
                                    {!isLoading && selectedFinalPayments.length === 0 && (
                                        <tr><td colSpan={7} className="px-3 py-6 text-center text-sm text-slate-500">Belum ada riwayat pembayaran.</td></tr>
                                    )}
                                </tbody>
                            </table>
                        </div>
                    </Panel>

                    <Panel title="Item Batch Final Verification" icon={ReceiptText}>
                        <div className="overflow-x-auto rounded-xl border border-white/10">
                            <table className="w-full min-w-[1250px] text-sm text-left">
                                <thead className="bg-black/50 text-xs uppercase tracking-wider text-slate-500 border-b border-white/10">
                                    <tr>
                                        {["No", "No Surat", "Nama Program", "Periode Awal", "Periode Akhir", "Toko", "Barang", "Nominal", "Cara Bayar", "Type", "Deadline"].map((header) => (
                                            <th key={header} className="px-3 py-3 font-bold">{header}</th>
                                        ))}
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-white/5">
                                    {selectedFinalItems.map((item, index) => {
                                        const period = splitPeriodDates(item.periode);
                                        return (
                                            <tr key={item.id || `${item.noSurat}-${index}`} className="hover:bg-white/[0.03]">
                                                <td className="px-3 py-3 font-mono text-slate-300">{item.itemNo || index + 1}</td>
                                                <td className="px-3 py-3 font-mono text-slate-200">{item.noSurat || "-"}</td>
                                                <td className="px-3 py-3 min-w-[180px] text-slate-200">{item.namaProgram || "-"}</td>
                                                <td className="px-3 py-3 text-slate-300">{formatDateDisplay(period.periodeAwal)}</td>
                                                <td className="px-3 py-3 text-slate-300">{formatDateDisplay(period.periodeAkhir)}</td>
                                                <td className="px-3 py-3 min-w-[140px] text-slate-300">{item.toko || "-"}</td>
                                                <td className="px-3 py-3 text-slate-300">{item.barang || "-"}</td>
                                                <td className="px-3 py-3 text-right font-mono text-emerald-300">Rp {Number(item.nominal || 0).toLocaleString("id-ID")}</td>
                                                <td className="px-3 py-3 text-slate-300">{item.caraBayar || "-"}</td>
                                                <td className="px-3 py-3 text-slate-300">{item.type || "-"}</td>
                                                <td className="px-3 py-3 text-slate-300">{formatDateDisplay(item.deadline)}</td>
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                        </div>
                    </Panel>

                    <Panel title="Summary Pembayaran Final" icon={ReceiptText}>
                        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-5 gap-3">
                            <Field label="Total Nominal" value={`Rp ${finalTotalNominal.toLocaleString("id-ID")}`} />
                            <Field label="Transfer" value={`Rp ${finalTransfer.toLocaleString("id-ID")}`} />
                            <Field label="Tunai" value={`Rp ${finalTunai.toLocaleString("id-ID")}`} />
                            <Field label="Jumlah Dibayar Keuangan" value={`Rp ${paidAmount.toLocaleString("id-ID")}`} />
                            <Field label="Sisa Pembayaran" value={`Rp ${remainingFinalAmount.toLocaleString("id-ID")}`} />
                        </div>
                    </Panel>

                    <Panel title="Claim Final Verification Form" icon={ClipboardCheck}>
                        <InfoNote>Claim hanya perlu mengecek bukti pembayaran dan kesesuaian total pembayaran. Jika ada masalah, return ke Keuangan. Jika sesuai, approve completed.</InfoNote>
                        <div className="mt-4">
                            <label className="block">
                                <span className="text-xs text-slate-500 font-semibold">Catatan Final Claim</span>
                                <textarea value={finalClaimNote} onChange={(event) => setFinalClaimNote(event.target.value)} rows={4} className="mt-1 w-full resize-none rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-slate-200 outline-none placeholder:text-slate-600 focus:border-teal-500/50" />
                            </label>
                        </div>
                        {canFinalClaim ? (
                            <div className="mt-5 flex flex-wrap gap-3">
                                <button onClick={returnToFinance} disabled={!selectedFinalBatch || isActionLoading} className="inline-flex items-center justify-center rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-2.5 text-sm font-bold text-rose-300 hover:bg-rose-500/20 disabled:opacity-50">
                                    Return to Finance
                                </button>
                                <button onClick={completeFinalClaim} disabled={!selectedFinalBatch || isActionLoading} className="inline-flex items-center justify-center rounded-xl border border-emerald-500 bg-emerald-600 px-4 py-2.5 text-sm font-bold text-white hover:bg-emerald-500 disabled:opacity-50">
                                    Complete / Completed
                                </button>
                            </div>
                        ) : (
                            <div className="mt-5 rounded-xl border border-white/10 bg-black/30 px-4 py-3 text-sm text-slate-400">Readonly: role ini tidak bisa memproses final Claim.</div>
                        )}
                    </Panel>
                </div>
            </div>}
        </div>
    );
}

function OperationalManagerDashboard({ offRole }: OffDashboardProps) {
    const canDecideOm = canPerformOffAction(offRole, "om_approve") || canPerformOffAction(offRole, "om_cancel");
    const [omBatches, setOmBatches] = useState<OffApiBatch[]>([]);
    const [omHistory, setOmHistory] = useState<OffApiBatch[]>([]);
    const [selectedBatch, setSelectedBatch] = useState<OffApiBatch | null>(null);
    const [selectedItems, setSelectedItems] = useState<OffApiItem[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [isActionLoading, setIsActionLoading] = useState(false);
    const [omNote, setOmNote] = useState("");
    const [omMessage, setOmMessage] = useState("");
    const summary = selectedBatch?.summary;
    const totalNominal = Number(summary?.totalNominal || selectedItems.reduce((total, item) => total + Number(item.nominal || 0), 0));
    const transfer = Number(summary?.transfer || selectedItems.filter((item) => normalizeUiPaymentMethod(item.caraBayar || "") === "Transfer").reduce((total, item) => total + Number(item.nominal || 0), 0));
    const tunai = Number(summary?.tunai || selectedItems.filter((item) => normalizeUiPaymentMethod(item.caraBayar || "") === "Tunai").reduce((total, item) => total + Number(item.nominal || 0), 0));
    const hasMixedPaymentTypes = transfer > 0 && tunai > 0;

    const isOmQueueBatch = (batch: OffApiBatch) => batch.smStatus === "Approved by SM"
        && batch.claimStatus === "Approved"
        && batch.omStatus === "Waiting Approval"
        && (batch.status === "Claim Approved" || batch.status === "Ready for OM" || batch.status === "Waiting OM")
        && !["Cancelled by OM", "OM Approved", "Completed"].includes(batch.status);

    const loadOmDetail = async (batch: OffApiBatch) => {
        const response = await fetch(`/api/off-program-control/batches/${batch.id}`, { credentials: "include" });
        const data = await parseJsonResponse(response);
        if (!response.ok || !data.ok) throw new Error(String(data.error || "Gagal mengambil detail OM."));
        setSelectedBatch(data.batch as OffApiBatch || batch);
        setSelectedItems(Array.isArray(data.items) ? data.items as OffApiItem[] : []);
        setOmNote((data.batch as OffApiBatch)?.omNote || "");
    };

    const loadOmBatches = async () => {
        setIsLoading(true);
        setOmMessage("");
        try {
            const response = await fetch("/api/off-program-control/batches", { credentials: "include" });
            const data = await parseJsonResponse(response);
            if (!response.ok || !data.ok) throw new Error(String(data.error || "Gagal mengambil queue OM."));
            const rows = Array.isArray(data.batches) ? data.batches as OffApiBatch[] : [];
            const queue = rows.filter(isOmQueueBatch);
            setOmBatches(queue);
            setOmHistory(rows.filter((batch) => batch.omStatus === "Approved" || batch.omStatus === "Cancelled"));
            const nextBatch = queue[0] || null;
            setSelectedBatch(nextBatch);
            if (nextBatch) {
                await loadOmDetail(nextBatch);
            } else {
                setSelectedItems([]);
                setOmNote("");
            }
        } catch (error) {
            setOmMessage(error instanceof Error ? error.message : "Gagal mengambil queue OM.");
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
        setSelectedItems([]);
        setOmMessage("");
        try {
            await loadOmDetail(batch);
        } catch (error) {
            setOmMessage(error instanceof Error ? error.message : "Gagal mengambil detail OM.");
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
            const response = await fetch(`/api/off-program-control/batches/${selectedBatch.id}/om-decision`, {
                method: "POST",
                credentials: "include",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ action, note: omNote }),
            });
            const data = await parseJsonResponse(response);
            if (!response.ok || !data.ok) throw new Error(String(data.error || data.message || "Gagal memproses keputusan OM."));
            setOmMessage(String(data.message || "Keputusan OM berhasil disimpan."));
            setOmNote("");
            await loadOmBatches();
        } catch (error) {
            setOmMessage(error instanceof Error ? error.message : "Gagal memproses keputusan OM.");
        } finally {
            setIsActionLoading(false);
        }
    };

    return (
        <div className="space-y-6">
            <InfoNote>
                OM dapat melihat data yang sudah approved oleh SM. Approval final OM idealnya dilakukan setelah validasi Claim sesuai.
            </InfoNote>
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
                {[
                    ["Approved by SM", String(omBatches.filter((batch) => batch.smStatus === "Approved by SM").length)],
                    ["Claim Approved", String(omBatches.filter((batch) => batch.claimStatus === "Approved").length)],
                    ["Ready for OM Approval", String(omBatches.length)],
                    ["Cancelled", String(omHistory.filter((batch) => batch.omStatus === "Cancelled").length)],
                ].map(([label, value]) => (
                    <div key={label} className="rounded-2xl border border-white/10 bg-[#1a1c23]/60 p-5 shadow-xl">
                        <p className="text-sm text-slate-400">{label}</p>
                        <p className="mt-2 text-3xl font-black text-white">{value}</p>
                    </div>
                ))}
            </div>

            <div className="grid grid-cols-1 xl:grid-cols-[0.75fr_1.25fr] gap-6">
                <Panel title="Menunggu Approval OM" icon={ShieldCheck}>
                    <div className="space-y-3">
                        {isLoading && <p className="text-sm text-slate-400">Memuat queue OM...</p>}
                        {!isLoading && omBatches.length === 0 && <p className="text-sm text-slate-400">Belum ada batch Claim Approved yang menunggu OM.</p>}
                        {omBatches.map((batch) => {
                            const batchSummary = batch.summary || { totalRows: 0, totalNominal: 0 };
                            return (
                                <button
                                    key={batch.id}
                                    onClick={() => selectOmBatch(batch)}
                                    className={`w-full rounded-xl border p-4 text-left transition-colors ${selectedBatch?.id === batch.id ? "border-teal-500/40 bg-teal-500/10" : "border-white/10 bg-black/30 hover:bg-white/[0.04]"}`}
                                >
                                    <p className="font-mono text-sm font-bold text-white">{batch.noPengajuan}</p>
                                    <p className="mt-1 text-sm text-slate-300">{batch.principleName} <span className="font-mono text-teal-300">({batch.principleCode})</span></p>
                                    <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-slate-400">
                                        <span>No Claim: <b className="text-slate-200">{batch.noClaim || "-"}</b></span>
                                        <span>Row: <b className="text-slate-200">{batchSummary.totalRows || batchSummary.rowCount || 0}</b></span>
                                        <span>Total: <b className="text-emerald-300">Rp {Number(batchSummary.totalNominal || 0).toLocaleString("id-ID")}</b></span>
                                        <span>Deadline: <b className="text-slate-200">{formatDateDisplay(batch.claimDeadline)}</b></span>
                                        <span>SM: <b className="text-emerald-300">{batch.smStatus}</b></span>
                                        <span>Claim: <b className="text-sky-300">{batch.claimStatus}</b></span>
                                        <span>OM: <b className="text-purple-300">{batch.omStatus}</b></span>
                                    </div>
                                </button>
                            );
                        })}
                    </div>
                    <div className="mt-6 border-t border-white/10 pt-5">
                        <p className="mb-3 text-sm font-bold text-white">Riwayat Approval OM</p>
                        <div className="space-y-2">
                            {omHistory.slice(0, 5).map((batch) => (
                                <div key={batch.id} className="rounded-lg border border-white/10 bg-black/20 p-3">
                                    <p className="font-mono text-xs font-bold text-slate-200">{batch.noPengajuan}</p>
                                    <p className="mt-1 text-xs text-slate-500">{batch.principleCode} - {batch.principleName}</p>
                                    <span className={`mt-2 inline-flex rounded-md border px-2 py-1 text-xs font-bold ${statusClass(batch.omStatus)}`}>{batch.omStatus}</span>
                                </div>
                            ))}
                            {omHistory.length === 0 && <p className="text-sm text-slate-500">Belum ada history OM.</p>}
                        </div>
                    </div>
                </Panel>

                <div className="space-y-6">
            <Panel title="Detail Approval OM" icon={ClipboardCheck}>
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                    <Field label="No Pengajuan" value={selectedBatch?.noPengajuan || "-"} />
                    <Field label="Gelombang" value={selectedBatch?.gelombang || "-"} />
                    <Field label="Principle" value={selectedBatch?.principleName || "-"} />
                    <Field label="Kode Principle" value={selectedBatch?.principleCode || "-"} />
                    <Field label="Bulan/Tahun" value={selectedBatch ? `${selectedBatch.bulan}/${selectedBatch.tahun}` : "-"} />
                    <Field label="Supervisor" value={selectedBatch?.supervisorName || "-"} />
                    <Field label="No Claim" value={selectedBatch?.noClaim || "-"} />
                    <Field label="Tanggal Diajukan Claim" value={formatDateDisplay(selectedBatch?.claimSubmittedDate)} />
                    <Field label="Deadline Claim" value={formatDateDisplay(selectedBatch?.claimDeadline)} />
                    <Field label="Total Nominal" value={`Rp ${totalNominal.toLocaleString("id-ID")}`} />
                    <Field label="Status SM" value={selectedBatch?.smStatus || "-"} />
                    <Field label="Status Claim" value={selectedBatch?.claimStatus || "-"} />
                    <Field label="Status OM" value={selectedBatch?.omStatus || "-"} />
                </div>
            </Panel>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                    <div className="rounded-xl border border-white/10 bg-black/30 p-4">
                        <h3 className="font-bold text-white mb-3">Data Approved by SM</h3>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                            <Field label="Status SM" value={selectedBatch?.smStatus || "-"} />
                            <Field label="Locked Supervisor" value={selectedBatch?.locked ? "Ya" : "Tidak"} />
                            <Field label="Audit SM Approve" value="Tercatat di audit log" />
                            <Field label="Mock Notification OM" value={selectedBatch?.omStatus === "Waiting Approval" ? "Claim meneruskan ke OM" : selectedBatch?.omStatus || "-"} />
                        </div>
                        <div className="mt-3">
                            <TextArea label="Catatan SM" value={selectedBatch?.smNote || "-"} />
                        </div>
                    </div>
                    <div className="rounded-xl border border-white/10 bg-black/30 p-4">
                        <h3 className="font-bold text-white mb-3">Validasi Claim</h3>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                            <Field label="Status Claim" value={selectedBatch?.claimStatus || "-"} />
                            <Field label="No Claim" value={selectedBatch?.noClaim || "-"} />
                            <Field label="Tanggal Diajukan" value={formatDateDisplay(selectedBatch?.claimSubmittedDate)} />
                            <Field label="Deadline Claim" value={formatDateDisplay(selectedBatch?.claimDeadline)} />
                            <Field label="Status Kelengkapan Claim" value="Aman" />
                        </div>
                        <div className="mt-3">
                            <TextArea label="Catatan Claim" value={selectedBatch?.claimNote || "-"} />
                        </div>
                    </div>
                </div>

            <Panel title="Item Batch untuk Approval OM" icon={ReceiptText}>
                <div className="overflow-x-auto rounded-xl border border-white/10">
                    <table className="w-full min-w-[1350px] text-sm text-left">
                        <thead className="bg-black/50 text-xs uppercase tracking-wider text-slate-500 border-b border-white/10">
                            <tr>
                                {["No", "No Surat", "Nama Program", "Periode Awal", "Periode Akhir", "Toko", "Barang", "Nominal", "Cara Bayar", "Type", "Deadline", "Kelengkapan"].map((header) => (
                                    <th key={header} className="px-3 py-3 font-bold">{header}</th>
                                ))}
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-white/5">
                            {selectedItems.map((item, index) => {
                                const period = splitPeriodDates(item.periode);
                                return (
                                    <tr key={item.id || `${item.noSurat}-${index}`} className="hover:bg-white/[0.03]">
                                        <td className="px-3 py-3 font-mono text-slate-300">{item.itemNo || index + 1}</td>
                                        <td className="px-3 py-3 font-mono text-slate-200">{item.noSurat || "-"}</td>
                                        <td className="px-3 py-3 min-w-[180px] text-slate-200">{item.namaProgram || "-"}</td>
                                        <td className="px-3 py-3 text-slate-300">{formatDateDisplay(period.periodeAwal)}</td>
                                        <td className="px-3 py-3 text-slate-300">{formatDateDisplay(period.periodeAkhir)}</td>
                                        <td className="px-3 py-3 min-w-[140px] text-slate-300">{item.toko || "-"}</td>
                                        <td className="px-3 py-3 text-slate-300">{item.barang || "-"}</td>
                                        <td className="px-3 py-3 text-right font-mono text-emerald-300">Rp {Number(item.nominal || 0).toLocaleString("id-ID")}</td>
                                        <td className="px-3 py-3 text-slate-300">{item.caraBayar || "-"}</td>
                                        <td className="px-3 py-3 text-slate-300">{item.type || "-"}</td>
                                        <td className="px-3 py-3 text-slate-300">{formatDateDisplay(item.deadline)}</td>
                                        <td className="px-3 py-3 min-w-[180px] text-slate-300">{itemDocsSummary(item)}</td>
                                    </tr>
                                );
                            })}
                            {!isLoading && selectedItems.length === 0 && (
                                <tr><td colSpan={12} className="px-3 py-6 text-center text-sm text-slate-500">Pilih batch untuk melihat item.</td></tr>
                            )}
                        </tbody>
                    </table>
                </div>
            </Panel>

            <Panel title="Ringkasan Pembayaran" icon={Wallet}>
                <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
                    <Field label="Total" value={`Rp ${totalNominal.toLocaleString("id-ID")}`} />
                    <Field label="Transfer" value={`Rp ${transfer.toLocaleString("id-ID")}`} />
                    <Field label="Tunai" value={`Rp ${tunai.toLocaleString("id-ID")}`} />
                </div>
                {hasMixedPaymentTypes && (
                    <div className="mt-4 rounded-xl border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
                        Batch ini memiliki lebih dari satu jenis pembayaran. Pastikan pembayaran sesuai rincian row.
                    </div>
                )}
            </Panel>

            <Panel title="Keputusan Operational Manager" icon={ShieldCheck}>
                <label className="block">
                    <span className="text-xs text-slate-500 font-semibold">Catatan OM</span>
                    <textarea
                        value={omNote}
                        onChange={(event) => setOmNote(event.target.value)}
                        placeholder="Catatan wajib untuk cancel. Catatan approve boleh dikosongkan."
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
                            disabled={!selectedBatch || isActionLoading}
                            className="inline-flex items-center justify-center gap-2 rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-2.5 text-sm font-bold text-rose-300 transition-colors hover:bg-rose-500/20 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                            <XCircle size={16} /> Cancel
                        </button>
                        <button
                            onClick={() => decideOm("approve")}
                            disabled={!selectedBatch || isActionLoading}
                            className="inline-flex items-center justify-center gap-2 rounded-xl border border-emerald-500 bg-emerald-600 px-4 py-2.5 text-sm font-bold text-white transition-colors hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                            <CheckCircle2 size={16} /> Approve
                        </button>
                    </div>
                ) : (
                    <div className="mt-5 rounded-xl border border-white/10 bg-black/30 px-4 py-3 text-sm text-slate-400">Readonly: role ini tidak bisa mengambil keputusan OM.</div>
                )}
            </Panel>
                </div>
            </div>
        </div>
    );
}

function FinanceDashboard({ offRole }: OffDashboardProps) {
    const canPayFinance = canPerformOffAction(offRole, "finance_payment");
    const [financeBatches, setFinanceBatches] = useState<OffApiBatch[]>([]);
    const [financeHistory, setFinanceHistory] = useState<OffApiBatch[]>([]);
    const [selectedBatch, setSelectedBatch] = useState<OffApiBatch | null>(null);
    const [selectedFinanceBatchId, setSelectedFinanceBatchId] = useState<string | null>(null);
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
    const [paymentResult, setPaymentResult] = useState<{ paymentNo?: number; paymentDate: string; paidAmount: string; paymentMethod: string; senderBank: string; paymentProofName: string; remainingAmount?: number; isFullyPaid?: boolean } | null>(null);
    const summary = selectedBatch?.summary;
    const totalNominal = Number(summary?.totalNominal || selectedItems.reduce((total, item) => total + Number(item.nominal || 0), 0));
    const transfer = Number(summary?.transfer || selectedItems.filter((item) => normalizeUiPaymentMethod(item.caraBayar || "") === "Transfer").reduce((total, item) => total + Number(item.nominal || 0), 0));
    const tunai = Number(summary?.tunai || selectedItems.filter((item) => normalizeUiPaymentMethod(item.caraBayar || "") === "Tunai").reduce((total, item) => total + Number(item.nominal || 0), 0));
    const paymentSummary = selectedBatch?.paymentSummary;
    const totalPaid = Number(paymentSummary?.totalPaid ?? selectedBatch?.paidAmount ?? selectedPayments.reduce((total, payment) => total + Number(payment.paidAmount || 0), 0));
    const remainingAmount = Number(paymentSummary?.remainingAmount ?? Math.max(0, totalNominal - totalPaid));
    const hasMixedItemPayments = transfer > 0 && tunai > 0;

    const isFinanceQueueBatch = (batch: OffApiBatch) => batch.smStatus === "Approved by SM"
        && batch.claimStatus === "Approved"
        && batch.omStatus === "Approved"
        && ["Waiting Payment", "Partial Paid", "Need Correction"].includes(batch.financeStatus)
        && !["Cancelled by OM", "Finance Paid", "Completed", "Cancelled"].includes(batch.status);

    const loadFinanceDetail = async (batch: OffApiBatch) => {
        const response = await fetch(`/api/off-program-control/batches/${batch.id}`, { credentials: "include" });
        const data = await parseJsonResponse(response);
        if (!response.ok || !data.ok) throw new Error(String(data.error || "Gagal mengambil detail Keuangan."));
        const detailBatch = data.batch as OffApiBatch;
        const payments = Array.isArray(data.payments) ? data.payments as OffApiPayment[] : [];
        setSelectedBatch({ ...(detailBatch || batch), paymentSummary: data.paymentSummary as OffPaymentSummary | undefined, payments });
        setSelectedItems(Array.isArray(data.items) ? data.items as OffApiItem[] : []);
        setSelectedPayments(payments);
        setPaymentDate("");
        setPaidAmount("");
        setFinanceNote(detailBatch?.financeNote || "");
    };

    const loadFinanceBatches = async (options?: { preserveSelectedId?: string | null; autoSelectFirst?: boolean }) => {
        setIsLoading(true);
        setFinanceMessage("");
        try {
            const response = await fetch("/api/off-program-control/batches", { credentials: "include" });
            const data = await parseJsonResponse(response);
            if (!response.ok || !data.ok) throw new Error(String(data.error || "Gagal mengambil queue Keuangan."));
            const rows = Array.isArray(data.batches) ? data.batches as OffApiBatch[] : [];
            const queue = rows.filter(isFinanceQueueBatch);
            setFinanceBatches(queue);
            setFinanceHistory(rows.filter((batch) => batch.financeStatus === "Paid" || batch.finalStatus === "Waiting Claim Final Verification" || batch.status === "Finance Paid"));
            const preservedId = options?.preserveSelectedId || selectedFinanceBatchId;
            const preservedBatch = preservedId ? queue.find((batch) => batch.id === preservedId) || null : null;
            const nextBatch = preservedBatch || (options?.autoSelectFirst === false ? null : queue[0] || null);
            if (nextBatch) {
                setSelectedBatch(nextBatch);
                setSelectedFinanceBatchId(nextBatch.id);
                await loadFinanceDetail(nextBatch);
            } else if (preservedId) {
                const finishedBatch = rows.find((batch) => batch.id === preservedId) || null;
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
            setFinanceMessage(error instanceof Error ? error.message : "Gagal mengambil queue Keuangan.");
            setSelectedItems([]);
            setSelectedPayments([]);
        } finally {
            setIsLoading(false);
        }
    };

    useEffect(() => {
        loadFinanceBatches();
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
        try {
            await loadFinanceDetail(batch);
        } catch (error) {
            setFinanceMessage(error instanceof Error ? error.message : "Gagal mengambil detail Keuangan.");
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
            if (!["application/pdf", "image/png", "image/jpeg"].includes(paymentProofFile.type)) {
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
            const response = await fetch(`/api/off-program-control/batches/${selectedBatch.id}/finance-payment`, {
                method: "POST",
                credentials: "include",
                body: formData,
            });
            const data = await parseJsonResponse(response);
            if (!response.ok || !data.ok) throw new Error(String(data.error || data.message || "Gagal submit pembayaran."));
            const nextPaymentSummary = data.paymentSummary as OffPaymentSummary | undefined;
            setFinanceMessage(nextPaymentSummary?.isFullyPaid ? "Pembayaran lunas. Pengajuan dikirim ke Claim Final Verification." : String(data.message || "Pembayaran berhasil dicatat."));
            const payment = data.payment as OffApiPayment | undefined;
            setPaymentResult({ paymentNo: payment?.paymentNo, paymentDate, paidAmount, paymentMethod, senderBank, paymentProofName: paymentProofFile.name, remainingAmount: nextPaymentSummary?.remainingAmount, isFullyPaid: nextPaymentSummary?.isFullyPaid });
            setPaymentDate("");
            setPaidAmount("");
            setPaymentProofFile(null);
            await loadFinanceBatches({ preserveSelectedId: selectedBatch.id, autoSelectFirst: false });
        } catch (error) {
            setFinanceMessage(error instanceof Error ? error.message : "Gagal submit pembayaran.");
        } finally {
            setIsActionLoading(false);
        }
    };

    return (
        <div className="grid grid-cols-1 xl:grid-cols-[0.75fr_1.25fr] gap-6">
            <Panel title="Menunggu Pembayaran Keuangan" icon={Clock3}>
                <div className="space-y-3">
                    {isLoading && <p className="text-sm text-slate-400">Memuat queue Keuangan...</p>}
                    {!isLoading && financeBatches.length === 0 && <p className="text-sm text-slate-400">Belum ada batch OM Approved yang menunggu pembayaran.</p>}
                    {financeBatches.map((batch) => {
                        const batchSummary = batch.summary || { totalRows: 0, totalNominal: 0, transfer: 0, tunai: 0 };
                        const batchPaymentSummary = batch.paymentSummary || { totalPaid: Number(batch.paidAmount || 0), remainingAmount: Math.max(0, Number(batchSummary.totalNominal || 0) - Number(batch.paidAmount || 0)) };
                        return (
                            <button
                                key={batch.id}
                                onClick={() => selectFinanceBatch(batch)}
                                className={`w-full rounded-xl border p-4 text-left transition-colors ${selectedBatch?.id === batch.id ? "border-teal-500/40 bg-teal-500/10" : "border-white/10 bg-black/30 hover:bg-white/[0.04]"}`}
                            >
                                <p className="font-mono text-sm font-bold text-white">{batch.noPengajuan}</p>
                                <p className="mt-1 text-sm text-slate-300">{batch.principleName} <span className="font-mono text-teal-300">({batch.principleCode})</span></p>
                                <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-slate-400">
                                    <span>No Claim: <b className="text-slate-200">{batch.noClaim || "-"}</b></span>
                                    <span>Row: <b className="text-slate-200">{batchSummary.totalRows || batchSummary.rowCount || 0}</b></span>
                                    <span>Total: <b className="text-emerald-300">Rp {Number(batchSummary.totalNominal || 0).toLocaleString("id-ID")}</b></span>
                                    <span>Sudah Dibayar: <b className="text-sky-300">Rp {Number(batchPaymentSummary.totalPaid || 0).toLocaleString("id-ID")}</b></span>
                                    <span>Sisa: <b className="text-amber-300">Rp {Number(batchPaymentSummary.remainingAmount || 0).toLocaleString("id-ID")}</b></span>
                                    <span>Finance: <b className="text-sky-300">{batch.financeStatus}</b></span>
                                </div>
                            </button>
                        );
                    })}
                </div>
                <div className="mt-6 border-t border-white/10 pt-5">
                    <p className="mb-3 text-sm font-bold text-white">Riwayat Pembayaran Keuangan</p>
                    <div className="space-y-2">
                        {financeHistory.slice(0, 5).map((batch) => (
                            <div key={batch.id} className="rounded-lg border border-white/10 bg-black/20 p-3">
                                <p className="font-mono text-xs font-bold text-slate-200">{batch.noPengajuan}</p>
                                <p className="mt-1 text-xs text-slate-500">{batch.principleCode} - {batch.principleName}</p>
                                <span className={`mt-2 inline-flex rounded-md border px-2 py-1 text-xs font-bold ${statusClass(batch.financeStatus)}`}>{batch.financeStatus}</span>
                            </div>
                        ))}
                        {financeHistory.length === 0 && <p className="text-sm text-slate-500">Belum ada history pembayaran.</p>}
                    </div>
                </div>
            </Panel>

            <div className="space-y-6">
            <Panel title="Detail Pembayaran Keuangan" icon={Wallet}>
                <InfoNote>
                    Keuangan menerima data setelah OM approve. Setelah bayar, data masuk kembali ke Claim untuk final payment verification.
                </InfoNote>
                <div className="mt-5 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                    <Field label="No Pengajuan" value={selectedBatch?.noPengajuan || "-"} />
                    <Field label="Principle" value={selectedBatch?.principleName || "-"} />
                    <Field label="Kode Principle" value={selectedBatch?.principleCode || "-"} />
                    <Field label="Bulan/Tahun" value={selectedBatch ? `${selectedBatch.bulan}/${selectedBatch.tahun}` : "-"} />
                    <Field label="Supervisor" value={selectedBatch?.supervisorName || "-"} />
                    <Field label="No Claim" value={selectedBatch?.noClaim || "-"} />
                    <Field label="Tanggal Diajukan Claim" value={formatDateDisplay(selectedBatch?.claimSubmittedDate)} />
                    <Field label="Deadline Claim" value={formatDateDisplay(selectedBatch?.claimDeadline)} />
                    <Field label="Total Nominal" value={`Rp ${totalNominal.toLocaleString("id-ID")}`} />
                    <Field label="Status SM" value={selectedBatch?.smStatus || "-"} />
                    <Field label="Status Claim" value={selectedBatch?.claimStatus || "-"} />
                    <Field label="Status OM" value={selectedBatch?.omStatus || "-"} />
                    <Field label="Status Finance" value={selectedBatch?.financeStatus || "-"} />
                </div>
            </Panel>

            <Panel title="Ringkasan Pembayaran Approved" icon={ReceiptText}>
                <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
                    <Field label="Total Pengajuan" value={`Rp ${totalNominal.toLocaleString("id-ID")}`} />
                    <Field label="Total Sudah Dibayar" value={`Rp ${totalPaid.toLocaleString("id-ID")}`} />
                    <Field label="Sisa Pembayaran" value={`Rp ${remainingAmount.toLocaleString("id-ID")}`} />
                    <Field label="Status" value={selectedBatch?.financeStatus || "-"} />
                    <Field label="Total Transfer Row" value={`Rp ${transfer.toLocaleString("id-ID")}`} />
                    <Field label="Total Tunai Row" value={`Rp ${tunai.toLocaleString("id-ID")}`} />
                </div>
                {hasMixedItemPayments && (
                    <div className="mt-4 rounded-xl border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
                        Batch ini memiliki lebih dari satu jenis pembayaran. Pastikan pembayaran sesuai rincian row.
                    </div>
                )}
            </Panel>

            <Panel title="Item Batch untuk Pembayaran" icon={ListChecks}>
                <div className="overflow-x-auto rounded-xl border border-white/10">
                    <table className="w-full min-w-[1250px] text-sm text-left">
                        <thead className="bg-black/50 text-xs uppercase tracking-wider text-slate-500 border-b border-white/10">
                            <tr>
                                {["No", "No Surat", "Nama Program", "Periode Awal", "Periode Akhir", "Toko", "Barang", "Nominal", "Cara Bayar", "Type", "Deadline"].map((header) => (
                                    <th key={header} className="px-3 py-3 font-bold">{header}</th>
                                ))}
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-white/5">
                            {selectedItems.map((item, index) => {
                                const period = splitPeriodDates(item.periode);
                                return (
                                    <tr key={item.id || `${item.noSurat}-${index}`} className="hover:bg-white/[0.03]">
                                        <td className="px-3 py-3 font-mono text-slate-300">{item.itemNo || index + 1}</td>
                                        <td className="px-3 py-3 font-mono text-slate-200">{item.noSurat || "-"}</td>
                                        <td className="px-3 py-3 min-w-[180px] text-slate-200">{item.namaProgram || "-"}</td>
                                        <td className="px-3 py-3 text-slate-300">{formatDateDisplay(period.periodeAwal)}</td>
                                        <td className="px-3 py-3 text-slate-300">{formatDateDisplay(period.periodeAkhir)}</td>
                                        <td className="px-3 py-3 min-w-[140px] text-slate-300">{item.toko || "-"}</td>
                                        <td className="px-3 py-3 text-slate-300">{item.barang || "-"}</td>
                                        <td className="px-3 py-3 text-right font-mono text-emerald-300">Rp {Number(item.nominal || 0).toLocaleString("id-ID")}</td>
                                        <td className="px-3 py-3 text-slate-300">{item.caraBayar || "-"}</td>
                                        <td className="px-3 py-3 text-slate-300">{item.type || "-"}</td>
                                        <td className="px-3 py-3 text-slate-300">{formatDateDisplay(item.deadline)}</td>
                                    </tr>
                                );
                            })}
                            {!isLoading && selectedItems.length === 0 && (
                                <tr><td colSpan={11} className="px-3 py-6 text-center text-sm text-slate-500">Pilih batch untuk melihat item.</td></tr>
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
                                {["Payment No", "Tanggal Bayar", "Metode", "Jumlah", "Bank Pengirim", "Bukti Pembayaran", "Catatan"].map((header) => (
                                    <th key={header} className="px-3 py-3 font-bold">{header}</th>
                                ))}
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-white/5">
                            {selectedPayments.map((payment) => (
                                <tr key={payment.id} className="hover:bg-white/[0.03]">
                                    <td className="px-3 py-3 font-mono text-slate-300">{payment.paymentNo}</td>
                                    <td className="px-3 py-3 text-slate-300">{formatDateDisplay(payment.paymentDate)}</td>
                                    <td className="px-3 py-3 text-slate-300">{payment.paymentMethod}</td>
                                    <td className="px-3 py-3 text-right font-mono text-emerald-300">Rp {Number(payment.paidAmount || 0).toLocaleString("id-ID")}</td>
                                    <td className="px-3 py-3 text-slate-300">{payment.senderBank || "-"}</td>
                                    <td className="px-3 py-3">
                                        <div className="min-w-[180px] space-y-2">
                                            <p className="font-mono text-xs text-slate-300">{payment.paymentProofName || "-"}</p>
                                            {payment.proofUrl && (
                                                <button type="button" onClick={() => window.open(payment.proofUrl || "", "_blank")} className="rounded-lg border border-teal-500/30 bg-teal-500/10 px-2 py-1 text-xs font-bold text-teal-300 hover:bg-teal-500/20">
                                                    Lihat Bukti
                                                </button>
                                            )}
                                        </div>
                                    </td>
                                    <td className="px-3 py-3 text-slate-300">{payment.note || "-"}</td>
                                </tr>
                            ))}
                            {!isLoading && selectedPayments.length === 0 && (
                                <tr><td colSpan={7} className="px-3 py-6 text-center text-sm text-slate-500">Belum ada pembayaran untuk batch ini.</td></tr>
                            )}
                        </tbody>
                    </table>
                </div>
            </Panel>

            <Panel title="Form Pembayaran Keuangan" icon={Wallet}>
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                    <DateField label="Tanggal Bayar" value={paymentDate} onChange={setPaymentDate} />
                    <EditableField label="Jumlah Dibayar oleh Keuangan" value={paidAmount} onChange={setPaidAmount} />
                    <label className="block">
                        <span className="text-xs text-slate-500 font-semibold">Metode Pembayaran</span>
                        <select value={paymentMethod} onChange={(event) => setPaymentMethod(event.target.value)} className="mt-1 w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2.5 text-sm text-slate-200 outline-none focus:border-teal-500/50">
                            {offPaymentMethods.map((method) => (
                                <option key={method} className="bg-[#1a1c23]" value={method}>{method}</option>
                            ))}
                        </select>
                    </label>
                    <EditableField label="Bank Pengirim" value={senderBank} onChange={setSenderBank} />
                    <label className="block">
                        <span className="text-xs text-slate-500 font-semibold">Bukti Pembayaran</span>
                        <input
                            type="file"
                            accept="application/pdf,image/png,image/jpeg"
                            onChange={(event) => {
                                const file = event.target.files?.[0] || null;
                                setPaymentProofFile(file);
                            }}
                            className="mt-1 w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2.5 text-sm text-slate-200 file:mr-3 file:rounded-md file:border-0 file:bg-teal-600 file:px-3 file:py-1.5 file:text-xs file:font-bold file:text-white outline-none focus:border-teal-500/50"
                        />
                        <p className="mt-1 text-[11px] text-slate-500">PDF, PNG, JPG, atau JPEG. Maksimal 5MB.</p>
                    </label>
                </div>
                <div className="mt-4">
                    <label className="block">
                        <span className="text-xs text-slate-500 font-semibold">Catatan Keuangan</span>
                        <textarea value={financeNote} onChange={(event) => setFinanceNote(event.target.value)} rows={4} className="mt-1 w-full resize-none rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-slate-200 outline-none placeholder:text-slate-600 focus:border-teal-500/50" />
                    </label>
                </div>
                {financeMessage && (
                    <div className="mt-4 rounded-xl border border-white/10 bg-black/30 px-4 py-3 text-sm text-slate-300">{financeMessage}</div>
                )}
                {paymentResult && (
                    <div className="mt-4 rounded-xl border border-emerald-500/20 bg-emerald-500/10 p-4 text-xs text-emerald-100">
                        <p className="mb-2 font-bold uppercase tracking-wider">Payment Result</p>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                            <p>Tanggal Bayar: <span className="font-mono">{formatDateDisplay(paymentResult.paymentDate)}</span></p>
                            <p>Jumlah Dibayar: <span className="font-mono">{paymentResult.paidAmount}</span></p>
                            <p>Metode Pembayaran: <span className="font-mono">{paymentResult.paymentMethod}</span></p>
                            <p>Bank Pengirim: <span className="font-mono">{paymentResult.senderBank || "-"}</span></p>
                            <p>Bukti Pembayaran: <span className="font-mono">{paymentResult.paymentProofName}</span></p>
                            <p>Payment No: <span className="font-mono">{paymentResult.paymentNo || "-"}</span></p>
                            <p>Sisa Pembayaran: <span className="font-mono">Rp {Number(paymentResult.remainingAmount || 0).toLocaleString("id-ID")}</span></p>
                            <p>Status Lunas: <span className="font-mono">{paymentResult.isFullyPaid ? "Lunas" : "Belum Lunas"}</span></p>
                        </div>
                    </div>
                )}
                {canPayFinance ? (
                    <div className="mt-5 flex flex-wrap gap-3">
                        <button
                            onClick={submitFinancePayment}
                            disabled={!selectedBatch || isActionLoading}
                            className="inline-flex items-center justify-center gap-2 rounded-xl border border-emerald-500 bg-emerald-600 px-4 py-2.5 text-sm font-bold text-white transition-colors hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                            Tambah Pembayaran
                        </button>
                    </div>
                ) : (
                    <div className="mt-5 rounded-xl border border-white/10 bg-black/30 px-4 py-3 text-sm text-slate-400">Readonly: role ini tidak bisa menambah pembayaran Keuangan.</div>
                )}
            </Panel>
            </div>
        </div>
    );
}

function AuditTimeline() {
    return (
        <Panel title="Timeline Audit Log" icon={ScrollText}>
            <div className="space-y-4">
                {auditLogs.map((log, index) => (
                    <div key={log.title} className="grid grid-cols-[auto_1fr] gap-4">
                        <div className="flex flex-col items-center">
                            <span className="w-9 h-9 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 text-sm font-black flex items-center justify-center">
                                {index + 1}
                            </span>
                            {index < auditLogs.length - 1 && <span className="w-px flex-1 bg-white/10 my-2" />}
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

function OverviewTab() {
    return (
        <div className="space-y-6">
            <MetricsGrid />
            <WorkflowStepper />
            <MonitoringTable />
            <QueueSummaryPanel />
        </div>
    );
}

export default function OffProgramControlPage() {
    const [activeTab, setActiveTab] = useState<TabKey>("overview");
    const { data: session } = authClient.useSession();
    const sessionUser = session?.user as ({
        name?: string | null;
        email?: string | null;
        role?: unknown;
        userRole?: unknown;
        type?: unknown;
        position?: unknown;
        department?: unknown;
    }) | undefined;
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
    const accessibleTabs = tabs.filter((tab) => accessibleTabKeys.includes(tab.key));
    const effectiveActiveTab = accessibleTabKeys.includes(activeTab) ? activeTab : accessibleTabs[0]?.key;
    const mappingSummary = useMemo(() => `${PRINCIPLE_OPTIONS.length} principle mappings loaded`, []);

    return (
        <div className="max-w-[1800px] mx-auto pb-12">
            <div className="mb-6 flex flex-col lg:flex-row lg:items-end justify-between gap-4">
                <div>
                    <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full border border-teal-500/30 bg-teal-500/10 text-teal-300 text-xs font-bold uppercase tracking-widest mb-4">
                        <ClipboardCheck size={14} /> OFF Workflow
                    </div>
                    <h1 className="text-3xl font-black text-white tracking-tight flex items-center gap-3">
                        OFF Program Control
                    </h1>
                    <p className="text-slate-400 mt-2 text-lg">
                        Corporate Finance Dashboard for OFF Program / Faktur Beban Principle
                    </p>
                    <p className="text-xs text-slate-500 mt-2">{mappingSummary}</p>
                    <div className="mt-3 flex flex-wrap gap-2 text-xs">
                        <span className="rounded-lg border border-white/10 bg-black/30 px-3 py-1.5 text-slate-300">
                            Logged in as: <b className="text-slate-100">{sessionUser?.name || sessionUser?.email || "Unknown User"}</b>
                        </span>
                        <span className="rounded-lg border border-teal-500/20 bg-teal-500/10 px-3 py-1.5 text-teal-200">
                            OFF Role: <b>{offRole}{roleInfo.source === "email" ? " (from email domain)" : roleInfo.isFallback ? " (fallback dev)" : ""}</b>
                        </span>

                    </div>
                </div>
                <div className="flex items-center gap-3 rounded-2xl border border-white/10 bg-[#1a1c23]/60 px-4 py-3">
                    <CalendarClock className="text-teal-300" size={20} />
                    <div>
                        <p className="text-xs uppercase tracking-wider text-slate-500 font-bold">Cycle</p>
                        <p className="text-sm text-slate-200 font-semibold">May 2026 Monitoring</p>
                    </div>
                </div>
            </div>

            {offRole === "sales" && accessibleTabs.length === 0 && (
                <Panel title="OFF Program Control" icon={ClipboardCheck}>
                    <p className="text-sm text-slate-400">Role Sales belum dikonfigurasi untuk OFF Program Control.</p>
                </Panel>
            )}

            {offRole !== "sales" && accessibleTabs.length === 0 && (
                <Panel title="OFF Program Control" icon={ClipboardCheck}>
                    <p className="text-sm text-slate-400">Anda belum memiliki akses OFF Program Control. Hubungi admin.</p>
                </Panel>
            )}

            {accessibleTabs.length > 0 && (
            <>
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
            {effectiveActiveTab === "supervisor" && <SupervisorDashboard offRole={offRole} />}
            {effectiveActiveTab === "sales" && <SalesManagerDashboard offRole={offRole} />}
            {effectiveActiveTab === "claim" && <ClaimDashboard offRole={offRole} />}
            {effectiveActiveTab === "om" && <OperationalManagerDashboard offRole={offRole} />}
            {effectiveActiveTab === "finance" && <FinanceDashboard offRole={offRole} />}
            {effectiveActiveTab === "audit" && <AuditTimeline />}
            </>
            )}
        </div>
    );
}
