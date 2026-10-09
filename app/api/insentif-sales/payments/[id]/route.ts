/*
 * Tujuan: PATCH update payment status & proof untuk satu record insentif.
 * Caller: Admin finance panel PATCH /api/insentif-sales/payments/{id}.
 * Dependensi: db/schema (incentivePayments), lib/insentif-sales (requireSalesSession).
 * Main Functions: PATCH update paymentStatus, paymentDate, paidBy, paymentProofUrl.
 * Side Effects: DB write.
 */

import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { incentivePayments, kontrolAuditLog } from "@/db/schema";
import { requirePermission } from "@/lib/rbac/resolve";
import { getScopeForUser, getUserHierarchyIdentity, payeeInScope } from "@/lib/insentif-hierarchy-scope";
import { perubahanLunas, resolvePaidAt } from "@/lib/insentif-payment-date";
import { tolakLunasTanpaKonstanta } from "@/lib/insentif-settings";

export async function PATCH(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> },
) {
    const gate = await requirePermission(req, "insentif_sales.manage_payment");
    if (gate.response) return gate.response;

    const { id } = await params;

    let body: {
        paymentStatus?: "belum" | "lunas" | "tunggakan";
        paymentProofUrl?: string;
        paymentDate?: string; // "YYYY-MM-DD" tanggal WITA (lib/insentif-payment-date)
    };
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    // Nilai status asing ditolak, bukan disimpan apa adanya (audit 2026-08-28, M5).
    const STATUS_SAH = ["belum", "lunas", "tunggakan"];
    if (body.paymentStatus !== undefined && !STATUS_SAH.includes(body.paymentStatus)) {
        return NextResponse.json(
            { error: `paymentStatus harus salah satu dari: ${STATUS_SAH.join(", ")}` },
            { status: 400 },
        );
    }
    // Pembayaran memakai PATCH untuk baris yang SUDAH tercatat: pagar yang sama dengan POST (konstanta tak terbaca = nominal
    // dashboard dari bawaan → tidak boleh ditandai lunas). Badan dibaca sebelum baris dicari supaya pagar ini jalan duluan.
    const tolakKonstanta = body.paymentStatus === "lunas" ? await tolakLunasTanpaKonstanta() : null;
    if (tolakKonstanta) return tolakKonstanta;

    const [existing] = await db
        .select({
            id: incentivePayments.id,
            salesCode: incentivePayments.salesCode,
            periodMonth: incentivePayments.periodMonth,
            periodYear: incentivePayments.periodYear,
        })
        .from(incentivePayments)
        .where(eq(incentivePayments.id, id))
        .limit(1);

    if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

    // Kepemilikan diperiksa dari baris yang BENAR-BENAR ada di DB, bukan dari body: id
    // pembayaran orang lain tidak boleh bisa dilunasi hanya karena pemanggil punya izin
    // manage_payment (audit 2026-08-28, H4).
    const [scope, identity] = await Promise.all([
        getScopeForUser(gate.session.user.id, { month: existing.periodMonth, year: existing.periodYear }, gate.perms),
        getUserHierarchyIdentity(gate.session.user.id),
    ]);
    if (!payeeInScope(scope, identity, existing.salesCode)) {
        return NextResponse.json({ error: `${existing.salesCode}: di luar cakupan Anda.` }, { status: 403 });
    }

    const now = new Date();
    const updateSet: Record<string, unknown> = { updatedAt: now, updatedBy: gate.session.user.id };

    if (body.paymentStatus) updateSet.paymentStatus = body.paymentStatus;
    if (body.paymentProofUrl) updateSet.paymentProofUrl = body.paymentProofUrl;
    // Dulu `new Date(body.paymentDate)` tanpa validasi: tanggal masa depan atau "Invalid Date"
    // ikut tersimpan. Aturannya kini sama dengan POST (owner 8 Okt 2026, S4c-2).
    const tanggal = resolvePaidAt(body.paymentStatus, body.paymentDate, existing, now);
    if ("error" in tanggal) return NextResponse.json({ error: tanggal.error }, { status: 400 });
    const paidAt = tanggal.date;
    const actorName = gate.session.user.name ?? gate.session.user.email ?? "Unknown";
    if (paidAt) {
        updateSet.paymentDate = paidAt;
        updateSet.paidBy = gate.session.user.id;
        updateSet.paidByName = actorName;
    }

    // Melunasi ulang baris yang sudah lunas menimpa tanggal/pencatat: nilai lama dicatat dalam
    // transaksi yang sama (tinjauan PR #134).
    await db.transaction(async (tx) => {
        const [lama] = paidAt
            ? await tx.select({
                paymentStatus: incentivePayments.paymentStatus,
                paymentDate: incentivePayments.paymentDate,
                paidBy: incentivePayments.paidBy,
            }).from(incentivePayments).where(eq(incentivePayments.id, id)).for("update")
            : [];
        await tx.update(incentivePayments).set(updateSet).where(eq(incentivePayments.id, id));
        const ubah = paidAt ? perubahanLunas(lama, { paymentDate: paidAt, paidBy: gate.session.user.id }) : null;
        if (ubah) {
            await tx.insert(kontrolAuditLog).values({
                id: randomUUID(), entity: "insentif_sales.payment", entityId: id, action: "relunas",
                actorId: gate.session.user.id, actorName, payload: ubah, createdAt: now,
            });
        }
    });

    return NextResponse.json({ id, updated: true });
}
