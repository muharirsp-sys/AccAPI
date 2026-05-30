import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { offBatch, offBatchItem, offPayment } from "@/db/schema";
import { buildNoPengajuan, buildSearchHaystack, canActorAccessOffData, canActorPerformOffAction, computeOffFinancePaymentSummary, computeOffPaymentSummary, findDuplicateNoSuratWithinPayload, findOffNoSuratConflicts, getPrincipleByCode, getPrincipleByName, matchesSearch, parseCurrency, publicBatch, publicPayment, requireOffSession, resolveProgramTypeForSave, writeOffAudit } from "@/lib/off-program-control";

// PPh masih HOLD. NOTE: PPh disiapkan nullable di level item/toko, tetapi
// perhitungan final ditahan karena masih terkait format kwitansi setelah pembayaran.
function nullableNumber(value: unknown) {
    if (value === undefined || value === null || value === "") return null;
    const parsed = parseCurrency(value);
    return Number.isFinite(parsed) ? parsed : null;
}

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
        const resolvedType = resolveProgramTypeForSave(
            row.type ?? row.normalizedType,
            row.originalType,
        );
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
            type: resolvedType.normalizedType,
            normalizedType: resolvedType.normalizedType,
            originalType: resolvedType.originalType || resolvedType.normalizedType,
            typeIsLegacy: resolvedType.typeIsLegacy,
            // PPh HOLD: nullable, tidak memblokir submit.
            pphExempt: bool(row.pphExempt),
            pphAmount: nullableNumber(row.pphAmount),
            adjustmentPph: nullableNumber(row.adjustmentPph),
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

// --- Filter periode (revisi C) ---
// periodType menentukan tanggal mana yang difilter:
//  - "program"   : periode program (item.periode, format "YYYY-MM-DD - YYYY-MM-DD")
//  - "pengajuan"  : tanggal pengajuan (batch.createdAt / submittedAt)
//  - "claim"      : tanggal diajukan Claim (batch.claimSubmittedDate)
//  - "bayar"      : tanggal bayar (payment.paymentDate / batch.paymentDate)
// Filter gabungan: month-year ATAU range dateFrom-dateTo.
type PeriodFilter = {
    periodType: string;
    month: string;
    year: string;
    dateFrom: string;
    dateTo: string;
};

function toIsoDate(value: unknown): string {
    if (!value) return "";
    if (value instanceof Date) return value.toISOString().slice(0, 10);
    const raw = String(value).trim();
    const match = raw.match(/\d{4}-\d{2}-\d{2}/);
    return match ? match[0] : "";
}

function collectPeriodDates(
    batch: typeof offBatch.$inferSelect,
    items: Array<typeof offBatchItem.$inferSelect>,
    payments: Array<typeof offPayment.$inferSelect>,
    periodType: string,
): string[] {
    switch (periodType) {
        case "program": {
            const dates: string[] = [];
            for (const item of items) {
                const periode = String(item.periode || "");
                for (const part of periode.split(" - ")) {
                    const iso = toIsoDate(part);
                    if (iso) dates.push(iso);
                }
            }
            return dates;
        }
        case "claim":
            return [toIsoDate(batch.claimSubmittedDate)].filter(Boolean);
        case "bayar":
            return [
                ...payments.map((payment) => toIsoDate(payment.paymentDate)),
                toIsoDate(batch.paymentDate),
            ].filter(Boolean);
        case "pengajuan":
        default:
            return [toIsoDate(batch.submittedAt), toIsoDate(batch.createdAt)].filter(Boolean);
    }
}

function dateMatchesWindow(date: string, filter: PeriodFilter): boolean {
    if (filter.dateFrom || filter.dateTo) {
        if (filter.dateFrom && date < filter.dateFrom) return false;
        if (filter.dateTo && date > filter.dateTo) return false;
        return true;
    }
    if (filter.year || filter.month) {
        const [yy, mm] = date.split("-");
        if (filter.year && yy !== filter.year) return false;
        if (filter.month && mm !== String(filter.month).padStart(2, "0")) return false;
        return true;
    }
    return true;
}

function matchesPeriodFilter(
    batch: typeof offBatch.$inferSelect,
    items: Array<typeof offBatchItem.$inferSelect>,
    payments: Array<typeof offPayment.$inferSelect>,
    filter: PeriodFilter,
): boolean {
    const hasFilter = Boolean(filter.month || filter.year || filter.dateFrom || filter.dateTo);
    if (!hasFilter) return true;
    const dates = collectPeriodDates(batch, items, payments, filter.periodType);
    if (dates.length === 0) return false;
    return dates.some((date) => dateMatchesWindow(date, filter));
}

