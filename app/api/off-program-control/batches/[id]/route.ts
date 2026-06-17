/*
 * Tujuan: API detail dan revisi pengajuan OFF Program Control.
 * Caller: Halaman OFF Program Control saat membuka detail atau menyimpan revisi.
 * Dependensi: Better Auth OFF session, Drizzle SQLite, helper workflow/data OFF.
 * Main Functions: GET detail pengajuan, PATCH revisi pengajuan.
 * Side Effects: DB read/write SQLite, audit log OFF.
 */

import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { offBatch, offBatchItem } from "@/db/schema";
import { canActorAccessOffData, canActorPerformOffAction, computeOffFinancePaymentSummary, computeOffPaymentSummary, findOffNoSuratConflicts, getNextOffBatchNumber, getPrincipleByCode, getPrincipleByName, getBatchWithItems, isOffPeriodClosedForBatch, parseCurrency, publicBatch, publicPayment, requireOffSession, resolveProgramTypeForSave, writeOffAudit } from "@/lib/off-program-control";

type Context = { params: Promise<{ id: string }> };

function asNumber(value: unknown) {
    return parseCurrency(value);
}

// PPh masih HOLD. NOTE: PPh disiapkan nullable di level item/toko, tetapi
// perhitungan final ditahan karena masih terkait format kwitansi setelah pembayaran.
function nullableNumber(value: unknown) {
    if (value === undefined || value === null || value === "") return null;
    const parsed = parseCurrency(value);
    return Number.isFinite(parsed) ? parsed : null;
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

function normalizeItemNoRekening(value: unknown, caraBayar: string) {
    const noRekening = String(value || "").trim();
    if (caraBayar === "Transfer" && !noRekening) {
        throw new Error("No Rekening wajib diisi untuk baris Transfer.");
    }
    return caraBayar === "Transfer" ? noRekening : null;
}

function isSupervisorEditableBatch(batch: typeof offBatch.$inferSelect) {
    return !batch.locked && (
        batch.status === "Draft" ||
        batch.status === "Returned by SM" ||
        batch.status === "Returned by Claim" ||
        batch.smStatus === "Returned" ||
        batch.claimStatus === "Returned"
    );
}

function maskItemRekening(
    items: Array<typeof offBatchItem.$inferSelect>,
    canSeeRekening: boolean,
) {
    return items.map((item) => ({
        ...item,
        noRekening: canSeeRekening ? item.noRekening : null,
    }));
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
    const actor = await requireOffSession();
    if (!actor) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    if (!canActorAccessOffData(actor)) {
        return NextResponse.json({ ok: false, error: "Role Anda tidak memiliki akses OFF Program Control." }, { status: 403 });
    }

    try {
        const { id } = await context.params;
        const data = await getBatchWithItems(id);
        if (!data) return NextResponse.json({ ok: false, error: "Batch not found" }, { status: 404 });
        // Isolasi per-supervisor: SPV tidak boleh membaca detail pengajuan milik SPV lain
        // (tutup celah akses langsung via API). Role lain tidak terpengaruh.
        if (actor.role === "supervisor" && data.batch.createdBy !== actor.id) {
            return NextResponse.json({ ok: false, error: "Batch not found" }, { status: 404 });
        }
        const summary = batchSummary(data.items);
        // No Rekening item hanya terlihat oleh Finance/Admin, atau Supervisor pemilik
        // saat batch masih editable. Field batch legacy tidak dipakai UI baru.
        const canSeeRekening =
            canActorPerformOffAction(actor, "finance_payment") ||
            (actor.role === "supervisor" && data.batch.createdBy === actor.id && isSupervisorEditableBatch(data.batch));
        return NextResponse.json({
            ok: true,
            batch: { ...publicBatch(data.batch), noRekening: null },
            items: maskItemRekening(data.items, canSeeRekening),
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
        if (!actor) return NextResponse.json({ ok: false, error: "Anda tidak memiliki akses untuk melakukan tindakan ini." }, { status: 401 });
        if (!canActorPerformOffAction(actor, "edit_returned_batch")) {
            return NextResponse.json({ ok: false, error: "Role Anda tidak memiliki akses edit batch OFF." }, { status: 403 });
        }

        const { id } = await context.params;
        const data = await getBatchWithItems(id);
        if (!data) return NextResponse.json({ ok: false, error: "Pengajuan tidak ditemukan." }, { status: 404 });
        if (actor.role !== "admin" && await isOffPeriodClosedForBatch(data.batch)) {
            return NextResponse.json({ ok: false, error: "Periode ini sudah ditutup dan tidak dapat diubah." }, { status: 409 });
        }
        if (data.batch.locked) return NextResponse.json({ ok: false, error: "Batch sudah approved oleh SM dan terkunci untuk Supervisor." }, { status: 409 });
        if (!["Draft", "Returned by SM", "Returned by Claim"].includes(data.batch.status) && !["Returned"].includes(data.batch.smStatus) && !["Returned"].includes(data.batch.claimStatus)) {
            return NextResponse.json({ ok: false, error: "Batch hanya bisa diedit saat Draft atau Returned/Rejected dan belum terkunci." }, { status: 409 });
        }

        const body = await request.json().catch(() => ({}));
        const now = new Date();
        const nextPrinciple = body.principleName ? getPrincipleByName(String(body.principleName)) : getPrincipleByCode(data.batch.principleCode);
        if (!nextPrinciple) return NextResponse.json({ ok: false, error: "Principle tidak valid." }, { status: 400 });
        if (body.principleCode && String(body.principleCode) !== nextPrinciple.code) {
            return NextResponse.json({ ok: false, error: "Kode Principle tidak sesuai dengan Principle." }, { status: 400 });
        }

        const bulan = body.bulan ? String(body.bulan).padStart(2, "0") : data.batch.bulan;
        const tahun = body.tahun ? String(body.tahun) : data.batch.tahun;
        const numberScopeChanged =
            nextPrinciple.code !== data.batch.principleCode ||
            bulan !== data.batch.bulan ||
            tahun !== data.batch.tahun;
        let gelombang = data.batch.gelombang;
        let noPengajuan = data.batch.noPengajuan;
        if (numberScopeChanged) {
            const nextNumber = await getNextOffBatchNumber({
                principleCode: nextPrinciple.code,
                bulan,
                tahun,
                createdByRole: data.batch.createdByRole,
                excludeBatchId: id,
            });
            gelombang = nextNumber.gelombang;
            noPengajuan = nextNumber.noPengajuan;
        }

        const patch: Partial<typeof offBatch.$inferInsert> = {
            noPengajuan,
            gelombang,
            principleCode: nextPrinciple.code,
            principleName: nextPrinciple.name,
            bulan,
            tahun,
            supervisorName: body.supervisorName ? String(body.supervisorName) : data.batch.supervisorName,
            // Field batch legacy dipertahankan nullable, flow baru memakai item.noRekening.
            noRekening: data.batch.noRekening || null,
            updatedAt: now,
        };
        await db.update(offBatch).set(patch).where(eq(offBatch.id, id));

        if (Array.isArray(body.items)) {
            // Validasi duplikat No Surat (per principle, kecuali batch yang sudah Cancelled by OM).
            const force = body.forceDuplicateNoSurat === true || body.forceDuplicateNoSurat === "true";
            const candidateNoSurats = (body.items as Array<Record<string, unknown>>)
                .map((item) => String(item.noSurat || "").trim())
                .filter((value) => value.length > 0);

            // Catatan (#4): No Surat boleh sama DALAM satu pengajuan/batch.
            // Validasi duplikat intra-payload sengaja dilonggarkan sesuai kebutuhan bisnis.
            // Validasi lintas-batch (per principle) tetap dipertahankan dengan bypass `force`.

            if (!force && candidateNoSurats.length > 0) {
                const conflictMap = await findOffNoSuratConflicts({
                    principleCode: nextPrinciple.code,
                    noSurats: candidateNoSurats,
                    excludeBatchId: id,
                });
                if (conflictMap.size > 0) {
                    const conflicts = Array.from(conflictMap.values()).flat();
                    return NextResponse.json({
                        ok: false,
                        code: "DUPLICATE_NO_SURAT",
                        message: `No Surat berikut sudah pernah dipakai pada principle ${nextPrinciple.name}: ${Array.from(conflictMap.keys()).join(", ")}. Konfirmasi ulang jika ingin tetap melanjutkan.`,
                        principleCode: nextPrinciple.code,
                        principleName: nextPrinciple.name,
                        conflicts,
                    }, { status: 409 });
                }
            }

            await db.delete(offBatchItem).where(eq(offBatchItem.batchId, id));
            const legacyMigrations: Array<{ rowNo: number; originalType: string; normalizedType: string; forced: boolean }> = [];
            const itemValues = (body.items as Array<Record<string, unknown>>).map((item, index) => {
                const resolvedType = resolveProgramTypeForSave(
                    item.type ?? item.normalizedType,
                    item.originalType,
                );
                if (resolvedType.typeIsLegacy) {
                    legacyMigrations.push({
                        rowNo: index + 1,
                        originalType: resolvedType.originalType,
                        normalizedType: resolvedType.normalizedType,
                        forced: resolvedType.forcedToFallback,
                    });
                }
                return {
                    id: randomUUID(),
                    batchId: id,
                    itemNo: index + 1,
                    rowNo: index + 1,
                    noSurat: String(item.noSurat || "").trim(),
                    namaProgram: String(item.namaProgram || item.program || `Program ${index + 1}`),
                    periode: periodText(item),
                    toko: String(item.toko || ""),
                    barang: String(item.barang || ""),
                    nominal: asNumber(item.nominal),
                    caraBayar: normalizeCaraBayar(item.caraBayar),
                    noRekening: normalizeItemNoRekening(item.noRekening, normalizeCaraBayar(item.caraBayar)),
                    type: resolvedType.normalizedType,
                    normalizedType: resolvedType.normalizedType,
                    originalType: resolvedType.originalType || resolvedType.normalizedType,
                    typeIsLegacy: resolvedType.typeIsLegacy,
                    // PPh HOLD: nullable, tidak memblokir submit.
                    pphExempt: bool(item.pphExempt),
                    pphAmount: nullableNumber(item.pphAmount),
                    adjustmentPph: nullableNumber(item.adjustmentPph),
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
                };
            });
            await db.insert(offBatchItem).values(itemValues);
            if (legacyMigrations.length > 0) {
                await writeOffAudit({
                    batchId: id,
                    actor,
                    action: "legacy_type_migrated",
                    fromStatus: data.batch.status,
                    toStatus: data.batch.status,
                    note: `Migrasi tipe legacy otomatis untuk ${legacyMigrations.length} item.`,
                    metadata: { migrations: legacyMigrations },
                });
            }
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
        if (message === "Jenis pembayaran hanya boleh Tunai atau Transfer." || message === "No Rekening wajib diisi untuk baris Transfer.") {
            return NextResponse.json({ ok: false, error: message }, { status: 400 });
        }
        return NextResponse.json({ ok: false, error: "Gagal menyimpan revisi batch." }, { status: 500 });
    }
}
