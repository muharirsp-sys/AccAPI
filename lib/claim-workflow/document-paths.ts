/*
 * Tujuan: Helper terpusat untuk path file dokumen klaim per submission
 *         (Phase R7c). Mengkonsolidasikan resolver folder, builder
 *         filename, slug No Claim, dan validator path supaya tidak ada
 *         duplikasi konstanta antar route generator/serve PDF.
 * Caller:
 *   - app/api/claim-workflow/[id]/submissions/[submissionId]/{letter,
 *     summary,receipt}/route.ts (R7c — generate + stream per submission).
 *   - app/api/claim-workflow/[id]/{claim-letter,summary,receipt}/route.ts
 *     (legacy workflow-level — re-pakai validator + legacy dir).
 *   - app/api/claim-workflow/[id]/status/route.ts (return_to_draft —
 *     invalidate file workflow + submission).
 * Dependensi: node:path. TIDAK akses DB atau filesystem di file ini.
 *             Caller bertanggung jawab `mkdir`/`writeFile`/`unlink`.
 * Side Effects: Tidak ada (pure helpers).
 *
 * Struktur path R7c:
 *   runtime/claim-workflow/
 *     {workflowId}/submissions/{submissionId}/{type}/{slug}-{type}-{ts}.pdf
 *     letters/   ← LEGACY workflow-level (pre-R7c)
 *     summaries/ ← LEGACY workflow-level
 *     receipts/  ← LEGACY workflow-level
 *
 * Folder utama submission selalu pakai `submissionId` (immutable). No
 * Claim hanya boleh masuk filename setelah disanitasi via
 * `slugifyNoClaim`. Saat noClaim diubah, folder tidak ikut bergerak.
 */
import path from "node:path";
import { claimDocumentTypes, type ClaimDocumentType } from "./constants";

/**
 * Root semua dokumen klaim. Semua path file claim-workflow yang valid
 * harus berada di bawah folder ini.
 */
export const CLAIM_DOCUMENT_ROOT_DIR = path.resolve(
    process.cwd(),
    "runtime",
    "claim-workflow",
);

/**
 * Folder legacy workflow-level (pra-R7c). Tetap valid sebagai cache
 * untuk single-submission workflow yang dimirror dari endpoint legacy.
 * Multi-submission workflow tidak menulis ke folder ini.
 */
export const LEGACY_DOCUMENT_DIRS: Readonly<Record<ClaimDocumentType, string>> = {
    [claimDocumentTypes.letter]: path.join(CLAIM_DOCUMENT_ROOT_DIR, "letters"),
    [claimDocumentTypes.summary]: path.join(CLAIM_DOCUMENT_ROOT_DIR, "summaries"),
    [claimDocumentTypes.receipt]: path.join(CLAIM_DOCUMENT_ROOT_DIR, "receipts"),
} as const;

const ID_SEGMENT_REGEX = /[^a-zA-Z0-9._-]+/g;
const FILENAME_SLUG_REGEX = /[^a-zA-Z0-9._-]+/g;

/**
 * Sanitasi segmen path (workflowId / submissionId). Karakter di luar
 * `[a-zA-Z0-9._-]` diganti `-`, leading/trailing `-` di-strip. UUID v4
 * lulus tanpa perubahan.
 */
function sanitizeIdSegment(value: string): string {
    const cleaned = String(value || "")
        .replace(ID_SEGMENT_REGEX, "-")
        .replace(/^-+|-+$/g, "");
    if (!cleaned) {
        throw new Error("Invalid id segment for claim document path");
    }
    return cleaned;
}

/**
 * Slug filename dari nilai No Claim. Aman untuk dijadikan bagian
 * filename. Kalau noClaim NULL/empty, return null supaya caller dapat
 * fallback ke `submissionId`.
 */
export function slugifyNoClaim(value: string | null | undefined): string | null {
    if (value === null || value === undefined) return null;
    const ascii = String(value)
        .normalize("NFKD")
        .replace(/[^\x20-\x7E]/g, "")
        .trim();
    if (!ascii) return null;
    const slug = ascii
        .replace(FILENAME_SLUG_REGEX, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 80);
    return slug.length > 0 ? slug : null;
}

/**
 * Folder dokumen untuk satu submission + tipe dokumen. Belum dibuat di
 * disk; caller wajib `mkdir(..., { recursive: true })` sebelum write.
 */
export function getSubmissionDocumentDir(
    workflowId: string,
    submissionId: string,
    type: ClaimDocumentType,
): string {
    return path.join(
        CLAIM_DOCUMENT_ROOT_DIR,
        sanitizeIdSegment(workflowId),
        "submissions",
        sanitizeIdSegment(submissionId),
        type,
    );
}

/**
 * Format timestamp untuk filename (YYYYMMDDHHMMSS, UTC). Konsisten dengan
 * pola filename builder PDF lama.
 */
export function formatDocumentTimestamp(generatedAt: Date): string {
    return generatedAt.toISOString().replace(/[-:T]/g, "").slice(0, 14);
}

/**
 * Bangun path file PDF lengkap untuk satu dokumen submission.
 * Filename pattern: `{slug}-{type}-{timestamp}.pdf` di mana slug
 * di-derive dari noClaim atau (kalau noClaim NULL/empty) submissionId.
 */
export function buildSubmissionDocumentFilePath(input: {
    workflowId: string;
    submissionId: string;
    type: ClaimDocumentType;
    noClaim: string | null | undefined;
    generatedAt: Date;
}): string {
    const dir = getSubmissionDocumentDir(input.workflowId, input.submissionId, input.type);
    const slugCandidate = slugifyNoClaim(input.noClaim);
    const slug = slugCandidate ?? sanitizeIdSegment(input.submissionId);
    const ts = formatDocumentTimestamp(input.generatedAt);
    return path.join(dir, `${slug}-${input.type}-${ts}.pdf`);
}

/**
 * Validator umum: target path harus berada di bawah
 * `runtime/claim-workflow/`. Dipakai oleh route GET sebelum stream PDF
 * supaya tidak melayani file di luar runtime claim-workflow.
 */
export function isPathInsideClaimDocumentRoot(targetPath: string): boolean {
    if (!targetPath) return false;
    const resolved = path.resolve(targetPath);
    return resolved === CLAIM_DOCUMENT_ROOT_DIR
        || resolved.startsWith(CLAIM_DOCUMENT_ROOT_DIR + path.sep);
}

/**
 * Cek apakah path berada di bawah folder legacy untuk tipe tertentu.
 * Dipakai oleh route legacy sebelum stream/unlink supaya hanya path
 * yang memang tertulis lewat route legacy yang ditangani.
 */
export function isPathInsideLegacyDir(
    targetPath: string,
    type: ClaimDocumentType,
): boolean {
    if (!targetPath) return false;
    const dir = LEGACY_DOCUMENT_DIRS[type];
    const resolved = path.resolve(targetPath);
    return resolved === dir || resolved.startsWith(dir + path.sep);
}

/**
 * Cek apakah path berada di bawah submission tree untuk satu workflow
 * + submission spesifik. Berguna sebagai narrow check di route serve
 * per submission (lebih ketat dari `isPathInsideClaimDocumentRoot`).
 */
export function isPathInsideSubmissionDocumentDir(input: {
    workflowId: string;
    submissionId: string;
    type: ClaimDocumentType;
    targetPath: string;
}): boolean {
    if (!input.targetPath) return false;
    const dir = getSubmissionDocumentDir(input.workflowId, input.submissionId, input.type);
    const resolved = path.resolve(input.targetPath);
    return resolved === dir || resolved.startsWith(dir + path.sep);
}
