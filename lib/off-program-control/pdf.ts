import { stat, writeFile } from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import * as XLSX from "xlsx";
import type { OffBatchRow, OffItemRow } from "./types";
import { docsLabel, fitText, formatDateForPrint, formatPeriodForPrint, money, sanitizePdfFileName } from "./helpers";
import { computeOffPaymentSummary, normalizePaymentMethod } from "./payments";
import { getBatchWithItems } from "./data";

const execFileAsync = promisify(execFile);

async function buildPdf(batch: OffBatchRow, items: OffItemRow[]) {
    const pdfDoc = await PDFDocument.create();
    pdfDoc.setTitle(`OFF Program ${batch.noPengajuan}`);
    pdfDoc.setSubject("SUMMARY PROGRAM OFF FAKTUR BEBAN PRINCIPLE");
    pdfDoc.setCreator("AccAPI OFF Program Control");
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    const pageWidth = 841.89;
    const pageHeight = 595.28;
    const margin = 24;
    const contentWidth = pageWidth - margin * 2;
    const rowHeight = 23;
    const tableHeaderY = 382;
    const startY = 356;
    const rowsPerPage = 8;
    const totalPages = Math.max(1, Math.ceil(items.length / rowsPerPage));
    const baseWidths = [24, 68, 104, 56, 78, 74, 64, 60, 44, 56, 92, 74];
    const baseWidthTotal = baseWidths.reduce((totalWidth, width) => totalWidth + width, 0);
    const widths = baseWidths.map((width) => Number(((width / baseWidthTotal) * contentWidth).toFixed(2)));
    widths[widths.length - 1] += Number((contentWidth - widths.reduce((totalWidth, width) => totalWidth + width, 0)).toFixed(2));
    const headers = ["No", "No Surat", "Nama Program", "Periode", "Toko", "Barang", "Nominal", "Cara Bayar", "Type", "Deadline", "Kelengkapan", "Others"];
    const tableX = margin;
    const tableWidth = widths.reduce((totalWidth, width) => totalWidth + width, 0);
    const summary = computeOffPaymentSummary(items);
    const total = summary.total;

    for (let page = 0; page < totalPages; page += 1) {
        const pdfPage = pdfDoc.addPage([pageWidth, pageHeight]);
        const pageItems = items.slice(page * rowsPerPage, (page + 1) * rowsPerPage);
        pdfPage.drawRectangle({ x: 0, y: 0, width: pageWidth, height: pageHeight, color: rgb(0.96, 0.97, 0.98) });
        pdfPage.drawRectangle({ x: margin, y: margin, width: contentWidth, height: pageHeight - margin * 2, borderWidth: 1.1, borderColor: rgb(0.05, 0.05, 0.05) });
        pdfPage.drawRectangle({ x: margin, y: 520, width: contentWidth, height: 47, color: rgb(0.86, 0.9, 0.94) });
        pdfPage.drawText("SUMMARY PROGRAM OFF FAKTUR BEBAN PRINCIPLE", { x: margin + 20, y: 548, size: 13, font: bold, color: rgb(0.05, 0.08, 0.12) });
        pdfPage.drawText("Fallback PDF dari data sheet PRINT karena converter Excel tidak tersedia", { x: margin + 20, y: 531, size: 7.5, font, color: rgb(0.18, 0.22, 0.3) });
        pdfPage.drawText(`Page ${page + 1} / ${totalPages}`, { x: pageWidth - margin - 70, y: 548, size: 7.5, font, color: rgb(0.18, 0.22, 0.3) });

        const leftInfo: Array<[string, string]> = [
            ["No Pengajuan", batch.noPengajuan],
            ["Principle", batch.principleName],
            ["Kode Principle", batch.principleCode],
            ["Bulan/Tahun", `${batch.bulan}/${batch.tahun}`],
        ];
        const rightInfo: Array<[string, string]> = [
            ["Supervisor", batch.supervisorName],
            ["Tanggal Submit", new Date(batch.updatedAt).toLocaleString("id-ID")],
            ["Total Nominal", money(total)],
        ];
        leftInfo.forEach(([label, value], index) => {
            const y = 494 - index * 16;
            pdfPage.drawText(label, { x: margin + 18, y, size: 7.5, font: bold });
            pdfPage.drawText(fitText(value, 48), { x: margin + 108, y, size: 8, font });
        });
        rightInfo.forEach(([label, value], index) => {
            const y = 494 - index * 16;
            pdfPage.drawText(label, { x: margin + 410, y, size: 7.5, font: bold });
            pdfPage.drawText(fitText(value, 38), { x: margin + 505, y, size: 8, font });
        });

        pdfPage.drawRectangle({ x: tableX, y: tableHeaderY, width: tableWidth, height: 20, color: rgb(0.12, 0.16, 0.22) });
        let x = tableX;
        headers.forEach((header, idx) => {
            pdfPage.drawRectangle({ x, y: tableHeaderY, width: widths[idx], height: 20, borderWidth: 0.6, borderColor: rgb(1, 1, 1) });
            pdfPage.drawText(header, { x: x + 2.5, y: tableHeaderY + 12, size: 6, font: bold, color: rgb(1, 1, 1) });
            x += widths[idx];
        });

        let y = startY;
        pageItems.forEach((item) => {
            x = tableX;
            const row = [
                item.itemNo,
                item.noSurat || "-",
                item.namaProgram,
                formatPeriodForPrint(item.periode),
                item.toko || "-",
                item.barang || "-",
                money(item.nominal),
                item.caraBayar || "-",
                item.type || "-",
                formatDateForPrint(item.deadline),
                docsLabel(item),
                item.othersText || "-",
            ];
            row.forEach((cell, idx) => {
                pdfPage.drawRectangle({ x, y, width: widths[idx], height: rowHeight, borderWidth: 0.6, borderColor: rgb(0.25, 0.28, 0.33) });
                pdfPage.drawText(fitText(cell, Math.max(6, Math.floor(widths[idx] / 4))), {
                    x: x + 2.5,
                    y: y + rowHeight - 9.5,
                    size: 5.9,
                    font,
                    color: rgb(0.04, 0.06, 0.09),
                });
                x += widths[idx];
            });
            y -= rowHeight;
        });

        if (page === totalPages - 1) {
            const summaryX = margin + 16;
            const summaryY = 116;
            const summaryWidth = 250;
            const summaryHeight = 64;
            pdfPage.drawRectangle({
                x: summaryX,
                y: summaryY,
                width: summaryWidth,
                height: summaryHeight,
                borderWidth: 0.8,
                borderColor: rgb(0.15, 0.18, 0.24),
                color: rgb(0.93, 0.95, 0.98),
            });
            pdfPage.drawText("Summary Pembayaran", { x: summaryX + 10, y: summaryY + 48, size: 8, font: bold });
            pdfPage.drawText(`Total: ${money(summary.total)}`, { x: summaryX + 10, y: summaryY + 34, size: 7.8, font: bold });
            pdfPage.drawText(`Transfer: ${money(summary.transfer)}`, { x: summaryX + 10, y: summaryY + 22, size: 7.2, font });
            pdfPage.drawText(`Tunai: ${money(summary.tunai)}`, { x: summaryX + 10, y: summaryY + 10, size: 7.2, font });

            const signY = margin + 10;
            const signWidth = 150;
            const signerGap = (contentWidth - signWidth * 3) / 4;
            const signers: Array<[string, number]> = [
                ["Sales Manager", margin + signerGap],
                ["Claim", margin + signerGap * 2 + signWidth],
                ["Operational Manager", margin + signerGap * 3 + signWidth * 2],
            ];
            signers.forEach(([label, sx]) => {
                pdfPage.drawRectangle({ x: sx, y: signY, width: 150, height: 62, borderWidth: 0.8, borderColor: rgb(0.1, 0.1, 0.1) });
                pdfPage.drawText(label, { x: sx + 28, y: signY + 44, size: 8, font: bold });
                pdfPage.drawText("(", { x: sx + 12, y: signY + 9, size: 10, font });
                pdfPage.drawText(")", { x: sx + 132, y: signY + 9, size: 10, font });
            });
        }
    }
    return Buffer.from(await pdfDoc.save());
}

