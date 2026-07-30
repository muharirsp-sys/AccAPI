/*
 * Tujuan: Kirim email laporan untuk 1 report_run secara gated.
 *         Mode trial hanya mengirim file terpilih ke allowlist internal tanpa mengubah penerima eksternal.
 *         Mode mapped mempertahankan state machine dry_run/failed -> sending -> sent/failed.
 * Caller: UI Laporan Harian (tombol "Kirim" setelah review preview).
 * Dependensi: requirePermission("laporan_harian.send"), lib/email, recipient-selection, send-state,
 *             FastAPI /laporan-harian/file (ambil file run-scoped), db/schema.
 * Main Functions: POST (trial internal terpilih atau claim/kirim/retry penerima mapping).
 * Side Effects: HTTP fetch file; kirim email; mode mapped mengubah report_run + report_run_recipient.
 */
import { NextRequest, NextResponse } from "next/server";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { reportRun, reportRunRecipient } from "@/db/schema";
import { requirePermission } from "@/lib/rbac/resolve";
import { sendEmail } from "@/lib/email";
import {
    canClaimReportRun,
    finalReportRunStatus,
    RETRYABLE_RECIPIENT_STATUSES,
} from "@/lib/laporan-harian/send-state";
import {
    internalRecipientAllowlist,
    selectRequestedFiles,
    validateInternalRecipients,
} from "@/lib/laporan-harian/recipient-selection";

export const runtime = "nodejs";
export const maxDuration = 300;

