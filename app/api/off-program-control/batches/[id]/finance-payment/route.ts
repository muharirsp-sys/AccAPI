/*
 * Tujuan: API pencatatan pembayaran Keuangan untuk pengajuan OFF Program Control.
 * Caller: Halaman OFF Program Control tab Keuangan.
 * Dependensi: Better Auth OFF session, Drizzle SQLite, file upload bukti bayar, helper pembayaran OFF.
 * Main Functions: POST finance-payment.
 * Side Effects: DB write SQLite, file I/O bukti bayar, audit log OFF.
 */

import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { db } from "@/lib/db";
import { offBatch, offPayment } from "@/db/schema";
import { canActorPerformOffAction, canProcessFinancePayment, computeOffFinancePaymentSummary, computeOffPaymentSummary, getBatchWithItems, isOffPeriodClosedForBatch, normalizeOffPaymentMethod, parseCurrency, publicBatch, publicPayment, requireOffSession, writeOffAudit } from "@/lib/off-program-control";

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
        if (!actor) return NextResponse.json({ ok: false, error: "Anda tidak memiliki akses untuk melakukan tindakan ini." }, { status: 401 });
        if (!canActorPerformOffAction(actor, "finance_payment")) return NextResponse.json({ ok: false, error: "Role Anda tidak memiliki akses pembayaran Keuangan." }, { status: 403 });
        const { id } = await context.params;
        const data = await getBatchWithItems(id);
        if (!data) return NextResponse.json({ ok: false, error: "Pengajuan tidak ditemukan." }, { status: 404 });
        if (actor.role !== "admin" && await isOffPeriodClosedForBatch(data.batch)) {
            return NextResponse.json({ ok: false, error: "Periode ini sudah ditutup dan tidak dapat diubah." }, { status: 409 });
        }
        if (data.batch.smStatus !== "Approved by SM" || data.batch.claimStatus !== "Approved") {
            return NextResponse.json({ ok: false, error: "Pengajuan belum lengkap persetujuan Sales Manager dan Klaim." }, { status: 409 });
        }
        if (data.batch.omStatus !== "Approved") {
            return NextResponse.json({ ok: false, error: "Pengajuan belum disetujui OM." }, { status: 409 });
        }
        if (!canProcessFinancePayment(data.batch)) {
            return NextResponse.json({ ok: false, error: "Pengajuan tidak sedang menunggu pembayaran Keuangan." }, { status: 409 });
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
        // Revisi B: Bukti pembayaran TIDAK wajib untuk metode Tunai.
        // Untuk Transfer/non-tunai, bukti tetap wajib (aturan existing dipertahankan).
        // Bukti boleh tetap diupload walau Tunai.
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
        const [payment] = await db.insert(offPayment).values({
            id: randomUUID(),
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
        await db.update(offBatch).set({
            status: isFullyPaid ? "Paid" : "Partial Paid",
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
            metadata: { paymentNo, amount: paidAmount, method: paymentMethod, proofName: proofName || null, hasProof, totalPaidAfter, remainingAmount },
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
