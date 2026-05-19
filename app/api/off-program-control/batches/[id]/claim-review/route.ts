import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { offBatch } from "@/db/schema";
import { canActorPerformOffAction, getBatchWithItems, publicBatch, requireOffSession, writeOffAudit } from "@/lib/off-program-control";

type Context = { params: Promise<{ id: string }> };

function canReviewClaim(smStatus: string) {
    return smStatus === "Approved by SM";
}

export async function POST(request: Request, context: Context) {
    try {
        const actor = await requireOffSession();
        if (!actor) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
        if (!canActorPerformOffAction(actor, "claim_review")) return NextResponse.json({ ok: false, error: "Role Anda tidak memiliki akses review Claim." }, { status: 403 });
        const { id } = await context.params;
        const data = await getBatchWithItems(id);
        if (!data) return NextResponse.json({ ok: false, error: "Batch not found" }, { status: 404 });
        if (!canReviewClaim(data.batch.smStatus)) {
            return NextResponse.json({ ok: false, error: "Batch belum Approved by SM." }, { status: 409 });
        }

        const body = await request.json().catch(() => ({}));
        const action = String(body.action || body.decision || "approve");
        const note = String(body.note || body.claimNote || "").trim();
        const completenessStatus = String(body.completenessStatus || "").trim();
        const now = new Date();

        if (action === "return") {
            if (!note) return NextResponse.json({ ok: false, error: "Catatan Claim wajib diisi untuk return." }, { status: 400 });
            await db.update(offBatch).set({
                status: "Returned by Claim",
                claimStatus: "Returned",
                claimNote: note,
                locked: false,
                updatedAt: now,
            }).where(eq(offBatch.id, id));
            await writeOffAudit({ batchId: id, actor, action: "claim_return", fromStatus: data.batch.claimStatus, toStatus: "Returned", note, metadata: { completenessStatus } });
            const updated = await getBatchWithItems(id);
            return NextResponse.json({
                ok: true,
                message: "Pengajuan dikembalikan oleh Claim untuk diperbaiki.",
                batch: updated ? publicBatch(updated.batch) : null,
            });
        }

        if (action !== "approve") return NextResponse.json({ ok: false, error: "Action Claim tidak valid." }, { status: 400 });
        const noClaim = String(body.noClaim || "").trim();
        const claimSubmittedDate = String(body.claimSubmittedDate || "").trim();
        const claimDeadline = String(body.claimDeadline || "").trim();
        if (!noClaim) return NextResponse.json({ ok: false, error: "No Claim wajib diisi." }, { status: 400 });
        if (!claimSubmittedDate) return NextResponse.json({ ok: false, error: "Tanggal Diajukan wajib diisi." }, { status: 400 });
        if (!claimDeadline) return NextResponse.json({ ok: false, error: "Deadline Claim wajib diisi." }, { status: 400 });
        if (completenessStatus !== "Aman") return NextResponse.json({ ok: false, error: "Status Kelengkapan harus Aman untuk approve." }, { status: 400 });

        await db.update(offBatch).set({
            status: "Claim Approved",
            claimStatus: "Approved",
            noClaim,
            claimSubmittedDate,
            claimDeadline,
            claimNote: note,
            omStatus: "Waiting Approval",
            locked: true,
            updatedAt: now,
        }).where(eq(offBatch.id, id));
        await writeOffAudit({ batchId: id, actor, action: "claim_approve", fromStatus: data.batch.claimStatus, toStatus: "Approved", note, metadata: { noClaim, claimSubmittedDate, claimDeadline, completenessStatus } });
        const updated = await getBatchWithItems(id);
        return NextResponse.json({
            ok: true,
            message: "Claim menyetujui pengajuan dan meneruskan ke OM.",
            batch: updated ? publicBatch(updated.batch) : null,
        });
    } catch (error) {
        console.error("[OFF CLAIM REVIEW ERROR]", error);
        return NextResponse.json({ ok: false, error: "Gagal memproses validasi Claim." }, { status: 500 });
    }
}
