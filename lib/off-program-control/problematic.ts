/*
 * Tujuan: Helper deteksi "Pengajuan Bermasalah" berdasarkan SLA waktu di setiap tahapan workflow OFF Program Control.
 * Caller: app/(dashboard)/off-program-control/page.tsx, komponen OffNotificationBell.
 * Dependensi: Tipe OffBatchRow, OffItemRow dari schema.
 * Main Functions: detectProblematicBatches, getNotificationsForRole, SLA_DAYS.
 * Side Effects: Tidak ada — pure function, hanya analisis data in-memory.
 */

import type { OffRole } from "./access";
import { isBusinessDay } from "./holidays";

// --- SLA Configuration (hari kerja: exclude weekend + tanggal merah) ---
export const SLA_DAYS = {
    /** Maks waktu SM approve setelah SPV submit */
    smApproval: 2,
    /** Maks waktu Claim approve setelah SM approve */
    claimApproval: 2,
    /** Maks waktu OM keputusan setelah Claim approve */
    omDecision: 2,
    /** Maks waktu SPV revisi setelah batch dikembalikan */
    revisionAfterReturn: 3,
    /** Maks waktu Finance realisasi pembayaran setelah deadline claim */
    paymentAfterDeadline: 7,
    /** Maks waktu verifikasi final setelah pembayaran */
    finalVerificationAfterPayment: 5,
    /** Maks waktu refund selesai setelah verifikasi final */
    refundCompletion: 7,
    /** Maks waktu draft idle sebelum dianggap terbengkalai */
    draftIdle: 5,
    /** Maks waktu tanpa lanjutan setelah parsial bayar */
    partialPaymentStall: 5,
} as const;

// --- Types ---

export type ProblemCode =
    | "DEADLINE_BERKAS_BELUM_LENGKAP"
    | "PEMBAYARAN_TERLAMBAT"
    | "SM_LAMBAT_APPROVE"
    | "CLAIM_LAMBAT_APPROVE"
    | "CLAIM_TERHAMBAT_BERKAS"
    | "OM_LAMBAT_KEPUTUSAN"
    | "SPV_LAMBAT_REVISI"
    | "VERIFIKASI_FINAL_LAMBAT"
    | "VERIFIKASI_TERHAMBAT_BERKAS"
    | "REFUND_BELUM_LUNAS"
    | "DRAFT_TERBENGKALAI"
    | "PARSIAL_BAYAR_MACET";

export type ProblemSeverity = "warning" | "danger" | "critical";

export type ProblematicBatch = {
    batchId: string;
    noPengajuan: string;
    principleName: string;
    code: ProblemCode;
    severity: ProblemSeverity;
    title: string;
    message: string;
    daysPastDue: number;
    /** Role yang harus dapat notif (yang menghambat + atasan) */
    notifyRoles: OffRole[];
};

/** Subset field batch yang dibutuhkan untuk deteksi. */
export type ProblemDetectionBatch = {
    id: string;
    noPengajuan: string;
    principleName: string;
    status: string;
    smStatus: string;
    claimStatus: string;
    omStatus: string;
    financeStatus: string;
    finalStatus: string;
    locked: boolean;
    completenessStatus?: string | null;
    claimDeadline?: string | null;
    submittedAt?: Date | string | number | null;
    smApprovedAt?: Date | string | number | null;
    claimReviewedAt?: Date | string | number | null;
    returnedAt?: Date | string | number | null;
    paidAt?: Date | string | number | null;
    createdAt?: Date | string | number | null;
    updatedAt?: Date | string | number | null;
    refundStatus?: string | null;
    /** Untuk cek berkas lengkap tanpa load items */
    documentsComplete?: boolean;
};

export type ProblemDetectionPayment = {
    paymentDate: string;
    paidAmount: number;
};

// --- Helpers ---

