import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { offBatch, offBatchItem } from "@/db/schema";
import {
  canActorPerformOffAction,
  canOpenFinalClaim,
  computeOffFinancePaymentSummary,
  computeOffPaymentSummary,
  getBatchWithItems,
  hasMinimalFinalChecklist,
  paymentsHaveProofs,
  publicBatch,
  requireOffSession,
  writeOffAudit,
} from "@/lib/off-program-control";

type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: Context) {
  try {
    const actor = await requireOffSession();
    if (!actor)
      return NextResponse.json(
        { ok: false, error: "Unauthorized" },
        { status: 401 },
      );
    if (!canActorPerformOffAction(actor, "claim_final"))
      return NextResponse.json(
        { ok: false, error: "Role Anda tidak memiliki akses final Claim." },
        { status: 403 },
      );
    const { id } = await context.params;
    const data = await getBatchWithItems(id);
    if (!data)
      return NextResponse.json(
        { ok: false, error: "Batch not found" },
        { status: 404 },
      );
    const itemSummary = computeOffPaymentSummary(data.items);
    const paymentSummary = computeOffFinancePaymentSummary(
      itemSummary.total,
      data.payments,
    );
    if (!canOpenFinalClaim(data.batch)) {
      return NextResponse.json(
        { ok: false, error: "Batch belum dibayar Keuangan." },
        { status: 409 },
      );
    }
    if (!paymentSummary.isFullyPaid) {
      return NextResponse.json(
        {
          ok: false,
          error: "Pembayaran belum lunas, belum bisa di-approve Claim.",
        },
        { status: 409 },
      );
    }

    const body = await request.json().catch(() => ({}));
    const action = String(body.action || body.decision || "complete");
    const note = String(body.note || body.finalClaimNote || "").trim();
    const claimRefs = Array.isArray(body.claimRefs) ? body.claimRefs : [];
    const now = new Date();

    if (action === "remind_incomplete_documents") {
      if (!note)
        return NextResponse.json(
          {
            ok: false,
            error:
              "Catatan Final Claim wajib diisi untuk mengirim pengingat kelengkapan belum lengkap.",
          },
          { status: 400 },
        );
      await db
        .update(offBatch)
        .set({
          status: "Paid",
          financeStatus: "Paid",
          finalStatus: "Incomplete Documents",
          finalClaimNote: note,
          locked: true,
          updatedAt: now,
        })
        .where(eq(offBatch.id, id));
      await writeOffAudit({
        batchId: id,
        actor,
        action: "final_remind_incomplete_documents",
        fromStatus: data.batch.finalStatus,
        toStatus: "Incomplete Documents",
        note,
        metadata: {
          totalPaid: paymentSummary.totalPaid,
          totalNominal: paymentSummary.totalNominal,
        },
      });
      const updated = await getBatchWithItems(id);
      return NextResponse.json({
        ok: true,
        message:
          "Pengingat kelengkapan ditampilkan di web untuk Sales Manager dan Supervisor/SPV. Batch tetap menunggu final Claim.",
        batch: updated ? publicBatch(updated.batch) : null,
      });
    }

    if (action !== "complete")
      return NextResponse.json(
        { ok: false, error: "Action Final Claim tidak valid." },
        { status: 400 },
      );
    if (data.payments.length === 0)
      return NextResponse.json(
        {
          ok: false,
          error: "Pembayaran belum lunas, belum bisa di-approve Claim.",
        },
        { status: 409 },
      );
    if (!paymentsHaveProofs(data.payments)) {
      return NextResponse.json(
        {
          ok: false,
          error: "Semua pembayaran wajib memiliki bukti pembayaran.",
        },
        { status: 400 },
      );
    }
    if (paymentSummary.totalPaid !== paymentSummary.totalNominal) {
      return NextResponse.json(
        {
          ok: false,
          error: "Pembayaran belum lunas, belum bisa di-approve Claim.",
        },
        { status: 409 },
      );
    }

    type ClaimRef = {
      itemId: string;
      noSurat: string;
      noClaim: string;
      finalKwt: boolean;
      finalSkp: boolean;
      finalFp: boolean;
      finalPc: boolean;
      finalFoto: boolean;
      finalRekap: boolean;
      finalOthers: boolean;
      finalOthersText: string;
      finalCompletenessNote: string;
    };

    const sanitizedClaimRefs: ClaimRef[] = claimRefs.map(
      (ref: Record<string, unknown>) => ({
        itemId: String(ref.itemId || "").trim(),
        noSurat: String(ref.noSurat || "").trim(),
        noClaim: String(ref.noClaim || "").trim(),
        finalKwt: ref.finalKwt === true || ref.finalKwt === "true",
        finalSkp: ref.finalSkp === true || ref.finalSkp === "true",
        finalFp: ref.finalFp === true || ref.finalFp === "true",
        finalPc: ref.finalPc === true || ref.finalPc === "true",
        finalFoto: ref.finalFoto === true || ref.finalFoto === "true",
        finalRekap: ref.finalRekap === true || ref.finalRekap === "true",
        finalOthers: ref.finalOthers === true || ref.finalOthers === "true",
        finalOthersText: String(ref.finalOthersText || "").trim(),
        finalCompletenessNote: String(ref.finalCompletenessNote || "").trim(),
      }),
    );

    const claimRefMap = new Map<string, ClaimRef>(
      sanitizedClaimRefs.map((ref): [string, ClaimRef] => [ref.itemId, ref]),
    );

    // Validasi: setiap item yang punya noSurat wajib punya noClaim
    const missingNoClaim = data.items
      .filter((item) => String(item.noSurat || "").trim())
      .filter((item) => !claimRefMap.get(item.id)?.noClaim)
      .map((item) => String(item.noSurat || "").trim());

    if (missingNoClaim.length > 0) {
      return NextResponse.json(
        {
          ok: false,
          error: `No Claim wajib diisi untuk No Surat: ${missingNoClaim.join(", ")}`,
        },
        { status: 400 },
      );
    }

    // Validasi: setiap item minimal harus punya checklist final yang dianggap cukup
    const missingChecklist = data.items
      .filter((item) => String(item.noSurat || "").trim())
      .filter((item) => {
        const ref = claimRefMap.get(item.id);
        if (!ref) return true;
        return !hasMinimalFinalChecklist(ref);
      })
      .map((item) => String(item.noSurat || "").trim());

    if (missingChecklist.length > 0) {
      return NextResponse.json(
        {
          ok: false,
          error: `Checklist kelengkapan final wajib diisi minimal satu untuk No Surat: ${missingChecklist.join(", ")}`,
        },
        { status: 400 },
      );
    }

    await Promise.all(
      data.items.map((item) => {
        const ref = claimRefMap.get(item.id);
        if (!ref) return Promise.resolve();

        return db
          .update(offBatchItem)
          .set({
            noClaim: ref.noClaim,
            finalKwt: ref.finalKwt,
            finalSkp: ref.finalSkp,
            finalFp: ref.finalFp,
            finalPc: ref.finalPc,
            finalFoto: ref.finalFoto,
            finalRekap: ref.finalRekap,
            finalOthers: ref.finalOthers,
            finalOthersText: ref.finalOthersText || null,
            finalCompletenessNote: ref.finalCompletenessNote || null,
            updatedAt: now,
          })
          .where(eq(offBatchItem.id, item.id));
      }),
    );

    await db
      .update(offBatch)
      .set({
        status: "Completed",
        finalStatus: "Completed",
        verifiedAmount: paymentSummary.totalPaid,
        finalClaimNote: note,
        locked: true,
        updatedAt: now,
      })
      .where(eq(offBatch.id, id));

    await writeOffAudit({
      batchId: id,
      actor,
      action: "complete",
      fromStatus: data.batch.finalStatus,
      toStatus: "Completed",
      note,
      metadata: {
        totalPaid: paymentSummary.totalPaid,
        paymentCount: data.payments.length,
        claimRefs: sanitizedClaimRefs,
      },
    });
    const updated = await getBatchWithItems(id);
    return NextResponse.json({
      ok: true,
      message: "Pengajuan selesai dan status menjadi Completed.",
      batch: updated ? publicBatch(updated.batch) : null,
    });
  } catch (error) {
    console.error("[OFF FINAL CLAIM ERROR]", error);
    return NextResponse.json(
      { ok: false, error: "Gagal memproses final verification Claim." },
      { status: 500 },
    );
  }
}
