import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { offBatch, offNotification } from "@/db/schema";
import { getBatchWithItems, isOffPeriodClosedForBatch, publicBatch, requireOffSession, writeOffAudit } from "@/lib/off-program-control";
import { requirePermissionH } from "@/lib/rbac/resolve";

type Context = { params: Promise<{ id: string }> };

function canReviewSm(status: string, smStatus: string) {
    return status === "Submitted to SM" || smStatus === "Waiting Review";
}

export async function POST(request: Request, context: Context) {
    try {
        const actor = await requireOffSession();
        if (!actor) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
        const gate = await requirePermissionH("off_program_control.sm_approve");
        if (gate.response) return gate.response;
        const { id } = await context.params;
        const data = await getBatchWithItems(id);
        if (!data) return NextResponse.json({ ok: false, error: "Batch not found" }, { status: 404 });
        if (actor.role !== "admin" && await isOffPeriodClosedForBatch(data.batch)) {
            return NextResponse.json({ ok: false, error: "Periode ini sudah ditutup dan tidak dapat diubah." }, { status: 409 });
        }
        if (!canReviewSm(data.batch.status, data.batch.smStatus)) {
            return NextResponse.json({ ok: false, error: "Batch tidak lagi menunggu review Sales Manager." }, { status: 409 });
        }
        const body = await request.json().catch(() => ({}));
        const note = String(body.note || "");
        const now = new Date();
        const notification = {
            id: randomUUID(),
            batchId: id,
            type: "mock_om_email",
            to: "operational.manager@company.local",
            subject: "Pengajuan OFF Approved by SM",
            message: "Ada batch pengajuan OFF yang sudah disetujui Sales Manager dan siap ditinjau OM.",
            status: "sent_mock",
            createdAt: now,
        };
        await db.update(offBatch).set({
            status: "Approved by SM",
            smStatus: "Approved by SM",
            smNote: note,
            locked: true,
            omStatus: "Notify OM",
            // Timestamp tahap SM approve untuk deteksi SLA "Bermasalah" (#16).
            smApprovedAt: now,
            updatedAt: now,
        }).where(eq(offBatch.id, id));
        await db.insert(offNotification).values(notification);
        await writeOffAudit({ batchId: id, actor, action: "sm_approve", fromStatus: data.batch.status, toStatus: "Approved by SM", note });
        await writeOffAudit({ batchId: id, actor, action: "mock_notification_created", toStatus: "Notify OM", metadata: { to: notification.to } });
        const updated = await getBatchWithItems(id);
        return NextResponse.json({
            ok: true,
            message: "Pengajuan disetujui Sales Manager dan notifikasi OM dibuat.",
            batch: updated ? publicBatch(updated.batch) : null,
            notification,
        });
    } catch (error) {
        console.error("[OFF SM APPROVE ERROR]", error);
        return NextResponse.json({ ok: false, error: "Gagal menyetujui pengajuan Sales Manager." }, { status: 500 });
    }
}
