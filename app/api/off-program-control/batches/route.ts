import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { offBatch, offBatchItem, offPayment } from "@/db/schema";
import { buildNoPengajuan, canActorAccessOffData, canActorPerformOffAction, computeOffFinancePaymentSummary, computeOffPaymentSummary, findDuplicateNoSuratWithinPayload, findOffNoSuratConflicts, getPrincipleByCode, getPrincipleByName, parseCurrency, publicBatch, publicPayment, requireOffSession, writeOffAudit } from "@/lib/off-program-control";

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

function periodText(row: Record<string, unknown>) {
    const periodeAwal = String(row.periodeAwal || "").trim();
    const periodeAkhir = String(row.periodeAkhir || "").trim();
    if (periodeAwal && periodeAkhir) return `${periodeAwal} - ${periodeAkhir}`;
    return String(row.periode || periodeAwal || periodeAkhir || "");
}

function normalizeItems(items: unknown[]) {
    const now = new Date();
    return items.map((item, index) => {
        const row = item && typeof item === "object" ? item as Record<string, unknown> : {};
        return {
            id: randomUUID(),
            itemNo: index + 1,
            rowNo: index + 1,
            noSurat: String(row.noSurat || "").trim(),
            namaProgram: String(row.namaProgram || row.program || `Program ${index + 1}`),
            periode: periodText(row),
            toko: String(row.toko || ""),
            barang: String(row.barang || ""),
            nominal: asNumber(row.nominal),
            caraBayar: normalizeCaraBayar(row.caraBayar),
            type: String(row.type || ""),
            deadline: String(row.deadline || ""),
            kwt: bool(row.kwt),
            skp: bool(row.skp),
            fp: bool(row.fp),
            pc: bool(row.pc),
            foto: bool(row.foto),
            rekap: bool(row.rekap),
            others: bool(row.others),
            othersText: String(row.othersText || ""),
            createdAt: now,
            updatedAt: now,
        };
    });
}

function alreadySubmittedResponse(batch: typeof offBatch.$inferSelect) {
    const publicRow = publicBatch(batch);
    return NextResponse.json({
        ok: false,
        code: "ALREADY_SUBMITTED",
        message: "Pengajuan ini sudah pernah disubmit.",
        existingBatchId: batch.id,
        noPengajuan: batch.noPengajuan,
        pdfUrl: publicRow.pdfUrl,
    }, { status: 409 });
}

export async function GET() {
    const actor = await requireOffSession();
    if (!actor) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    if (!canActorAccessOffData(actor)) {
        return NextResponse.json({ ok: false, error: "Role Anda tidak memiliki akses OFF Program Control." }, { status: 403 });
    }

    try {
        const rows = await db.select().from(offBatch).orderBy(desc(offBatch.createdAt)).limit(200);
        const items = await db.select().from(offBatchItem);
        const payments = await db.select().from(offPayment);
        const summaries = new Map<string, { totalRows: number; totalNominal: number; transfer: number; tunai: number }>();
        const paymentSummaries = new Map<string, { totalNominal: number; totalPaid: number; remainingAmount: number; isFullyPaid: boolean }>();
        const paymentsByBatch = new Map<string, Array<typeof offPayment.$inferSelect>>();
        rows.forEach((row) => {
            const batchItems = items.filter((item) => item.batchId === row.id);
            const batchPayments = payments.filter((payment) => payment.batchId === row.id);
            const paymentSummary = computeOffPaymentSummary(batchItems);
            summaries.set(row.id, {
                totalRows: batchItems.length,
                totalNominal: paymentSummary.total,
                transfer: paymentSummary.transfer,
                tunai: paymentSummary.tunai,
            });
            paymentsByBatch.set(row.id, batchPayments);
            paymentSummaries.set(row.id, computeOffFinancePaymentSummary(paymentSummary.total, batchPayments));
        });
        return NextResponse.json({
            ok: true,
            batches: rows.map((row) => ({
                ...publicBatch(row),
                payments: (paymentsByBatch.get(row.id) || []).map(publicPayment),
                summary: summaries.get(row.id),
                paymentSummary: paymentSummaries.get(row.id),
            })),
        });
    } catch (error) {
        console.error("[OFF BATCH LIST ERROR]", error);
        return NextResponse.json({ ok: false, error: "Gagal mengambil daftar batch." }, { status: 500 });
    }
}