// Haystack pencarian batch termasuk item/toko nested (revisi D).
function buildBatchSearchText(
    batch: typeof offBatch.$inferSelect,
    items: Array<typeof offBatchItem.$inferSelect>,
): string {
    return buildSearchHaystack([
        batch.noPengajuan,
        batch.principleName,
        batch.principleCode,
        batch.supervisorName,
        batch.status,
        batch.smStatus,
        batch.claimStatus,
        batch.omStatus,
        batch.financeStatus,
        batch.finalStatus,
        batch.noClaim,
        ...items.flatMap((item) => [
            item.noSurat,
            item.noClaim,
            item.namaProgram,
            item.toko,
            item.barang,
            item.type,
            item.normalizedType,
            item.originalType,
        ]),
    ]);
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

export async function GET(request: Request) {
    const actor = await requireOffSession();
    if (!actor) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    if (!canActorAccessOffData(actor)) {
        return NextResponse.json({ ok: false, error: "Role Anda tidak memiliki akses OFF Program Control." }, { status: 403 });
    }

    // Revisi C/D: filter periode + pencarian dilakukan di backend bila parameter dikirim.
    // Default tanpa parameter mengembalikan data seperti sebelumnya (tidak kosong tiba-tiba).
    const url = new URL(request.url);
    const search = url.searchParams.get("search") || "";
    const periodType = (url.searchParams.get("periodType") || "").trim();
    const month = (url.searchParams.get("month") || "").trim();
    const year = (url.searchParams.get("year") || "").trim();
    const dateFrom = (url.searchParams.get("dateFrom") || "").trim();
    const dateTo = (url.searchParams.get("dateTo") || "").trim();

    try {
        const rows = await db.select().from(offBatch).orderBy(desc(offBatch.createdAt)).limit(200);
        const items = await db.select().from(offBatchItem);
        const payments = await db.select().from(offPayment);
        const summaries = new Map<string, { totalRows: number; totalNominal: number; transfer: number; tunai: number }>();
        const paymentSummaries = new Map<string, { totalNominal: number; totalPaid: number; remainingAmount: number; isFullyPaid: boolean }>();
        const paymentsByBatch = new Map<string, Array<typeof offPayment.$inferSelect>>();
        const itemsByBatch = new Map<string, Array<typeof offBatchItem.$inferSelect>>();
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
            itemsByBatch.set(row.id, batchItems);
            paymentsByBatch.set(row.id, batchPayments);
            paymentSummaries.set(row.id, computeOffFinancePaymentSummary(paymentSummary.total, batchPayments));
        });

        const filteredRows = rows.filter((row) => {
            const batchItems = itemsByBatch.get(row.id) || [];
            const batchPayments = paymentsByBatch.get(row.id) || [];
            if (!matchesPeriodFilter(row, batchItems, batchPayments, { periodType, month, year, dateFrom, dateTo })) {
                return false;
            }
            if (!search) return true;
            return matchesSearch(buildBatchSearchText(row, batchItems), search);
        });

        return NextResponse.json({
            ok: true,
            batches: filteredRows.map((row) => ({
                ...publicBatch(row),
                payments: (paymentsByBatch.get(row.id) || []).map(publicPayment),
                summary: summaries.get(row.id),
                paymentSummary: paymentSummaries.get(row.id),
                // Revisi D: searchText precomputed (termasuk item/toko) agar pencarian
                // client bisa membaca isi pengajuan tanpa fetch tambahan.
                searchText: buildBatchSearchText(row, itemsByBatch.get(row.id) || []),
                // Revisi C: periodDates precomputed agar filter periode konsisten di
                // semua monitor tanpa fetch tambahan per jenis tanggal.
                periodDates: {
                    program: collectPeriodDates(row, itemsByBatch.get(row.id) || [], paymentsByBatch.get(row.id) || [], "program"),
                    pengajuan: collectPeriodDates(row, itemsByBatch.get(row.id) || [], paymentsByBatch.get(row.id) || [], "pengajuan"),
                    claim: collectPeriodDates(row, itemsByBatch.get(row.id) || [], paymentsByBatch.get(row.id) || [], "claim"),
                    bayar: collectPeriodDates(row, itemsByBatch.get(row.id) || [], paymentsByBatch.get(row.id) || [], "bayar"),
                },
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