async function uniquePdfPath(noPengajuan: string) {
    const dir = path.join(process.cwd(), "runtime", "off-program-control", "pdfs");
    fs.mkdirSync(dir, { recursive: true });
    const baseName = sanitizePdfFileName(noPengajuan);
    let filePath = path.join(dir, baseName);
    try {
        await stat(filePath);
        const now = new Date();
        const stamp = [
            now.getFullYear(),
            String(now.getMonth() + 1).padStart(2, "0"),
            String(now.getDate()).padStart(2, "0"),
            "-",
            String(now.getHours()).padStart(2, "0"),
            String(now.getMinutes()).padStart(2, "0"),
            String(now.getSeconds()).padStart(2, "0"),
        ].join("");
        filePath = path.join(dir, baseName.replace(/\.pdf$/i, `-${stamp}.pdf`));
    } catch {
        // file does not exist
    }
    return filePath;
}

async function uniquePrintWorkbookPath(noPengajuan: string) {
    const dir = path.join(process.cwd(), "runtime", "off-program-control", "print-workbooks");
    fs.mkdirSync(dir, { recursive: true });
    const baseName = sanitizePdfFileName(noPengajuan).replace(/\.pdf$/i, ".xlsx");
    let filePath = path.join(dir, baseName);
    try {
        await stat(filePath);
        const now = new Date();
        const stamp = [
            now.getFullYear(),
            String(now.getMonth() + 1).padStart(2, "0"),
            String(now.getDate()).padStart(2, "0"),
            "-",
            String(now.getHours()).padStart(2, "0"),
            String(now.getMinutes()).padStart(2, "0"),
            String(now.getSeconds()).padStart(2, "0"),
        ].join("");
        filePath = path.join(dir, baseName.replace(/\.xlsx$/i, `-${stamp}.xlsx`));
    } catch {
        // file does not exist
    }
    return filePath;
}

