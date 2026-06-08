import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { terbilangRupiah } from "@/lib/off-program-control/helpers";
import { claimDocumentTypes } from "./constants";
import {
    buildSubmissionDocumentFilePath,
    formatDocumentTimestamp,
} from "./document-paths";
import type { ClaimSubmissionRow, ClaimWorkflowItemRow, ClaimWorkflowRow } from "./types";

/**
 * Phase R7c — Documents per submission:
 * Builder PDF dapat di-panggil di dua mode:
 *   1. Workflow-level (legacy): hanya `workflow + items`, totals + noClaim
 *      mengikuti row workflow apa adanya. Path output di legacy dir
 *      `runtime/claim-workflow/letters/`.
 *   2. Submission-level (R7c): tambahan `submission` untuk override
 *      totals + noClaim + claim header. Items WAJIB sudah difilter
 *      oleh caller agar hanya berisi item yang ditugaskan ke submission.
 *      Path output di submission tree
 *      `runtime/claim-workflow/{workflowId}/submissions/{submissionId}/letter/`.
 *
 * Mode dipilih lewat optional argument `options.submission`. Tidak ada
 * breaking change untuk caller workflow-level lama.
 */
type EffectiveWorkflowTotals = Pick<
    ClaimWorkflowRow,
    "noClaim" | "totalDpp" | "totalPpn" | "totalPph" | "totalClaim"
>;

function applySubmissionOverrides<T extends ClaimWorkflowRow>(
    workflow: T,
    submission: ClaimSubmissionRow | null | undefined,
): T {
    if (!submission) return workflow;
    const override: EffectiveWorkflowTotals = {
        noClaim: submission.noClaim,
        totalDpp: Number(submission.totalDpp || 0),
        totalPpn: Number(submission.totalPpn || 0),
        totalPph: Number(submission.totalPph || 0),
        totalClaim: Number(submission.totalClaim || 0),
    };
    return { ...workflow, ...override };
}

const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN = 48;
const TABLE_WIDTH = PAGE_WIDTH - MARGIN * 2;
const DETAIL_WIDTH = 350;
const AMOUNT_WIDTH = TABLE_WIDTH - 38 - DETAIL_WIDTH;

type LetterRow = {
    number: string;
    detail: string;
    amount: string;
    bold?: boolean;
};

function asciiText(value: unknown): string {
    return String(value ?? "")
        .normalize("NFKD")
        .replace(/[^\x20-\x7E]/g, "")
        .replace(/\s+/g, " ")
        .trim();
}

function fitText(value: string, maxChars: number): string {
    const text = asciiText(value);
    if (text.length <= maxChars) return text;
    return `${text.slice(0, Math.max(0, maxChars - 3))}...`;
}

function rupiah(value: number): string {
    return Number(value || 0).toLocaleString("id-ID");
}

function percentage(value: number): string {
    return `${Number(value || 0).toLocaleString("id-ID", { maximumFractionDigits: 2 })}%`;
}

function generatedDateText(date: Date): string {
    return new Intl.DateTimeFormat("id-ID", {
        timeZone: "Asia/Makassar",
        day: "numeric",
        month: "long",
        year: "numeric",
    }).format(date);
}

function generatedReference(workflow: ClaimWorkflowRow, items: ClaimWorkflowItemRow[]): string {
    if (items.length === 1 && String(items[0].noSurat || "").trim()) {
        return String(items[0].noSurat);
    }
    const distinctReferences = new Set(items.map((item) => String(item.noSurat || "").trim()).filter(Boolean));
    return distinctReferences.size === 1
        ? [...distinctReferences][0]
        : workflow.claimWorkflowNo;
}

function subjectText(workflow: ClaimWorkflowRow, items: ClaimWorkflowItemRow[]): string {
    if (items.length === 1) {
        const item = items[0];
        return `Klaim ${item.jenisPromosi || "Program"} Periode ${item.periode || "-"}`;
    }
    const principle = String(workflow.principleName ?? "").trim() || "PRINCIPAL TERKAIT";
    return `Klaim Program ${principle}`;
}

