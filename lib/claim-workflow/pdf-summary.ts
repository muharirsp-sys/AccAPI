/*
 * Tujuan: Builder Claim Summary PDF — ringkasan satu workflow (header,
 *         total, tabel item) untuk dilampirkan saat pengajuan klaim ke
 *         principal. Pola mirroring `pdf.ts` (Claim Letter): satu PDF
 *         aktif per workflow, file disimpan di
 *         `runtime/claim-workflow/summaries/`.
 * Caller: `app/api/claim-workflow/[id]/summary/route.ts`.
 * Dependensi: pdf-lib, ClaimWorkflowItemRow, ClaimWorkflowRow.
 * Main Functions: generateClaimSummaryPdf.
 * Side Effects: Menulis file PDF ke disk dan return path absolut + buffer.
 */
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { uppercasePageText } from "@/lib/pdf-text";
import { claimDocumentTypes } from "./constants";
import {
    buildSubmissionDocumentFilePath,
    formatDocumentTimestamp,
} from "./document-paths";
import type { ClaimSubmissionRow, ClaimWorkflowItemRow, ClaimWorkflowRow } from "./types";

const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN = 48;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;

// Layout kolom tabel item (lebar dalam point pdf-lib).
// Total harus = CONTENT_WIDTH supaya garis vertikal rapi.
const COLUMN_WIDTHS = {
    no: 26,
    noSurat: 82,
    program: 133,
    dpp: 66,
    ppn: 50,
    pph: 50,
    nilai: CONTENT_WIDTH - 26 - 82 - 133 - 66 - 50 - 50,
} as const;

type ColumnKey = keyof typeof COLUMN_WIDTHS;

const COLUMN_ORDER: ColumnKey[] = ["no", "noSurat", "program", "dpp", "ppn", "pph", "nilai"];

