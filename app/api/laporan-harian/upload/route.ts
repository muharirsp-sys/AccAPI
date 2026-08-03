/*
 * Tujuan: Upload sumber laporan -> proses di FastAPI -> feed dashboard dan siapkan artefak review/arsip
 *         (sales_daily_progress, batch) + catat report_run + PREVIEW penerima email (DRY-RUN).
 *         TIDAK mengirim email. Kirim email = endpoint terpisah /send (Tahap 4, gated).
 * Caller: UI modul Laporan Harian (browser, multipart).
 * Dependensi: requirePermission, FastAPI /laporan-harian/process, normalisasi ingest,
 *             db/schema, default penerima laporan khusus.
 * Main Functions: POST (proses, simpan progress, dry-run penerima, kembalikan artefak download).
 * Side Effects: HTTP call ke FastAPI; DB write (report_run, report_run_recipient, sales_daily_progress).
 */
import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { reportRun, reportRecipient, reportRunRecipient } from "@/db/schema";
import { requirePermission } from "@/lib/rbac/resolve";
import {
    normalizeDailyProgressRows,
    type DailyProgressInputRow,
} from "@/lib/laporan-harian/progress-normalize";
import { replaceDailyProgressForPeriod } from "@/lib/laporan-harian/ingest";
import { withSpecialReportRecipients } from "@/lib/laporan-harian/default-recipients";

export const runtime = "nodejs";
export const maxDuration = 300;

function fastapiBase(): string {
    return process.env.NEXT_PUBLIC_FASTAPI_BASE_URL || "http://localhost:8000";
}

function splitEmails(raw: string): string[] {
    return raw.split(/[;,]/).map((e) => e.trim()).filter(Boolean);
}

export async function POST(req: NextRequest) {
    const gate = await requirePermission(req, "laporan_harian.upload");
    if (gate.response) return gate.response;

    let form: FormData;
    try {
        form = await req.formData();
    } catch {
        return NextResponse.json({ error: "Body harus multipart/form-data" }, { status: 400 });
    }
    // Model 3-file mentah Accurate: penjualan (wajib) + retur (opsional) + stock (opsional).
    // Backward-compat: masih menerima 'fix' (FIX LAP PENJ jadi) bila dikirim.
    const penjualan = form.get("penjualan");
    const retur = form.get("retur");
    const fix = form.get("fix");
    const stock = form.get("stock");
    if (!(penjualan instanceof File) && !(fix instanceof File)) {
        return NextResponse.json(
            { error: "Upload file 'penjualan' (rincian faktur INV) — retur & stock opsional." },
            { status: 400 },
        );
    }

    // runId & tanggal dulu supaya FastAPI menyimpan file per-SPV run-scoped (dipakai saat /send)
    const runId = randomUUID();
    const reportDate = new Date().toISOString().slice(0, 10);

    // Teruskan ke FastAPI untuk diproses (pandas) + minta tulis file per-SPV
    const fwd = new FormData();
    if (penjualan instanceof File) fwd.append("penjualan", penjualan, penjualan.name || "penjualan.xlsx");
    if (retur instanceof File) fwd.append("retur", retur, retur.name || "retur.xlsx");
    if (fix instanceof File) fwd.append("fix", fix, fix.name || "fix.xlsx");
    if (stock instanceof File) fwd.append("stock", stock, stock.name || "stock.xlsx");
    fwd.append("run_id", runId);
    fwd.append("report_date", reportDate);
    fwd.append("write_files", "1");

    let result: Record<string, unknown>;
    try {
        const resp = await fetch(`${fastapiBase()}/laporan-harian/process`, { method: "POST", body: fwd });
        result = await resp.json();
        if (!resp.ok || !result?.ok) {
            return NextResponse.json({ error: "Proses FastAPI gagal", detail: result?.error ?? null }, { status: 502 });
        }
    } catch (e) {
        return NextResponse.json({ error: "Tidak bisa menghubungi FastAPI backend", detail: String(e) }, { status: 502 });
    }

    const { month, year } = (result.period ?? {}) as { month?: number; year?: number };
    const rawProgress: DailyProgressInputRow[] = Array.isArray(result.progress) ? result.progress : [];
    const { rows: progress, unmapped: unmappedProgress } = normalizeDailyProgressRows(rawProgress);
    const generatedFiles = Array.isArray(result.files)
        ? (result.files as Array<Record<string, unknown>>).map((file) => ({
            spv: String(file.spv ?? ""),
            fileName: String(file.fileName ?? ""),
            rows: Number(file.rows ?? 0),
        })).filter((file) => file.fileName)
        : [];

    const toFormatFileName = String((result.to_format as Record<string, unknown> | null)?.fileName ?? "");
    const archiveFileName = String((result.archive as Record<string, unknown> | null)?.fileName ?? "");

    try {
        // Feed dashboard (batch, replace-per-periode). Idempotent.
        let fed = { deleted: false, inserted: 0 };
        if (month && year && progress.length) {
            fed = await replaceDailyProgressForPeriod(Number(month), Number(year), progress, gate.session.user.id);
        }

        // Preview penerima (DRY-RUN): match keyword report_recipient ke nama file per SPV (mirror logika lama).
        const recips = withSpecialReportRecipients(
            await db.select().from(reportRecipient).where(eq(reportRecipient.active, true)),
        );
        const preview: { keyword: string; spv: string; fileName: string; emails: string[] }[] = [];
        for (const generated of generatedFiles) {
            const { spv, fileName } = generated;
            const normalizedFileName = fileName.toLowerCase();
            for (const recipient of recips) {
                if (normalizedFileName.includes(recipient.keyword.toLowerCase())) {
                    preview.push({ keyword: recipient.keyword, spv, fileName, emails: splitEmails(recipient.emails) });
                }
            }
        }
        const totalEmails = new Set(preview.flatMap((p) => p.emails)).size;

        // Catat report_run (status dry_run) + report_run_recipient (pending)
        const now = new Date();
        await db.insert(reportRun).values({
            id: runId,
            reportDate,
            status: "dry_run",
            fileCount: generatedFiles.length,
            emailCount: totalEmails,
            salesRows: Number(result.sales_rows ?? 0),
            progressRows: progress.length,
            note: `feed dashboard: +${fed.inserted} baris (periode ${month}/${year}); unmapped sales: ${unmappedProgress.rows}`,
            uploadedBy: gate.session.user.id,
            createdAt: now,
        });
        if (preview.length) {
            const rows = preview.flatMap((p) =>
                p.emails.map((email) => ({
                    id: randomUUID(), runId, keyword: p.keyword, email, fileName: p.fileName,
                    sendStatus: "pending", error: null as string | null,
                })),
            );
            for (let i = 0; i < rows.length; i += 400) await db.insert(reportRunRecipient).values(rows.slice(i, i + 400));
        }

        return NextResponse.json({
            ok: true,
            runId,
            dryRun: true,
            message: "Proses selesai (DRY-RUN). Email BELUM dikirim. Review daftar penerima lalu panggil /send.",
            period: { month, year },
            dashboardFed: fed,
            unmappedProgress,
            salesRows: result.sales_rows,
            netDpp: result.net_dpp,
            summary: result.summary,
            recipientsPreview: preview,
            generatedFiles,
            toFormatFileName,
            archiveFileName,
            reportDate,
            totalRecipients: totalEmails,
        });
    } catch (e) {
        return NextResponse.json(
            { error: "Proses FastAPI berhasil tapi gagal simpan ke database", detail: String(e) },
            { status: 500 },
        );
    }
}
