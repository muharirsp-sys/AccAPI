import { readFile } from "node:fs/promises";
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { offBatch } from "@/db/schema";
import { db } from "@/lib/db";
import {
    canActorAccessOffData,
    canActorPerformOffAction,
    generateOffBatchReceiptPdf,
    getBatchWithItems,
    requireOffSession,
    writeOffAudit,
} from "@/lib/off-program-control";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

function canPrintWithoutSaving(batch: typeof offBatch.$inferSelect) {
    return !batch.locked && (
        batch.status === "Draft" ||
        batch.status === "Returned by SM" ||
        batch.status === "Returned by Claim" ||
        batch.smStatus === "Returned" ||
        batch.claimStatus === "Returned"
    );
}

function validateReceiptItems(data: Awaited<ReturnType<typeof getBatchWithItems>>) {
    if (!data) return "Batch not found";
    if (data.items.length === 0) return "Kwitansi tidak dapat dibuat: batch belum memiliki item.";
    for (const item of data.items) {
        if (Number(item.nominal || 0) <= 0) return `Kwitansi tidak dapat dibuat: nominal item ${item.itemNo} harus lebih dari 0.`;
        if (!String(item.toko || "").trim()) return `Kwitansi tidak dapat dibuat: toko item ${item.itemNo} wajib diisi.`;
        if (!String(item.namaProgram || "").trim()) return `Kwitansi tidak dapat dibuat: nama program item ${item.itemNo} wajib diisi.`;
        if (!String(item.noSurat || "").trim()) return `Kwitansi tidak dapat dibuat: no. surat item ${item.itemNo} wajib diisi.`;
    }
    return null;
}

export async function POST(_request: Request, context: Context) {
    try {
        const actor = await requireOffSession();
        if (!actor) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
        if (!canActorPerformOffAction(actor, "submit_batch")) {
            return NextResponse.json({ ok: false, error: "Hanya Supervisor atau Admin yang dapat membuat kwitansi OFF." }, { status: 403 });
        }

        const { id } = await context.params;
        const data = await getBatchWithItems(id);
        if (!data) return NextResponse.json({ ok: false, error: "Batch not found" }, { status: 404 });
        const validationError = validateReceiptItems(data);
        if (validationError) return NextResponse.json({ ok: false, error: validationError }, { status: 400 });

        const saved = !canPrintWithoutSaving(data.batch);
        const result = await generateOffBatchReceiptPdf(id, { persist: saved });
        const generatedAt = new Date();
        if (saved && result.filePath) {
            await db.update(offBatch).set({
                receiptPdfPath: result.filePath,
                receiptPdfStatus: "generated",
                receiptPdfGeneratedAt: generatedAt,
                updatedAt: generatedAt,
            }).where(eq(offBatch.id, id));
        }
        await writeOffAudit({
            batchId: id,
            actor,
            action: "receipt_pdf_generated",
            fromStatus: data.batch.receiptPdfStatus,
            toStatus: saved ? "generated" : data.batch.receiptPdfStatus,
            metadata: {
                receiptCount: data.items.length,
                saved,
                ...(result.filePath ? { receiptPdfPath: result.filePath } : {}),
            },
        });

        return new NextResponse(new Uint8Array(result.pdf), {
            headers: {
                "Content-Type": "application/pdf",
                "Content-Disposition": `inline; filename="${data.batch.noPengajuan.replace(/[^a-zA-Z0-9]+/g, "-")}-kwitansi.pdf"`,
            },
        });
    } catch (error) {
        console.error("[OFF RECEIPT PDF ERROR]", error);
        const message = error instanceof Error ? error.message : "Gagal membuat PDF kwitansi.";
        return NextResponse.json({ ok: false, error: message }, { status: 500 });
    }
}

export async function GET(_request: Request, context: Context) {
    const actor = await requireOffSession();
    if (!actor) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    if (!canActorAccessOffData(actor)) {
        return NextResponse.json({ ok: false, error: "Role Anda tidak memiliki akses OFF Program Control." }, { status: 403 });
    }

    const { id } = await context.params;
    const data = await getBatchWithItems(id);
    if (!data) return NextResponse.json({ ok: false, error: "Batch not found" }, { status: 404 });
    if (!data.batch.receiptPdfPath) return NextResponse.json({ ok: false, error: "PDF kwitansi belum pernah disimpan." }, { status: 404 });

    try {
        const file = await readFile(data.batch.receiptPdfPath);
        return new NextResponse(new Uint8Array(file), {
            headers: {
                "Content-Type": "application/pdf",
                "Content-Disposition": `inline; filename="${data.batch.noPengajuan.replace(/[^a-zA-Z0-9]+/g, "-")}-kwitansi.pdf"`,
            },
        });
    } catch {
        return NextResponse.json({ ok: false, error: "File PDF kwitansi tidak ditemukan." }, { status: 404 });
    }
}
