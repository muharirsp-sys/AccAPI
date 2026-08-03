/*
 * Tujuan: Lihat detail run/penerima serta contoh atau unduhan file hasil sebelum email dikirim.
 * Caller: UI Laporan Harian (review opsional sebelum Send).
 * Dependensi: requirePermission, db/schema, FastAPI file endpoint, xlsx, file-review.
 * Main Functions: GET (ringkasan run, sample file, download workbook, atau download arsip ZIP).
 * Side Effects: DB read dan HTTP read workbook/arsip; tidak mengubah data.
 */
import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { reportRun, reportRunRecipient } from "@/db/schema";
import { requirePermission } from "@/lib/rbac/resolve";
import { buildReviewSample, isAllowedReviewFile } from "@/lib/laporan-harian/file-review";
import * as XLSX from "xlsx";

export const runtime = "nodejs";

function fastapiBase(): string {
    return process.env.NEXT_PUBLIC_FASTAPI_BASE_URL || "http://localhost:8000";
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ runId: string }> }) {
    const gate = await requirePermission(req, "laporan_harian.view");
    if (gate.response) return gate.response;

    const { runId } = await ctx.params;
    const [run] = await db.select().from(reportRun).where(eq(reportRun.id, runId)).limit(1);
    if (!run) return NextResponse.json({ error: "Run tidak ditemukan" }, { status: 404 });

    if (req.nextUrl.searchParams.get("download") === "all") {
        const archiveName = `${run.reportDate}_Laporan_Harian_Arsip.zip`;
        const archiveUrl = `${fastapiBase()}/laporan-harian/file?run=${encodeURIComponent(runId)}&name=${encodeURIComponent(archiveName)}`;
        const archiveResponse = await fetch(archiveUrl);
        if (!archiveResponse.ok) {
            return NextResponse.json({ error: "Arsip hasil belum tersedia" }, { status: 404 });
        }
        return new NextResponse(Buffer.from(await archiveResponse.arrayBuffer()), {
            headers: {
                "Content-Type": "application/zip",
                "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(archiveName)}`,
                "Cache-Control": "private, no-store",
            },
        });
    }

    const fileName = req.nextUrl.searchParams.get("file");
    if (fileName) {
        if (!isAllowedReviewFile(fileName, run.reportDate)) {
            return NextResponse.json({ error: "Nama file review tidak valid" }, { status: 400 });
        }
        const fileUrl = `${fastapiBase()}/laporan-harian/file?run=${encodeURIComponent(runId)}&name=${encodeURIComponent(fileName)}`;
        const fileResponse = await fetch(fileUrl);
        if (!fileResponse.ok) {
            return NextResponse.json({ error: "File hasil tidak ditemukan" }, { status: 404 });
        }
        const buffer = Buffer.from(await fileResponse.arrayBuffer());
        if (req.nextUrl.searchParams.get("download") === "1") {
            return new NextResponse(buffer, {
                headers: {
                    "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                    "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
                    "Cache-Control": "private, no-store",
                },
            });
        }

        const workbook = XLSX.read(buffer, { type: "buffer", cellDates: true, sheetRows: 26 });
        const sheetName = workbook.SheetNames[0];
        const matrix = sheetName
            ? XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets[sheetName], { header: 1, defval: null, raw: false })
            : [];
        return NextResponse.json({ fileName, sheetName, ...buildReviewSample(matrix) });
    }

    const recipients = await db.select().from(reportRunRecipient).where(eq(reportRunRecipient.runId, runId));
    return NextResponse.json({ run, recipients, totalRecipients: recipients.length });
}
