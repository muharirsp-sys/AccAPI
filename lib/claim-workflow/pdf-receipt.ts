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

// Lebar teks UPPERCASE — page.drawText di-uppercase otomatis (uppercasePageText),
// jadi pengukuran untuk teks rata-kanan harus pakai versi uppercase agar tidak
// overflow menembus tepi kartu.
function uWidth(font: PDFFont, text: string, size: number): number {
    return font.widthOfTextAtSize(text.toUpperCase(), size);
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
    const page = uppercasePageText(pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]));

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
        x: PAGE_WIDTH - MARGIN - 16 - uWidth(font, dateText, 10),
        y: footerTopY,
        size: 10,
        font,
        color: rgb(0.15, 0.18, 0.24),
    });
    page.drawText("Hormat kami,", {
        x: PAGE_WIDTH - MARGIN - 16 - uWidth(font, "Hormat kami,", 10),
        y: footerTopY - 18,
        size: 10,
        font,
    });
    page.drawText("CV. Surya Perkasa", {
        x: PAGE_WIDTH - MARGIN - 16 - uWidth(bold, "CV. Surya Perkasa", 11),
        y: MARGIN + 60,
        size: 11,
        font: bold,
        color: rgb(0.08, 0.19, 0.3),
    });
    page.drawText("Distributor Makassar", {
        x: PAGE_WIDTH - MARGIN - 16 - uWidth(font, "Distributor Makassar", 9),
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

// =============================================================================
// Kwitansi Gabungan (Combined) — A4 Landscape, 4 kwitansi per halaman (2x2)
// =============================================================================
// Phase R7 doc rule: Kwitansi digabung dalam 1 PDF workflow-level untuk
// semua No Claim/submission aktif. Layout A4 Landscape, grid 2 kolom x 2
// baris (maks 4 kwitansi per halaman). Bila > 4 submission, lanjut ke
// halaman berikutnya. Ukuran diperkecil agar muat.

const LS_PAGE_WIDTH = 841.89; // A4 landscape width (= A4 portrait height)
const LS_PAGE_HEIGHT = 595.28; // A4 landscape height
const LS_MARGIN = 24;
const LS_GUTTER = 16;

type CombinedReceiptEntry = {
    submission: ClaimSubmissionRow;
    items: ClaimWorkflowItemRow[];
};

function drawMiniReceipt(
    page: PDFPage,
    font: PDFFont,
    bold: PDFFont,
    workflow: ClaimWorkflowRow,
    entry: CombinedReceiptEntry,
    cellX: number,
    cellY: number,
    cellW: number,
    cellH: number,
    generatedAt: Date,
) {
    const submission = entry.submission;
    const totalClaim = Number(submission.totalClaim || 0);

    // Card frame.
    page.drawRectangle({
        x: cellX,
        y: cellY,
        width: cellW,
        height: cellH,
        borderWidth: 1,
        borderColor: rgb(0.08, 0.19, 0.3),
        color: rgb(1, 1, 1),
    });

    // Header band.
    const headerH = 26;
    page.drawRectangle({
        x: cellX,
        y: cellY + cellH - headerH,
        width: cellW,
        height: headerH,
        color: rgb(0.08, 0.19, 0.32),
    });
    page.drawText("KWITANSI CLAIM", {
        x: cellX + 10,
        y: cellY + cellH - 17,
        size: 11,
        font: bold,
        color: rgb(1, 1, 1),
    });

    const innerMaxChars = Math.max(24, Math.floor((cellW - 90) / (9 * 0.55)));
    let y = cellY + cellH - headerH - 18;
    const labelX = cellX + 10;
    const valueX = cellX + 92;

    const row = (label: string, value: string) => {
        page.drawText(label, { x: labelX, y, size: 8, font: bold, color: rgb(0.22, 0.27, 0.34) });
        page.drawText(":", { x: valueX - 8, y, size: 8, font: bold });
        page.drawText(fitText(value, innerMaxChars), { x: valueX, y, size: 8.5, font });
        y -= 14;
    };

    row("No. Claim", asciiText(submission.noClaim || "-"));
    row("Diajukan ke", recipientName(workflow));
    row("Rincian", summarizeItems(entry.items));
    row("Total Item", `${entry.items.length} item`);

    // Nominal box.
    const boxH = 34;
    const boxY = y - boxH + 4;
    const boxX = cellX + 10;
    const boxW = cellW - 20;
    page.drawRectangle({
        x: boxX,
        y: boxY,
        width: boxW,
        height: boxH,
        borderWidth: 0.8,
        borderColor: rgb(0.08, 0.19, 0.3),
        color: rgb(0.95, 0.97, 1),
    });
    page.drawText("Jumlah Klaim", {
        x: boxX + 8,
        y: boxY + boxH - 12,
        size: 7.5,
        font: bold,
        color: rgb(0.22, 0.27, 0.34),
    });
    page.drawText(`Rp ${rupiah(totalClaim)}`, {
        x: boxX + 8,
        y: boxY + 8,
        size: 13,
        font: bold,
        color: rgb(0.08, 0.19, 0.3),
    });

    // Terbilang.
    const terbilangText = `Terbilang: ${terbilangRupiah(totalClaim)}`;
    page.drawText(fitText(terbilangText, Math.max(40, Math.floor((cellW - 20) / (7 * 0.55)))), {
        x: cellX + 10,
        y: boxY - 12,
        size: 7,
        font,
        color: rgb(0.18, 0.22, 0.28),
    });

    // Footer: tanggal + entitas.
    const dateText = `Makassar, ${indonesianLongDate(generatedAt)}`;
    page.drawText(dateText, {
        x: cellX + cellW - 10 - uWidth(font, dateText, 7.5),
        y: cellY + 30,
        size: 7.5,
        font,
        color: rgb(0.15, 0.18, 0.24),
    });
    page.drawText("CV. Surya Perkasa", {
        x: cellX + cellW - 10 - uWidth(bold, "CV. Surya Perkasa", 8),
        y: cellY + 14,
        size: 8,
        font: bold,
        color: rgb(0.08, 0.19, 0.3),
    });
}

async function buildCombinedClaimReceiptPdf(
    workflow: ClaimWorkflowRow,
    entries: CombinedReceiptEntry[],
    generatedAt: Date,
): Promise<Buffer> {
    const pdfDoc = await PDFDocument.create();
    pdfDoc.setTitle(`Kwitansi Claim Gabungan ${workflow.claimWorkflowNo}`);
    pdfDoc.setSubject(`Kwitansi Claim Gabungan - ${recipientName(workflow)}`);
    pdfDoc.setCreator("AccAPI Claim Workflow");
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

    const usableW = LS_PAGE_WIDTH - LS_MARGIN * 2;
    const usableH = LS_PAGE_HEIGHT - LS_MARGIN * 2;
    const cellW = (usableW - LS_GUTTER) / 2;
    const cellH = (usableH - LS_GUTTER) / 2;

    // Posisi sel grid 2x2 (urutan: kiri-atas, kanan-atas, kiri-bawah, kanan-bawah).
    const cellPositions = [
        { x: LS_MARGIN, y: LS_MARGIN + cellH + LS_GUTTER },
        { x: LS_MARGIN + cellW + LS_GUTTER, y: LS_MARGIN + cellH + LS_GUTTER },
        { x: LS_MARGIN, y: LS_MARGIN },
        { x: LS_MARGIN + cellW + LS_GUTTER, y: LS_MARGIN },
    ];

    const safeEntries = entries.length > 0 ? entries : [];
    for (let i = 0; i < safeEntries.length; i += 4) {
        const page = uppercasePageText(pdfDoc.addPage([LS_PAGE_WIDTH, LS_PAGE_HEIGHT]));
        const pageEntries = safeEntries.slice(i, i + 4);
        pageEntries.forEach((entry, idx) => {
            const pos = cellPositions[idx];
            drawMiniReceipt(
                page,
                font,
                bold,
                workflow,
                entry,
                pos.x,
                pos.y,
                cellW,
                cellH,
                generatedAt,
            );
        });
    }

    // Bila tidak ada entry, tetap buat 1 halaman kosong agar PDF valid.
    if (safeEntries.length === 0) {
        pdfDoc.addPage([LS_PAGE_WIDTH, LS_PAGE_HEIGHT]);
    }

    return Buffer.from(await pdfDoc.save());
}

/**
 * Generate Kwitansi gabungan workflow-level (A4 Landscape, 2x2 per page).
 * Disimpan di folder legacy receipts/ supaya `claim_workflow.receiptPdfPath`
 * menunjuk ke file gabungan ini sebagai source-of-truth kwitansi.
 */
export async function generateCombinedClaimReceiptPdf(
    workflow: ClaimWorkflowRow,
    entries: CombinedReceiptEntry[],
    generatedAt: Date,
) {
    const pdf = await buildCombinedClaimReceiptPdf(workflow, entries, generatedAt);
    if (pdf.byteLength === 0) throw new Error("Combined Claim Receipt PDF output is empty.");
    const directory = path.join(process.cwd(), "runtime", "claim-workflow", "receipts");
    await mkdir(directory, { recursive: true });
    const timestamp = formatDocumentTimestamp(generatedAt);
    const filePath = path.join(
        directory,
        `${safeFileName(workflow.claimWorkflowNo)}-receipt-combined-${timestamp}.pdf`,
    );
    await writeFile(filePath, pdf);
    return { filePath, pdf };
}
