/*
 * Tujuan: Generate PDF rekonsiliasi periode OFF Program Control.
 * Caller: API route /api/off-program-control/periods/reconciliation/route.ts
 * Dependensi: pdf-lib, drizzle, schema OFF.
 * Main Functions: generateReconciliationPdf.
 * Side Effects: DB read untuk fetch batch data.
 */

import { and, asc, eq } from "drizzle-orm";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { db } from "@/lib/db";
import { offBatch, offBatchItem } from "@/db/schema";
import { fitText, indonesianMonthName, money } from "./helpers";

export interface ReconciliationRow {
    // Daftar No. Pengajuan yang tergabung dalam satu No. Claim (mis. "PGJ-001, PGJ-002").
    noPengajuan: string;
    toko: string;
    nilaiPengajuan: number;
    noClaim: string;
    nilaiClaim: number;
    selisih: number;
}

export interface ReconciliationData {
    principleName: string;
    principleCode: string;
    bulan: string;
    tahun: string;
    rows: ReconciliationRow[];
    totalPengajuan: number;
    totalClaim: number;
    totalSelisih: number;
    generatedAt: string;
}

/**
 * Fetch reconciliation data for a given principal + period.
 */
export async function fetchReconciliationData(principleCode: string, bulan: string, tahun: string): Promise<ReconciliationData | null> {
    const batches = await db
        .select()
        .from(offBatch)
        .where(and(
            eq(offBatch.principleCode, principleCode),
            eq(offBatch.bulan, bulan),
            eq(offBatch.tahun, tahun),
        ))
        .orderBy(asc(offBatch.noPengajuan));

    if (batches.length === 0) return null;

    // Akumulator grouping per No. Claim. Key:
    //  - No. Claim terisi  -> key = noClaim (batch dengan claim sama digabung)
    //  - No. Claim kosong   -> key unik per batch ("__empty__<id>") agar tetap terpisah
    interface ReconciliationGroup {
        noClaim: string;
        noPengajuanList: string[];
        tokoSet: Set<string>;
        nilaiPengajuan: number;
        nilaiClaim: number;
    }
    const groups = new Map<string, ReconciliationGroup>();
    let totalPengajuan = 0;
    let totalClaim = 0;

    for (const batch of batches) {
        // Sum nominal dari items (nilai pengajuan per batch)
        const items = await db
            .select()
            .from(offBatchItem)
            .where(eq(offBatchItem.batchId, batch.id));

        const nilaiPengajuan = items.reduce((sum, item) => sum + Number(item.nominal || 0), 0);
        const nilaiClaim = Number(batch.verifiedAmount || batch.paidAmount || 0);

        // No Claim: prioritas batch-level, fallback ke item-level (ambil yang pertama terisi)
        const batchNoClaim = String(batch.noClaim || "").trim();
        const itemNoClaim = items
            .map((item) => String(item.noClaim || "").trim())
            .find((val) => val.length > 0) || "";
        const noClaim = batchNoClaim || itemNoClaim;
        const groupKey = noClaim.length > 0 ? noClaim : `__empty__${batch.id}`;

        let group = groups.get(groupKey);
        if (!group) {
            group = {
                noClaim: noClaim.length > 0 ? noClaim : "-",
                noPengajuanList: [],
                tokoSet: new Set<string>(),
                nilaiPengajuan: 0,
                nilaiClaim: 0,
            };
            groups.set(groupKey, group);
        }

        if (batch.noPengajuan) group.noPengajuanList.push(String(batch.noPengajuan));
        items.forEach((item) => {
            if (item.toko) group!.tokoSet.add(item.toko);
        });
        group.nilaiPengajuan += nilaiPengajuan;
        group.nilaiClaim += nilaiClaim;

        totalPengajuan += nilaiPengajuan;
        totalClaim += nilaiClaim;
    }

    const truncateList = (values: string[]): string => {
        const unique = Array.from(new Set(values.filter(Boolean)));
        if (unique.length === 0) return "-";
        return unique.length <= 2
            ? unique.join(", ")
            : `${unique.slice(0, 2).join(", ")} +${unique.length - 2}`;
    };

    const rows: ReconciliationRow[] = Array.from(groups.values()).map((group) => ({
        noPengajuan: truncateList(group.noPengajuanList),
        toko: truncateList(Array.from(group.tokoSet)),
        nilaiPengajuan: group.nilaiPengajuan,
        noClaim: group.noClaim,
        nilaiClaim: group.nilaiClaim,
        selisih: group.nilaiPengajuan - group.nilaiClaim,
    }));

    return {
        principleName: batches[0].principleName,
        principleCode,
        bulan,
        tahun,
        rows,
        totalPengajuan,
        totalClaim,
        totalSelisih: totalPengajuan - totalClaim,
        generatedAt: new Date().toLocaleString("id-ID", { timeZone: "Asia/Makassar" }),
    };
}