function setCell(ws: XLSX.WorkSheet, address: string, value: string | number) {
    const existing = ws[address] || {};
    ws[address] = { ...existing, t: typeof value === "number" ? "n" : "s", v: value };
}

async function generatePrintWorkbook(batch: OffBatchRow, items: OffItemRow[]) {
    const templatePath = path.join(process.cwd(), "templates", "off-print-template.xlsx");
    if (!fs.existsSync(templatePath)) {
        throw new Error(`OFF print template not found: ${templatePath}`);
    }
    const buffer = fs.readFileSync(templatePath);
    const workbook = XLSX.read(buffer, { type: "buffer", cellStyles: true });
    const ws = workbook.Sheets.PRINT;
    if (!ws) throw new Error("Template sheet PRINT not found");
    const summary = computeOffPaymentSummary(items);
    const submitDate = new Date(batch.updatedAt).toLocaleDateString("id-ID", { day: "2-digit", month: "long", year: "numeric" }).toUpperCase();
    const monthName = new Date(Number(batch.tahun), Number(batch.bulan) - 1, 1).toLocaleDateString("id-ID", { month: "long" }).toUpperCase();

    setCell(ws, "A1", "SUMMARY PROGRAM OFF FAKTUR BEBAN PRINCIPLE");
    setCell(ws, "A2", `${batch.principleName} PERIODE`);
    setCell(ws, "H2", monthName);
    setCell(ws, "I2", Number(batch.tahun));
    setCell(ws, "C3", submitDate);
    setCell(ws, "M3", `(OFF PRINCIPLE ${batch.principleCode})`);

    for (let row = 8; row <= 200; row += 1) {
        for (let col = 0; col <= 13; col += 1) {
            const address = XLSX.utils.encode_cell({ r: row - 1, c: col });
            if (ws[address]) ws[address].v = "";
        }
    }

    items.forEach((item, index) => {
        const row = 8 + index;
        setCell(ws, `A${row}`, index + 1);
        setCell(ws, `B${row}`, batch.noPengajuan);
        setCell(ws, `C${row}`, item.namaProgram);
        setCell(ws, `D${row}`, item.noSurat || "-");
        setCell(ws, `E${row}`, formatPeriodForPrint(item.periode));
        setCell(ws, `F${row}`, item.toko || "-");
        setCell(ws, `G${row}`, item.barang || "-");
        setCell(ws, `H${row}`, "-");
        setCell(ws, `I${row}`, "-");
        setCell(ws, `J${row}`, normalizePaymentMethod(item.caraBayar));
        setCell(ws, `K${row}`, Number(item.nominal || 0));
        setCell(ws, `L${row}`, item.type || "-");
        setCell(ws, `M${row}`, docsLabel(item));
        setCell(ws, `N${row}`, formatDateForPrint(item.deadline));
    });

    const summaryRow = Math.max(17, 8 + items.length + 2);
    setCell(ws, `B${summaryRow - 1}`, `Makassar , ${submitDate}`);
    setCell(ws, `I${summaryRow}`, "Total");
    setCell(ws, `J${summaryRow}`, summary.total);
    setCell(ws, `I${summaryRow + 1}`, "Transfer");
    setCell(ws, `J${summaryRow + 1}`, summary.transfer);
    setCell(ws, `I${summaryRow + 2}`, "Tunai");
    setCell(ws, `J${summaryRow + 2}`, summary.tunai);
    setCell(ws, `B${summaryRow + 6}`, "SM");
    setCell(ws, `D${summaryRow + 6}`, "CLAIM");
    setCell(ws, `L${summaryRow + 6}`, "OPERATIONAL MANAGER");
    ws["!ref"] = `A1:N${summaryRow + 7}`;
    ws["!printHeader"] = undefined;

    const workbookPath = await uniquePrintWorkbookPath(batch.noPengajuan);
    try {
        fs.mkdirSync(path.dirname(workbookPath), { recursive: true });
        fs.mkdirSync(path.join(process.cwd(), "runtime", "off-program-control", "pdfs"), { recursive: true });
        const workbookBuffer = XLSX.write(workbook, { bookType: "xlsx", type: "buffer", cellStyles: true });
        fs.writeFileSync(workbookPath, workbookBuffer);
        if (!fs.existsSync(workbookPath)) {
            throw new Error("output file was not created");
        }
        const stats = fs.statSync(workbookPath);
        if (stats.size <= 0) {
            throw new Error("output file is empty");
        }
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`Cannot save generated print workbook: ${detail}`);
    }
    return workbookPath;
}