function buildRows(workflow: ClaimWorkflowRow, items: ClaimWorkflowItemRow[]): LetterRow[] {
    const rows: LetterRow[] = items.map((item, index) => ({
        number: String(index + 1),
        detail: `DPP - ${item.jenisPromosi || "Program"} Periode ${item.periode || "-"}`,
        amount: rupiah(Number(item.dpp || 0)),
    }));
    if (Number(workflow.totalPpn || 0) > 0) {
        const rate = items.length === 1 ? ` ${percentage(Number(items[0].ppnRate || 0))}` : "";
        rows.push({ number: "", detail: `PPN${rate}`, amount: rupiah(Number(workflow.totalPpn || 0)) });
    }
    if (Number(workflow.totalPph || 0) > 0) {
        const rate = items.length === 1 ? ` ${percentage(Number(items[0].pphRate || 0))}` : "";
        rows.push({ number: "", detail: `PPH${rate}`, amount: `(${rupiah(Number(workflow.totalPph || 0))})` });
    }
    rows.push({
        number: "",
        detail: "Nilai Klaim",
        amount: rupiah(Number(workflow.totalClaim || 0)),
        bold: true,
    });
    return rows;
}

function drawRightText(page: PDFPage, value: string, rightX: number, y: number, size: number, font: PDFFont) {
    page.drawText(value, {
        x: rightX - font.widthOfTextAtSize(value, size),
        y,
        size,
        font,
        color: rgb(0.08, 0.1, 0.14),
    });
}

function drawTableHeader(page: PDFPage, y: number, bold: PDFFont) {
    page.drawRectangle({
        x: MARGIN,
        y: y - 22,
        width: TABLE_WIDTH,
        height: 22,
        color: rgb(0.12, 0.19, 0.3),
    });
    page.drawText("No.", { x: MARGIN + 9, y: y - 15, size: 9, font: bold, color: rgb(1, 1, 1) });
    page.drawText("RINCIAN CLAIM", { x: MARGIN + 48, y: y - 15, size: 9, font: bold, color: rgb(1, 1, 1) });
    page.drawText("TOTAL (Rp)", { x: MARGIN + 408, y: y - 15, size: 9, font: bold, color: rgb(1, 1, 1) });
}

function drawContinuationHeading(page: PDFPage, workflow: ClaimWorkflowRow, pageNo: number, font: PDFFont, bold: PDFFont) {
    page.drawText("Lampiran Rincian Claim", { x: MARGIN, y: PAGE_HEIGHT - 65, size: 14, font: bold });
    page.drawText(fitText(`Referensi: ${workflow.claimWorkflowNo}`, 70), {
        x: MARGIN,
        y: PAGE_HEIGHT - 84,
        size: 9,
        font,
    });
    drawRightText(page, `Halaman ${pageNo}`, PAGE_WIDTH - MARGIN, PAGE_HEIGHT - 84, 9, font);
}

function recipientName(workflow: ClaimWorkflowRow): string {
    const raw = String(workflow.principleName ?? "").trim();
    return raw.length > 0 ? raw : "PRINCIPAL TERKAIT";
}

