/*
 * Tujuan: API pengembalian dana selisih (refund) saat realisasi klaim < dana yang dikeluarkan Finance.
 * Caller: Halaman OFF Program Control tab Finance/Claim.
 * Dependensi: Better Auth OFF session, Drizzle SQLite, helper OFF.
 * Main Functions: GET daftar refund per batch, POST submit refund, PATCH verify/reject refund.
 * Side Effects: DB read/write SQLite, audit log OFF, update refundStatus batch.
 */

import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { eq, and } from "drizzle-orm";
import { db } from "@/lib/db";
import { offBatch, offRefund } from "@/db/schema";
import {
    getBatchWithItems,
    computeOffFinancePaymentSummary,
    computeOffPaymentSummary,
    isOffPeriodClosedForBatch,
    requireOffSession,
    writeOffAudit,
} from "@/lib/off-program-control";
import { requirePermissionH, resolveRequestPermissionsH } from "@/lib/rbac/resolve";

type Context = { params: Promise<{ id: string }> };

function computeRefundSummary(
    paidAmount: number,
    verifiedAmount: number,
    refunds: Array<{ refundAmount: number; status: string }>,
) {
    const overpaidAmount = Math.max(0, paidAmount - verifiedAmount);
    const totalRefunded = refunds
        .filter((r) => r.status === "Verified")
        .reduce((sum, r) => sum + r.refundAmount, 0);
    const pendingRefund = refunds
        .filter((r) => r.status === "Pending")
        .reduce((sum, r) => sum + r.refundAmount, 0);
    const remainingRefund = Math.max(0, overpaidAmount - totalRefunded);
    const isFullyRefunded = overpaidAmount > 0 && remainingRefund <= 0;

    return {
        overpaidAmount,
        totalRefunded,
        pendingRefund,
        remainingRefund,
        isFullyRefunded,
    };
}

function resolveRefundStatus(overpaidAmount: number, totalRefunded: number): string {
    if (overpaidAmount <= 0) return "Not Applicable";
    if (totalRefunded >= overpaidAmount) return "Fully Refunded";
    if (totalRefunded > 0) return "Partially Refunded";
    return "Pending Refund";
}

export async function GET(_request: Request, context: Context) {
    const actor = await requireOffSession();
    if (!actor) {
        return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }
    const gate = await requirePermissionH("off_program_control.view");
    if (gate.response) return gate.response;

    const { id } = await context.params;
    const data = await getBatchWithItems(id);
    if (!data) {
        return NextResponse.json({ ok: false, error: "Batch tidak ditemukan." }, { status: 404 });
    }
    // Isolasi per-supervisor: SPV hanya boleh melihat refund batch miliknya sendiri.
    if (actor.role === "supervisor" && data.batch.createdBy !== actor.id) {
        return NextResponse.json({ ok: false, error: "Batch tidak ditemukan." }, { status: 404 });
    }

    const refunds = await db.select().from(offRefund).where(eq(offRefund.batchId, id));
    const itemSummary = computeOffPaymentSummary(data.items);
    const paymentSummary = computeOffFinancePaymentSummary(itemSummary.total, data.payments);
    const verifiedAmount = data.batch.verifiedAmount ?? paymentSummary.totalPaid;
    const paidAmount = paymentSummary.totalPaid;
    const summary = computeRefundSummary(paidAmount, verifiedAmount, refunds);

    return NextResponse.json({
        ok: true,
        refunds: refunds.map((r) => ({
            ...r,
            proofUrl: r.proofPath ? `/api/off-program-control/refunds/${r.id}/proof` : null,
        })),
        summary: {
            paidAmount,
            verifiedAmount,
            ...summary,
        },
    });
}