export async function POST(request: Request) {
    const actor = await requireOffSession();
    if (!actor) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    if (!canActorPerformOffAction(actor, "create_batch")) {
        return NextResponse.json({ ok: false, error: "Role Anda tidak memiliki akses membuat batch OFF." }, { status: 403 });
    }

    try {
        const body = await request.json();
        const principle = getPrincipleByName(String(body.principleName || ""));
        if (!principle) return NextResponse.json({ ok: false, error: "Invalid principle" }, { status: 400 });
        const principleFromCode = body.principleCode ? getPrincipleByCode(String(body.principleCode)) : principle;
        if (!principleFromCode || principleFromCode.code !== principle.code) {
            return NextResponse.json({ ok: false, error: "Principle code does not match selected principle" }, { status: 400 });
        }

        const gelombang = String(body.gelombang || "").padStart(3, "0");
        const bulan = String(body.bulan || "").padStart(2, "0");
        const tahun = String(body.tahun || "");
        if (!gelombang || !bulan || !tahun) {
            return NextResponse.json({ ok: false, error: "Gelombang, bulan, and tahun are required" }, { status: 400 });
        }

        const items = normalizeItems(Array.isArray(body.items) ? body.items : []);
        if (items.length === 0) return NextResponse.json({ ok: false, error: "At least one item is required" }, { status: 400 });

        // Validasi duplikat No Surat (per principle, kecuali batch yang sudah Cancelled by OM).
        const force = body.forceDuplicateNoSurat === true || body.forceDuplicateNoSurat === "true";
        const candidateNoSurats = items
            .map((item) => String(item.noSurat || "").trim())
            .filter((value) => value.length > 0);

        const intraDuplicates = findDuplicateNoSuratWithinPayload(candidateNoSurats);
        if (intraDuplicates.length > 0) {
            return NextResponse.json({
                ok: false,
                code: "DUPLICATE_NO_SURAT_IN_PAYLOAD",
                message: `No Surat tidak boleh sama dalam satu batch: ${intraDuplicates.join(", ")}`,
                duplicates: intraDuplicates,
            }, { status: 409 });
        }

        if (!force && candidateNoSurats.length > 0) {
            const conflictMap = await findOffNoSuratConflicts({
                principleCode: principle.code,
                noSurats: candidateNoSurats,
            });
            if (conflictMap.size > 0) {
                const conflicts = Array.from(conflictMap.values()).flat();
                return NextResponse.json({
                    ok: false,
                    code: "DUPLICATE_NO_SURAT",
                    message: `No Surat berikut sudah pernah dipakai pada principle ${principle.name}: ${Array.from(conflictMap.keys()).join(", ")}. Konfirmasi ulang jika ingin tetap melanjutkan.`,
                    principleCode: principle.code,
                    principleName: principle.name,
                    conflicts,
                }, { status: 409 });
            }
        }

        const now = new Date();
        const batchId = randomUUID();
        const noPengajuan = buildNoPengajuan(gelombang, principle.code, bulan, tahun);
        const [existingBatch] = await db.select().from(offBatch).where(eq(offBatch.noPengajuan, noPengajuan));
        if (existingBatch) {
            if (existingBatch.status !== "Draft" || existingBatch.pdfPath) return alreadySubmittedResponse(existingBatch);
            return NextResponse.json({
                ok: false,
                code: "DUPLICATE_DRAFT",
                message: "No Pengajuan ini sudah ada sebagai draft.",
                existingBatchId: existingBatch.id,
                noPengajuan: existingBatch.noPengajuan,
                pdfUrl: publicBatch(existingBatch).pdfUrl,
            }, { status: 409 });
        }

        await db.insert(offBatch).values({
            id: batchId,
            noPengajuan,
            gelombang,
            principleCode: principle.code,
            principleName: principle.name,
            bulan,
            tahun,
            supervisorName: String(body.supervisorName || actor.name || "Supervisor"),
            status: "Draft",
            smStatus: "Not Started",
            claimStatus: "Not Started",
            omStatus: "Not Started",
            financeStatus: "Not Started",
            finalStatus: "Not Started",
            locked: false,
            pdfStatus: "pending",
            createdBy: actor.id,
            createdAt: now,
            updatedAt: now,
        });

        await db.insert(offBatchItem).values(items.map((item) => ({ ...item, batchId })));
        await writeOffAudit({ batchId, actor, action: "create_batch", toStatus: "Draft", metadata: { itemCount: items.length } });

        return NextResponse.json({ ok: true, batchId, noPengajuan });
    } catch (error) {
        const message = error instanceof Error ? error.message : "";
        if (message === "Jenis pembayaran hanya boleh Tunai atau Transfer.") {
            return NextResponse.json({ ok: false, error: message }, { status: 400 });
        }
        if (message.toLowerCase().includes("unique") || message.toLowerCase().includes("no_pengajuan")) {
            return NextResponse.json({
                ok: false,
                code: "ALREADY_SUBMITTED",
                message: "Pengajuan ini sudah pernah disubmit.",
            }, { status: 409 });
        }
        console.error("[OFF CREATE BATCH ERROR]", error);
        return NextResponse.json({ ok: false, error: "Failed to create batch" }, { status: 500 });
    }
}