async function buildClaimLetterPdf(
    workflow: ClaimWorkflowRow,
    items: ClaimWorkflowItemRow[],
    generatedAt: Date,
): Promise<Buffer> {
    const principle = recipientName(workflow);
    const pdfDoc = await PDFDocument.create();
    pdfDoc.setTitle(`Surat Claim ${workflow.claimWorkflowNo}`);
    pdfDoc.setSubject(`Claim Letter - ${principle}`);
    pdfDoc.setCreator("AccAPI Claim Workflow");
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    const rows = buildRows(workflow, items);
    let page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    let pageNo = 1;

    drawRightText(page, `Makassar, ${generatedDateText(generatedAt)}`, PAGE_WIDTH - MARGIN, 776, 10, font);
    page.drawText(`No.     : ${fitText(generatedReference(workflow, items), 68)}`, { x: MARGIN, y: 741, size: 10, font });
    page.drawText(`Perihal : ${fitText(subjectText(workflow, items), 68)}`, { x: MARGIN, y: 723, size: 10, font });
    page.drawText("Kepada Yth.", { x: MARGIN, y: 678, size: 10, font });
    page.drawText(fitText(principle, 70), { x: MARGIN, y: 660, size: 10, font: bold });
    page.drawText("Di Tempat", { x: MARGIN, y: 642, size: 10, font });
    page.drawText("Dengan hormat,", { x: MARGIN, y: 600, size: 10, font });
    page.drawText(fitText(`Bersama surat ini kami mengajukan klaim kepada ${principle}`, 88), {
        x: MARGIN,
        y: 577,
        size: 10,
        font,
    });
    page.drawText("atas program yang telah dilaksanakan, dengan rincian sebagai berikut:", {
        x: MARGIN,
        y: 560,
        size: 10,
        font,
    });

    let y = 523;
    drawTableHeader(page, y, bold);
    y -= 22;

    rows.forEach((row) => {
        if (y < 185) {
            page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
            pageNo += 1;
            drawContinuationHeading(page, workflow, pageNo, font, bold);
            y = PAGE_HEIGHT - 112;
            drawTableHeader(page, y, bold);
            y -= 22;
        }
        const rowFont = row.bold ? bold : font;
        page.drawRectangle({
            x: MARGIN,
            y: y - 25,
            width: TABLE_WIDTH,
            height: 25,
            borderWidth: 0.6,
            borderColor: rgb(0.68, 0.71, 0.76),
            color: row.bold ? rgb(0.93, 0.95, 0.98) : rgb(1, 1, 1),
        });
        page.drawLine({ start: { x: MARGIN + 38, y }, end: { x: MARGIN + 38, y: y - 25 }, thickness: 0.6, color: rgb(0.68, 0.71, 0.76) });
        page.drawLine({ start: { x: MARGIN + 38 + DETAIL_WIDTH, y }, end: { x: MARGIN + 38 + DETAIL_WIDTH, y: y - 25 }, thickness: 0.6, color: rgb(0.68, 0.71, 0.76) });
        page.drawText(row.number, { x: MARGIN + 15, y: y - 17, size: 9, font: rowFont });
        page.drawText(fitText(row.detail, 61), { x: MARGIN + 48, y: y - 17, size: 9, font: rowFont });
        drawRightText(page, row.amount, MARGIN + 38 + DETAIL_WIDTH + AMOUNT_WIDTH - 9, y - 17, 9, rowFont);
        y -= 25;
    });

    if (y < 250) {
        page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
        pageNo += 1;
        drawContinuationHeading(page, workflow, pageNo, font, bold);
        y = PAGE_HEIGHT - 128;
    }

    page.drawText(`Terbilang: ${fitText(terbilangRupiah(Number(workflow.totalClaim || 0)), 76)}`, {
        x: MARGIN,
        y: y - 20,
        size: 9,
        font,
        color: rgb(0.18, 0.22, 0.28),
    });
    page.drawText("Demikian pengajuan klaim ini kami sampaikan. Atas perhatian dan kerja samanya,", {
        x: MARGIN,
        y: y - 60,
        size: 10,
        font,
    });
    page.drawText("kami ucapkan terima kasih.", { x: MARGIN, y: y - 78, size: 10, font });
    page.drawText("Hormat kami,", { x: MARGIN, y: y - 120, size: 10, font });
    page.drawText("CV. Surya Perkasa", { x: MARGIN, y: y - 172, size: 10, font: bold });
    page.drawText("Distributor Makassar", { x: MARGIN, y: y - 189, size: 10, font });

    return Buffer.from(await pdfDoc.save());
}

function safeFileName(value: string): string {
    const clean = asciiText(value).replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
    return clean || "claim-workflow";
}