export async function POST(request: Request, context: Context) {
    const actor = await requireOffSession();
    if (!actor) {
        return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }
    const access = await resolveRequestPermissionsH();
    if (access.response) return access.response;
    const perms = access.perms!;
    // Supervisor atau Finance bisa submit refund
    const canSubmit =
        perms.has("off_program_control.submit_refund") ||
        perms.has("off_program_control.finance_payment") ||
        actor.role === "admin";
    if (!canSubmit) {
        return NextResponse.json({ ok: false, error: "Anda tidak memiliki akses untuk submit pengembalian dana." }, { status: 403 });
    }

    const { id } = await context.params;
    const data = await getBatchWithItems(id);
    if (!data) {
        return NextResponse.json({ ok: false, error: "Batch tidak ditemukan." }, { status: 404 });
    }
    // Isolasi per-supervisor: SPV hanya boleh submit refund untuk batch miliknya sendiri.
    if (actor.role === "supervisor" && data.batch.createdBy !== actor.id) {
        return NextResponse.json({ ok: false, error: "Batch tidak ditemukan." }, { status: 404 });
    }
    if (actor.role !== "admin" && await isOffPeriodClosedForBatch(data.batch)) {
        return NextResponse.json({ ok: false, error: "Periode ini sudah ditutup dan tidak dapat diubah." }, { status: 409 });
    }

    // Hanya batch yang sudah dibayar bisa refund
    const itemSummary = computeOffPaymentSummary(data.items);
    const paymentSummary = computeOffFinancePaymentSummary(itemSummary.total, data.payments);
    if (paymentSummary.totalPaid <= 0) {
        return NextResponse.json({ ok: false, error: "Batch belum ada pembayaran, tidak bisa submit refund." }, { status: 409 });
    }

    const body = await request.json().catch(() => ({}));
    const refundAmount = Number(body.refundAmount || 0);
    const refundMethod = String(body.refundMethod || "").trim();
    const refundDate = String(body.refundDate || "").trim();
    const senderName = String(body.senderName || "").trim();
    const receiverBank = String(body.receiverBank || "").trim();
    const note = String(body.note || "").trim();

    if (refundAmount <= 0) {
        return NextResponse.json({ ok: false, error: "Jumlah pengembalian harus lebih dari 0." }, { status: 400 });
    }
    if (!["Transfer", "Tunai", "Kompensasi Batch Lain"].includes(refundMethod)) {
        return NextResponse.json({ ok: false, error: "Metode pengembalian tidak valid. Pilih Transfer, Tunai, atau Kompensasi Batch Lain." }, { status: 400 });
    }
    if (!refundDate) {
        return NextResponse.json({ ok: false, error: "Tanggal pengembalian wajib diisi." }, { status: 400 });
    }

    // Hitung selisih existing
    const verifiedAmount = data.batch.verifiedAmount ?? paymentSummary.totalPaid;
    const overpaidAmount = Math.max(0, paymentSummary.totalPaid - verifiedAmount);
    const existingRefunds = await db.select().from(offRefund).where(eq(offRefund.batchId, id));
    const totalRefundedSoFar = existingRefunds
        .filter((r) => r.status === "Verified" || r.status === "Pending")
        .reduce((sum, r) => sum + r.refundAmount, 0);

    if (overpaidAmount <= 0) {
        return NextResponse.json({
            ok: false,
            error: "Tidak ada selisih dana yang perlu dikembalikan.",
        }, { status: 409 });
    }

    if (refundAmount + totalRefundedSoFar > overpaidAmount + 100) {
        // Toleransi 100 untuk pembulatan
        return NextResponse.json({
            ok: false,
            error: `Total pengembalian (Rp ${(refundAmount + totalRefundedSoFar).toLocaleString("id-ID")}) melebihi selisih yang harus dikembalikan (Rp ${overpaidAmount.toLocaleString("id-ID")}).`,
        }, { status: 400 });
    }

    const now = new Date();
    const refundNo = existingRefunds.length + 1;
    const refundId = randomUUID();

    await db.insert(offRefund).values({
        id: refundId,
        batchId: id,
        refundNo,
        refundAmount,
        refundMethod,
        refundDate,
        senderName: senderName || actor.name || null,
        receiverBank: receiverBank || null,
        note: note || null,
        status: "Pending",
        createdBy: actor.id,
        createdAt: now,
        updatedAt: now,
    });

    // Update batch refund status
    const newRefundStatus = resolveRefundStatus(overpaidAmount, totalRefundedSoFar);
    await db.update(offBatch).set({
        refundStatus: newRefundStatus,
        refundAmount: overpaidAmount,
        updatedAt: now,
    }).where(eq(offBatch.id, id));

    await writeOffAudit({
        batchId: id,
        actor,
        action: "submit_refund",
        note: `Pengembalian #${refundNo}: Rp ${refundAmount.toLocaleString("id-ID")} via ${refundMethod}. ${note}`.trim(),
        metadata: { refundId, refundAmount, refundMethod, refundDate },
    });

    return NextResponse.json({
        ok: true,
        message: `Pengembalian dana #${refundNo} sebesar Rp ${refundAmount.toLocaleString("id-ID")} berhasil disubmit. Menunggu verifikasi Finance.`,
        refundId,
    });
}

