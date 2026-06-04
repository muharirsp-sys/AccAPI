/*
 * Tujuan: Builder Kwitansi Claim PDF — kwitansi pengajuan klaim ke
 *         principal (PRE-submission, BUKAN payment receipt dari principal).
 *         File aktif tunggal per workflow, disimpan di
 *         `runtime/claim-workflow/receipts/`.
 * Caller: `app/api/claim-workflow/[id]/receipt/route.ts`.
 * Dependensi: pdf-lib, helper terbilangRupiah dari OFF.
 * Main Functions: generateClaimReceiptPdf.
 * Side Effects: Menulis file PDF ke disk dan return path absolut + buffer.
 *
 * Catatan: Phase R2 sengaja tidak menunggu claim_payment. Kwitansi ini
 * dipasangkan dengan Claim Letter dan Summary saat dikirim ke principal
 * sebagai paket dokumen klaim. Lihat docs/CLAIM_WORKFLOW_AI_CONTEXT.md.
 */
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

const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN = 48;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;

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

function safeFileName(value: string): string {
    const clean = asciiText(value).replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
    return clean || "claim-workflow";
}

function indonesianLongDate(date: Date): string {
    return new Intl.DateTimeFormat("id-ID", {
        timeZone: "Asia/Makassar",
        day: "numeric",
        month: "long",
        year: "numeric",
    }).format(date);
}

function recipientName(workflow: ClaimWorkflowRow): string {
    const raw = String(workflow.principleName ?? "").trim();
    return raw.length > 0 ? raw : "PRINCIPAL TERKAIT";
}

function summarizeItems(items: ClaimWorkflowItemRow[]): string {
    if (items.length === 0) return "Pengajuan klaim program promosi";
    if (items.length === 1) {
        const item = items[0];
        return `${item.jenisPromosi || "Program Promosi"} - Periode ${item.periode || "-"}`;
    }
    const distinctPrograms = new Set(
        items.map((it) => String(it.jenisPromosi || "").trim()).filter(Boolean),
    );
    if (distinctPrograms.size === 1) {
        return `${[...distinctPrograms][0]} (${items.length} item)`;
    }
    return `Program promosi gabungan ${items.length} item`;
}

function drawLabelValueRow(
    page: PDFPage,
    label: string,
    value: string,
    y: number,
    font: PDFFont,
    bold: PDFFont,
): number {
    page.drawText(label, {
        x: MARGIN + 8,
        y,
        size: 9,
        font: bold,
        color: rgb(0.22, 0.27, 0.34),
    });
    page.drawText(":", { x: MARGIN + 8 + 110, y, size: 9, font: bold });
    const valueX = MARGIN + 8 + 122;
    const maxWidth = CONTENT_WIDTH - 8 - 122 - 12;
    const maxChars = Math.max(20, Math.floor(maxWidth / (10 * 0.55)));
    page.drawText(fitText(value, maxChars), { x: valueX, y, size: 10, font });
    return y - 18;
}

