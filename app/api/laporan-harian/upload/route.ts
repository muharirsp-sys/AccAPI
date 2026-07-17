/*
 * Tujuan: Upload FIX LAP PENJ (+stock opsional) -> proses file SPV/SM/principal di FastAPI -> feed dashboard
 *         (sales_daily_progress, batch) + catat report_run + PREVIEW penerima email (DRY-RUN).
 *         TIDAK mengirim email. Kirim email = endpoint terpisah /send (Tahap 4, gated).
 * Caller: UI modul Laporan Harian (browser, multipart).
 * Dependensi: requirePermission, recipient aktif, FastAPI /laporan-harian/process, normalisasi ingest,
 *             db/schema (reportRun, reportRecipient, reportRunRecipient).
 * Main Functions: POST (proses + dry-run, simpan tanggal transaksi penjualan terakhir).
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

    // runId & tanggal dulu supaya FastAPI menyimpan file per-target run-scoped (dipakai saat /send)
    const runId = randomUUID();
    const reportDate = new Date().toISOString().slice(0, 10);
    let recips: (typeof reportRecipient.$inferSelect)[];
    try {
        recips = await db.select().from(reportRecipient).where(eq(reportRecipient.active, true));
    } catch (e) {
        return NextResponse.json(
            { error: "Gagal membaca mapping penerima laporan", detail: String(e) },
            { status: 500 },
        );
    }
    if (recips.length === 0) {
        return NextResponse.json(
            { error: "Mapping penerima laporan masih kosong. Sinkronkan mapping SPV, SM, dan Principal terlebih dahulu." },
            { status: 422 },
        );
    }

    // Teruskan ke FastAPI untuk diproses (pandas) + minta tulis file per target.
    const fwd = new FormData();
    if (penjualan instanceof File) fwd.append("penjualan", penjualan, penjualan.name || "penjualan.xlsx");
    if (retur instanceof File) fwd.append("retur", retur, retur.name || "retur.xlsx");
    if (fix instanceof File) fwd.append("fix", fix, fix.name || "fix.xlsx");
    if (stock instanceof File) fwd.append("stock", stock, stock.name || "stock.xlsx");
    fwd.append("run_id", runId);
    fwd.append("report_date", reportDate);
    fwd.append("write_files", "1");
    fwd.append("report_keywords", JSON.stringify(recips.map((recipient) => recipient.keyword)));

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
            keyword: String(file.keyword ?? ""),
            groupType: String(file.groupType ?? ""),
            fileName: String(file.fileName ?? ""),
            rows: Number(file.rows ?? 0),
            stockRows: Number(file.stockRows ?? 0),
        })).filter((file) => file.fileName)
        : [];
    const unmatchedReportKeywords = Array.isArray(result.unmatched_report_keywords)
        ? result.unmatched_report_keywords.map(String)
        : [];
    const processedReportDate = String(result.report_date ?? reportDate);
    const effectiveReportDate = /^\d{4}-\d{2}-\d{2}$/.test(processedReportDate)
        ? processedReportDate
        : reportDate;
    if (generatedFiles.length === 0) {
        return NextResponse.json(
            {
                error: "Tidak ada file laporan yang berhasil dibuat dari mapping aktif.",
                unmatchedReportKeywords,
            },
            { status: 422 },
        );
    }

    try {
        // Feed dashboard (batch, replace-per-periode). Idempotent.
        let fed = { deleted: false, inserted: 0 };
        if (month && year && progress.length) {
            fed = await replaceDailyProgressForPeriod(Number(month), Number(year), progress, gate.session.user.id);
        }

        // Exact keyword dari writer menghindari collision/typo alias seperti GODREJJ dan RECKIT.
        const recipientsByKeyword = new Map(
            recips.map((recipient) => [recipient.keyword.trim().toUpperCase(), recipient]),
        );
        const preview: { keyword: string; groupType: string; fileName: string; emails: string[] }[] = [];
        for (const file of generatedFiles) {
            const recipient = recipientsByKeyword.get(file.keyword.trim().toUpperCase());
            if (recipient) {
                preview.push({
                    keyword: recipient.keyword,
                    groupType: file.groupType,
                    fileName: file.fileName,
                    emails: splitEmails(recipient.emails),
                });
            }
        }
        const totalEmails = new Set(preview.flatMap((p) => p.emails)).size;

        // Catat report_run (status dry_run) + report_run_recipient (pending)
        const now = new Date();
        await db.insert(reportRun).values({
            id: runId,
            reportDate: effectiveReportDate,
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
            reportDate: effectiveReportDate,
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
            totalRecipients: totalEmails,
            unmatchedReportKeywords,
        });
    } catch (e) {
        return NextResponse.json(
            { error: "Proses FastAPI berhasil tapi gagal simpan ke database", detail: String(e) },
            { status: 500 },
        );
    }
}
