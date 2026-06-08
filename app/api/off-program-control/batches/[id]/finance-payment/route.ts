import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { db } from "@/lib/db";
import { offBatch, offBatchItem, offPayment } from "@/db/schema";
import { canActorPerformOffAction, canProcessFinancePayment, computeOffFinancePaymentSummary, computeOffPaymentSummary, getBatchWithItems, normalizeOffPaymentMethod, publicBatch, publicPayment, requireOffSession, writeOffAudit } from "@/lib/off-program-control";

type Context = { params: Promise<{ id: string }> };

function sanitizeFileName(value: string) {
    return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "payment-proof";
}

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

        const isTunai = paymentMethod === "Tunai";
        const hasProof = proof instanceof File && proof.size > 0;
        if (!isTunai && !hasProof) {
            return NextResponse.json({ ok: false, error: "Bukti pembayaran wajib diupload untuk pembayaran Transfer." }, { status: 400 });
        }
        if (hasProof) {
            const proofFile = proof as File;
            if (!proofMimeOk(proofFile.type)) return NextResponse.json({ ok: false, error: "File bukti pembayaran harus PDF/PNG/JPG/JPEG." }, { status: 400 });
            if (proofFile.size > 5 * 1024 * 1024) return NextResponse.json({ ok: false, error: "Ukuran file maksimal 5MB." }, { status: 400 });
        }

        const totalNominal = computeOffPaymentSummary(data.items).total;
        const existingPayments = data.payments;
        const itemPaidBefore = data.items.reduce((total, item) => total + (item.financePaymentStatus === "paid" ? Number(item.financePaidAmount || item.nominal || 0) : 0), 0);
        const totalPaidAfter = itemPaidBefore + paidAmount;
        const paymentNo = existingPayments.reduce((maxNo, payment) => Math.max(maxNo, Number(payment.paymentNo || 0)), 0) + 1;
        const remainingAmount = totalNominal - totalPaidAfter;
        const isFullyPaid = remainingAmount === 0;
        const now = new Date();

        // Simpan bukti hanya jika ada file. Untuk Tunai bukti opsional (revisi B).
        let proofPath: string | null = null;
        let proofName: string | null = null;
        let proofMime: string | null = null;
        let proofSize: number | null = null;
        if (hasProof) {
            const proofFile = proof as File;
            const proofDir = path.join(process.cwd(), "runtime", "off-program-control", "payment-proofs", id);
            fs.mkdirSync(proofDir, { recursive: true });
            const storedName = `${sanitizeFileName(data.batch.noPengajuan)}-${paymentNo}-${sanitizeFileName(proofFile.name)}`;
            const storedPath = path.join(proofDir, storedName);
            const proofBuffer = Buffer.from(await proofFile.arrayBuffer());
            fs.writeFileSync(storedPath, proofBuffer);
            const proofStats = fs.statSync(storedPath);
            if (proofStats.size <= 0) return NextResponse.json({ ok: false, error: "Gagal menyimpan bukti pembayaran." }, { status: 500 });
            proofPath = storedPath;
            proofName = proofFile.name;
            proofMime = proofFile.type;
            proofSize = proofFile.size;
        }
        const paymentId = randomUUID();
        const [payment] = await db.transaction(async (tx) => {
            const [createdPayment] = await tx.insert(offPayment).values({
            id: paymentId,
            batchId: id,
            paymentNo,
            paymentDate,
            paymentMethod,
            paidAmount,
            senderBank,
            paymentProofName: proofName,
            paymentProofPath: proofPath,
            paymentProofMime: proofMime,
            paymentProofSize: proofSize,
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
            metadata: { paymentNo, itemIds, selectedItemCount: itemIds.length, selectedTotal: paidAmount, paymentMethod, proofName: proofName || null, hasProof, totalPaidAfter, remainingAmount },
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