const COLUMN_LABELS: Record<ColumnKey, string> = {
    no: "No.",
    noSurat: "No. Surat",
    program: "Rincian/Program",
    dpp: "DPP",
    ppn: "PPN",
    pph: "PPH",
    nilai: "Nilai Klaim",
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

function generatedDateText(date: Date): string {
    return new Intl.DateTimeFormat("id-ID", {
        timeZone: "Asia/Makassar",
        day: "numeric",
        month: "long",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
    }).format(date);
}

function safeFileName(value: string): string {
    const clean = asciiText(value).replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
    return clean || "claim-workflow";
}

function drawRightText(
    page: PDFPage,
    value: string,
    rightX: number,
    y: number,
    size: number,
    font: PDFFont,
    color = rgb(0.08, 0.1, 0.14),
) {
    // Ukur lebar pada teks UPPERCASE karena page.drawText di-uppercase otomatis
    // (uppercasePageText). Tanpa ini, teks rata-kanan meleset/overflow.
    page.drawText(value, {
        x: rightX - font.widthOfTextAtSize(value.toUpperCase(), size),
        y,
        size,
        font,
        color,
    });
}

function approxCharCapacity(width: number, fontSize: number): number {
    // Rough: Helvetica avg char width ≈ 0.55 * fontSize.
    return Math.max(4, Math.floor(width / (fontSize * 0.55)));
}

function drawHeaderRow(page: PDFPage, y: number, bold: PDFFont) {
    page.drawRectangle({
        x: MARGIN,
        y: y - 22,
        width: CONTENT_WIDTH,
        height: 22,
        color: rgb(0.12, 0.19, 0.3),
    });
    let cursorX = MARGIN;
    for (const key of COLUMN_ORDER) {
        const width = COLUMN_WIDTHS[key];
        const label = COLUMN_LABELS[key];
        const isNumeric = key === "dpp" || key === "ppn" || key === "pph" || key === "nilai";
        const labelText = fitText(label, approxCharCapacity(width - 12, 9));
        if (isNumeric) {
            drawRightText(page, labelText, cursorX + width - 6, y - 15, 9, bold, rgb(1, 1, 1));
        } else {
            page.drawText(labelText, { x: cursorX + 6, y: y - 15, size: 9, font: bold, color: rgb(1, 1, 1) });
        }
        cursorX += width;
    }
}

function drawItemRow(
    page: PDFPage,
    y: number,
    item: ClaimWorkflowItemRow,
    index: number,
    font: PDFFont,
    bold: PDFFont,
) {
    page.drawRectangle({
        x: MARGIN,
        y: y - 22,
        width: CONTENT_WIDTH,
        height: 22,
        borderWidth: 0.6,
        borderColor: rgb(0.7, 0.74, 0.8),
        color: index % 2 === 0 ? rgb(1, 1, 1) : rgb(0.97, 0.98, 0.99),
    });
    let cursorX = MARGIN;
    const cellY = y - 15;
    const program = `${asciiText(item.jenisPromosi || "Program")}` +
        (item.periode ? ` - ${asciiText(item.periode)}` : "");
    const values: Record<ColumnKey, string> = {
        no: String(index + 1),
        noSurat: asciiText(item.noSurat || "-"),
        program,
        dpp: rupiah(Number(item.dpp || 0)),
        ppn: rupiah(Number(item.ppnAmount || 0)),
        pph: rupiah(Number(item.pphAmount || 0)),
        nilai: rupiah(Number(item.nilaiKlaim || 0)),
    };
    for (const key of COLUMN_ORDER) {
        const width = COLUMN_WIDTHS[key];
        const isNumeric = key === "dpp" || key === "ppn" || key === "pph" || key === "nilai";
        const value = fitText(values[key], approxCharCapacity(width - 10, 9));
        const rowFont = key === "nilai" ? bold : font;
        if (isNumeric) {
            drawRightText(page, value, cursorX + width - 6, cellY, 9, rowFont);
        } else {
            page.drawText(value, { x: cursorX + 6, y: cellY, size: 9, font: rowFont });
        }
        cursorX += width;
    }
}

function drawTotalRow(page: PDFPage, y: number, workflow: ClaimWorkflowRow, font: PDFFont, bold: PDFFont) {
    page.drawRectangle({
        x: MARGIN,
        y: y - 24,
        width: CONTENT_WIDTH,
        height: 24,
        borderWidth: 0.8,
        borderColor: rgb(0.12, 0.19, 0.3),
        color: rgb(0.93, 0.95, 0.98),
    });
    let cursorX = MARGIN;
    const cellY = y - 16;
    const totals: Record<ColumnKey, string> = {
        no: "",
        noSurat: "",
        program: "TOTAL",
        dpp: rupiah(Number(workflow.totalDpp || 0)),
        ppn: rupiah(Number(workflow.totalPpn || 0)),
        pph: rupiah(Number(workflow.totalPph || 0)),
        nilai: rupiah(Number(workflow.totalClaim || 0)),
    };
    for (const key of COLUMN_ORDER) {
        const width = COLUMN_WIDTHS[key];
        const isNumeric = key === "dpp" || key === "ppn" || key === "pph" || key === "nilai";
        const value = totals[key];
        if (!value) {
            cursorX += width;
            continue;
        }
        if (key === "program") {
            page.drawText(value, { x: cursorX + 6, y: cellY, size: 10, font: bold });
        } else if (isNumeric) {
            drawRightText(page, value, cursorX + width - 6, cellY, 10, bold);
        }
        cursorX += width;
        void font;
    }
}

async function buildClaimSummaryPdf(
    workflow: ClaimWorkflowRow,
    items: ClaimWorkflowItemRow[],
    generatedAt: Date,
): Promise<Buffer> {
    const pdfDoc = await PDFDocument.create();
    pdfDoc.setTitle(`Claim Summary ${workflow.claimWorkflowNo}`);
    pdfDoc.setSubject(`Claim Summary - ${workflow.principleName}`);
    pdfDoc.setCreator("AccAPI Claim Workflow");
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

    let page = uppercasePageText(pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]));
    page.drawText("CLAIM SUMMARY", { x: MARGIN, y: PAGE_HEIGHT - 60, size: 18, font: bold, color: rgb(0.08, 0.19, 0.3) });
    drawRightText(page, `Generated: ${generatedDateText(generatedAt)}`, PAGE_WIDTH - MARGIN, PAGE_HEIGHT - 60, 9, font);

    // Header info block (2 kolom label + value).
    const headerLines: Array<[string, string]> = [
        ["Claim Workflow No", asciiText(workflow.claimWorkflowNo)],
        ["No Claim", asciiText(workflow.noClaim || "-")],
        ["Principle", asciiText(workflow.principleName || "-")],
        ["Status", asciiText(workflow.status || "-")],
    ];
    const headerStartY = PAGE_HEIGHT - 100;
    headerLines.forEach(([label, value], idx) => {
        const lineY = headerStartY - idx * 16;
        page.drawText(`${label}`, { x: MARGIN, y: lineY, size: 9, font: bold, color: rgb(0.25, 0.29, 0.36) });
        page.drawText(":", { x: MARGIN + 110, y: lineY, size: 9, font });
        page.drawText(fitText(value, 80), { x: MARGIN + 118, y: lineY, size: 9, font });
    });

    // Tabel item.
    let y = headerStartY - headerLines.length * 16 - 18;
    drawHeaderRow(page, y, bold);
    y -= 22;

    items.forEach((item, idx) => {
        if (y < MARGIN + 90) {
            // Page break: header tabel diulang di halaman berikut supaya mudah dibaca.
            page = uppercasePageText(pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]));
            page.drawText("CLAIM SUMMARY (lanjutan)", {
                x: MARGIN,
                y: PAGE_HEIGHT - 60,
                size: 14,
                font: bold,
                color: rgb(0.08, 0.19, 0.3),
            });
            y = PAGE_HEIGHT - 90;
            drawHeaderRow(page, y, bold);
            y -= 22;
        }
        drawItemRow(page, y, item, idx, font, bold);
        y -= 22;
    });

    if (y < MARGIN + 80) {
        page = uppercasePageText(pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]));
        y = PAGE_HEIGHT - 90;
    }
    drawTotalRow(page, y, workflow, font, bold);
    y -= 32;

    page.drawText("Dokumen ini ringkasan internal Claim Workflow untuk pengajuan klaim ke principal.", {
        x: MARGIN,
        y: y - 6,
        size: 8,
        font,
        color: rgb(0.4, 0.45, 0.5),
    });

    return Buffer.from(await pdfDoc.save());
}

