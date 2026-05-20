import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { db } from "@/lib/db";
import { offBatch, offPayment } from "@/db/schema";
import { canActorPerformOffAction, canProcessFinancePayment, computeOffFinancePaymentSummary, computeOffPaymentSummary, getBatchWithItems, normalizeOffPaymentMethod, parseCurrency, publicBatch, publicPayment, requireOffSession, writeOffAudit } from "@/lib/off-program-control";

type Context = { params: Promise<{ id: string }> };

function asNumber(value: unknown) {
    return parseCurrency(value);
}

function sanitizeFileName(value: string) {
    return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "payment-proof";
}

function proofMimeOk(type: string) {
    return ["application/pdf", "image/png", "image/jpeg", "image/jpg"].includes(type);
}

export async function POST(request: Request, context: Context) {
    try {
        const actor = await requireOffSession();
        if (!actor) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
        if (!canActorPerformOffAction(actor, "finance_payment")) return NextResponse.json({ ok: false, error: "Role Anda tidak memiliki akses pembayaran Keuangan." }, { status: 403 });
        const { id } = await context.params;
        const data = await getBatchWithItems(id);
        if (!data) return NextResponse.json({ ok: false, error: "Batch not found" }, { status: 404 });
        if (data.batch.smStatus !== "Approved by SM" || data.batch.claimStatus !== "Approved") {
            return NextResponse.json({ ok: false, error: "Batch belum lengkap approval SM dan Claim." }, { status: 409 });
        }
        if (data.batch.omStatus !== "Approved") {
            return NextResponse.json({ ok: false, error: "Batch belum Approved by OM." }, { status: 409 });
        }
        if (!canProcessFinancePayment(data.batch)) {
            return NextResponse.json({ ok: false, error: "Batch tidak sedang menunggu pembayaran Keuangan." }, { status: 409 });
        }

        const formData = await request.formData();
        const paymentDate = String(formData.get("paymentDate") || "").trim();
        const paidAmount = asNumber(formData.get("paidAmount"));
        const paymentMethodInput = String(formData.get("paymentMethod") || "").trim();
        const senderBank = String(formData.get("senderBank") || "").trim();
        const note = String(formData.get("note") || formData.get("financeNote") || "").trim();
        const proof = formData.get("paymentProof");

        if (!paymentDate) return NextResponse.json({ ok: false, error: "Tanggal bayar wajib diisi." }, { status: 400 });
        if (!paidAmount || paidAmount <= 0) return NextResponse.json({ ok: false, error: "Jumlah dibayar wajib lebih dari 0." }, { status: 400 });
        if (!paymentMethodInput) return NextResponse.json({ ok: false, error: "Metode pembayaran wajib diisi." }, { status: 400 });
        const paymentMethod = normalizeOffPaymentMethod(paymentMethodInput);
        if (!(proof instanceof File) || proof.size <= 0) return NextResponse.json({ ok: false, error: "Bukti pembayaran wajib diupload." }, { status: 400 });
        if (!proofMimeOk(proof.type)) return NextResponse.json({ ok: false, error: "File bukti pembayaran harus PDF/PNG/JPG/JPEG." }, { status: 400 });
        if (proof.size > 5 * 1024 * 1024) return NextResponse.json({ ok: false, error: "Ukuran file maksimal 5MB." }, { status: 400 });

        const itemSummary = computeOffPaymentSummary(data.items);
        const totalNominal = itemSummary.total;
        const existingPayments = data.payments;
        const totalPaidBefore = existingPayments.reduce((total, payment) => total + Number(payment.paidAmount || 0), 0);
        const totalPaidAfter = totalPaidBefore + paidAmount;
        if (totalPaidAfter > totalNominal) {
            return NextResponse.json({ ok: false, error: "Jumlah pembayaran melebihi total pengajuan." }, { status: 400 });
        }
        const paymentNo = existingPayments.reduce((maxNo, payment) => Math.max(maxNo, Number(payment.paymentNo || 0)), 0) + 1;
        const remainingAmount = totalNominal - totalPaidAfter;
        const isFullyPaid = remainingAmount === 0;
        const now = new Date();
        const proofDir = path.join(process.cwd(), "runtime", "off-program-control", "payment-proofs", id);
        fs.mkdirSync(proofDir, { recursive: true });
        const proofName = `${sanitizeFileName(data.batch.noPengajuan)}-${paymentNo}-${sanitizeFileName(proof.name)}`;
        const proofPath = path.join(proofDir, proofName);
        const proofBuffer = Buffer.from(await proof.arrayBuffer());
        fs.writeFileSync(proofPath, proofBuffer);
        const proofStats = fs.statSync(proofPath);
        if (proofStats.size <= 0) return NextResponse.json({ ok: false, error: "Gagal menyimpan bukti pembayaran." }, { status: 500 });
        const [payment] = await db.insert(offPayment).values({
            id: randomUUID(),
            batchId: id,
            paymentNo,
            paymentDate,
            paymentMethod,
            paidAmount,
            senderBank,
            paymentProofName: proof.name,
            paymentProofPath: proofPath,
            paymentProofMime: proof.type,
            paymentProofSize: proof.size,
            note,
            createdBy: actor.id,
            createdAt: now,
            updatedAt: now,
        }).returning();
        await db.update(offBatch).set({
            status: isFullyPaid ? "Finance Paid" : "Partial Paid",
            financeStatus: isFullyPaid ? "Paid" : "Partial Paid",
            finalStatus: isFullyPaid ? "Waiting Claim Final Verification" : "Not Started",
            financeNote: note,
            paymentDate,
            paidAmount: totalPaidAfter,
            updatedAt: now,
        }).where(eq(offBatch.id, id));
        await writeOffAudit({
            batchId: id,
            actor,
            action: "finance_payment_added",
            fromStatus: data.batch.financeStatus,
            toStatus: isFullyPaid ? "Paid" : "Partial Paid",
            note,
            metadata: { paymentNo, amount: paidAmount, method: paymentMethod, proofName: proof.name, totalPaidAfter, remainingAmount },
        });
        const updated = await getBatchWithItems(id);
        return NextResponse.json({
            ok: true,
            message: isFullyPaid
                ? "Pembayaran lunas dan dikirim ke Claim Final Verification."
                : "Pembayaran berhasil dicatat. Pengajuan masih Partial Paid di Keuangan.",
            batch: updated ? publicBatch(updated.batch) : null,
            payment: publicPayment(payment),
            payments: updated?.payments.map(publicPayment) || [],
            paymentSummary: updated ? computeOffFinancePaymentSummary(totalNominal, updated.payments) : { totalNominal, totalPaid: totalPaidAfter, remainingAmount, isFullyPaid },
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : "";
        if (message === "Jenis pembayaran hanya boleh Tunai atau Transfer.") {
            return NextResponse.json({ ok: false, error: message }, { status: 400 });
        }
        console.error("[OFF FINANCE PAYMENT ERROR]", error);
        return NextResponse.json({ ok: false, error: "Gagal mencatat pembayaran Keuangan." }, { status: 500 });
    }
}