async function tryConvertWorkbookToPdf(workbookPath: string) {
    const outDir = path.dirname(workbookPath);
    const commands = ["soffice", "libreoffice"];
    for (const command of commands) {
        try {
            await execFileAsync(command, ["--headless", "--convert-to", "pdf", "--outdir", outDir, workbookPath], { windowsHide: true, timeout: 60000 });
            const pdfPath = workbookPath.replace(/\.xlsx$/i, ".pdf");
            const stats = await stat(pdfPath);
            if (stats.size > 0) return pdfPath;
        } catch {
            // try next converter
        }
    }
    return null;
}

export async function generateOffBatchPdf(batchId: string) {
    const data = await getBatchWithItems(batchId);
    if (!data) throw new Error("Batch not found");
    if (data.items.length === 0) throw new Error("Cannot generate PDF: batch has no items");
    const workbookPath = await generatePrintWorkbook(data.batch, data.items);
    const convertedPdfPath = await tryConvertWorkbookToPdf(workbookPath);
    if (convertedPdfPath) return convertedPdfPath;

    const filePath = await uniquePdfPath(data.batch.noPengajuan);
    const pdf = await buildPdf(data.batch, data.items);
    if (pdf.byteLength === 0) throw new Error("Cannot generate PDF: output is empty");
    await writeFile(filePath, pdf);
    return filePath;
}
