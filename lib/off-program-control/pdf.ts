import { stat, writeFile } from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import * as XLSX from "xlsx";
import { uppercasePageText } from "../pdf-text";
import type { OffBatchRow, OffItemRow } from "./types";
import {
  docsLabel,
  fitText,
  formatDateForPrint,
  formatIndonesianLongDate,
  formatPeriodForPrint,
  indonesianMonthName,
  money,
  sanitizePdfFileName,
  terbilangRupiah,
} from "./helpers";
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
  const baseWidthTotal = baseWidths.reduce(
    (totalWidth, width) => totalWidth + width,
    0,
  );
  const widths = baseWidths.map((width) =>
    Number(((width / baseWidthTotal) * contentWidth).toFixed(2)),
  );
  widths[widths.length - 1] += Number(
    (
      contentWidth - widths.reduce((totalWidth, width) => totalWidth + width, 0)
    ).toFixed(2),
  );
  const headers = [
    "No",
    "No Surat",
    "Nama Program",
    "Periode",
    "Toko",
    "Barang",
    "Nominal",
    "Cara Bayar",
    "Type",
    "Deadline",
    "Kelengkapan",
    "Others",
  ];
  const tableX = margin;
  const tableWidth = widths.reduce(
    (totalWidth, width) => totalWidth + width,
    0,
  );
  const summary = computeOffPaymentSummary(items);
  const total = summary.total;

  for (let page = 0; page < totalPages; page += 1) {
    const pdfPage = uppercasePageText(pdfDoc.addPage([pageWidth, pageHeight]));
    const pageItems = items.slice(page * rowsPerPage, (page + 1) * rowsPerPage);
    pdfPage.drawRectangle({
      x: 0,
      y: 0,
      width: pageWidth,
      height: pageHeight,
      color: rgb(0.96, 0.97, 0.98),
    });
    pdfPage.drawRectangle({
      x: margin,
      y: margin,
      width: contentWidth,
      height: pageHeight - margin * 2,
      borderWidth: 1.1,
      borderColor: rgb(0.05, 0.05, 0.05),
    });
    pdfPage.drawRectangle({
      x: margin,
      y: 520,
      width: contentWidth,
      height: 47,
      color: rgb(0.86, 0.9, 0.94),
    });
    pdfPage.drawText("SUMMARY PROGRAM OFF FAKTUR BEBAN PRINCIPLE", {
      x: margin + 20,
      y: 548,
      size: 13,
      font: bold,
      color: rgb(0.05, 0.08, 0.12),
    });
    pdfPage.drawText(
      "Dokumen ringkasan pengajuan program OFF - CV. Surya Perkasa",
      { x: margin + 20, y: 531, size: 7.5, font, color: rgb(0.18, 0.22, 0.3) },
    );
    pdfPage.drawText(`Page ${page + 1} / ${totalPages}`, {
      x: pageWidth - margin - 70,
      y: 548,
      size: 7.5,
      font,
      color: rgb(0.18, 0.22, 0.3),
    });

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
      pdfPage.drawText(fitText(value, 48), {
        x: margin + 108,
        y,
        size: 8,
        font,
      });
    });
    rightInfo.forEach(([label, value], index) => {
      const y = 494 - index * 16;
      pdfPage.drawText(label, { x: margin + 410, y, size: 7.5, font: bold });
      pdfPage.drawText(fitText(value, 38), {
        x: margin + 505,
        y,
        size: 8,
        font,
      });
    });

    pdfPage.drawRectangle({
      x: tableX,
      y: tableHeaderY,
      width: tableWidth,
      height: 20,
      color: rgb(0.12, 0.16, 0.22),
    });
    let x = tableX;
    headers.forEach((header, idx) => {
      pdfPage.drawRectangle({
        x,
        y: tableHeaderY,
        width: widths[idx],
        height: 20,
        borderWidth: 0.6,
        borderColor: rgb(1, 1, 1),
      });
      pdfPage.drawText(header, {
        x: x + 2.5,
        y: tableHeaderY + 12,
        size: 6,
        font: bold,
        color: rgb(1, 1, 1),
      });
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
        pdfPage.drawRectangle({
          x,
          y,
          width: widths[idx],
          height: rowHeight,
          borderWidth: 0.6,
          borderColor: rgb(0.25, 0.28, 0.33),
        });
        pdfPage.drawText(
          fitText(cell, Math.max(6, Math.floor(widths[idx] / 4))),
          {
            x: x + 2.5,
            y: y + rowHeight - 9.5,
            size: 5.9,
            font,
            color: rgb(0.04, 0.06, 0.09),
          },
        );
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
      pdfPage.drawText("Summary Pembayaran", {
        x: summaryX + 10,
        y: summaryY + 48,
        size: 8,
        font: bold,
      });
      pdfPage.drawText(`Total: ${money(summary.total)}`, {
        x: summaryX + 10,
        y: summaryY + 34,
        size: 7.8,
        font: bold,
      });
      pdfPage.drawText(`Transfer: ${money(summary.transfer)}`, {
        x: summaryX + 10,
        y: summaryY + 22,
        size: 7.2,
        font,
      });
      pdfPage.drawText(`Tunai: ${money(summary.tunai)}`, {
        x: summaryX + 10,
        y: summaryY + 10,
        size: 7.2,
        font,
      });

      const signY = margin + 10;
      const signWidth = 150;
      const signerGap = (contentWidth - signWidth * 3) / 4;
      const signers: Array<[string, number]> = [
        ["Sales Manager", margin + signerGap],
        ["Claim", margin + signerGap * 2 + signWidth],
        ["Operational Manager", margin + signerGap * 3 + signWidth * 2],
      ];
      signers.forEach(([label, sx]) => {
        pdfPage.drawRectangle({
          x: sx,
          y: signY,
          width: 150,
          height: 62,
          borderWidth: 0.8,
          borderColor: rgb(0.1, 0.1, 0.1),
        });
        pdfPage.drawText(label, {
          x: sx + 28,
          y: signY + 44,
          size: 8,
          font: bold,
        });
        pdfPage.drawText("(", { x: sx + 12, y: signY + 9, size: 10, font });
        pdfPage.drawText(")", { x: sx + 132, y: signY + 9, size: 10, font });
      });
    }
  }
  return Buffer.from(await pdfDoc.save());
}

