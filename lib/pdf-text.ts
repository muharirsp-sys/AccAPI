/*
 * Tujuan: Helper agar SELURUH teks yang digambar ke halaman PDF otomatis UPPERCASE (CapsLock).
 * Caller: generator PDF OFF Program Control & Claim Workflow (pdf.ts, reconciliation-pdf.ts,
 *         pdf-receipt.ts, pdf-summary.ts).
 * Cara pakai: bungkus hasil pdfDoc.addPage([...]) -> uppercasePageText(pdfDoc.addPage([...])).
 * Dependensi: pdf-lib (tipe PDFPage). Tidak ada side effect lain.
 *
 * Catatan: Hanya argumen teks (string) pada page.drawText yang di-uppercase. drawRectangle,
 * drawImage, dsb. tidak terpengaruh. Aman dipanggil berulang (idempoten via penanda).
 */
import { rgb, type PDFFont, type PDFPage } from "pdf-lib";

const PATCHED = Symbol.for("accapi.pdf.uppercase.patched");

/**
 * Kop surat berbasis teks (tanpa logo) yang konsisten di seluruh dokumen PDF.
 * Menggambar nama perusahaan + deskriptor + garis pemisah, mengembalikan
 * koordinat Y tepat di bawah garis agar konten berikutnya bisa menyambung.
 */
export function drawTextLetterhead(
  page: PDFPage,
  fonts: { bold: PDFFont; regular: PDFFont },
  opts: { x: number; topY: number; width: number },
): number {
  const navy = rgb(0.08, 0.19, 0.3);
  const gray = rgb(0.35, 0.4, 0.46);
  page.drawText("CV. Surya Perkasa", {
    x: opts.x,
    y: opts.topY,
    size: 15,
    font: fonts.bold,
    color: navy,
  });
  page.drawText("Distributor Resmi - Makassar", {
    x: opts.x,
    y: opts.topY - 13,
    size: 8,
    font: fonts.regular,
    color: gray,
  });
  const lineY = opts.topY - 21;
  page.drawLine({
    start: { x: opts.x, y: lineY },
    end: { x: opts.x + opts.width, y: lineY },
    thickness: 1.2,
    color: navy,
  });
  return lineY;
}

export function uppercasePageText<T extends PDFPage>(page: T): T {
  const target = page as unknown as Record<PropertyKey, unknown>;
  if (target[PATCHED]) return page;

  const original = page.drawText.bind(page);
  page.drawText = ((text: string, options?: Parameters<PDFPage["drawText"]>[1]) => {
    const upper = typeof text === "string" ? text.toUpperCase() : text;
    return original(upper as string, options);
  }) as PDFPage["drawText"];

  target[PATCHED] = true;
  return page;
}
