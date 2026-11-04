/*
 * Tujuan: GET Pantau Pengajuan Promo (owner 3 Nov 2026): salesman melihat progres pengajuan OPC principal yang ia tangani — sudah diajukan,
 *   sudah dibayar, dan bukti bayarnya. Baca saja. Cakupan = lib/off-program-control/pantau (profil sales + JKS -> kode OPC; admin semua).
 * Caller: app/(dashboard)/off-program-control/pantau/Pantau.tsx.
 * Dependensi: requirePermissionH (off_program_control.pantau_sales), cakupanPantau, lib/opc-ui (infoTahap, alurBatch), payments (ringkasan).
 * Main Functions: GET -> { ok, cakupan, batas, batches[] } — 200 pengajuan terbaru (bukan Draf; Dibatalkan tetap tampil) + item + pembayaran.
 *   Tidak pernah mengirim path berkas, catatan internal, audit, nomor rekening, atau id pengguna.
 * Side Effects: DB read (sales_profile, jks_master, principal*, off_batch, off_batch_item, off_payment).
 */
import { NextResponse } from "next/server";
import { and, asc, desc, inArray, ne } from "drizzle-orm";
import { db } from "@/lib/db";
import { offBatch, offBatchItem, offPayment } from "@/db/schema";
import { requirePermissionH } from "@/lib/rbac/resolve";
import { cakupanPantau } from "@/lib/off-program-control/pantau";
import { bebanItem } from "@/lib/off-program-control/constants";
import { computeOffPaymentSummary, normalizePaymentMethod } from "@/lib/off-program-control/payments";
import { alurBatch, infoTahap } from "@/lib/opc-ui";

export const runtime = "nodejs";

const BATAS = 200;
const iso = (d: Date | null) => (d ? d.toISOString() : null);

export async function GET() {
    const gate = await requirePermissionH("off_program_control.pantau_sales");
    if (gate.response) return gate.response;
    try {
        const cakupan = await cakupanPantau(gate.session.user);
        const kode = cakupan.principal.map((p) => p.code);
        if (!cakupan.semua && kode.length === 0) return NextResponse.json({ ok: true, cakupan, batas: BATAS, batches: [] });

        const batches = await db.select({
            id: offBatch.id, noPengajuan: offBatch.noPengajuan, principleCode: offBatch.principleCode, principleName: offBatch.principleName,
            bulan: offBatch.bulan, tahun: offBatch.tahun, supervisorName: offBatch.supervisorName, totalNominal: offBatch.totalNominal,
            status: offBatch.status, smStatus: offBatch.smStatus, claimStatus: offBatch.claimStatus, omStatus: offBatch.omStatus,
            financeStatus: offBatch.financeStatus, finalStatus: offBatch.finalStatus, createdByRole: offBatch.createdByRole,
            submittedAt: offBatch.submittedAt, updatedAt: offBatch.updatedAt,
        }).from(offBatch)
            .where(and(ne(offBatch.status, "Draft"), cakupan.semua ? undefined : inArray(offBatch.principleCode, kode)))
            .orderBy(desc(offBatch.createdAt)).limit(BATAS);
        const ids = batches.map((b) => b.id);
        const [items, payments] = ids.length ? await Promise.all([
            db.select({
                batchId: offBatchItem.batchId, itemNo: offBatchItem.itemNo, noSurat: offBatchItem.noSurat, namaProgram: offBatchItem.namaProgram,
                periode: offBatchItem.periode, toko: offBatchItem.toko, nominal: offBatchItem.nominal, caraBayar: offBatchItem.caraBayar,
                beban: offBatchItem.beban, financePaymentStatus: offBatchItem.financePaymentStatus, financePaidAt: offBatchItem.financePaidAt,
                financePaymentId: offBatchItem.financePaymentId,
            }).from(offBatchItem).where(inArray(offBatchItem.batchId, ids)).orderBy(asc(offBatchItem.itemNo)),
            db.select({
                id: offPayment.id, batchId: offPayment.batchId, paymentNo: offPayment.paymentNo, paymentDate: offPayment.paymentDate,
                paidAmount: offPayment.paidAmount, paymentMethod: offPayment.paymentMethod, paymentProofPath: offPayment.paymentProofPath,
            }).from(offPayment).where(inArray(offPayment.batchId, ids)).orderBy(asc(offPayment.paymentNo)),
        ]) : [[], []];

        const itemPer = Map.groupBy(items, (i) => i.batchId);
        const bayarPer = Map.groupBy(payments, (p) => p.batchId);
        const noBayar = new Map(payments.map((p) => [p.id, p.paymentNo]));
        return NextResponse.json({
            ok: true, cakupan, batas: BATAS,
            batches: batches.map((b) => {
                const its = itemPer.get(b.id) ?? [];
                const pays = bayarPer.get(b.id) ?? [];
                const ringkas = computeOffPaymentSummary(its);
                const total = its.length ? ringkas.total : Number(b.totalNominal || 0);
                // infoTahap membaca ringkasan + pembayaran untuk pemegang tahap Bayar (Keuangan / Incaso untuk Potong Tagihan).
                const tahap = infoTahap({ ...b, summary: { totalNominal: total, potongTagihan: ringkas.potongTagihan },
                    payments: pays.map((p) => ({ id: p.id, batchId: p.batchId, paymentNo: p.paymentNo, paymentDate: p.paymentDate, paymentMethod: p.paymentMethod, paidAmount: p.paidAmount })) });
                return {
                    noPengajuan: b.noPengajuan, principleCode: b.principleCode, principleName: b.principleName, bulan: b.bulan, tahun: b.tahun,
                    supervisorName: b.supervisorName, diajukanPada: iso(b.submittedAt), diperbaruiPada: iso(b.updatedAt),
                    tahap: { kunci: tahap.kunci, label: tahap.label, tone: tahap.tone, pemilik: tahap.pemilik, posisi: tahap.posisi },
                    alur: alurBatch(b),
                    total, totalDibayar: pays.reduce((t, p) => t + Number(p.paidAmount || 0), 0),
                    items: its.map((i) => ({
                        no: i.itemNo, noSurat: i.noSurat, namaProgram: i.namaProgram, periode: i.periode, toko: i.toko, nominal: Number(i.nominal || 0),
                        caraBayar: normalizePaymentMethod(i.caraBayar), beban: bebanItem(i.beban),
                        dibayar: i.financePaymentStatus === "paid", dibayarPada: iso(i.financePaidAt),
                        pembayaranKe: i.financePaymentId ? noBayar.get(i.financePaymentId) ?? null : null,
                    })),
                    payments: pays.map((p) => ({
                        no: p.paymentNo, tanggal: p.paymentDate, cara: normalizePaymentMethod(p.paymentMethod), jumlah: Number(p.paidAmount || 0),
                        buktiUrl: p.paymentProofPath ? `/api/off-program-control/pantau/bukti/${encodeURIComponent(p.id)}` : null,
                    })),
                };
            }),
        });
    } catch (error) {
        console.error("[OPC PANTAU]", error);
        return NextResponse.json({ ok: false, error: "Daftar pengajuan gagal dimuat." }, { status: 500 });
    }
}
