/*
 * Tujuan: Helper builder + CSV serializer untuk Phase R5/R7e Reporting/Export.
 *         Mengonsolidasi query Claim Submission + Claim Payment menjadi
 *         baris-baris siap tampil/ekspor untuk tiga report:
 *         Summary, Paid (transaction-based), Outstanding.
 * Caller: app/api/claim-workflow/reports/* (JSON + CSV) dan UI report
 *         page. Helper tidak menulis DB.
 * Dependensi: drizzle-orm, lib/claim-workflow/calculations.
 * Side Effects: Tidak ada (read-only).
 *
 * Phase R7e — Reports per submission:
 *   Sumber data utama berubah dari `claim_workflow` ke `claim_submission`.
 *   Setiap row report = satu submission. Workflow context (claimWorkflowNo,
 *   sourceType, principleCode, OFF batch) di-join sebagai metadata.
 *
 * Aturan:
 *   - `totalPaid` per submission di-recalc dari `claim_payment` aktif
 *     (voidedAt NULL) yang link ke `claim_submission_id`.
 *   - `remainingAmount = max(totalClaim - totalPaid, 0)` (helper R3).
 *   - Hanya status production yang masuk report. Legacy PEKA/EC/CN tidak
 *     boleh memperluas dataset.
 */
import { and, asc, count, desc, eq, gte, inArray, lte, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import {
    claimPayment,
    claimSubmission,
    claimWorkflow,
    claimWorkflowItem,
    offBatch,
} from "@/db/schema";
import { calculateRemainingAmount, sumActivePayments } from "./calculations";
import {
    claimSubmissionStatusList,
    claimWorkflowStatuses,
} from "./constants";

// =============================================================================
// CSV serializer
// =============================================================================

export function escapeCsvCell(value: unknown): string {
    if (value === null || value === undefined) return "";
    let text: string;
    if (value instanceof Date) {
        text = Number.isFinite(value.getTime()) ? value.toISOString() : "";
    } else if (typeof value === "number") {
        if (!Number.isFinite(value)) return "";
        text = String(value);
    } else if (typeof value === "boolean") {
        text = value ? "true" : "false";
    } else {
        text = String(value);
    }
    const needsQuote = /[",\r\n]/.test(text) || /^\s|\s$/.test(text);
    if (!needsQuote) return text;
    return `"${text.replace(/"/g, '""')}"`;
}

export function rowsToCsv<T extends Record<string, unknown>>(
    columns: ReadonlyArray<{ key: keyof T & string; label: string }>,
    rows: ReadonlyArray<T>,
): string {
    const header = columns.map((col) => escapeCsvCell(col.label)).join(",");
    const body = rows
        .map((row) => columns.map((col) => escapeCsvCell(row[col.key])).join(","))
        .join("\r\n");
    const csv = body.length > 0 ? `${header}\r\n${body}\r\n` : `${header}\r\n`;
    return `\uFEFF${csv}`;
}

export function todayStamp(): string {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}${m}${day}`;
}

// =============================================================================
// Filters
// =============================================================================

export type CommonReportFilters = {
    status?: string | null;
    principleCode?: string | null;
    dateFrom?: string | null;
    dateTo?: string | null;
};

export type SummaryReportFilters = CommonReportFilters & {
    onlyOpen?: boolean;
};

export type PaidReportFilters = CommonReportFilters & {
    includeVoided?: boolean;
};

export type OutstandingReportFilters = Pick<CommonReportFilters, "status" | "principleCode">;

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseIsoDateStartOfDay(value: string | null | undefined): Date | null {
    if (!value || !ISO_DATE_RE.test(value)) return null;
    const date = new Date(`${value}T00:00:00.000Z`);
    return Number.isFinite(date.getTime()) ? date : null;
}

function parseIsoDateEndOfDay(value: string | null | undefined): Date | null {
    if (!value || !ISO_DATE_RE.test(value)) return null;
    const date = new Date(`${value}T23:59:59.999Z`);
    return Number.isFinite(date.getTime()) ? date : null;
}

function isKnownSubmissionStatus(value: string | null | undefined): value is string {
    if (!value) return false;
    return (claimSubmissionStatusList as ReadonlyArray<string>).includes(value);
}

// =============================================================================
// Aggregation helpers
// =============================================================================

type PaymentSlim = {
    id: string;
    claimWorkflowId: string;
    claimSubmissionId: string | null;
    paymentDate: string;
    paymentAmount: number;
    paymentType: string | null;
    paymentNote: string | null;
    createdBy: string | null;
    createdAt: Date;
    voidedAt: Date | null;
    voidedBy: string | null;
    voidReason: string | null;
};

async function loadPaymentsForSubmissions(submissionIds: ReadonlyArray<string>): Promise<Map<string, PaymentSlim[]>> {
    const map = new Map<string, PaymentSlim[]>();
    if (submissionIds.length === 0) return map;
    const CHUNK = 400;
    for (let i = 0; i < submissionIds.length; i += CHUNK) {
        const slice = submissionIds.slice(i, i + CHUNK);
        const rows = await db
            .select({
                id: claimPayment.id,
                claimWorkflowId: claimPayment.claimWorkflowId,
                claimSubmissionId: claimPayment.claimSubmissionId,
                paymentDate: claimPayment.paymentDate,
                paymentAmount: claimPayment.paymentAmount,
                paymentType: claimPayment.paymentType,
                paymentNote: claimPayment.paymentNote,
                createdBy: claimPayment.createdBy,
                createdAt: claimPayment.createdAt,
                voidedAt: claimPayment.voidedAt,
                voidedBy: claimPayment.voidedBy,
                voidReason: claimPayment.voidReason,
            })
            .from(claimPayment)
            .where(inArray(claimPayment.claimSubmissionId, slice as string[]))
            .orderBy(asc(claimPayment.paymentDate), asc(claimPayment.createdAt));
        for (const row of rows) {
            const key = row.claimSubmissionId;
            if (!key) continue;
            const existing = map.get(key);
            if (existing) {
                existing.push(row);
            } else {
                map.set(key, [row]);
            }
        }
    }
    return map;
}

// =============================================================================
// Summary Report (per submission)
// =============================================================================

export type SummaryReportRow = {
    workflowId: string;
    claimWorkflowNo: string;
    sourceType: string;
    offBatchId: string;
    offNoPengajuan: string | null;
    submissionId: string;
    noClaim: string | null;
    scope: string;
    scopeLabel: string | null;
    submissionStatus: string;
    workflowAggregateStatus: string | null;
    principleCode: string;
    principleName: string;
    totalDpp: number;
    totalPpn: number;
    totalPph: number;
    totalClaim: number;
    totalPaid: number;
    remainingAmount: number;
    itemCount: number;
    submittedToPrincipalAt: string | null;
    closedAt: string | null;
    createdAt: string;
};

const OPEN_SUBMISSION_STATUSES = [
    claimWorkflowStatuses.draft,
    claimWorkflowStatuses.needRevision,
    claimWorkflowStatuses.readyToSubmit,
    claimWorkflowStatuses.submittedToPrincipal,
    claimWorkflowStatuses.partiallyPaid,
    claimWorkflowStatuses.outstanding,
] as const;

export async function buildSummaryReport(filters: SummaryReportFilters): Promise<SummaryReportRow[]> {
    if (filters.status && !isKnownSubmissionStatus(filters.status)) return [];
    const conditions: SQL[] = [
        inArray(claimSubmission.status, claimSubmissionStatusList as unknown as string[]),
    ];
    if (isKnownSubmissionStatus(filters.status ?? null)) {
        conditions.push(eq(claimSubmission.status, filters.status as string));
    }
    if (filters.principleCode) {
        conditions.push(eq(claimWorkflow.principleCode, filters.principleCode));
    }
    const dateFrom = parseIsoDateStartOfDay(filters.dateFrom ?? null);
    const dateTo = parseIsoDateEndOfDay(filters.dateTo ?? null);
    if (dateFrom) conditions.push(gte(claimSubmission.createdAt, dateFrom));
    if (dateTo) conditions.push(lte(claimSubmission.createdAt, dateTo));
    if (filters.onlyOpen) {
        conditions.push(inArray(claimSubmission.status, OPEN_SUBMISSION_STATUSES as unknown as string[]));
    }

    const baseQuery = db
        .select({
            submission: claimSubmission,
            workflow: claimWorkflow,
            offNoPengajuan: offBatch.noPengajuan,
        })
        .from(claimSubmission)
        .innerJoin(claimWorkflow, eq(claimSubmission.claimWorkflowId, claimWorkflow.id))
        .leftJoin(offBatch, eq(claimWorkflow.offBatchId, offBatch.id));
    const filtered = conditions.length > 0 ? baseQuery.where(and(...conditions)) : baseQuery;
    const rows = await filtered.orderBy(desc(claimSubmission.createdAt));

    const submissionIds = rows.map((r) => r.submission.id);
    const paymentsBySubmission = await loadPaymentsForSubmissions(submissionIds);

    // itemCount per submission via single GROUP BY.
    const itemCountMap = new Map<string, number>();
    if (submissionIds.length > 0) {
        const itemRows = await db
            .select({
                claimSubmissionId: claimWorkflowItem.claimSubmissionId,
                count: count(claimWorkflowItem.id),
            })
            .from(claimWorkflowItem)
            .where(inArray(claimWorkflowItem.claimSubmissionId, submissionIds as string[]))
            .groupBy(claimWorkflowItem.claimSubmissionId);
        for (const row of itemRows) {
            if (row.claimSubmissionId) {
                itemCountMap.set(row.claimSubmissionId, Number(row.count || 0));
            }
        }
    }

    return rows.map(({ submission: s, workflow: w, offNoPengajuan }) => {
        const totalClaim = Number(s.totalClaim || 0);
        const payments = paymentsBySubmission.get(s.id) ?? [];
        const totalPaid = sumActivePayments(payments);
        const remainingAmount = calculateRemainingAmount(totalClaim, totalPaid);
        return {
            workflowId: w.id,
            claimWorkflowNo: w.claimWorkflowNo,
            sourceType: w.sourceType,
            offBatchId: w.offBatchId,
            offNoPengajuan,
            submissionId: s.id,
            noClaim: s.noClaim,
            scope: s.scope,
            scopeLabel: s.scopeLabel,
            submissionStatus: s.status,
            workflowAggregateStatus: w.aggregateStatus,
            principleCode: w.principleCode,
            principleName: w.principleName,
            totalDpp: Number(s.totalDpp || 0),
            totalPpn: Number(s.totalPpn || 0),
            totalPph: Number(s.totalPph || 0),
            totalClaim,
            totalPaid,
            remainingAmount,
            itemCount: itemCountMap.get(s.id) ?? 0,
            submittedToPrincipalAt: s.submittedToPrincipalAt
                ? new Date(s.submittedToPrincipalAt).toISOString()
                : null,
            closedAt: s.closedAt ? new Date(s.closedAt).toISOString() : null,
            createdAt: new Date(s.createdAt).toISOString(),
        } satisfies SummaryReportRow;
    });
}

export const SUMMARY_REPORT_COLUMNS: ReadonlyArray<{ key: keyof SummaryReportRow & string; label: string }> = [
    { key: "claimWorkflowNo", label: "Claim Workflow No" },
    { key: "sourceType", label: "Source Type" },
    { key: "submissionId", label: "Submission Id" },
    { key: "noClaim", label: "No Claim" },
    { key: "scope", label: "Scope" },
    { key: "scopeLabel", label: "Scope Label" },
    { key: "submissionStatus", label: "Submission Status" },
    { key: "workflowAggregateStatus", label: "Workflow Aggregate Status" },
    { key: "principleCode", label: "Principle Code" },
    { key: "principleName", label: "Principle Name" },
    { key: "totalDpp", label: "Total DPP" },
    { key: "totalPpn", label: "Total PPN" },
    { key: "totalPph", label: "Total PPH" },
    { key: "totalClaim", label: "Total Claim" },
    { key: "totalPaid", label: "Total Paid" },
    { key: "remainingAmount", label: "Remaining Amount" },
    { key: "itemCount", label: "Item Count" },
    { key: "submittedToPrincipalAt", label: "Submitted To Principal At" },
    { key: "closedAt", label: "Closed At" },
    { key: "createdAt", label: "Created At" },
    { key: "offBatchId", label: "OFF Batch Id" },
    { key: "offNoPengajuan", label: "OFF No Pengajuan" },
];

// =============================================================================
// Paid Report (transaction-based, per submission)
// =============================================================================

export type PaidReportRow = {
    paymentId: string;
    workflowId: string;
    claimWorkflowNo: string;
    sourceType: string;
    submissionId: string | null;
    noClaim: string | null;
    scope: string | null;
    scopeLabel: string | null;
    principleCode: string;
    principleName: string;
    paymentDate: string;
    paymentAmount: number;
    paymentType: string | null;
    paymentNote: string | null;
    submissionTotalClaim: number;
    submissionTotalPaid: number;
    submissionRemainingAmount: number;
    submissionStatus: string | null;
    createdBy: string | null;
    createdAt: string;
    voidedAt: string | null;
    voidedBy: string | null;
    voidReason: string | null;
};

export async function buildPaidReport(filters: PaidReportFilters): Promise<PaidReportRow[]> {
    if (filters.status && !isKnownSubmissionStatus(filters.status)) return [];
    const conditions: SQL[] = [
        inArray(claimSubmission.status, claimSubmissionStatusList as unknown as string[]),
    ];
    if (isKnownSubmissionStatus(filters.status ?? null)) {
        conditions.push(eq(claimSubmission.status, filters.status as string));
    }
    if (filters.principleCode) {
        conditions.push(eq(claimWorkflow.principleCode, filters.principleCode));
    }

    const baseQuery = db
        .select({
            submission: claimSubmission,
            workflow: claimWorkflow,
        })
        .from(claimSubmission)
        .innerJoin(claimWorkflow, eq(claimSubmission.claimWorkflowId, claimWorkflow.id));
    const filtered = conditions.length > 0 ? baseQuery.where(and(...conditions)) : baseQuery;
    const submissionRows = await filtered;
    if (submissionRows.length === 0) return [];

    const submissionIds = submissionRows.map((r) => r.submission.id);
    const paymentsBySubmission = await loadPaymentsForSubmissions(submissionIds);

    const includeVoided = Boolean(filters.includeVoided);
    const dateFrom = filters.dateFrom && ISO_DATE_RE.test(filters.dateFrom) ? filters.dateFrom : null;
    const dateTo = filters.dateTo && ISO_DATE_RE.test(filters.dateTo) ? filters.dateTo : null;

    const rows: PaidReportRow[] = [];
    for (const { submission: s, workflow: w } of submissionRows) {
        const payments = paymentsBySubmission.get(s.id) ?? [];
        if (payments.length === 0) continue;
        const totalClaim = Number(s.totalClaim || 0);
        const totalPaid = sumActivePayments(payments);
        const remainingAmount = calculateRemainingAmount(totalClaim, totalPaid);
        for (const p of payments) {
            const isVoid = p.voidedAt !== null;
            if (!includeVoided && isVoid) continue;
            if (dateFrom && p.paymentDate < dateFrom) continue;
            if (dateTo && p.paymentDate > dateTo) continue;
            rows.push({
                paymentId: p.id,
                workflowId: w.id,
                claimWorkflowNo: w.claimWorkflowNo,
                sourceType: w.sourceType,
                submissionId: s.id,
                noClaim: s.noClaim,
                scope: s.scope,
                scopeLabel: s.scopeLabel,
                principleCode: w.principleCode,
                principleName: w.principleName,
                paymentDate: p.paymentDate,
                paymentAmount: Number(p.paymentAmount || 0),
                paymentType: p.paymentType,
                paymentNote: p.paymentNote,
                submissionTotalClaim: totalClaim,
                submissionTotalPaid: totalPaid,
                submissionRemainingAmount: remainingAmount,
                submissionStatus: s.status,
                createdBy: p.createdBy,
                createdAt: new Date(p.createdAt).toISOString(),
                voidedAt: p.voidedAt ? new Date(p.voidedAt).toISOString() : null,
                voidedBy: p.voidedBy,
                voidReason: p.voidReason,
            });
        }
    }
    rows.sort((a, b) => {
        if (a.paymentDate === b.paymentDate) return a.createdAt.localeCompare(b.createdAt);
        return a.paymentDate.localeCompare(b.paymentDate);
    });
    return rows;
}

export const PAID_REPORT_COLUMNS: ReadonlyArray<{ key: keyof PaidReportRow & string; label: string }> = [
    { key: "paymentId", label: "Payment Id" },
    { key: "claimWorkflowNo", label: "Claim Workflow No" },
    { key: "sourceType", label: "Source Type" },
    { key: "submissionId", label: "Submission Id" },
    { key: "noClaim", label: "No Claim" },
    { key: "scope", label: "Scope" },
    { key: "scopeLabel", label: "Scope Label" },
    { key: "principleCode", label: "Principle Code" },
    { key: "principleName", label: "Principle Name" },
    { key: "paymentDate", label: "Payment Date" },
    { key: "paymentAmount", label: "Payment Amount" },
    { key: "paymentType", label: "Payment Type" },
    { key: "paymentNote", label: "Payment Note" },
    { key: "submissionTotalClaim", label: "Submission Total Claim" },
    { key: "submissionTotalPaid", label: "Submission Total Paid" },
    { key: "submissionRemainingAmount", label: "Submission Remaining Amount" },
    { key: "submissionStatus", label: "Submission Status" },
    { key: "createdBy", label: "Created By" },
    { key: "createdAt", label: "Created At" },
    { key: "voidedAt", label: "Voided At" },
    { key: "voidedBy", label: "Voided By" },
    { key: "voidReason", label: "Void Reason" },
];

// =============================================================================
// Outstanding Report (per submission)
// =============================================================================

export type OutstandingReportRow = {
    workflowId: string;
    claimWorkflowNo: string;
    sourceType: string;
    submissionId: string;
    noClaim: string | null;
    scope: string;
    scopeLabel: string | null;
    submissionStatus: string;
    principleCode: string;
    principleName: string;
    totalClaim: number;
    totalPaid: number;
    remainingAmount: number;
    submittedToPrincipalAt: string | null;
    latestPaymentDate: string | null;
    daysOutstanding: number | null;
    agingBucket: "0-30" | "31-60" | "61-90" | ">90" | "Unknown";
    offBatchId: string;
    offNoPengajuan: string | null;
};

const OUTSTANDING_SUBMISSION_STATUSES = [
    claimWorkflowStatuses.submittedToPrincipal,
    claimWorkflowStatuses.partiallyPaid,
    claimWorkflowStatuses.outstanding,
] as const;

function bucketize(days: number | null): OutstandingReportRow["agingBucket"] {
    if (days === null) return "Unknown";
    if (days <= 30) return "0-30";
    if (days <= 60) return "31-60";
    if (days <= 90) return "61-90";
    return ">90";
}

export async function buildOutstandingReport(filters: OutstandingReportFilters): Promise<OutstandingReportRow[]> {
    if (filters.status && !(OUTSTANDING_SUBMISSION_STATUSES as ReadonlyArray<string>).includes(filters.status)) {
        return [];
    }
    const conditions: SQL[] = [];
    const requestedStatus = filters.status ?? null;
    if (requestedStatus && (OUTSTANDING_SUBMISSION_STATUSES as ReadonlyArray<string>).includes(requestedStatus)) {
        conditions.push(eq(claimSubmission.status, requestedStatus));
    } else {
        conditions.push(inArray(claimSubmission.status, OUTSTANDING_SUBMISSION_STATUSES as unknown as string[]));
    }
    if (filters.principleCode) {
        conditions.push(eq(claimWorkflow.principleCode, filters.principleCode));
    }

    const baseQuery = db
        .select({
            submission: claimSubmission,
            workflow: claimWorkflow,
            offNoPengajuan: offBatch.noPengajuan,
        })
        .from(claimSubmission)
        .innerJoin(claimWorkflow, eq(claimSubmission.claimWorkflowId, claimWorkflow.id))
        .leftJoin(offBatch, eq(claimWorkflow.offBatchId, offBatch.id));
    const filtered = conditions.length > 0 ? baseQuery.where(and(...conditions)) : baseQuery;
    const rows = await filtered.orderBy(desc(claimSubmission.submittedToPrincipalAt));

    const submissionIds = rows.map((r) => r.submission.id);
    const paymentsBySubmission = await loadPaymentsForSubmissions(submissionIds);

    const now = Date.now();
    const out: OutstandingReportRow[] = [];
    for (const { submission: s, workflow: w, offNoPengajuan } of rows) {
        const totalClaim = Number(s.totalClaim || 0);
        const payments = paymentsBySubmission.get(s.id) ?? [];
        const totalPaid = sumActivePayments(payments);
        const remainingAmount = calculateRemainingAmount(totalClaim, totalPaid);
        if (remainingAmount <= 0) continue;
        const activePayments = payments.filter((p) => p.voidedAt === null);
        const latestPaymentDate = activePayments.length > 0
            ? activePayments[activePayments.length - 1].paymentDate
            : null;
        const submittedAt = s.submittedToPrincipalAt
            ? new Date(s.submittedToPrincipalAt)
            : null;
        const days = submittedAt && Number.isFinite(submittedAt.getTime())
            ? Math.max(0, Math.floor((now - submittedAt.getTime()) / (1000 * 60 * 60 * 24)))
            : null;
        out.push({
            workflowId: w.id,
            claimWorkflowNo: w.claimWorkflowNo,
            sourceType: w.sourceType,
            submissionId: s.id,
            noClaim: s.noClaim,
            scope: s.scope,
            scopeLabel: s.scopeLabel,
            submissionStatus: s.status,
            principleCode: w.principleCode,
            principleName: w.principleName,
            totalClaim,
            totalPaid,
            remainingAmount,
            submittedToPrincipalAt: submittedAt ? submittedAt.toISOString() : null,
            latestPaymentDate,
            daysOutstanding: days,
            agingBucket: bucketize(days),
            offBatchId: w.offBatchId,
            offNoPengajuan,
        });
    }
    return out;
}

export const OUTSTANDING_REPORT_COLUMNS: ReadonlyArray<{ key: keyof OutstandingReportRow & string; label: string }> = [
    { key: "claimWorkflowNo", label: "Claim Workflow No" },
    { key: "sourceType", label: "Source Type" },
    { key: "submissionId", label: "Submission Id" },
    { key: "noClaim", label: "No Claim" },
    { key: "scope", label: "Scope" },
    { key: "scopeLabel", label: "Scope Label" },
    { key: "submissionStatus", label: "Submission Status" },
    { key: "principleCode", label: "Principle Code" },
    { key: "principleName", label: "Principle Name" },
    { key: "totalClaim", label: "Total Claim" },
    { key: "totalPaid", label: "Total Paid" },
    { key: "remainingAmount", label: "Remaining Amount" },
    { key: "submittedToPrincipalAt", label: "Submitted To Principal At" },
    { key: "latestPaymentDate", label: "Latest Payment Date" },
    { key: "daysOutstanding", label: "Days Outstanding" },
    { key: "agingBucket", label: "Aging Bucket" },
    { key: "offBatchId", label: "OFF Batch Id" },
    { key: "offNoPengajuan", label: "OFF No Pengajuan" },
];