async function uniquePdfPath(noPengajuan: string) {
  const dir = path.join(
    process.cwd(),
    "runtime",
    "off-program-control",
    "pdfs",
  );
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
  const dir = path.join(
    process.cwd(),
    "runtime",
    "off-program-control",
    "print-workbooks",
  );
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

async function uniqueReceiptPdfPath(noPengajuan: string) {
  const dir = path.join(
    process.cwd(),
    "runtime",
    "off-program-control",
    "receipts",
  );
  fs.mkdirSync(dir, { recursive: true });
  const baseName = sanitizePdfFileName(noPengajuan).replace(
    /\.pdf$/i,
    "-kwitansi.pdf",
  );
  let filePath = path.join(dir, baseName);
  try {
    await stat(filePath);
    const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
    filePath = path.join(dir, baseName.replace(/\.pdf$/i, `-${stamp}.pdf`));
  } catch {
    // file does not exist
  }
  return filePath;
}

async function uniquePaymentProofPdfPath(
  noPengajuan: string,
  batchId: string,
  paymentNo: number,
) {
  const dir = path.join(
    process.cwd(),
    "runtime",
    "off-program-control",
    "payment-proofs",
    batchId,
  );
  fs.mkdirSync(dir, { recursive: true });
  const baseName = sanitizePdfFileName(noPengajuan).replace(
    /\.pdf$/i,
    `-payment-${paymentNo}.pdf`,
  );
  let filePath = path.join(dir, baseName);
  try {
    await stat(filePath);
    const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
    filePath = path.join(dir, baseName.replace(/\.pdf$/i, `-${stamp}.pdf`));
  } catch {
    // file does not exist
  }
  return filePath;
}

type PaymentProofInput = {
  batch: OffBatchRow;
  paymentId: string;
  paymentNo: number;
  paymentDate: string;
  paymentMethod: string;
  paidAmount: number;
  senderBank?: string | null;
  note?: string | null;
  items: OffItemRow[];
  totalNominal: number;
  totalPaidAfter: number;
  remainingAmount: number;
  isFullyPaid: boolean;
  uploadedProofName?: string | null;
};

async function buildPaymentProofPdf(input: PaymentProofInput) {
  const pdfDoc = await PDFDocument.create();
  pdfDoc.setTitle(`Bukti Pembayaran ${input.batch.noPengajuan} #${input.paymentNo}`);
  pdfDoc.setSubject("Bukti Pembayaran OFF Program Control");
  pdfDoc.setCreator("AccAPI OFF Program Control");
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const pageWidth = 595.28;
  const pageHeight = 841.89;
  const margin = 36;
  const contentWidth = pageWidth - margin * 2;
  const rowHeight = 19;
  const rowsPerPage = 18;
  const totalPages = Math.max(1, Math.ceil(input.items.length / rowsPerPage));
  const printedAt = new Date().toLocaleString("id-ID", {
    timeZone: "Asia/Makassar",
  });

  const drawLabelValue = (
    page: ReturnType<typeof pdfDoc.addPage>,
    x: number,
    y: number,
    label: string,
    value: string,
    maxChars = 34,
  ) => {
    page.drawText(label, { x, y, size: 8, font: bold, color: rgb(0.2, 0.24, 0.32) });
    page.drawText(fitText(value || "-", maxChars), {
      x: x + 112,
      y,
      size: 8.5,
      font,
      color: rgb(0.06, 0.08, 0.12),
    });
  };

  for (let pageIndex = 0; pageIndex < totalPages; pageIndex += 1) {
    const page = pdfDoc.addPage([pageWidth, pageHeight]);
    const pageItems = input.items.slice(
      pageIndex * rowsPerPage,
      (pageIndex + 1) * rowsPerPage,
    );
    page.drawRectangle({
      x: 0,
      y: 0,
      width: pageWidth,
      height: pageHeight,
      color: rgb(0.97, 0.98, 0.99),
    });
    page.drawRectangle({
      x: margin,
      y: margin,
      width: contentWidth,
      height: pageHeight - margin * 2,
      borderWidth: 1,
      borderColor: rgb(0.12, 0.16, 0.22),
      color: rgb(1, 1, 1),
    });
    page.drawRectangle({
      x: margin,
      y: pageHeight - margin - 66,
      width: contentWidth,
      height: 66,
      color: rgb(0.08, 0.18, 0.3),
    });
    page.drawText("BUKTI PEMBAYARAN OFF", {
      x: margin + 18,
      y: pageHeight - margin - 28,
      size: 17,
      font: bold,
      color: rgb(1, 1, 1),
    });
    page.drawText(`No Pengajuan: ${fitText(input.batch.noPengajuan, 42)}`, {
      x: margin + 18,
      y: pageHeight - margin - 47,
      size: 9,
      font,
      color: rgb(0.86, 0.93, 1),
    });
    page.drawText(`Halaman ${pageIndex + 1} / ${totalPages}`, {
      x: pageWidth - margin - 92,
      y: pageHeight - margin - 28,
      size: 8,
      font,
      color: rgb(0.86, 0.93, 1),
    });

    let y = pageHeight - margin - 94;
    drawLabelValue(page, margin + 18, y, "Principal", input.batch.principleName, 38);
    drawLabelValue(page, margin + 300, y, "No Claim", input.batch.noClaim || "-", 18);
    y -= 16;
    drawLabelValue(page, margin + 18, y, "No Pembayaran", String(input.paymentNo), 20);
    drawLabelValue(page, margin + 300, y, "Tanggal Bayar", formatDateForPrint(input.paymentDate), 18);
    y -= 16;
    drawLabelValue(page, margin + 18, y, "Metode", input.paymentMethod, 22);
    drawLabelValue(page, margin + 300, y, "Bank Pengirim", input.senderBank || "-", 18);
    y -= 16;
    drawLabelValue(page, margin + 18, y, "Total Dibayar", money(input.paidAmount), 22);
    drawLabelValue(page, margin + 300, y, "Status", input.isFullyPaid ? "Lunas" : "Belum Lunas", 18);
    y -= 18;
    drawLabelValue(page, margin + 18, y, "Terbilang", terbilangRupiah(input.paidAmount), 66);
    y -= 16;
    drawLabelValue(page, margin + 18, y, "Sisa Pembayaran", money(input.remainingAmount), 22);
    drawLabelValue(page, margin + 300, y, "Total Batch", money(input.totalNominal), 18);
    y -= 16;
    drawLabelValue(page, margin + 18, y, "Dibuat", printedAt, 38);
    if (input.uploadedProofName) {
      drawLabelValue(page, margin + 300, y, "Lampiran", input.uploadedProofName, 18);
    }

    const tableY = y - 42;
    const widths = [28, 80, 152, 90, 74, 86];
    const headers = ["No", "No Surat", "Nama Program", "Toko", "Metode", "Nominal"];
    let x = margin + 18;
    page.drawRectangle({
      x,
      y: tableY,
      width: widths.reduce((sum, width) => sum + width, 0),
      height: 22,
      color: rgb(0.12, 0.16, 0.22),
    });
    headers.forEach((header, idx) => {
      page.drawText(header, {
        x: x + 4,
        y: tableY + 8,
        size: 7,
        font: bold,
        color: rgb(1, 1, 1),
      });
      x += widths[idx];
    });

    let rowY = tableY - rowHeight;
    pageItems.forEach((item) => {
      x = margin + 18;
      const row = [
        String(item.itemNo || "-"),
        item.noSurat || "-",
        item.namaProgram || "-",
        item.toko || "-",
        item.caraBayar || "-",
        money(Number(item.financePaidAmount || item.nominal || 0)),
      ];
      row.forEach((cell, idx) => {
        page.drawRectangle({
          x,
          y: rowY,
          width: widths[idx],
          height: rowHeight,
          borderWidth: 0.5,
          borderColor: rgb(0.78, 0.82, 0.88),
        });
        page.drawText(fitText(cell, idx === 2 ? 28 : idx === 3 ? 16 : 14), {
          x: x + 4,
          y: rowY + 7,
          size: 6.7,
          font,
          color: rgb(0.08, 0.1, 0.14),
        });
        x += widths[idx];
      });
      rowY -= rowHeight;
    });

    if (pageIndex === totalPages - 1) {
      const noteY = Math.max(margin + 104, rowY - 36);
      page.drawText("Catatan Keuangan", {
        x: margin + 18,
        y: noteY + 24,
        size: 8,
        font: bold,
        color: rgb(0.2, 0.24, 0.32),
      });
      receiptLines(input.note || "-", 82).forEach((line, lineIndex) => {
        page.drawText(fitText(line, 88), {
          x: margin + 18,
          y: noteY + 10 - lineIndex * 10,
          size: 7.5,
          font,
          color: rgb(0.08, 0.1, 0.14),
        });
      });
      page.drawText("Disetujui / Dibayar oleh Keuangan", {
        x: pageWidth - margin - 190,
        y: margin + 68,
        size: 8,
        font: bold,
        color: rgb(0.12, 0.16, 0.22),
      });
      page.drawLine({
        start: { x: pageWidth - margin - 190, y: margin + 42 },
        end: { x: pageWidth - margin - 42, y: margin + 42 },
        thickness: 0.7,
        color: rgb(0.12, 0.16, 0.22),
      });
    }
  }

  return Buffer.from(await pdfDoc.save());
}

function receiptLines(text: string, maxChars: number) {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  words.forEach((word) => {
    const next = line ? `${line} ${word}` : word;
    if (next.length > maxChars && line) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  });
  if (line) lines.push(line);
  return lines.slice(0, 2);
}

async function buildReceiptPdf(batch: OffBatchRow, items: OffItemRow[]) {
  const pdfDoc = await PDFDocument.create();
  pdfDoc.setTitle(`Kwitansi OFF ${batch.noPengajuan}`);
  pdfDoc.setSubject("Kwitansi OFF Program Control");
  pdfDoc.setCreator("AccAPI OFF Program Control");
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const pageWidth = 841.89;
  const pageHeight = 595.28;
  const margin = 22;
  const gap = 12;
  const cardWidth = (pageWidth - margin * 2 - gap) / 2;
  const cardHeight = (pageHeight - margin * 2 - gap) / 2;
  const printedDate = formatIndonesianLongDate();
  const period = `${indonesianMonthName(batch.bulan)} ${batch.tahun}`;

  items.forEach((item, index) => {
    if (index % 4 === 0) {
      const page = uppercasePageText(pdfDoc.addPage([pageWidth, pageHeight]));
      page.drawRectangle({
        x: 0,
        y: 0,
        width: pageWidth,
        height: pageHeight,
        color: rgb(0.98, 0.985, 0.99),
      });
    }
    const page = pdfDoc.getPages()[pdfDoc.getPageCount() - 1];
    const slot = index % 4;
    const column = slot % 2;
    const row = Math.floor(slot / 2);
    const x = margin + column * (cardWidth + gap);
    const y = pageHeight - margin - cardHeight - row * (cardHeight + gap);
    const innerX = x + 16;
    const rightX = x + cardWidth - 16;

    page.drawRectangle({
      x,
      y,
      width: cardWidth,
      height: cardHeight,
      color: rgb(1, 1, 1),
      borderWidth: 1,
      borderColor: rgb(0.2, 0.27, 0.37),
    });
    page.drawRectangle({
      x,
      y: y + cardHeight - 43,
      width: cardWidth,
      height: 43,
      color: rgb(0.08, 0.19, 0.32),
    });
    page.drawText("Kwitansi", {
      x: innerX,
      y: y + cardHeight - 28,
      size: 18,
      font: bold,
      color: rgb(1, 1, 1),
    });
    page.drawText(`No. Pengajuan: ${fitText(batch.noPengajuan, 34)}`, {
      x: innerX,
      y: y + cardHeight - 60,
      size: 8.5,
      font: bold,
      color: rgb(0.12, 0.16, 0.23),
    });

    const rows: Array<[string, string]> = [
      ["Telah diterima dari", batch.principleName],
      ["Terbilang", terbilangRupiah(item.nominal)],
      ["Untuk Pembayaran", `${item.namaProgram} - Periode ${period}`],
      ["No. Surat", item.noSurat || ""],
    ];
    let textY = y + cardHeight - 82;
    rows.forEach(([label, value]) => {
      page.drawText(label, {
        x: innerX,
        y: textY,
        size: 7.5,
        font: bold,
        color: rgb(0.25, 0.29, 0.36),
      });
      page.drawText(":", { x: innerX + 86, y: textY, size: 7.5, font: bold });
      const lines = receiptLines(value, 44);
      lines.forEach((line, lineIndex) => {
        page.drawText(fitText(line, 48), {
          x: innerX + 94,
          y: textY - lineIndex * 10,
          size: 8,
          font,
          color: rgb(0.07, 0.1, 0.16),
        });
      });
      textY -= lines.length > 1 ? 30 : 22;
    });

    page.drawText(`Tanggal: Makassar, ${printedDate}`, {
      x: rightX - 157,
      y: y + 75,
      size: 8,
      font,
      color: rgb(0.15, 0.18, 0.24),
    });
    page.drawText(fitText(`( ${item.toko || ""} )`, 36), {
      x: rightX - 128,
      y: y + 26,
      size: 9,
      font: bold,
      color: rgb(0.1, 0.13, 0.2),
    });

    // Kotak nominal tertutup (mengganti garis tunggal sebelumnya)
    const nominalBoxX = innerX - 4;
    const nominalBoxY = y + 36;
    const nominalBoxWidth = 168;
    const nominalBoxHeight = 26;
    page.drawRectangle({
      x: nominalBoxX,
      y: nominalBoxY,
      width: nominalBoxWidth,
      height: nominalBoxHeight,
      borderWidth: 1,
      borderColor: rgb(0.08, 0.19, 0.32),
      color: rgb(0.95, 0.97, 1),
    });
    page.drawText("Rp", {
      x: nominalBoxX + 8,
      y: nominalBoxY + 8,
      size: 12,
      font: bold,
      color: rgb(0.08, 0.19, 0.32),
    });
    page.drawText(Number(item.nominal || 0).toLocaleString("id-ID"), {
      x: nominalBoxX + 34,
      y: nominalBoxY + 7,
      size: 13,
      font: bold,
      color: rgb(0.08, 0.19, 0.32),
    });
  });

  return Buffer.from(await pdfDoc.save());
}

function setCell(ws: XLSX.WorkSheet, address: string, value: string | number) {
  const existing = ws[address] || {};
  ws[address] = {
    ...existing,
    t: typeof value === "number" ? "n" : "s",
    v: value,
  };
}

async function generatePrintWorkbook(batch: OffBatchRow, items: OffItemRow[]) {
  const templatePath = path.join(
    process.cwd(),
    "templates",
    "off-print-template.xlsx",
  );
  if (!fs.existsSync(templatePath)) {
    console.warn(
      `[OFF PDF WARNING] OFF print template not found, using manual fallback PDF: ${templatePath}`,
    );
    return null;
  }
  const buffer = fs.readFileSync(templatePath);
  const workbook = XLSX.read(buffer, { type: "buffer", cellStyles: true });
  const ws = workbook.Sheets.PRINT;
  if (!ws) throw new Error("Template sheet PRINT not found");
  const summary = computeOffPaymentSummary(items);
  const submitDate = new Date(batch.updatedAt)
    .toLocaleDateString("id-ID", {
      day: "2-digit",
      month: "long",
      year: "numeric",
    })
    .toUpperCase();
  const monthName = new Date(Number(batch.tahun), Number(batch.bulan) - 1, 1)
    .toLocaleDateString("id-ID", { month: "long" })
    .toUpperCase();

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
    fs.mkdirSync(
      path.join(process.cwd(), "runtime", "off-program-control", "pdfs"),
      { recursive: true },
    );
    const workbookBuffer = XLSX.write(workbook, {
      bookType: "xlsx",
      type: "buffer",
      cellStyles: true,
    });
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
      await execFileAsync(
        command,
        ["--headless", "--convert-to", "pdf", "--outdir", outDir, workbookPath],
        { windowsHide: true, timeout: 60000 },
      );
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
  if (data.items.length === 0)
    throw new Error("Cannot generate PDF: batch has no items");
  const workbookPath = await generatePrintWorkbook(data.batch, data.items);
  if (workbookPath) {
    const convertedPdfPath = await tryConvertWorkbookToPdf(workbookPath);
    if (convertedPdfPath) return convertedPdfPath;
  }

  const filePath = await uniquePdfPath(data.batch.noPengajuan);
  const pdf = await buildPdf(data.batch, data.items);
  if (pdf.byteLength === 0)
    throw new Error("Cannot generate PDF: output is empty");
  await writeFile(filePath, pdf);
  return filePath;
}

export async function generateOffBatchReceiptPdf(
  batchId: string,
  options: { persist?: boolean } = {},
) {
  const data = await getBatchWithItems(batchId);
  if (!data) throw new Error("Batch not found");
  if (data.items.length === 0)
    throw new Error("Cannot generate receipt PDF: batch has no items");
  const invalidItem = data.items.find(
    (item) =>
      Number(item.nominal || 0) <= 0 ||
      !String(item.toko || "").trim() ||
      !String(item.namaProgram || "").trim() ||
      !String(item.noSurat || "").trim(),
  );
  if (invalidItem)
    throw new Error(
      `Cannot generate receipt PDF: invalid item ${invalidItem.itemNo}`,
    );

  const pdf = await buildReceiptPdf(data.batch, data.items);
  if (pdf.byteLength === 0)
    throw new Error("Cannot generate receipt PDF: output is empty");
  if (!options.persist) return { pdf, filePath: null };

  const filePath = await uniqueReceiptPdfPath(data.batch.noPengajuan);
  await writeFile(filePath, pdf);
  return { pdf, filePath };
}

export async function generateOffPaymentProofPdf(input: PaymentProofInput) {
  const filePath = await uniquePaymentProofPdfPath(
    input.batch.noPengajuan,
    input.batch.id,
    input.paymentNo,
  );
  const pdf = await buildPaymentProofPdf(input);
  if (pdf.byteLength === 0)
    throw new Error("Cannot generate payment proof PDF: output is empty");
  await writeFile(filePath, pdf);
  const stats = await stat(filePath);
  if (stats.size <= 0)
    throw new Error("Cannot generate payment proof PDF: saved file is empty");
  return {
    filePath,
    fileName: path.basename(filePath),
    mime: "application/pdf",
    size: stats.size,
  };
}
