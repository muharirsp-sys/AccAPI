import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { offBatch } from "@/db/schema";
import { getBatchWithItems, publicBatch, requireOffSession, writeOffAudit } from "@/lib/off-program-control";
import { requirePermissionH } from "@/lib/rbac/resolve";

type Context = { params: Promise<{ id: string }> };

function canReviewSm(status: string, smStatus: string) {
    return status === "Submitted to SM" || smStatus === "Waiting Review";
}

export async function POST(request: Request, context: Context) {
    try {
        const actor = await requireOffSession();
        if (!actor) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
        const gate = await requirePermissionH("off_program_control.sm_return");
        if (gate.response) return gate.response;
        const { id } = await context.params;
        const data = await getBatchWithItems(id);
        if (!data) return NextResponse.json({ ok: false, error: "Batch not found" }, { status: 404 });
        if (!canReviewSm(data.batch.status, data.batch.smStatus)) {
            return NextResponse.json({ ok: false, error: "Batch tidak lagi menunggu review Sales Manager." }, { status: 409 });
        }
        const body = await request.json().catch(() => ({}));
        const note = String(body.note || "").trim();
        if (!note) return NextResponse.json({ ok: false, error: "Catatan Sales Manager wajib diisi untuk return." }, { status: 400 });
        const now = new Date();
        await db.update(offBatch).set({
            status: "Returned by SM",
            smStatus: "Returned",
            smNote: note,
            locked: false,
            // Timestamp tahap return untuk deteksi SLA "Bermasalah" (#16).
            returnedAt: now,
            updatedAt: now,
        }).where(eq(offBatch.id, id));
        await writeOffAudit({ batchId: id, actor, action: "sm_return", fromStatus: data.batch.status, toStatus: "Returned by SM", note });
        const updated = await getBatchWithItems(id);
        return NextResponse.json({
            ok: true,
            message: "Pengajuan dikembalikan ke Supervisor.",
            batch: updated ? publicBatch(updated.batch) : null,
        });
    } catch (error) {
        console.error("[OFF SM RETURN ERROR]", error);
        return NextResponse.json({ ok: false, error: "Gagal mengembalikan pengajuan ke Supervisor." }, { status: 500 });
    }
}