function fastapiBase(): string {
    return process.env.NEXT_PUBLIC_FASTAPI_BASE_URL || "http://localhost:8000";
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ runId: string }> }) {
    const gate = await requirePermission(req, "laporan_harian.send");
    if (gate.response) return gate.response;

    const { runId } = await ctx.params;
    let body: {
        confirm?: boolean;
        isClosing?: boolean;
        deliveryMode?: "trial" | "mapped";
        selectedFileNames?: string[];
        internalEmails?: string[];
    } = {};
    try { body = await req.json(); } catch { /* body opsional */ }

    // GATE 1: konfirmasi eksplisit wajib
    if (body?.confirm !== true) {
        return NextResponse.json(
            { error: "Konfirmasi wajib. Kirim body { \"confirm\": true } untuk mengirim email.", sent: 0 },
            { status: 400 },
        );
    }

    const [run] = await db.select().from(reportRun).where(eq(reportRun.id, runId)).limit(1);
    if (!run) return NextResponse.json({ error: "Run tidak ditemukan" }, { status: 404 });

    const fileCache = new Map<string, Buffer | null>();
    async function fetchFile(fileName: string): Promise<Buffer | null> {
        if (fileCache.has(fileName)) return fileCache.get(fileName)!;
        try {
            const url = `${fastapiBase()}/laporan-harian/file?run=${encodeURIComponent(runId)}&name=${encodeURIComponent(fileName)}`;
            const resp = await fetch(url);
            if (!resp.ok) { fileCache.set(fileName, null); return null; }
            const buf = Buffer.from(await resp.arrayBuffer());
            fileCache.set(fileName, buf);
            return buf;
        } catch {
            fileCache.set(fileName, null);
            return null;
        }
    }

    if (body.deliveryMode === "trial") {
        if (!canClaimReportRun(run.status)) {
            return NextResponse.json(
                { error: "Run ini sedang diproses atau sudah ditutup untuk pengiriman trial.", status: run.status },
                { status: 409 },
            );
        }
        const rows = await db
            .select({ fileName: reportRunRecipient.fileName })
            .from(reportRunRecipient)
            .where(eq(reportRunRecipient.runId, runId));
        const availableFiles = [...new Set(
            rows.map((row) => row.fileName).filter((fileName): fileName is string => Boolean(fileName)),
        )];
        const selectedFiles = selectRequestedFiles(availableFiles, body.selectedFileNames);
        const allowlist = internalRecipientAllowlist(
            process.env.LAPORAN_HARIAN_INTERNAL_EMAILS,
            gate.session.user.email,
        );
        const { recipients, rejected } = validateInternalRecipients(allowlist, body.internalEmails);
        if (rejected.length) {
            return NextResponse.json(
                { error: `Alamat berikut bukan penerima internal yang diizinkan: ${rejected.join(", ")}` },
                { status: 400 },
            );
        }
        if (!selectedFiles.length || !recipients.length) {
            return NextResponse.json(
                { error: "Pilih minimal satu file dan satu penerima internal.", sent: 0 },
                { status: 400 },
            );
        }

        const reportLabel = body.isClosing === true ? "Laporan Closing" : "Laporan Harian";
        let sent = 0, failed = 0;
        const errors: string[] = [];
        for (const fileName of selectedFiles) {
            const file = await fetchFile(fileName);
            const ok = !!file && await sendEmail({
                to: recipients,
                subject: `[Uji Coba Internal - ${reportLabel}] ${run.reportDate} - ${fileName}`,
                text: `Uji coba internal.\n\nBerikut ${reportLabel.toLowerCase()} tanggal ${run.reportDate}: ${fileName}.\nPenerima eksternal belum dikirimi email.`,
                attachments: file ? [{
                    filename: fileName,
                    content: file,
                    contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                }] : [],
            });
            if (ok) sent += recipients.length;
            else {
                failed += recipients.length;
                errors.push(`${fileName}: ${file ? "gagal kirim (cek SMTP)" : "file tidak ditemukan"}`);
            }
        }
        return NextResponse.json({
            ok: failed === 0,
            runId,
            status: failed === 0 ? "trial_sent" : "trial_failed",
            emailsSent: sent,
            emailsFailed: failed,
            files: selectedFiles.length,
            errors,
        }, { status: failed === 0 ? 200 : 502 });
    }

    const storedMode = run.note?.match(/email_mode:(closing|daily)/)?.[1];
    const requestedMode = body.isClosing === true ? "closing" : "daily";
    if (storedMode && storedMode !== requestedMode) {
        return NextResponse.json(
            { error: `Run ini sebelumnya dikirim sebagai laporan ${storedMode}. Pilihan tidak boleh diubah saat retry.` },
            { status: 409 },
        );
    }
    const emailMode = storedMode ?? requestedMode;
    // GATE 2: cegah dobel/concurrent send. Run gagal boleh di-retry.
    if (!canClaimReportRun(run.status)) {
        const error = run.status === "sent" ? "Run ini sudah pernah dikirim." : "Run ini sedang/tidak dapat dikirim.";
        return NextResponse.json({ error, status: run.status }, { status: 409 });
    }

    const claimed = await db
        .update(reportRun)
        .set({
            status: "sending",
            note: storedMode ? run.note : `${run.note ? `${run.note}; ` : ""}email_mode:${emailMode}`,
        })
        .where(and(eq(reportRun.id, runId), eq(reportRun.status, run.status)));
    if (claimed.rowCount !== 1) {
        return NextResponse.json({ error: "Status run berubah; muat ulang sebelum mengirim.", status: "conflict" }, { status: 409 });
    }

    const recips = await db
        .select()
        .from(reportRunRecipient)
        .where(and(
            eq(reportRunRecipient.runId, runId),
            inArray(reportRunRecipient.sendStatus, [...RETRYABLE_RECIPIENT_STATUSES]),
        ));
    if (recips.length === 0) {
        await db.update(reportRun).set({ status: "failed" }).where(eq(reportRun.id, runId));
        return NextResponse.json({ error: "Tidak ada penerima pending/gagal untuk run ini." }, { status: 400 });
    }

    // Group per fileName -> daftar email (1 email per file laporan, mirror alur lama)
    const byFile = new Map<string, { emails: string[]; ids: string[] }>();
    for (const r of recips) {
        const key = r.fileName || "";
        const g = byFile.get(key) || { emails: [], ids: [] };
        g.emails.push(r.email);
        g.ids.push(r.id);
        byFile.set(key, g);
    }

    let sent = 0, failed = 0;
    const reportLabel = emailMode === "closing" ? "Laporan Closing" : "Laporan Harian";
    for (const [fileName, grp] of byFile) {
        const file = await fetchFile(fileName);
        let ok = false, err: string | null = null;
        if (!file) {
            err = "file laporan tidak ditemukan di backend";
        } else {
            ok = await sendEmail({
                to: grp.emails,
                subject: `[${reportLabel}] ${run.reportDate} - ${fileName}`,
                text: `Halo,\n\nBerikut ${reportLabel.toLowerCase()} tanggal ${run.reportDate}: ${fileName}.\nDikirim otomatis oleh sistem AccAPI.\n\nTerima kasih.`,
                attachments: [{
                    filename: fileName,
                    content: file,
                    contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                }],
            });
            if (!ok) err = "gagal kirim (cek konfigurasi SMTP)";
        }
        for (const id of grp.ids) {
            await db.update(reportRunRecipient)
                .set({ sendStatus: ok ? "sent" : "failed", error: err })
                .where(eq(reportRunRecipient.id, id));
        }
        if (ok) sent += grp.emails.length; else failed += grp.emails.length;
    }

    const finalStatus = finalReportRunStatus(failed);
    await db.update(reportRun).set({ status: finalStatus }).where(eq(reportRun.id, runId));

    return NextResponse.json({
        ok: failed === 0,
        runId,
        status: finalStatus,
        emailsSent: sent,
        emailsFailed: failed,
        files: byFile.size,
    });
}