export async function generateClaimSummaryPdf(
    workflow: ClaimWorkflowRow,
    items: ClaimWorkflowItemRow[],
    generatedAt: Date,
    options: { submission?: ClaimSubmissionRow | null } = {},
) {
    // Phase R7c: bila `submission` di-supply, totals + noClaim di header
    // PDF di-override pakai data submission. Items WAJIB sudah difilter
    // oleh caller agar hanya berisi item yang ditugaskan ke submission.
    const submission = options.submission ?? null;
    const effectiveWorkflow: ClaimWorkflowRow = submission
        ? {
            ...workflow,
            noClaim: submission.noClaim,
            totalDpp: Number(submission.totalDpp || 0),
            totalPpn: Number(submission.totalPpn || 0),
            totalPph: Number(submission.totalPph || 0),
            totalClaim: Number(submission.totalClaim || 0),
        }
        : workflow;
    const pdf = await buildClaimSummaryPdf(effectiveWorkflow, items, generatedAt);
    if (pdf.byteLength === 0) throw new Error("Claim Summary PDF output is empty.");

    let filePath: string;
    if (submission) {
        filePath = buildSubmissionDocumentFilePath({
            workflowId: workflow.id,
            submissionId: submission.id,
            type: claimDocumentTypes.summary,
            noClaim: submission.noClaim,
            generatedAt,
        });
        await mkdir(path.dirname(filePath), { recursive: true });
    } else {
        const directory = path.join(process.cwd(), "runtime", "claim-workflow", "summaries");
        await mkdir(directory, { recursive: true });
        const timestamp = formatDocumentTimestamp(generatedAt);
        filePath = path.join(directory, `${safeFileName(workflow.claimWorkflowNo)}-summary-${timestamp}.pdf`);
    }
    await writeFile(filePath, pdf);
    return { filePath, pdf };
}

// =============================================================================
// Combined Claim Summary — 1 PDF gabungan workflow-level
// =============================================================================

type CombinedSummaryEntry = {
    submission: ClaimSubmissionRow;
    items: ClaimWorkflowItemRow[];
};

/**
 * Generate 1 PDF Summary gabungan untuk seluruh workflow. Setiap
 * submission aktif mendapat section summary sendiri (halaman baru) di
 * dalam PDF yang sama. Disimpan ke workflow.summaryPdfPath.
 */
export async function generateCombinedClaimSummaryPdf(
    workflow: ClaimWorkflowRow,
    entries: CombinedSummaryEntry[],
    generatedAt: Date,
) {
    const mergedDoc = await PDFDocument.create();
    mergedDoc.setTitle(`Summary Claim Gabungan ${workflow.claimWorkflowNo}`);
    mergedDoc.setCreator("AccAPI Claim Workflow");

    for (const entry of entries) {
        const effectiveWorkflow: ClaimWorkflowRow = {
            ...workflow,
            noClaim: entry.submission.noClaim,
            totalDpp: Number(entry.submission.totalDpp || 0),
            totalPpn: Number(entry.submission.totalPpn || 0),
            totalPph: Number(entry.submission.totalPph || 0),
            totalClaim: Number(entry.submission.totalClaim || 0),
        };
        const singlePdf = await buildClaimSummaryPdf(effectiveWorkflow, entry.items, generatedAt);
        const singleDoc = await PDFDocument.load(singlePdf);
        const pageIndices = singleDoc.getPageIndices();
        const copiedPages = await mergedDoc.copyPages(singleDoc, pageIndices);
        for (const page of copiedPages) {
            mergedDoc.addPage(page);
        }
    }

    if (entries.length === 0) {
        mergedDoc.addPage([595.28, 841.89]);
    }

    const pdf = Buffer.from(await mergedDoc.save());
    if (pdf.byteLength === 0) throw new Error("Combined Claim Summary PDF output is empty.");

    const directory = path.join(process.cwd(), "runtime", "claim-workflow", "summaries");
    await mkdir(directory, { recursive: true });
    const timestamp = formatDocumentTimestamp(generatedAt);
    const safeNo = String(workflow.claimWorkflowNo || "claim-workflow")
        .normalize("NFKD").replace(/[^\x20-\x7E]/g, "").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "claim-workflow";
    const filePath = path.join(directory, `${safeNo}-summary-combined-${timestamp}.pdf`);
    await writeFile(filePath, pdf);
    return { filePath, pdf };
}