/**
 * Build reconciliation PDF buffer from prepared data.
 */
export async function buildReconciliationPdf(data: ReconciliationData): Promise<Buffer> {
    const pdfDoc = await PDFDocument.create();
    pdfDoc.setTitle(`Rekonsiliasi ${data.principleName} - ${indonesianMonthName(data.bulan)} ${data.tahun}`);
    pdfDoc.setSubject("REKONSILIASI PERIODE OFF PROGRAM CONTROL");
    pdfDoc.setCreator("AccAPI OFF Program Control");

    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

    const pageWidth = 841.89; // A4 Landscape
    const pageHeight = 595.28;
    const margin = 28;
    const contentWidth = pageWidth - margin * 2;

    // Column widths for table
    const colWidths = [30, 120, 160, 120, 115, 110, 105];
    const colWidthTotal = colWidths.reduce((s, w) => s + w, 0);
    const widths = colWidths.map((w) => (w / colWidthTotal) * contentWidth);
    // Adjust last column to fill remaining space
    const sumWidths = widths.reduce((s, w) => s + w, 0);
    widths[widths.length - 1] += contentWidth - sumWidths;

    const headers = ["No", "No. Claim", "No. Pengajuan", "Nama Toko", "Nilai Pengajuan", "Nilai Claim", "Selisih"];
    const rowHeight = 22;
    const rowsPerPage = 15;
    const totalPages = Math.max(1, Math.ceil(data.rows.length / rowsPerPage));

    for (let page = 0; page < totalPages; page++) {
        const pdfPage = pdfDoc.addPage([pageWidth, pageHeight]);
        const pageRows = data.rows.slice(page * rowsPerPage, (page + 1) * rowsPerPage);

        // Background
        pdfPage.drawRectangle({ x: 0, y: 0, width: pageWidth, height: pageHeight, color: rgb(0.98, 0.96, 0.93) });

        // Border
        pdfPage.drawRectangle({ x: margin, y: margin, width: contentWidth, height: pageHeight - margin * 2, borderWidth: 1, borderColor: rgb(0.6, 0.45, 0.2) });

        // Header banner
        pdfPage.drawRectangle({ x: margin, y: pageHeight - margin - 52, width: contentWidth, height: 52, color: rgb(0.44, 0.34, 0.14) });

        pdfPage.drawText("REKONSILIASI PERIODE OFF PROGRAM", {
            x: margin + 20, y: pageHeight - margin - 25, size: 14, font: bold, color: rgb(1, 0.96, 0.88),
        });
        pdfPage.drawText("Laporan Perbandingan Pengajuan vs Klaim Principal", {
            x: margin + 20, y: pageHeight - margin - 42, size: 8, font, color: rgb(0.92, 0.85, 0.7),
        });
        pdfPage.drawText(`Halaman ${page + 1} / ${totalPages}`, {
            x: pageWidth - margin - 90, y: pageHeight - margin - 25, size: 8, font, color: rgb(0.92, 0.85, 0.7),
        });

        // Info section
        const infoY = pageHeight - margin - 80;
        const leftInfo: [string, string][] = [
            ["Principal", `${data.principleName} (${data.principleCode})`],
            ["Periode", `${indonesianMonthName(data.bulan)} ${data.tahun}`],
            ["Dicetak", data.generatedAt],
        ];
        const rightInfo: [string, string][] = [
            ["Total Pengajuan", money(data.totalPengajuan)],
            ["Total Klaim", money(data.totalClaim)],
            ["Selisih", money(Math.abs(data.totalSelisih))],
        ];

        leftInfo.forEach(([label, value], i) => {
            const y = infoY - i * 16;
            pdfPage.drawText(label, { x: margin + 20, y, size: 8, font: bold, color: rgb(0.2, 0.15, 0.08) });
            pdfPage.drawText(": " + fitText(value, 55), { x: margin + 100, y, size: 8.5, font, color: rgb(0.15, 0.1, 0.05) });
        });

        rightInfo.forEach(([label, value], i) => {
            const y = infoY - i * 16;
            pdfPage.drawText(label, { x: margin + 450, y, size: 8, font: bold, color: rgb(0.2, 0.15, 0.08) });
            pdfPage.drawText(": " + value, { x: margin + 550, y, size: 8.5, font: bold, color: rgb(0.15, 0.1, 0.05) });
        });

        // Kesesuaian badge
        const matchLabel = data.totalSelisih === 0 ? "Data Sudah Sesuai" : "Ada Selisih";
        const matchColor = data.totalSelisih === 0 ? rgb(0.05, 0.5, 0.3) : rgb(0.7, 0.2, 0.1);
        pdfPage.drawText(matchLabel, {
            x: margin + 550, y: infoY - 54, size: 9, font: bold, color: matchColor,
        });

        // Table header
        const tableTopY = infoY - 82;
        pdfPage.drawRectangle({ x: margin, y: tableTopY, width: contentWidth, height: 22, color: rgb(0.44, 0.34, 0.14) });

        let x = margin;
        headers.forEach((header, idx) => {
            pdfPage.drawRectangle({ x, y: tableTopY, width: widths[idx], height: 22, borderWidth: 0.5, borderColor: rgb(0.6, 0.48, 0.25) });
            pdfPage.drawText(header, { x: x + 4, y: tableTopY + 7, size: 7, font: bold, color: rgb(1, 0.97, 0.9) });
            x += widths[idx];
        });

        // Table rows
        let rowY = tableTopY - rowHeight;
        pageRows.forEach((row, idx) => {
            const globalIdx = page * rowsPerPage + idx;
            const isEven = globalIdx % 2 === 0;
            const bgColor = isEven ? rgb(0.97, 0.94, 0.88) : rgb(0.99, 0.97, 0.93);

            pdfPage.drawRectangle({ x: margin, y: rowY, width: contentWidth, height: rowHeight, color: bgColor });

            const cells = [
                String(globalIdx + 1),
                row.noClaim,
                row.noPengajuan,
                row.toko,
                money(row.nilaiPengajuan),
                money(row.nilaiClaim),
                money(Math.abs(row.selisih)),
            ];

            x = margin;
            cells.forEach((cell, colIdx) => {
                pdfPage.drawRectangle({ x, y: rowY, width: widths[colIdx], height: rowHeight, borderWidth: 0.4, borderColor: rgb(0.7, 0.58, 0.35) });
                const textColor = colIdx === 6 && row.selisih !== 0 ? rgb(0.7, 0.15, 0.1) : rgb(0.12, 0.1, 0.06);
                const maxChars = Math.max(8, Math.floor(widths[colIdx] / 4.5));
                pdfPage.drawText(fitText(cell, maxChars), {
                    x: x + 4, y: rowY + 7, size: 7, font: colIdx === 6 && row.selisih !== 0 ? bold : font, color: textColor,
                });
                x += widths[colIdx];
            });
            rowY -= rowHeight;
        });

        // Totals row (only on last page)
        if (page === totalPages - 1) {
            const totalRowY = rowY;
            pdfPage.drawRectangle({ x: margin, y: totalRowY, width: contentWidth, height: rowHeight, color: rgb(0.92, 0.87, 0.78) });

            x = margin;
            const totalCells = [
                "",
                "",
                "",
                "TOTAL",
                money(data.totalPengajuan),
                money(data.totalClaim),
                money(Math.abs(data.totalSelisih)),
            ];
            totalCells.forEach((cell, colIdx) => {
                pdfPage.drawRectangle({ x, y: totalRowY, width: widths[colIdx], height: rowHeight, borderWidth: 0.4, borderColor: rgb(0.6, 0.48, 0.25) });
                if (cell) {
                    pdfPage.drawText(cell, { x: x + 4, y: totalRowY + 7, size: 7.5, font: bold, color: rgb(0.12, 0.1, 0.06) });
                }
                x += widths[colIdx];
            });

            // Footer
            pdfPage.drawText("Dokumen ini dicetak otomatis oleh sistem AccAPI OFF Program Control.", {
                x: margin + 20, y: margin + 16, size: 7, font, color: rgb(0.45, 0.38, 0.25),
            });
        }
    }

    return Buffer.from(await pdfDoc.save());
}

/**
 * High-level: fetch data + generate PDF for a period.
 */
export async function generateReconciliationPdf(principleCode: string, bulan: string, tahun: string): Promise<{ pdf: Buffer; fileName: string } | null> {
    const data = await fetchReconciliationData(principleCode, bulan, tahun);
    if (!data || data.rows.length === 0) return null;

    const pdf = await buildReconciliationPdf(data);
    const fileName = `Rekonsiliasi-${data.principleCode}-${indonesianMonthName(data.bulan)}-${data.tahun}.pdf`;

    return { pdf, fileName };
}