async function buildClaimReceiptPdf(
    workflow: ClaimWorkflowRow,
    items: ClaimWorkflowItemRow[],
    generatedAt: Date,
): Promise<Buffer> {
    const pdfDoc = await PDFDocument.create();
    pdfDoc.setTitle(`Kwitansi Claim ${workflow.claimWorkflowNo}`);
    pdfDoc.setSubject(`Kwitansi Claim - ${recipientName(workflow)}`);
    pdfDoc.setCreator("AccAPI Claim Workflow");
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    const page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);

    // Frame utama.
    page.drawRectangle({
        x: MARGIN,
        y: MARGIN,
        width: CONTENT_WIDTH,
        height: PAGE_HEIGHT - MARGIN * 2,
        borderWidth: 1.2,
        borderColor: rgb(0.08, 0.19, 0.3),
        color: rgb(1, 1, 1),
    });

    // Header band.
    page.drawRectangle({
        x: MARGIN,
        y: PAGE_HEIGHT - MARGIN - 64,
        width: CONTENT_WIDTH,
        height: 64,
        color: rgb(0.08, 0.19, 0.32),
    });
    page.drawText("KWITANSI CLAIM", {
        x: MARGIN + 16,
        y: PAGE_HEIGHT - MARGIN - 36,
        size: 22,
        font: bold,
        color: rgb(1, 1, 1),
    });
    page.drawText("Dokumen klaim untuk principal (pre-submission)", {
        x: MARGIN + 16,
        y: PAGE_HEIGHT - MARGIN - 54,
        size: 9,
        font,
        color: rgb(0.85, 0.9, 0.95),
    });

    // Info utama (label-value rows).
    let y = PAGE_HEIGHT - MARGIN - 92;
    const noClaim = asciiText(workflow.noClaim || "-");
    y = drawLabelValueRow(page, "No. Claim", noClaim, y, font, bold);
    y = drawLabelValueRow(page, "Claim Workflow No", asciiText(workflow.claimWorkflowNo), y, font, bold);
    y = drawLabelValueRow(page, "Diajukan kepada", recipientName(workflow), y, font, bold);
    y = drawLabelValueRow(page, "Rincian Klaim", summarizeItems(items), y, font, bold);
    y = drawLabelValueRow(
        page,
        "Total Item",
        `${items.length} item${items.length === 0 ? "" : ""}`,
        y,
        font,
        bold,
    );
    y -= 12;

    // Box nominal.
    const nominalBoxX = MARGIN + 16;
    const nominalBoxY = y - 60;
    const nominalBoxWidth = CONTENT_WIDTH - 32;
    const nominalBoxHeight = 60;
    page.drawRectangle({
        x: nominalBoxX,
        y: nominalBoxY,
        width: nominalBoxWidth,
        height: nominalBoxHeight,
        borderWidth: 1,
        borderColor: rgb(0.08, 0.19, 0.3),
        color: rgb(0.95, 0.97, 1),
    });
    page.drawText("Jumlah Klaim", {
        x: nominalBoxX + 12,
        y: nominalBoxY + nominalBoxHeight - 18,
        size: 9,
        font: bold,
        color: rgb(0.22, 0.27, 0.34),
    });
    page.drawText(`Rp ${rupiah(Number(workflow.totalClaim || 0))}`, {
        x: nominalBoxX + 12,
        y: nominalBoxY + 18,
        size: 18,
        font: bold,
        color: rgb(0.08, 0.19, 0.3),
    });

    // Terbilang block.
    const terbilangText = `Terbilang: ${terbilangRupiah(Number(workflow.totalClaim || 0))}`;
    const terbilangY = nominalBoxY - 22;
    const maxTerbilangChars = Math.max(40, Math.floor((CONTENT_WIDTH - 32) / (9 * 0.55)));
    page.drawText(fitText(terbilangText, maxTerbilangChars), {
        x: MARGIN + 16,
        y: terbilangY,
        size: 9,
        font,
        color: rgb(0.18, 0.22, 0.28),
    });

    // Footer: tanggal + tanda tangan.
    const footerTopY = MARGIN + 160;
    const dateText = `Makassar, ${indonesianLongDate(generatedAt)}`;
    page.drawText(dateText, {
        x: PAGE_WIDTH - MARGIN - 16 - font.widthOfTextAtSize(dateText, 10),
        y: footerTopY,
        size: 10,
        font,
        color: rgb(0.15, 0.18, 0.24),
    });
    page.drawText("Hormat kami,", {
        x: PAGE_WIDTH - MARGIN - 16 - font.widthOfTextAtSize("Hormat kami,", 10),
        y: footerTopY - 18,
        size: 10,
        font,
    });
    page.drawText("CV. Surya Perkasa", {
        x: PAGE_WIDTH - MARGIN - 16 - bold.widthOfTextAtSize("CV. Surya Perkasa", 11),
        y: MARGIN + 60,
        size: 11,
        font: bold,
        color: rgb(0.08, 0.19, 0.3),
    });
    page.drawText("Distributor Makassar", {
        x: PAGE_WIDTH - MARGIN - 16 - font.widthOfTextAtSize("Distributor Makassar", 9),
        y: MARGIN + 46,
        size: 9,
        font,
        color: rgb(0.15, 0.18, 0.24),
    });

    // Catatan kecil di kiri bawah agar tidak tertukar dengan kwitansi
    // pembayaran principal.
    page.drawText(
        "Kwitansi ini adalah dokumen klaim pre-submission, bukan tanda terima",
        { x: MARGIN + 16, y: MARGIN + 60, size: 8, font, color: rgb(0.4, 0.45, 0.5) },
    );
    page.drawText(
        "pembayaran dari principal.",
        { x: MARGIN + 16, y: MARGIN + 48, size: 8, font, color: rgb(0.4, 0.45, 0.5) },
    );

    return Buffer.from(await pdfDoc.save());
}

export async function generateClaimReceiptPdf(
    workflow: ClaimWorkflowRow,
    items: ClaimWorkflowItemRow[],
    generatedAt: Date,
    options: { submission?: ClaimSubmissionRow | null } = {},
) {
    // Phase R7c: submission override seperti generator letter/summary.
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
    const pdf = await buildClaimReceiptPdf(effectiveWorkflow, items, generatedAt);
    if (pdf.byteLength === 0) throw new Error("Claim Receipt PDF output is empty.");

    let filePath: string;
    if (submission) {
        filePath = buildSubmissionDocumentFilePath({
            workflowId: workflow.id,
            submissionId: submission.id,
            type: claimDocumentTypes.receipt,
            noClaim: submission.noClaim,
            generatedAt,
        });
        await mkdir(path.dirname(filePath), { recursive: true });
    } else {
        const directory = path.join(process.cwd(), "runtime", "claim-workflow", "receipts");
        await mkdir(directory, { recursive: true });
        const timestamp = formatDocumentTimestamp(generatedAt);
        filePath = path.join(directory, `${safeFileName(workflow.claimWorkflowNo)}-receipt-${timestamp}.pdf`);
    }
    await writeFile(filePath, pdf);
    return { filePath, pdf };
}
