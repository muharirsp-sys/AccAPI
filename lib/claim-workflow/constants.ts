/*
 * Tujuan: Status Claim Workflow production setelah cleanup PEKA/EC/CN.
 * Caller: Lib helpers (`audit`, `access`, `pdf`, …) dan API routes
 *         (`/api/claim-workflow/...`) plus UI di `app/(dashboard)/claim-workflow`.
 * Dependensi: Tidak ada runtime dependency. Hanya konstanta.
 * Side Effects: Tidak ada.
 *
 * Catatan cleanup PEKA (Mei 2026):
 * - Status `Waiting PEKA`, `EC Received`, dan `CN Received` dihapus.
 *   Workflow production sekarang langsung jalan
 *   `Submitted to Principal -> Partially Paid / Paid -> Closed`.
 * - Status `Outstanding` tetap dipertahankan sebagai label monitoring untuk
 *   klaim lewat deadline tanpa pembayaran. Dipakai oleh dashboard outstanding
 *   (R3 — Principal Payment + Outstanding) tanpa tergantung PEKA/EC/CN.
 * - Legacy DB row yang masih berisi `Waiting PEKA` / `EC Received` /
 *   `CN Received` ditangani lewat `LEGACY_PEKA_STATUSES` / `isLegacyPekaStatus`
 *   — UI menampilkannya sebagai fallback `Submitted to Principal` dan tidak
 *   menyediakan aksi transisi PEKA apapun.
 */
export const claimWorkflowStatuses = {
    draft: "Draft",
    needRevision: "Need Revision",
    readyToSubmit: "Ready to Submit",
    submittedToPrincipal: "Submitted to Principal",
    partiallyPaid: "Partially Paid",
    paid: "Paid",
    outstanding: "Outstanding",
    closed: "Closed",
    cancelled: "Cancelled",
} as const;

export type ClaimWorkflowStatus =
    (typeof claimWorkflowStatuses)[keyof typeof claimWorkflowStatuses];

export const claimWorkflowStatusList = Object.values(claimWorkflowStatuses);

/**
 * Legacy PEKA status labels yang mungkin masih ada di SQLite lama. Tidak
 * dipakai untuk transisi baru. Dipakai oleh helper `isLegacyPekaStatus`
 * dan `displayClaimStatusLabel` agar UI tetap bisa render row legacy
 * tanpa crash dan tanpa memunculkan kembali aksi PEKA.
 */
export const LEGACY_PEKA_STATUSES = [
    "Waiting PEKA",
    "EC Received",
    "CN Received",
] as const;

export type LegacyPekaStatus = (typeof LEGACY_PEKA_STATUSES)[number];

export function isLegacyPekaStatus(value: string | null | undefined): value is LegacyPekaStatus {
    if (!value) return false;
    return (LEGACY_PEKA_STATUSES as ReadonlyArray<string>).includes(value);
}

/**
 * Label aman untuk ditampilkan di UI. Status legacy PEKA dipetakan ke
 * `Submitted to Principal` agar konsisten dengan flow production yang
 * baru, tanpa menulis kembali ke DB.
 */
export function displayClaimStatusLabel(value: string | null | undefined): string {
    if (!value) return "Draft";
    if (isLegacyPekaStatus(value)) {
        return `${claimWorkflowStatuses.submittedToPrincipal} (legacy: ${value})`;
    }
    return value;
}

/**
 * Phase R1 — Rewire OFF ↔ Claim No Claim:
 * Claim Workflow boleh dibuat setelah OFF OM Approved. Tidak perlu menunggu
 * OFF Completed lagi. Persyaratan minimum dipersempit ke `omStatus = Approved`
 * sehingga claim user bisa mempersiapkan tax editing dan generate dokumen
 * klaim tanpa harus menunggu Finance Paid + Final Completed.
 *
 * OFF Completed tetap punya rule terpisah: butuh Finance Paid + No Claim
 * Claim Workflow + sync ke off_batch_item.no_claim. Lihat
 * app/api/off-program-control/batches/[id]/final-claim/route.ts.
 */
export const claimWorkflowOffRequirements = {
    omStatus: "Approved",
} as const;

/**
 * Phase R7a — Multi No Claim + Direct Claim Source (additive):
 *
 * `claim_submission` adalah container baru yang akan menampung satu
 * No Claim. Satu `claim_workflow` boleh memiliki banyak submission. Phase
 * R7a hanya memperkenalkan schema + backfill, sehingga konstanta di sini
 * baru dipakai oleh helper backfill, seed, dan UI mulai phase berikut.
 * Tidak ada route existing yang gating ke nilai-nilai di bawah pada R7a.
 *
 * Scope mendokumentasikan cara grouping No Claim:
 *   per_pengajuan — satu submission mencakup keseluruhan pengajuan
 *                   (default backfill untuk workflow lama).
 *   per_program   — satu submission per nama program promosi.
 *   per_toko      — satu submission per outlet/toko.
 *   per_item      — satu submission per baris/item klaim. Mengikuti pola
 *                   sheet BASE di Excel Godrej (R7g).
 *   custom        — grouping manual yang ditentukan user.
 */
