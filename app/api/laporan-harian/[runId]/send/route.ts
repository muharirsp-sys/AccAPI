/*
 * Tujuan: Kirim email laporan untuk 1 report_run secara gated ke semua atau penerima mapping yang dipilih.
 * Caller: UI Laporan Harian (tombol "Kirim" setelah review preview).
 * Dependensi: requirePermission("laporan_harian.send"), lib/email, send-state,
 *             FastAPI /laporan-harian/file (ambil file run-scoped), db/schema.
 * Main Functions: POST (claim, pilih semua/sebagian penerima mapping, kirim/retry, update status).
 * Side Effects: HTTP fetch file; kirim email; DB update report_run + report_run_recipient.
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
        recipientMode?: "all" | "selected";
        selectedRecipients?: Array<{ fileName?: unknown; email?: unknown }>;
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

    let recips = await db
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

    let skipped = 0;
    if (body.recipientMode === "selected") {
        const requestedRecipients = (body.selectedRecipients ?? []).flatMap((recipient) =>
            typeof recipient.fileName === "string" && typeof recipient.email === "string"
                ? [{ fileName: recipient.fileName, email: recipient.email }]
                : [],
        );
        const selectedKeys = new Set(
            requestedRecipients
                .map((recipient) => `${recipient.fileName}\u0000${recipient.email.trim().toLowerCase()}`),
        );
        const selected = recips.filter((recipient) =>
            selectedKeys.has(`${recipient.fileName ?? ""}\u0000${recipient.email.trim().toLowerCase()}`),
        );
        if (selected.length === 0) {
            await db.update(reportRun).set({ status: "failed" }).where(eq(reportRun.id, runId));
            return NextResponse.json({ error: "Pilih minimal satu penerima dari daftar mapping email." }, { status: 400 });
        }
        const selectedIds = new Set(selected.map((recipient) => recipient.id));
        const skippedIds = recips.filter((recipient) => !selectedIds.has(recipient.id)).map((recipient) => recipient.id);
        if (skippedIds.length) {
            await db.update(reportRunRecipient)
                .set({ sendStatus: "skipped", error: "Tidak dipilih saat pengiriman" })
                .where(inArray(reportRunRecipient.id, skippedIds));
            skipped = skippedIds.length;
        }
        recips = selected;
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
        emailsSkipped: skipped,
        files: byFile.size,
    });
}
