/*
 * Tujuan: Unggah laporan integrasi principal jadi batch baris ternormalisasi, dan daftarnya.
 * Caller: halaman Order Principal.
 * Dependensi: lib/order-detail, db/schema (principalOrderBatch/Line, principalMapping), rbac.
 * Main Functions: GET (daftar batch / isi satu batch), POST (pratinjau atau simpan), DELETE.
 * Side Effects: DB write HANYA bila `apply=true`; tanpa itu murni pratinjau.
 *
 * Anti-ganda ada di PINTU MASUK: `file_hash` unik per principal. Faktur ganda di Accurate
 * tidak bisa dibatalkan, jadi berkas yang sama tidak boleh masuk dua kali tanpa disadari.
 */
import { createHash, randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { principalMapping, principalOrderBatch, principalOrderLine } from "@/db/schema";
import { resolveRequestPermissionsH } from "@/lib/rbac/resolve";
import { readOrderDetail, type PackInfo } from "@/lib/order-detail";

export const runtime = "nodejs";
const MAX_BYTES = 20 * 1024 * 1024;

async function packsOf(principal: string) {
    const rows = await db.select({ source: principalMapping.sourceCode, unit: principalMapping.unit, pack: principalMapping.packSize })
        .from(principalMapping)
        .where(and(eq(principalMapping.principal, principal), eq(principalMapping.kind, "item")));
    const packs = new Map<string, PackInfo>();
    for (const row of rows) packs.set(row.source, { unit: row.unit ?? "", packSize: Number(row.pack ?? 0) });
    return packs;
}

export async function GET(request: NextRequest) {
    const gate = await resolveRequestPermissionsH();
    if (gate.response) return gate.response;
    if (!gate.perms?.has("order.view")) {
        return NextResponse.json({ ok: false, error: "Akses order principal tidak diizinkan" }, { status: 403 });
    }
    const id = (request.nextUrl.searchParams.get("id") ?? "").trim();
    if (!id) {
        const batches = await db.select().from(principalOrderBatch).orderBy(desc(principalOrderBatch.uploadedAt)).limit(50);
        return NextResponse.json({ ok: true, batches });
    }
    const [batch] = await db.select().from(principalOrderBatch).where(eq(principalOrderBatch.id, id));
    if (!batch) return NextResponse.json({ ok: false, error: "Batch tidak ditemukan" }, { status: 404 });
    const lines = await db.select().from(principalOrderLine).where(eq(principalOrderLine.batchId, id)).orderBy(principalOrderLine.rowNumber);
    return NextResponse.json({ ok: true, batch, lines });
}

export async function POST(request: NextRequest) {
    const gate = await resolveRequestPermissionsH();
    if (gate.response) return gate.response;
    if (!gate.perms?.has("order.create")) {
        return NextResponse.json({ ok: false, error: "Akses unggah laporan principal tidak diizinkan" }, { status: 403 });
    }
    const form = await request.formData().catch(() => null);
    const file = form?.get("file");
    if (!(file instanceof File)) return NextResponse.json({ ok: false, error: "Pilih berkas Order Detail terlebih dahulu" }, { status: 400 });
    if (file.size > MAX_BYTES) return NextResponse.json({ ok: false, error: "Berkas maksimal 20 MB" }, { status: 413 });
    const principal = String(form?.get("principal") ?? "").trim();
    if (!principal) return NextResponse.json({ ok: false, error: "Nama principal wajib diisi" }, { status: 400 });
    const apply = String(form?.get("apply") ?? "") === "true";
    const replace = String(form?.get("replace") ?? "") === "true";

    const bytes = new Uint8Array(await file.arrayBuffer());
    const fileHash = createHash("sha256").update(bytes).digest("hex");
    const packs = await packsOf(principal);
    if (packs.size === 0) {
        return NextResponse.json({ ok: false, error: `Mapping barang untuk ${principal} belum dimuat; buka halaman Mapping Principal dulu` }, { status: 409 });
    }

    let parsed;
    try {
        parsed = readOrderDetail(bytes, packs);
    } catch {
        return NextResponse.json({ ok: false, error: "Berkas tidak bisa dibaca sebagai xlsx" }, { status: 422 });
    }

    const [existing] = await db.select({ id: principalOrderBatch.id, uploadedAt: principalOrderBatch.uploadedAt, fileName: principalOrderBatch.fileName })
        .from(principalOrderBatch)
        .where(and(eq(principalOrderBatch.principal, principal), eq(principalOrderBatch.fileHash, fileHash)));

    const summary = {
        fileName: file.name, principal, branch: parsed.branch, period: parsed.period,
        lineCount: parsed.lines.length, skipped: parsed.issues.length,
        issues: parsed.issues.slice(0, 200), unmappedProducts: parsed.unmappedProducts,
        sample: parsed.lines.slice(0, 8),
        duplicateOf: existing ? { id: existing.id, fileName: existing.fileName, uploadedAt: existing.uploadedAt } : null,
    };
    if (!apply) return NextResponse.json({ ok: true, applied: false, ...summary });

    if (existing && !replace) {
        return NextResponse.json({
            ok: false,
            error: `Berkas ini sudah pernah diunggah (${existing.fileName}, ${new Date(existing.uploadedAt).toLocaleString("id-ID")}). Centang "ganti batch lama" bila memang mau diulang.`,
            duplicateOf: existing.id,
        }, { status: 409 });
    }
    if (!parsed.lines.length) {
        return NextResponse.json({ ok: false, error: "Tidak ada satu pun baris yang bisa disimpan dari berkas ini" }, { status: 422 });
    }

    const id = randomUUID();
    await db.transaction(async (tx) => {
        if (existing) await tx.delete(principalOrderBatch).where(eq(principalOrderBatch.id, existing.id));
        await tx.insert(principalOrderBatch).values({
            id, principal, fileName: file.name, fileHash, branch: parsed.branch, period: parsed.period,
            lineCount: parsed.lines.length, skipped: parsed.issues.length, issues: parsed.issues.slice(0, 500),
            status: "parsed", uploadedBy: gate.session?.user?.email ?? "",
        });
        for (let start = 0; start < parsed.lines.length; start += 500) {
            await tx.insert(principalOrderLine).values(parsed.lines.slice(start, start + 500).map((line) => ({
                batchId: id, rowNumber: line.rowNumber, soNo: line.soNo,
                soDate: line.soDate || null, soStatus: line.soStatus,
                customerCode: line.customerCode, customerName: line.customerName, customerType: line.customerType,
                salesmanCode: line.salesmanCode, productCode: line.productCode, productName: line.productName,
                reportQty: String(line.reportQty), reportPrice: String(line.reportPrice), reportGross: String(line.reportGross),
                reportDiscount: String(line.reportTotalDiscount), reportPromo: String(line.reportTotalPromo), reportNet: String(line.reportNet),
                qty: String(line.qty), unit: line.unit, price: String(line.price),
                discounts: line.discounts, bonus: line.bonus,
            })));
        }
    });
    return NextResponse.json({ ok: true, applied: true, id, ...summary });
}

export async function DELETE(request: NextRequest) {
    const gate = await resolveRequestPermissionsH();
    if (gate.response) return gate.response;
    if (!gate.perms?.has("order.edit")) {
        return NextResponse.json({ ok: false, error: "Akses hapus batch tidak diizinkan" }, { status: 403 });
    }
    const id = (request.nextUrl.searchParams.get("id") ?? "").trim();
    if (!id) return NextResponse.json({ ok: false, error: "Parameter id wajib diisi" }, { status: 400 });
    const removed = await db.delete(principalOrderBatch).where(eq(principalOrderBatch.id, id)).returning({ id: principalOrderBatch.id });
    return NextResponse.json({ ok: true, removed: removed.length });
}
