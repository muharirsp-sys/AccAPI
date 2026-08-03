/*
 * Tujuan: Lihat detail run/penerima, preview JSON ringkas, atau stream unduhan file sebelum email dikirim.
 * Caller: UI Laporan Harian (review opsional sebelum Send).
 * Dependensi: requirePermission, db/schema, FastAPI preview/file endpoint, file-review.
 * Main Functions: GET (ringkasan run, sample JSON, atau proxy download streaming/range).
 * Side Effects: DB read dan HTTP streaming/read; tidak mengubah data.
 */
import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { reportRun, reportRunRecipient } from "@/db/schema";
import { requirePermission } from "@/lib/rbac/resolve";
import { buildReviewSample, isAllowedReviewFile } from "@/lib/laporan-harian/file-review";

export const runtime = "nodejs";

function fastapiBase(): string {
    return process.env.NEXT_PUBLIC_FASTAPI_BASE_URL || "http://localhost:8000";
}

async function backendError(response: Response): Promise<string | null> {
    try {
        const payload = await response.json() as { error?: unknown };
        return typeof payload.error === "string" ? payload.error : null;
    } catch {
        return null;
    }
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ runId: string }> }) {
    const gate = await requirePermission(req, "laporan_harian.view");
    if (gate.response) return gate.response;

    const { runId } = await ctx.params;
    const [run] = await db.select().from(reportRun).where(eq(reportRun.id, runId)).limit(1);
    if (!run) return NextResponse.json({ error: "Run tidak ditemukan" }, { status: 404 });

    const fileName = req.nextUrl.searchParams.get("file");
    if (fileName) {
        if (!isAllowedReviewFile(fileName, run.reportDate)) {
            return NextResponse.json({ error: "Nama file review tidak valid" }, { status: 400 });
        }
        const query = `run=${encodeURIComponent(runId)}&name=${encodeURIComponent(fileName)}`;
        const isDownload = req.nextUrl.searchParams.get("download") === "1";
        const endpoint = isDownload ? "file" : "preview";
        const requestHeaders = new Headers();
        const range = req.headers.get("range");
        if (isDownload && range) requestHeaders.set("range", range);

        try {
            const response = await fetch(
                `${fastapiBase()}/laporan-harian/${endpoint}?${query}`,
                { cache: "no-store", headers: requestHeaders },
            );
            if (!response.ok) {
                const detail = await backendError(response);
                return NextResponse.json(
                    { error: detail || (response.status === 404 ? "File hasil tidak ditemukan" : "Backend laporan tidak merespons dengan benar") },
                    { status: response.status === 404 ? 404 : 502 },
                );
            }

            if (isDownload) {
                if (!response.body) {
                    return NextResponse.json({ error: "Backend tidak mengirim isi file" }, { status: 502 });
                }
                const headers = new Headers({
                    "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                    "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
                    "Cache-Control": "private, no-store",
                });
                for (const header of ["content-length", "content-range", "accept-ranges", "etag", "last-modified"]) {
                    const value = response.headers.get(header);
                    if (value) headers.set(header, value);
                }
                return new NextResponse(response.body, { status: response.status, headers });
            }

            const payload = await response.json() as { fileName?: string; sheetName?: string; matrix?: unknown[][] };
            const matrix = Array.isArray(payload.matrix) ? payload.matrix : [];
            return NextResponse.json({
                fileName: payload.fileName || fileName,
                sheetName: payload.sheetName || "",
                ...buildReviewSample(matrix),
            });
        } catch (error) {
            console.error("[laporan-harian/preview] Backend request gagal", error);
            return NextResponse.json(
                { error: "Review file gagal dimuat dari backend laporan" },
                { status: 502 },
            );
        }
    }

    const recipients = await db.select().from(reportRunRecipient).where(eq(reportRunRecipient.runId, runId));
    return NextResponse.json({ run, recipients, totalRecipients: recipients.length });
}