export async function generateClaimLetterPdf(
    workflow: ClaimWorkflowRow,
    items: ClaimWorkflowItemRow[],
    generatedAt: Date,
    options: { submission?: ClaimSubmissionRow | null } = {},
) {
    const submission = options.submission ?? null;
    // Apply submission totals/noClaim ke "effective workflow" supaya
    // builder existing tetap bisa render header/total tanpa perubahan
    // signature internal yang besar. Items sudah difilter oleh caller.
    const effectiveWorkflow = applySubmissionOverrides(workflow, submission);
    const pdf = await buildClaimLetterPdf(effectiveWorkflow, items, generatedAt);
    if (pdf.byteLength === 0) throw new Error("Claim Letter PDF output is empty.");

    let filePath: string;
    if (submission) {
        filePath = buildSubmissionDocumentFilePath({
            workflowId: workflow.id,
            submissionId: submission.id,
            type: claimDocumentTypes.letter,
            noClaim: submission.noClaim,
            generatedAt,
        });
        await mkdir(path.dirname(filePath), { recursive: true });
    } else {
        const directory = path.join(process.cwd(), "runtime", "claim-workflow", "letters");
        await mkdir(directory, { recursive: true });
        const timestamp = formatDocumentTimestamp(generatedAt);
        filePath = path.join(directory, `${safeFileName(workflow.claimWorkflowNo)}-claim-letter-${timestamp}.pdf`);
    }
    await writeFile(filePath, pdf);
    return { filePath, pdf };
}

// =============================================================================
// Combined Claim Letter — 1 PDF gabungan workflow-level, banyak surat di dalamnya
// =============================================================================

type CombinedLetterEntry = {
    submission: ClaimSubmissionRow;
    items: ClaimWorkflowItemRow[];
};

/**
 * Generate 1 PDF Surat Claim gabungan untuk seluruh workflow. Setiap
 * submission aktif mendapat section surat sendiri (halaman baru) di
 * dalam PDF yang sama. Disimpan ke workflow.claimLetterPdfPath.
 */
export async function generateCombinedClaimLetterPdf(
    workflow: ClaimWorkflowRow,
    entries: CombinedLetterEntry[],
    generatedAt: Date,
) {
    const { PDFDocument: PDFDoc } = await import("pdf-lib");
    // Build individual letter PDFs in memory, then merge pages.
    const mergedDoc = await PDFDoc.create();
    mergedDoc.setTitle(`Surat Claim Gabungan ${workflow.claimWorkflowNo}`);
    mergedDoc.setSubject(`Claim Letter Gabungan - ${recipientName(workflow)}`);
    mergedDoc.setCreator("AccAPI Claim Workflow");

    for (const entry of entries) {
        const effectiveWorkflow = applySubmissionOverrides(workflow, entry.submission);
        const singlePdf = await buildClaimLetterPdf(effectiveWorkflow, entry.items, generatedAt);
        const singleDoc = await PDFDoc.load(singlePdf);
        const pageIndices = singleDoc.getPageIndices();
        const copiedPages = await mergedDoc.copyPages(singleDoc, pageIndices);
        for (const page of copiedPages) {
            mergedDoc.addPage(page);
        }
    }

    // Jika tidak ada entry, tetap buat 1 halaman kosong agar PDF valid.
    if (entries.length === 0) {
        mergedDoc.addPage([595.28, 841.89]);
    }

    const pdf = Buffer.from(await mergedDoc.save());
    if (pdf.byteLength === 0) throw new Error("Combined Claim Letter PDF output is empty.");

    const directory = path.join(process.cwd(), "runtime", "claim-workflow", "letters");
    await mkdir(directory, { recursive: true });
    const timestamp = formatDocumentTimestamp(generatedAt);
    const filePath = path.join(directory, `${safeFileName(workflow.claimWorkflowNo)}-claim-letter-combined-${timestamp}.pdf`);
    await writeFile(filePath, pdf);
    return { filePath, pdf };
}
