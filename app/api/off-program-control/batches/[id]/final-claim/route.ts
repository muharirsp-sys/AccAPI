/*
 * Tujuan: API verifikasi final Klaim setelah pembayaran Keuangan.
 * Caller: Halaman OFF Program Control tab Klaim.
 * Dependensi: Better Auth OFF session, Drizzle SQLite, checklist dokumen final, helper pembayaran OFF.
 * Main Functions: POST final-claim complete/remind.
 * Side Effects: DB write SQLite dan audit log OFF.
 */

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
  isOffPeriodClosedForBatch,
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
        { ok: false, error: "Anda tidak memiliki akses untuk melakukan tindakan ini." },
        { status: 401 },
      );
    if (!canActorPerformOffAction(actor, "claim_final"))
      return NextResponse.json(
        { ok: false, error: "Anda tidak memiliki akses final klaim." },
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
    const itemSummary = computeOffPaymentSummary(data.items);
    const paymentSummary = computeOffFinancePaymentSummary(
      itemSummary.total,
      data.payments,
    );
    if (!canOpenFinalClaim(data.batch)) {
      return NextResponse.json(
        { ok: false, error: "Pengajuan belum dibayar Keuangan." },
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
    const inputVerifiedAmount = body.verifiedAmount !== undefined && body.verifiedAmount !== null
      ? Number(body.verifiedAmount)
      : null;
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

    // Hitung selisih dana: jika Claim reviewer input verifiedAmount < totalPaid,
    // maka ada selisih yang perlu dikembalikan (refund).
    const effectiveVerifiedAmount = (inputVerifiedAmount !== null && Number.isFinite(inputVerifiedAmount) && inputVerifiedAmount >= 0)
      ? inputVerifiedAmount
      : paymentSummary.totalPaid;
    const overpaidAmount = Math.max(0, paymentSummary.totalPaid - effectiveVerifiedAmount);

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
        status: overpaidAmount > 0 ? "Overpaid - Pending Refund" : "Completed",
        finalStatus: overpaidAmount > 0 ? "Pending Refund" : "Completed",
        verifiedAmount: effectiveVerifiedAmount,
        refundStatus: overpaidAmount > 0 ? "Pending Refund" : "Not Applicable",
        refundAmount: overpaidAmount > 0 ? overpaidAmount : null,
        totalRefunded: 0,
        finalClaimNote: note,
        locked: true,
        updatedAt: now,
      })
      .where(eq(offBatch.id, id));

    await writeOffAudit({
      batchId: id,
      actor,
      action: overpaidAmount > 0 ? "final_claim_overpaid" : "complete",
      fromStatus: data.batch.finalStatus,
      toStatus: overpaidAmount > 0 ? "Pending Refund" : "Completed",
      note: overpaidAmount > 0
        ? `Realisasi klaim Rp ${effectiveVerifiedAmount.toLocaleString("id-ID")} lebih kecil dari dana keluar Rp ${paymentSummary.totalPaid.toLocaleString("id-ID")}. Selisih Rp ${overpaidAmount.toLocaleString("id-ID")} perlu dikembalikan. ${note}`.trim()
        : note,
      metadata: {
        totalPaid: paymentSummary.totalPaid,
        verifiedAmount: effectiveVerifiedAmount,
        overpaidAmount,
        paymentCount: data.payments.length,
        claimRefs: sanitizedClaimRefs,
      },
    });
    const updated = await getBatchWithItems(id);
    return NextResponse.json({
      ok: true,
      message: overpaidAmount > 0
        ? `Verifikasi selesai. Selisih dana Rp ${overpaidAmount.toLocaleString("id-ID")} perlu dikembalikan sebelum batch ditutup sebagai Completed.`
        : "Pengajuan selesai dan status menjadi Completed.",
      overpaidAmount,
      refundRequired: overpaidAmount > 0,
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