function toTimestamp(value: Date | string | number | null | undefined): number {
    if (!value) return 0;
    if (value instanceof Date) return value.getTime();
    if (typeof value === "number") return value > 1e12 ? value : value * 1000; // unix seconds → ms
    const parsed = Date.parse(String(value));
    return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Hitung jumlah HARI KERJA yang sudah berlalu sejak `timestamp` hingga `now`.
 * Sabtu/Minggu DAN tanggal merah (hari libur nasional) TIDAK dihitung.
 * Mengganti perhitungan hari kalender sebelumnya agar SLA benar-benar
 * berbasis hari kerja (lihat ./holidays.ts).
 */
function businessDaysSince(timestamp: number, now: number = Date.now()): number {
    if (!timestamp) return 0;
    if (now <= timestamp) return 0;

    const cursor = new Date(timestamp);
    cursor.setHours(0, 0, 0, 0);
    const end = new Date(now);
    end.setHours(0, 0, 0, 0);

    let count = 0;
    // Hitung hari kerja pada rentang (hari setelah tanggal mulai) s/d tanggal `now`.
    while (cursor < end) {
        cursor.setDate(cursor.getDate() + 1);
        if (isBusinessDay(cursor)) count += 1;
    }
    return count;
}

function parseDateString(value: string | null | undefined): number {
    if (!value) return 0;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
}

function isCompleted(batch: ProblemDetectionBatch): boolean {
    return (
        batch.status === "Completed" ||
        batch.finalStatus === "Completed" ||
        batch.finalStatus === "Fully Refunded" ||
        batch.status === "Cancelled" ||
        batch.omStatus === "Cancelled"
    );
}

function isBerkasLengkap(batch: ProblemDetectionBatch): boolean {
    // Gunakan field documentsComplete (precomputed) jika tersedia.
    if (typeof batch.documentsComplete === "boolean") return batch.documentsComplete;
    // Fallback: cek completenessStatus field di batch.
    const cs = (batch.completenessStatus || "").toLowerCase();
    return cs === "aman" || cs === "lengkap" || cs === "complete";
}

// --- Main Detection ---

export function detectProblematicBatches(
    batches: ProblemDetectionBatch[],
    options?: {
        now?: number;
        payments?: Map<string, ProblemDetectionPayment[]>;
    }
): ProblematicBatch[] {
    const now = options?.now || Date.now();
    const payments = options?.payments || new Map();
    const problems: ProblematicBatch[] = [];

    for (const batch of batches) {
        if (isCompleted(batch)) continue;

        const submittedAt = toTimestamp(batch.submittedAt);
        const smApprovedAt = toTimestamp(batch.smApprovedAt);
        const claimReviewedAt = toTimestamp(batch.claimReviewedAt);
        const returnedAt = toTimestamp(batch.returnedAt);
        const paidAt = toTimestamp(batch.paidAt);
        const createdAt = toTimestamp(batch.createdAt);
        const claimDeadline = parseDateString(batch.claimDeadline);
        const berkasLengkap = isBerkasLengkap(batch);

        // --- 1. Sudah deadline claim, berkas belum lengkap ---
        if (
            claimDeadline &&
            claimDeadline < now &&
            !berkasLengkap &&
            !["Paid", "Completed"].includes(batch.status)
        ) {
            const days = businessDaysSince(claimDeadline, now);
            problems.push({
                batchId: batch.id,
                noPengajuan: batch.noPengajuan,
                principleName: batch.principleName,
                code: "DEADLINE_BERKAS_BELUM_LENGKAP",
                severity: days > 7 ? "critical" : "danger",
                title: "Deadline terlewat: berkas belum lengkap",
                message: `Sudah ${days} hari melewati deadline claim. Berkas dari SPV/SM belum dilengkapi.`,
                daysPastDue: days,
                notifyRoles: ["supervisor", "sales_manager", "admin"],
            });
        }

        // --- 2. Pembayaran belum direalisasi 7 hari setelah deadline claim ---
        if (
            claimDeadline &&
            batch.omStatus === "Approved" &&
            ["Waiting Payment", "Not Started"].includes(batch.financeStatus) &&
            businessDaysSince(claimDeadline, now) > SLA_DAYS.paymentAfterDeadline
        ) {
            const days = businessDaysSince(claimDeadline, now);
            problems.push({
                batchId: batch.id,
                noPengajuan: batch.noPengajuan,
                principleName: batch.principleName,
                code: "PEMBAYARAN_TERLAMBAT",
                severity: days > 14 ? "critical" : "danger",
                title: "Pembayaran belum direalisasi",
                message: `Sudah ${days} hari dari deadline claim. Keuangan belum memproses pembayaran.`,
                daysPastDue: days - SLA_DAYS.paymentAfterDeadline,
                notifyRoles: ["finance", "admin"],
            });
        }

        // --- 3. SM belum approve setelah 2 hari SPV submit ---
        if (
            submittedAt &&
            batch.status === "Submitted to SM" &&
            batch.smStatus === "Waiting Review" &&
            businessDaysSince(submittedAt, now) > SLA_DAYS.smApproval
        ) {
            const days = businessDaysSince(submittedAt, now);
            problems.push({
                batchId: batch.id,
                noPengajuan: batch.noPengajuan,
                principleName: batch.principleName,
                code: "SM_LAMBAT_APPROVE",
                severity: days > 5 ? "danger" : "warning",
                title: "Sales Manager belum review",
                message: `Sudah ${days} hari sejak SPV ajukan. SM belum memberikan tinjauan.`,
                daysPastDue: days - SLA_DAYS.smApproval,
                notifyRoles: ["sales_manager", "admin"],
            });
        }

        // --- 4a. Claim belum approve, berkas lengkap ---
        if (
            smApprovedAt &&
            batch.smStatus === "Approved by SM" &&
            !["Approved", "Returned"].includes(batch.claimStatus) &&
            !["Cancelled", "Claim Approved", "Returned by Claim"].includes(batch.status) &&
            businessDaysSince(smApprovedAt, now) > SLA_DAYS.claimApproval
        ) {
            const days = businessDaysSince(smApprovedAt, now);
            if (berkasLengkap) {
                problems.push({
                    batchId: batch.id,
                    noPengajuan: batch.noPengajuan,
                    principleName: batch.principleName,
                    code: "CLAIM_LAMBAT_APPROVE",
                    severity: days > 5 ? "danger" : "warning",
                    title: "Claim belum memproses",
                    message: `Sudah ${days} hari sejak SM approve. Berkas lengkap, tapi Claim belum validasi.`,
                    daysPastDue: days - SLA_DAYS.claimApproval,
                    notifyRoles: ["claim", "admin"],
                });
            } else {
                // --- 4b. Claim belum approve karena berkas belum lengkap ---
                problems.push({
                    batchId: batch.id,
                    noPengajuan: batch.noPengajuan,
                    principleName: batch.principleName,
                    code: "CLAIM_TERHAMBAT_BERKAS",
                    severity: days > 5 ? "danger" : "warning",
                    title: "Claim tertahan: berkas belum lengkap",
                    message: `Sudah ${days} hari sejak SM approve. Claim tidak bisa proses karena berkas SPV belum dilengkapi.`,
                    daysPastDue: days - SLA_DAYS.claimApproval,
                    notifyRoles: ["supervisor", "sales_manager", "admin"],
                });
            }
        }

        // --- 5. OM belum ambil keputusan setelah 2 hari Claim approve ---
        if (
            claimReviewedAt &&
            batch.claimStatus === "Approved" &&
            batch.omStatus !== "Approved" &&
            batch.omStatus !== "Cancelled" &&
            businessDaysSince(claimReviewedAt, now) > SLA_DAYS.omDecision
        ) {
            const days = businessDaysSince(claimReviewedAt, now);
            problems.push({
                batchId: batch.id,
                noPengajuan: batch.noPengajuan,
                principleName: batch.principleName,
                code: "OM_LAMBAT_KEPUTUSAN",
                severity: days > 5 ? "danger" : "warning",
                title: "OM belum ambil keputusan",
                message: `Sudah ${days} hari sejak Claim approve. Operational Manager belum approve/reject.`,
                daysPastDue: days - SLA_DAYS.omDecision,
                notifyRoles: ["operational_manager", "admin"],
            });
        }

        // --- 6. Batch dikembalikan tapi SPV tidak revisi 3 hari ---
        if (
            returnedAt &&
            (batch.status === "Returned by SM" ||
                batch.status === "Returned by Claim" ||
                batch.smStatus === "Returned" ||
                batch.claimStatus === "Returned") &&
            businessDaysSince(returnedAt, now) > SLA_DAYS.revisionAfterReturn
        ) {
            const days = businessDaysSince(returnedAt, now);
            problems.push({
                batchId: batch.id,
                noPengajuan: batch.noPengajuan,
                principleName: batch.principleName,
                code: "SPV_LAMBAT_REVISI",
                severity: days > 7 ? "danger" : "warning",
                title: "Revisi terlambat setelah dikembalikan",
                message: `Sudah ${days} hari sejak batch dikembalikan. SPV belum melakukan perbaikan.`,
                daysPastDue: days - SLA_DAYS.revisionAfterReturn,
                notifyRoles: ["supervisor", "sales_manager", "admin"],
            });
        }

        // --- 7a/7b. Verifikasi final macet setelah 5 hari pembayaran ---
        if (
            paidAt &&
            batch.status === "Paid" &&
            batch.financeStatus === "Paid" &&
            batch.finalStatus !== "Completed" &&
            batch.finalStatus !== "Fully Refunded" &&
            businessDaysSince(paidAt, now) > SLA_DAYS.finalVerificationAfterPayment
        ) {
            const days = businessDaysSince(paidAt, now);
            if (berkasLengkap) {
                problems.push({
                    batchId: batch.id,
                    noPengajuan: batch.noPengajuan,
                    principleName: batch.principleName,
                    code: "VERIFIKASI_FINAL_LAMBAT",
                    severity: days > 10 ? "critical" : "danger",
                    title: "Verifikasi final terlambat",
                    message: `Sudah ${days} hari sejak pembayaran. Berkas lengkap, tapi Claim belum verifikasi final.`,
                    daysPastDue: days - SLA_DAYS.finalVerificationAfterPayment,
                    notifyRoles: ["claim", "admin"],
                });
            } else {
                problems.push({
                    batchId: batch.id,
                    noPengajuan: batch.noPengajuan,
                    principleName: batch.principleName,
                    code: "VERIFIKASI_TERHAMBAT_BERKAS",
                    severity: days > 10 ? "critical" : "danger",
                    title: "Verifikasi final tertahan: berkas belum lengkap",
                    message: `Sudah ${days} hari sejak pembayaran. Dana sudah keluar tapi SPV belum serahkan dokumen final.`,
                    daysPastDue: days - SLA_DAYS.finalVerificationAfterPayment,
                    notifyRoles: ["supervisor", "sales_manager", "admin"],
                });
            }
        }

        // --- 8. Refund belum lunas 7 hari setelah verifikasi ---
        if (
            batch.refundStatus === "Pending Refund" ||
            batch.refundStatus === "Partially Refunded"
        ) {
            // Gunakan updatedAt sebagai proxy untuk waktu verifikasi final selesai
            const verifiedAt = toTimestamp(batch.updatedAt);
            if (verifiedAt && businessDaysSince(verifiedAt, now) > SLA_DAYS.refundCompletion) {
                const days = businessDaysSince(verifiedAt, now);
                problems.push({
                    batchId: batch.id,
                    noPengajuan: batch.noPengajuan,
                    principleName: batch.principleName,
                    code: "REFUND_BELUM_LUNAS",
                    severity: days > 14 ? "critical" : "danger",
                    title: "Pengembalian selisih belum lunas",
                    message: `Sudah ${days} hari. Ada kelebihan bayar yang belum dikembalikan.`,
                    daysPastDue: days - SLA_DAYS.refundCompletion,
                    notifyRoles: ["finance", "supervisor", "admin"],
                });
            }
        }

        // --- 9. Draft terbengkalai lebih dari 5 hari ---
        if (
            batch.status === "Draft" &&
            createdAt &&
            businessDaysSince(createdAt, now) > SLA_DAYS.draftIdle
        ) {
            const days = businessDaysSince(createdAt, now);
            problems.push({
                batchId: batch.id,
                noPengajuan: batch.noPengajuan,
                principleName: batch.principleName,
                code: "DRAFT_TERBENGKALAI",
                severity: days > 10 ? "danger" : "warning",
                title: "Draft tidak diajukan",
                message: `Sudah ${days} hari sejak dibuat tapi belum diajukan. Kemungkinan terbengkalai.`,
                daysPastDue: days - SLA_DAYS.draftIdle,
                notifyRoles: ["supervisor", "admin"],
            });
        }

        // --- 10. Parsial bayar macet lebih dari 5 hari ---
        if (
            batch.financeStatus === "Partial Paid" ||
            batch.status === "Partial Paid"
        ) {
            const batchPayments = payments.get(batch.id) || [];
            // Cari tanggal pembayaran terakhir
            let lastPaymentTime = paidAt;
            for (const payment of batchPayments) {
                const payTime = parseDateString(payment.paymentDate);
                if (payTime > lastPaymentTime) lastPaymentTime = payTime;
            }
            if (lastPaymentTime && businessDaysSince(lastPaymentTime, now) > SLA_DAYS.partialPaymentStall) {
                const days = businessDaysSince(lastPaymentTime, now);
                problems.push({
                    batchId: batch.id,
                    noPengajuan: batch.noPengajuan,
                    principleName: batch.principleName,
                    code: "PARSIAL_BAYAR_MACET",
                    severity: days > 10 ? "danger" : "warning",
                    title: "Pembayaran parsial tanpa kelanjutan",
                    message: `Sudah ${days} hari sejak pembayaran terakhir. Sisa pembayaran belum dilanjutkan.`,
                    daysPastDue: days - SLA_DAYS.partialPaymentStall,
                    notifyRoles: ["finance", "admin"],
                });
            }
        }
    }

    // Sort: critical dulu, lalu danger, lalu warning. Dalam severity sama, yang paling lama duluan.
    const severityOrder: Record<ProblemSeverity, number> = { critical: 0, danger: 1, warning: 2 };
    problems.sort((a, b) => {
        const sevDiff = severityOrder[a.severity] - severityOrder[b.severity];
        if (sevDiff !== 0) return sevDiff;
        return b.daysPastDue - a.daysPastDue;
    });

    return problems;
}

/**
 * Filter problems yang relevan untuk role tertentu.
 */
export function getProblemsForRole(problems: ProblematicBatch[], role: OffRole): ProblematicBatch[] {
    // AM-026: Manager = pembaca semua tab -> semua peringatan (seperti sebelum dipisah dari admin).
    if (role === "admin" || role === "manager") return problems;
    return problems.filter((p) => p.notifyRoles.includes(role));
}

/**
 * Hitung ringkasan jumlah per severity untuk badge/counter.
 */
export function countProblemsBySeverity(problems: ProblematicBatch[]) {
    return {
        critical: problems.filter((p) => p.severity === "critical").length,
        danger: problems.filter((p) => p.severity === "danger").length,
        warning: problems.filter((p) => p.severity === "warning").length,
        total: problems.length,
    };
}
