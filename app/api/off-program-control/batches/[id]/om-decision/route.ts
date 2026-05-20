import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { offBatch } from "@/db/schema";
import { canActorPerformOffAction, getBatchWithItems, publicBatch, requireOffSession, writeOffAudit } from "@/lib/off-program-control";

type Context = { params: Promise<{ id: string }> };

function canDecideOm(batch: { smStatus: string; claimStatus: string; omStatus: string }) {
    if (batch.smStatus !== "Approved by SM") return "Batch belum Approved by SM.";
    if (batch.claimStatus !== "Approved") return "Batch belum Approved by Claim.";
    if (batch.omStatus !== "Waiting Approval") return "Batch tidak sedang menunggu approval OM.";
    return null;
}

export async function POST(request: Request, context: Context) {
    try {
        const actor = await requireOffSession();
        if (!actor) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
        if (!canActorPerformOffAction(actor, "om_approve") && !canActorPerformOffAction(actor, "om_cancel")) return NextResponse.json({ ok: false, error: "Role Anda tidak memiliki akses keputusan OM." }, { status: 403 });
        const { id } = await context.params;
        const data = await getBatchWithItems(id);
        if (!data) return NextResponse.json({ ok: false, error: "Batch not found" }, { status: 404 });
        const invalidReason = canDecideOm(data.batch);
        if (invalidReason) return NextResponse.json({ ok: false, error: invalidReason }, { status: 409 });

        const body = await request.json().catch(() => ({}));
        const action = String(body.action || body.decision || "approve");
        const note = String(body.note || "").trim();
        const now = new Date();

        if (action === "cancel") {
            if (!note) return NextResponse.json({ ok: false, error: "Catatan wajib diisi untuk cancel." }, { status: 400 });
            await db.update(offBatch).set({
                status: "Cancelled by OM",
                omStatus: "Cancelled",
                omNote: note,
                locked: true,
                updatedAt: now,
            }).where(eq(offBatch.id, id));
            await writeOffAudit({ batchId: id, actor, action: "om_cancel", fromStatus: data.batch.omStatus, toStatus: "Cancelled", note });
            const updated = await getBatchWithItems(id);
            return NextResponse.json({
                ok: true,
                message: "Pengajuan dibatalkan oleh Operational Manager.",
                batch: updated ? publicBatch(updated.batch) : null,
            });
        }

        if (action !== "approve") return NextResponse.json({ ok: false, error: "Action OM tidak valid." }, { status: 400 });
        await db.update(offBatch).set({
            status: "OM Approved",
            omStatus: "Approved",
            financeStatus: "Waiting Payment",
            omNote: note,
            locked: true,
            updatedAt: now,
        }).where(eq(offBatch.id, id));
        await writeOffAudit({ batchId: id, actor, action: "om_approve", fromStatus: data.batch.omStatus, toStatus: "Approved", note });
        const updated = await getBatchWithItems(id);
        return NextResponse.json({
            ok: true,
            message: "Pengajuan disetujui OM dan diteruskan ke Keuangan.",
            batch: updated ? publicBatch(updated.batch) : null,
        });
    } catch (error) {
        console.error("[OFF OM DECISION ERROR]", error);
        return NextResponse.json({ ok: false, error: "Gagal memproses keputusan OM." }, { status: 500 });
    }
}
