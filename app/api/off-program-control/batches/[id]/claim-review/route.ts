/*
 * Tujuan: API tinjauan Klaim setelah persetujuan Sales Manager.
 * Caller: Halaman OFF Program Control tab Klaim.
 * Dependensi: Better Auth OFF session, Drizzle SQLite, helper workflow/data OFF.
 * Main Functions: POST claim_review untuk approve/return pengajuan.
 * Side Effects: DB write SQLite dan audit log OFF.
 */

import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { offBatch } from "@/db/schema";
import {
  canActorPerformOffAction,
  getBatchWithItems,
  isOffPeriodClosedForBatch,
  publicBatch,
  requireOffSession,
  writeOffAudit,
} from "@/lib/off-program-control";

type Context = { params: Promise<{ id: string }> };

function canReviewClaim(smStatus: string) {
  return smStatus === "Approved by SM";
}

export async function POST(request: Request, context: Context) {
  try {
    const actor = await requireOffSession();
    if (!actor)
      return NextResponse.json(
        { ok: false, error: "Anda tidak memiliki akses untuk melakukan tindakan ini." },
        { status: 401 },
      );
    if (!canActorPerformOffAction(actor, "claim_review"))
      return NextResponse.json(
        { ok: false, error: "Anda tidak memiliki akses untuk meninjau klaim." },
        { status: 403 },
      );
    const { id } = await context.params;
    const data = await getBatchWithItems(id);
    if (!data)
      return NextResponse.json(
        { ok: false, error: "Pengajuan tidak ditemukan." },
        { status: 404 },
      );
    if (actor.role !== "admin" && await isOffPeriodClosedForBatch(data.batch)) {
      return NextResponse.json(
        { ok: false, error: "Periode ini sudah ditutup dan tidak dapat diubah." },
        { status: 409 },
      );
    }
    if (!canReviewClaim(data.batch.smStatus)) {
      return NextResponse.json(
        { ok: false, error: "Pengajuan belum disetujui Sales Manager." },
        { status: 409 },
      );
    }

    const body = await request.json().catch(() => ({}));
    const action = String(body.action || body.decision || "approve");
    const note = String(body.note || body.claimNote || "").trim();
    const completenessStatus = String(body.completenessStatus || "").trim();
    const now = new Date();

    if (action === "return") {
      if (!note)
        return NextResponse.json(
          { ok: false, error: "Catatan klaim wajib diisi untuk pengembalian." },
          { status: 400 },
        );
      await db
        .update(offBatch)
        .set({
          status: "Returned by Claim",
          claimStatus: "Returned",
          claimNote: note,
          locked: false,
          updatedAt: now,
        })
        .where(eq(offBatch.id, id));
      await writeOffAudit({
        batchId: id,
        actor,
        action: "claim_return",
        fromStatus: data.batch.claimStatus,
        toStatus: "Returned",
        note,
        metadata: { completenessStatus },
      });
      const updated = await getBatchWithItems(id);
      return NextResponse.json({
        ok: true,
        message: "Pengajuan dikembalikan oleh Claim untuk diperbaiki.",
        batch: updated ? publicBatch(updated.batch) : null,
      });
    }

    if (action !== "approve")
      return NextResponse.json(
        { ok: false, error: "Action Claim tidak valid." },
        { status: 400 },
      );

    const claimSubmittedDate = String(body.claimSubmittedDate || "").trim();
    const claimDeadline = String(body.claimDeadline || "").trim();

    if (!claimSubmittedDate)
      return NextResponse.json(
        { ok: false, error: "Tanggal Diajukan wajib diisi." },
        { status: 400 },
      );
    if (!claimDeadline)
      return NextResponse.json(
        { ok: false, error: "Deadline Claim wajib diisi." },
        { status: 400 },
      );
    if (completenessStatus !== "Aman")
      return NextResponse.json(
        { ok: false, error: "Status Kelengkapan harus Aman untuk approve." },
        { status: 400 },
      );

    await db
      .update(offBatch)
      .set({
        status: "Claim Approved",
        claimStatus: "Approved",
        claimSubmittedDate,
        claimDeadline,
        claimNote: note,
        omStatus: "Waiting Approval",
        locked: true,
        updatedAt: now,
      })
      .where(eq(offBatch.id, id));

    await writeOffAudit({
      batchId: id,
      actor,
      action: "claim_approve",
      fromStatus: data.batch.claimStatus,
      toStatus: "Approved",
      note,
      metadata: { claimSubmittedDate, claimDeadline, completenessStatus },
    });
    const updated = await getBatchWithItems(id);
    return NextResponse.json({
      ok: true,
      message: "Claim menyetujui pengajuan dan meneruskan ke OM.",
      batch: updated ? publicBatch(updated.batch) : null,
    });
  } catch (error) {
    console.error("[OFF CLAIM REVIEW ERROR]", error);
    return NextResponse.json(
      { ok: false, error: "Gagal memproses validasi Claim." },
      { status: 500 },
    );
  }
}
