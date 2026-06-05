/*
 * Tujuan: API submit pengajuan OFF Program Control ke Sales Manager dan generate PDF.
 * Caller: Form pengajuan Supervisor.
 * Dependensi: Better Auth OFF session, Drizzle SQLite, helper PDF/workflow OFF.
 * Main Functions: POST submit_batch.
 * Side Effects: DB write SQLite, audit log OFF, file I/O PDF.
 */

import { NextResponse } from "next/server";
import { stat } from "node:fs/promises";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { offBatch } from "@/db/schema";
import { canActorPerformOffAction, computeOffPaymentSummary, generateOffBatchPdf, getBatchWithItems, isOffPeriodClosedForBatch, publicBatch, requireOffSession, writeOffAudit } from "@/lib/off-program-control";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

export async function POST(_request: Request, context: Context) {
    try {
        const actor = await requireOffSession();
        if (!actor) return NextResponse.json({ ok: false, error: "Anda tidak memiliki akses untuk melakukan tindakan ini." }, { status: 401 });
        if (!canActorPerformOffAction(actor, "submit_batch")) {
            return NextResponse.json({ ok: false, error: "Role Anda tidak memiliki akses submit batch OFF." }, { status: 403 });
        }

        const { id } = await context.params;
        const data = await getBatchWithItems(id);
        if (!data) return NextResponse.json({ ok: false, error: "Pengajuan tidak ditemukan." }, { status: 404 });
        if (actor.role !== "admin" && await isOffPeriodClosedForBatch(data.batch)) {
            return NextResponse.json({ ok: false, error: "Periode ini sudah ditutup dan tidak dapat diubah." }, { status: 409 });
        }
        if (data.batch.locked) return NextResponse.json({ ok: false, error: "Pengajuan ini sudah terkunci." }, { status: 409 });
        if (!["Draft", "Returned by SM", "Returned by Claim"].includes(data.batch.status) && !["Returned"].includes(data.batch.smStatus) && !["Returned"].includes(data.batch.claimStatus)) {
            return NextResponse.json({ ok: false, error: "Batch hanya bisa disubmit saat Draft atau Returned/Rejected dan belum terkunci." }, { status: 409 });
        }
        if (data.items.length === 0) return NextResponse.json({ ok: false, error: "Cannot generate PDF: batch has no items" }, { status: 400 });
        const summary = computeOffPaymentSummary(data.items);

        const now = new Date();
        await db.update(offBatch).set({
            status: "Submitted to SM",
            smStatus: "Waiting Review",
            claimStatus: "Not Started",
            omStatus: "Not Started",
            financeStatus: "Not Started",
            finalStatus: "Not Started",
            locked: false,
            updatedAt: now,
        }).where(eq(offBatch.id, id));
        await writeOffAudit({ batchId: id, actor, action: "submit_to_sm", fromStatus: data.batch.status, toStatus: "Submitted to SM" });

        const pdfPath = await generateOffBatchPdf(id);
        const pdfStats = await stat(pdfPath);
        if (pdfStats.size <= 0) {
            return NextResponse.json({ ok: false, error: "Cannot generate PDF: output file is empty" }, { status: 500 });
        }
        const pdfGeneratedAt = new Date();
        await db.update(offBatch).set({
            pdfPath,
            pdfStatus: "generated",
            pdfGeneratedAt,
            updatedAt: pdfGeneratedAt,
        }).where(eq(offBatch.id, id));
        await writeOffAudit({ batchId: id, actor, action: "pdf_generated", fromStatus: data.batch.pdfStatus, toStatus: "generated", metadata: { pdfPath } });

        const updated = await getBatchWithItems(id);
        const batch = updated ? publicBatch(updated.batch) : publicBatch(data.batch);
        return NextResponse.json({
            ok: true,
            batchId: id,
            noPengajuan: data.batch.noPengajuan,
            pdfUrl: batch.pdfUrl,
            summary,
            batch,
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to submit OFF batch";
        console.error("[OFF SUBMIT ERROR]", error);
        return NextResponse.json({ ok: false, error: message }, { status: 500 });
    }
}