export async function PATCH(request: Request, context: Context) {
    const actor = await requireOffSession();
    if (!actor) {
        return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }
    const access = await resolveRequestPermissionsH();
    if (access.response) return access.response;
    const perms = access.perms!;
    // Hanya Finance atau Admin yang bisa verifikasi refund
    const canVerify =
        perms.has("off_program_control.finance_payment") || actor.role === "admin";
    if (!canVerify) {
        return NextResponse.json({ ok: false, error: "Hanya Finance atau Admin yang dapat memverifikasi pengembalian." }, { status: 403 });
    }

    const { id } = await context.params;
    const body = await request.json().catch(() => ({}));
    const refundId = String(body.refundId || "").trim();
    const action = String(body.action || "").trim();
    const verificationNote = String(body.note || "").trim();

    if (!refundId) {
        return NextResponse.json({ ok: false, error: "refundId wajib diisi." }, { status: 400 });
    }
    if (!["verify", "reject"].includes(action)) {
        return NextResponse.json({ ok: false, error: "Action harus 'verify' atau 'reject'." }, { status: 400 });
    }

    const data = await getBatchWithItems(id);
    if (!data) {
        return NextResponse.json({ ok: false, error: "Batch tidak ditemukan." }, { status: 404 });
    }
    if (actor.role !== "admin" && await isOffPeriodClosedForBatch(data.batch)) {
        return NextResponse.json({ ok: false, error: "Periode ini sudah ditutup dan tidak dapat diubah." }, { status: 409 });
    }

    const [refundRecord] = await db.select().from(offRefund)
        .where(and(eq(offRefund.id, refundId), eq(offRefund.batchId, id)));

    if (!refundRecord) {
        return NextResponse.json({ ok: false, error: "Data refund tidak ditemukan." }, { status: 404 });
    }
    if (refundRecord.status !== "Pending") {
        return NextResponse.json({ ok: false, error: `Refund sudah ${refundRecord.status}, tidak bisa diubah lagi.` }, { status: 409 });
    }

    const now = new Date();
    const newStatus = action === "verify" ? "Verified" : "Rejected";

    await db.update(offRefund).set({
        status: newStatus,
        verifiedBy: actor.id,
        verifiedAt: now,
        verificationNote: verificationNote || null,
        updatedAt: now,
    }).where(eq(offRefund.id, refundId));

    // Recalculate batch refund status
    if (data) {
        const allRefunds = await db.select().from(offRefund).where(eq(offRefund.batchId, id));
        const itemSummary = computeOffPaymentSummary(data.items);
        const paymentSummary = computeOffFinancePaymentSummary(itemSummary.total, data.payments);
        const verifiedAmount = data.batch.verifiedAmount ?? paymentSummary.totalPaid;
        const overpaidAmount = Math.max(0, paymentSummary.totalPaid - verifiedAmount);
        const totalRefunded = allRefunds
            .filter((r) => r.status === "Verified")
            .reduce((sum, r) => sum + r.refundAmount, 0);
        const newBatchRefundStatus = resolveRefundStatus(overpaidAmount, totalRefunded);

        // #17 Gap d: saat seluruh selisih terkonfirmasi (Fully Refunded),
        // transisi status batch ke Completed agar alur ditutup secara penuh.
        const batchStatusUpdate: Partial<typeof offBatch.$inferInsert> = {
            refundStatus: newBatchRefundStatus,
            totalRefunded,
            updatedAt: now,
        };
        if (newBatchRefundStatus === "Fully Refunded") {
            batchStatusUpdate.status = "Completed";
            batchStatusUpdate.finalStatus = "Fully Refunded";
        }
        await db.update(offBatch).set(batchStatusUpdate).where(eq(offBatch.id, id));

        // If fully refunded and batch was waiting, allow completion
        if (newBatchRefundStatus === "Fully Refunded") {
            await writeOffAudit({
                batchId: id,
                actor,
                action: "refund_settled",
                note: `Selisih dana telah dikembalikan seluruhnya (Rp ${totalRefunded.toLocaleString("id-ID")}). Status batch menjadi Completed.`,
                metadata: { totalRefunded, overpaidAmount },
            });
        }
    }

    await writeOffAudit({
        batchId: id,
        actor,
        action: action === "verify" ? "verify_refund" : "reject_refund",
        note: `Refund #${refundRecord.refundNo} ${action === "verify" ? "diverifikasi" : "ditolak"}. ${verificationNote}`.trim(),
        metadata: { refundId, refundAmount: refundRecord.refundAmount, action },
    });

    return NextResponse.json({
        ok: true,
        message: action === "verify"
            ? `Pengembalian #${refundRecord.refundNo} berhasil diverifikasi.`
            : `Pengembalian #${refundRecord.refundNo} ditolak.${verificationNote ? ` Alasan: ${verificationNote}` : ""}`,
    });
}
