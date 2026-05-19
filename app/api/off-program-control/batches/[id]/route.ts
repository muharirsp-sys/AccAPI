import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { offBatch, offBatchItem } from "@/db/schema";
import { buildNoPengajuan, canActorPerformOffAction, computeOffFinancePaymentSummary, computeOffPaymentSummary, getPrincipleByCode, getPrincipleByName, getBatchWithItems, parseCurrency, publicBatch, publicPayment, requireOffSession, writeOffAudit } from "@/lib/off-program-control";

type Context = { params: Promise<{ id: string }> };

function asNumber(value: unknown) {
    return parseCurrency(value);
}

function bool(value: unknown) {
    return value === true || value === "true" || value === 1 || value === "1";
}

function normalizeCaraBayar(value: unknown) {
    const normalized = String(value || "").trim().toLowerCase();
    if (normalized === "transfer") return "Transfer";
    if (normalized === "tunai") return "Tunai";
    throw new Error("Jenis pembayaran hanya boleh Tunai atau Transfer.");
}

function periodText(item: Record<string, unknown>) {
    const periodeAwal = String(item.periodeAwal || "").trim();
    const periodeAkhir = String(item.periodeAkhir || "").trim();
    if (periodeAwal && periodeAkhir) return `${periodeAwal} - ${periodeAkhir}`;
    return String(item.periode || periodeAwal || periodeAkhir || "");
}

function batchSummary(items: Array<typeof offBatchItem.$inferSelect>) {
    const paymentSummary = computeOffPaymentSummary(items);
    return {
        totalRows: items.length,
        totalNominal: items.reduce((total, item) => total + Number(item.nominal || 0), 0),
        transfer: paymentSummary.transfer,
        tunai: paymentSummary.tunai,
    };
}

export async function GET(_request: Request, context: Context) {
    try {
        const { id } = await context.params;
        const data = await getBatchWithItems(id);
        if (!data) return NextResponse.json({ ok: false, error: "Batch not found" }, { status: 404 });
        const summary = batchSummary(data.items);
        return NextResponse.json({
            ok: true,
            batch: publicBatch(data.batch),
            items: data.items,
            payments: data.payments.map(publicPayment),
            summary,
            paymentSummary: computeOffFinancePaymentSummary(summary.totalNominal, data.payments),
        });
    } catch (error) {
        console.error("[OFF BATCH DETAIL ERROR]", error);
        return NextResponse.json({ ok: false, error: "Gagal mengambil detail batch." }, { status: 500 });
    }
}

export async function PATCH(request: Request, context: Context) {
    try {
        const actor = await requireOffSession();
        if (!actor) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
        if (!canActorPerformOffAction(actor, "edit_returned_batch")) {
            return NextResponse.json({ ok: false, error: "Role Anda tidak memiliki akses edit batch OFF." }, { status: 403 });
        }

        const { id } = await context.params;
        const data = await getBatchWithItems(id);
        if (!data) return NextResponse.json({ ok: false, error: "Batch not found" }, { status: 404 });
        if (data.batch.locked) return NextResponse.json({ ok: false, error: "Batch sudah approved oleh SM dan terkunci untuk Supervisor." }, { status: 409 });

        const body = await request.json().catch(() => ({}));
        const now = new Date();
        const nextPrinciple = body.principleName ? getPrincipleByName(String(body.principleName)) : getPrincipleByCode(data.batch.principleCode);
        if (!nextPrinciple) return NextResponse.json({ ok: false, error: "Principle tidak valid." }, { status: 400 });
        if (body.principleCode && String(body.principleCode) !== nextPrinciple.code) {
            return NextResponse.json({ ok: false, error: "Kode Principle tidak sesuai dengan Principle." }, { status: 400 });
        }

        const gelombang = body.gelombang ? String(body.gelombang).padStart(3, "0") : data.batch.gelombang;
        const bulan = body.bulan ? String(body.bulan).padStart(2, "0") : data.batch.bulan;
        const tahun = body.tahun ? String(body.tahun) : data.batch.tahun;
        const noPengajuan = buildNoPengajuan(gelombang, nextPrinciple.code, bulan, tahun);
        if (noPengajuan !== data.batch.noPengajuan) {
            const [duplicate] = await db.select().from(offBatch).where(eq(offBatch.noPengajuan, noPengajuan));
            if (duplicate && duplicate.id !== id) {
                return NextResponse.json({ ok: false, error: "No Pengajuan hasil revisi sudah digunakan batch lain." }, { status: 409 });
            }
        }

        const patch: Partial<typeof offBatch.$inferInsert> = {
            noPengajuan,
            gelombang,
            principleCode: nextPrinciple.code,
            principleName: nextPrinciple.name,
            bulan,
            tahun,
            supervisorName: body.supervisorName ? String(body.supervisorName) : data.batch.supervisorName,
            updatedAt: now,
        };
        await db.update(offBatch).set(patch).where(eq(offBatch.id, id));

        if (Array.isArray(body.items)) {
            await db.delete(offBatchItem).where(eq(offBatchItem.batchId, id));
            await db.insert(offBatchItem).values(body.items.map((item: Record<string, unknown>, index: number) => ({
                id: randomUUID(),
                batchId: id,
                itemNo: index + 1,
                rowNo: index + 1,
                noSurat: String(item.noSurat || ""),
                namaProgram: String(item.namaProgram || item.program || `Program ${index + 1}`),
                periode: periodText(item),
                toko: String(item.toko || ""),
                barang: String(item.barang || ""),
                nominal: asNumber(item.nominal),
                caraBayar: normalizeCaraBayar(item.caraBayar),
                type: String(item.type || ""),
                deadline: String(item.deadline || ""),
                kwt: bool(item.kwt),
                skp: bool(item.skp),
                fp: bool(item.fp),
                pc: bool(item.pc),
                foto: bool(item.foto),
                rekap: bool(item.rekap),
                others: bool(item.others),
                othersText: String(item.othersText || ""),
                createdAt: now,
                updatedAt: now,
            })));
        }

        await writeOffAudit({ batchId: id, actor, action: "update_batch", fromStatus: data.batch.status, toStatus: data.batch.status });
        const updated = await getBatchWithItems(id);
        return NextResponse.json({
            ok: true,
            batch: updated ? publicBatch(updated.batch) : null,
            items: updated?.items || [],
            payments: updated?.payments.map(publicPayment) || [],
            summary: updated ? batchSummary(updated.items) : { totalRows: 0, totalNominal: 0 },
            paymentSummary: updated ? computeOffFinancePaymentSummary(batchSummary(updated.items).totalNominal, updated.payments) : { totalNominal: 0, totalPaid: 0, remainingAmount: 0, isFullyPaid: false },
        });
    } catch (error) {
        console.error("[OFF BATCH PATCH ERROR]", error);
        const message = error instanceof Error ? error.message : "";
        if (message === "Jenis pembayaran hanya boleh Tunai atau Transfer.") {
            return NextResponse.json({ ok: false, error: message }, { status: 400 });
        }
        return NextResponse.json({ ok: false, error: "Gagal menyimpan revisi batch." }, { status: 500 });
    }
}
