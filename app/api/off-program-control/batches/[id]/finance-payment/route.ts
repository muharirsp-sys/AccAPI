import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import { offBatch, offBatchItem, offPayment } from "@/db/schema";
import { canProcessFinancePayment, computeOffFinancePaymentSummary, computeOffPaymentSummary, generateOffPaymentProofPdf, getBatchWithItems, isOffPeriodClosedForBatch, normalizeOffPaymentMethod, publicBatch, publicPayment, requireOffSession, writeOffAudit } from "@/lib/off-program-control";
import { requirePermissionH } from "@/lib/rbac/resolve";

type Context = { params: Promise<{ id: string }> };

function proofMimeOk(type: string) {
    return ["application/pdf", "image/png", "image/jpeg", "image/jpg"].includes(type);
}

function parseItemIds(formData: FormData) {
    const rawValues = formData.getAll("itemIds").flatMap((value) => {
        const text = String(value || "").trim();
        if (!text) return [];
        if (text.startsWith("[")) {
            try {
                const parsed = JSON.parse(text);
                return Array.isArray(parsed) ? parsed.map((item) => String(item || "").trim()) : [];
            } catch {
                return [];
            }
        }
        return text.split(",").map((item) => item.trim());
    });
    return Array.from(new Set(rawValues.filter(Boolean)));
}

export async function POST(request: Request, context: Context) {
    try {
        const actor = await requireOffSession();
        if (!actor) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
        const gate = await requirePermissionH("off_program_control.finance_payment");
        if (gate.response) return gate.response;
        const { id } = await context.params;
        const data = await getBatchWithItems(id);
        if (!data) return NextResponse.json({ ok: false, error: "Batch not found" }, { status: 404 });
        if (actor.role !== "admin" && await isOffPeriodClosedForBatch(data.batch)) {
            return NextResponse.json({ ok: false, error: "Periode ini sudah ditutup dan tidak dapat diubah." }, { status: 409 });
        }
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
        const senderBank = String(formData.get("senderBank") || "").trim();
        const note = String(formData.get("note") || formData.get("financeNote") || "").trim();
        const proof = formData.get("paymentProof");
        const itemIds = parseItemIds(formData);

        if (!paymentDate) return NextResponse.json({ ok: false, error: "Tanggal bayar wajib diisi." }, { status: 400 });
        if (itemIds.length === 0) return NextResponse.json({ ok: false, error: "Pilih item yang akan dibayar." }, { status: 400 });

        const selectedItems = data.items.filter((item) => itemIds.includes(item.id));
        if (selectedItems.length !== itemIds.length) {
            return NextResponse.json({ ok: false, error: "Item pembayaran tidak valid untuk batch ini." }, { status: 400 });
        }
        const alreadyPaid = selectedItems.filter((item) => item.financePaymentStatus === "paid" || item.financePaymentId);
        if (alreadyPaid.length > 0) {
            return NextResponse.json({ ok: false, error: "Item yang sudah dibayar tidak boleh dipilih lagi." }, { status: 409 });
        }
        const methods = Array.from(new Set(selectedItems.map((item) => normalizeOffPaymentMethod(item.caraBayar))));
        if (methods.length !== 1) {
            return NextResponse.json({ ok: false, error: "Pilih item dengan cara bayar yang sama." }, { status: 400 });
        }
        const paymentMethod = methods[0];
        const paidAmount = selectedItems.reduce((total, item) => total + Number(item.nominal || 0), 0);
        if (paidAmount <= 0) return NextResponse.json({ ok: false, error: "Total item yang dipilih wajib lebih dari 0." }, { status: 400 });

        const hasProof = proof instanceof File && proof.size > 0;
        let uploadedProofName: string | null = null;
        if (hasProof) {
            const proofFile = proof as File;
            if (!proofMimeOk(proofFile.type)) return NextResponse.json({ ok: false, error: "File bukti pembayaran harus PDF/PNG/JPG/JPEG." }, { status: 400 });
            if (proofFile.size > 5 * 1024 * 1024) return NextResponse.json({ ok: false, error: "Ukuran file maksimal 5MB." }, { status: 400 });
            uploadedProofName = proofFile.name;
        }

        const totalNominal = computeOffPaymentSummary(data.items).total;
        const existingPayments = data.payments;
        const itemPaidBefore = data.items.reduce((total, item) => total + (item.financePaymentStatus === "paid" ? Number(item.financePaidAmount || item.nominal || 0) : 0), 0);
        const totalPaidAfter = itemPaidBefore + paidAmount;
        const paymentNo = existingPayments.reduce((maxNo, payment) => Math.max(maxNo, Number(payment.paymentNo || 0)), 0) + 1;
        const remainingAmount = totalNominal - totalPaidAfter;
        const isFullyPaid = remainingAmount === 0;
        const now = new Date();
        const paymentId = randomUUID();
        const generatedProof = await generateOffPaymentProofPdf({
            batch: data.batch,
            paymentId,
            paymentNo,
            paymentDate,
            paymentMethod,
            paidAmount,
            senderBank,
            note,
            items: selectedItems,
            totalNominal,
            totalPaidAfter,
            remainingAmount,
            isFullyPaid,
            uploadedProofName,
        });
        const [payment] = await db.transaction(async (tx) => {
            const [createdPayment] = await tx.insert(offPayment).values({
            id: paymentId,
            batchId: id,
            paymentNo,
            paymentDate,
            paymentMethod,
            paidAmount,
            senderBank,
            paymentProofName: generatedProof.fileName,
            paymentProofPath: generatedProof.filePath,
            paymentProofMime: generatedProof.mime,
            paymentProofSize: generatedProof.size,
            note,
            createdBy: actor.id,
            createdAt: now,
            updatedAt: now,
            }).returning();
            for (const item of selectedItems) {
                await tx.update(offBatchItem).set({
                    financePaymentStatus: "paid",
                    financePaidAt: now,
                    financePaymentId: paymentId,
                    financePaidAmount: Number(item.nominal || 0),
                    updatedAt: now,
                }).where(eq(offBatchItem.id, item.id));
            }
            await tx.update(offBatch).set({
            status: isFullyPaid ? "Paid" : "Partial Paid",
            financeStatus: isFullyPaid ? "Paid" : "Partial Paid",
            finalStatus: isFullyPaid ? "Waiting Claim Final Verification" : "Not Started",
            financeNote: note,
            paymentDate,
            paidAmount: totalPaidAfter,
            // Timestamp lunas penuh untuk deteksi SLA verifikasi final "Bermasalah" (#16).
            ...(isFullyPaid ? { paidAt: now } : {}),
            updatedAt: now,
            }).where(eq(offBatch.id, id));
            return [createdPayment];
        });
        await writeOffAudit({
            batchId: id,
            actor,
            action: "finance_payment_added",
            fromStatus: data.batch.financeStatus,
            toStatus: isFullyPaid ? "Paid" : "Partial Paid",
            note,
            metadata: { paymentNo, itemIds, selectedItemCount: itemIds.length, selectedTotal: paidAmount, paymentMethod, proofName: generatedProof.fileName, uploadedProofName, hasUploadedProof: hasProof, totalPaidAfter, remainingAmount },
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