export const claimSubmissionScopes = {
    perPengajuan: "per_pengajuan",
    perProgram: "per_program",
    perToko: "per_toko",
    perItem: "per_item",
    custom: "custom",
} as const;

export type ClaimSubmissionScope =
    (typeof claimSubmissionScopes)[keyof typeof claimSubmissionScopes];

export const claimSubmissionScopeList = Object.values(claimSubmissionScopes);

/**
 * Status produksi untuk `claim_submission`. Mirrors `claimWorkflowStatuses`
 * tetapi dengan subset yang masuk akal untuk satu submission. `Outstanding`
 * dan `Cancelled` di workflow ditahan dulu — submission level akan dipakai
 * di phase R7d/R7e dengan rule yang lebih ketat.
 *
 * `Need Revision` dan transisi balik diatur oleh route Phase R7b ke depan.
 * Di R7a tidak ada route yang menulis tabel `claim_submission` selain
 * migration backfill yang langsung mengisi `status = workflow.status`.
 */
export const claimSubmissionStatuses = {
    draft: "Draft",
    needRevision: "Need Revision",
    readyToSubmit: "Ready to Submit",
    submittedToPrincipal: "Submitted to Principal",
    partiallyPaid: "Partially Paid",
    paid: "Paid",
    closed: "Closed",
} as const;

export type ClaimSubmissionStatus =
    (typeof claimSubmissionStatuses)[keyof typeof claimSubmissionStatuses];

export const claimSubmissionStatusList = Object.values(claimSubmissionStatuses);

/**
 * Sumber data klaim untuk `claim_workflow.sourceType`. Default `off_program`
 * mempertahankan semantics R1-R6. `direct_kwitansi` dan `manual` dibuat
 * untuk Phase R7f (deferred) dan tidak dipakai untuk gating apapun di R7a.
 */
export const claimWorkflowSourceTypes = {
    offProgram: "off_program",
    directKwitansi: "direct_kwitansi",
    manual: "manual",
} as const;

export type ClaimWorkflowSourceType =
    (typeof claimWorkflowSourceTypes)[keyof typeof claimWorkflowSourceTypes];

export const claimWorkflowSourceTypeList = Object.values(claimWorkflowSourceTypes);

/**
 * Audit scope label untuk `claim_audit_log.auditScope`. Audit existing
 * (R1-R6) bersifat workflow-scope; audit submission dipakai mulai R7b.
 */
export const claimAuditScopes = {
    workflow: "workflow",
    submission: "submission",
} as const;

export type ClaimAuditScope =
    (typeof claimAuditScopes)[keyof typeof claimAuditScopes];

/**
 * Length limits untuk field tekstual yang dipakai oleh banyak route
 * (legacy `/[id]/no-claim`, submission CRUD R7b, dan endpoint masa
 * depan R7c–R7e). Disimpan di satu tempat supaya validasi backend tidak
 * pernah drift antar route bila bisnis menaikkan/menurunkan batas.
 */
export const NO_CLAIM_MAX_LENGTH = 120;
export const SCOPE_LABEL_MAX_LENGTH = 200;

/**
 * Phase R7c — Documents per submission:
 * Tipe dokumen klaim yang di-generate per submission (Letter / Summary /
 * Kwitansi). Dipakai oleh helper path resolver di
 * `lib/claim-workflow/document-paths.ts` dan route generator di
 * `app/api/claim-workflow/[id]/submissions/[submissionId]/{type}`.
 *
 * String value sengaja singkat (lowercase) supaya bisa dipakai sebagai
 * segmen path. Audit action tetap memakai prefix `claim_`:
 *   letter  → claim_letter_generated
 *   summary → claim_summary_generated
 *   receipt → claim_receipt_generated
 */
export const claimDocumentTypes = {
    letter: "letter",
    summary: "summary",
    receipt: "receipt",
} as const;

export type ClaimDocumentType =
    (typeof claimDocumentTypes)[keyof typeof claimDocumentTypes];

export const claimDocumentTypeList = Object.values(claimDocumentTypes);

export function isClaimDocumentType(value: unknown): value is ClaimDocumentType {
    return typeof value === "string"
        && (claimDocumentTypeList as ReadonlyArray<string>).includes(value);
}
