/*
 * Tujuan: Validasi tahap 1 satu batch — item, pelanggan, harga, dan pecahan diskon.
 * Caller: halaman Order Principal, tombol "Validasi".
 * Dependensi: lib/principal-validation, lib/item-price, db/schema, rbac.
 *
 * Harga dicari per pelanggan DAN per cabang pelanggan; lihat catatan di dekat `branchOf`.
 * Main Functions: POST.
 * Side Effects: Menulis hasil pemeriksaan ke `principal_order_line` dan hitungan ke batch.
 *
 * Hasil terjemahan (kode barang, pelanggan, salesman) DISIMPAN, bukan dihitung ulang saat
 * kirim: mapping bisa berubah setelah batch ditinjau, dan faktur wajib memakai angka yang
 * benar-benar dilihat manusia.
 */
import { NextRequest, NextResponse } from "next/server";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { customer, item, principalMapping, principalOrderBatch, principalOrderLine } from "@/db/schema";
import { resolveRequestPermissionsH } from "@/lib/rbac/resolve";
import { itemUnits, resolvePrices } from "@/lib/item-price";
import { syncItemPrices } from "@/lib/item-price-sync";
import { checkLine, type DiscountAt } from "@/lib/principal-validation";

export const runtime = "nodejs";

/** Akhiran cabang Accurate milik principal ini; satu outlet punya satu customerNo per cabang. */
const BRANCH_SUFFIX: Record<string, string> = { "KINO NON FOOD": "-KN" };

async function mappingOf(principal: string, kind: "item" | "customer" | "salesman") {
    const rows = await db.select({ source: principalMapping.sourceCode, target: principalMapping.targetCode })
        .from(principalMapping).where(and(eq(principalMapping.principal, principal), eq(principalMapping.kind, kind)));
    return new Map(rows.map((row) => [row.source, row.target]));
}

export async function POST(request: NextRequest) {
    const gate = await resolveRequestPermissionsH();
    if (gate.response) return gate.response;
    if (!gate.perms?.has("order.create")) {
        return NextResponse.json({ ok: false, error: "Akses validasi batch tidak diizinkan" }, { status: 403 });
    }
    const id = (request.nextUrl.searchParams.get("id") ?? "").trim();
    if (!id) return NextResponse.json({ ok: false, error: "Parameter id wajib diisi" }, { status: 400 });

    const [batch] = await db.select().from(principalOrderBatch).where(eq(principalOrderBatch.id, id));
    if (!batch) return NextResponse.json({ ok: false, error: "Batch tidak ditemukan" }, { status: 404 });
    const lines = await db.select().from(principalOrderLine).where(eq(principalOrderLine.batchId, id)).orderBy(principalOrderLine.rowNumber);
    if (!lines.length) return NextResponse.json({ ok: false, error: "Batch ini tidak punya baris" }, { status: 422 });

    const [items, customers, salesmen] = await Promise.all([
        mappingOf(batch.principal, "item"),
        mappingOf(batch.principal, "customer"),
        mappingOf(batch.principal, "salesman"),
    ]);
    const suffix = BRANCH_SUFFIX[batch.principal] ?? "";

    // ponytail: aturan promo terbit tinggal di SQLite backend Python, bukan di Postgres ini,
    // jadi belum bisa ditanya dari sini. Ditahan pada `false` DENGAN SENGAJA — artinya setiap
    // klaim principal wajib ditinjau manusia. Gagal tertutup: potongan yang tertahan bisa
    // dilepas, potongan yang terlanjur masuk faktur tidak bisa ditarik.
    // Upgrade: panggil `GET /summary/library/published` pada FastAPI dan bandingkan hasil
    // `calculate()` per faktur, bukan sekadar boolean ini.
    const hasPublishedRules = false;

    const itemCodes = [...new Set(lines.map((line) => items.get(line.productCode)).filter(Boolean) as string[])];
    let priceRefresh: { ok: boolean; error?: string; processed?: number; priceRows?: number } | null = null;
    const customerNos = [...new Set(lines.map((line) => {
        const base = customers.get(line.customerCode);
        return base ? `${base}${suffix}` : null;
    }).filter(Boolean) as string[])];

    // Harga jual di cache bisa TERTINGGAL: `sync-item-prices` tidak pernah masuk cron, jadi
    // satu-satunya penyegar selama ini adalah tangan manusia. Akibatnya admin yang baru saja
    // memperbaiki harga di Accurate tetap melihat baris tertahan, dan tidak punya cara
    // menjalankan ulang sync-nya dari layar. `?prices=1` menyegarkan HANYA barang pada batch
    // ini lebih dulu — puluhan item, bukan 4.182, jadi hitungan detik bukan 21 menit.
    if (request.nextUrl.searchParams.get("prices") === "1" && itemCodes.length) {
        try {
            priceRefresh = await syncItemPrices({ itemNos: itemCodes });
        } catch (error) {
            // Gagal menyegarkan BUKAN alasan membatalkan validasi: harga lama tetap dipakai
            // dan barisnya tetap tertahan bila berselisih — gagal tertutup, seperti biasa.
            priceRefresh = { ok: false, error: error instanceof Error ? error.message : "penyegaran harga gagal" };
        }
    }

    const [knownItems, knownCustomers, unitsByCode] = await Promise.all([
        itemCodes.length ? db.select({ no: item.no }).from(item).where(inArray(item.no, itemCodes)) : Promise.resolve([]),
        customerNos.length ? db.select({ no: customer.customerNo, branchId: customer.branchId }).from(customer).where(inArray(customer.customerNo, customerNos)) : Promise.resolve([]),
        itemUnits(itemCodes),
    ]);
    const itemSet = new Set(knownItems.map((row) => row.no));
    const customerSet = new Set(knownCustomers.map((row) => row.no));
    // Cabang pelanggan WAJIB ikut ke pencarian harga. Daftar harga Accurate punya satu baris
    // per (kategori x satuan x CABANG), dan kenaikan harga sering hanya terbit di cabang
    // principalnya. Contoh nyata 11 Sep 2026: item K1082002002010 SCH kategori MT berharga
    // 7.207 di cabang KINO NON FOOD (berlaku 1 Agu 2026) tetapi masih 6.306 di 21 cabang
    // lain. Tanpa cabang, pemilih jatuh ke cabang default (Kantor Pusat) dan mengambil harga
    // lama — 47 dari 53 baris tertahan sebagai "selisih harga" yang sebenarnya tidak ada.
    const branchOf = new Map(knownCustomers.map((row) => [row.no, row.branchId ?? undefined]));

    // Harga dilihat per pelanggan: kategori harga berbeda memberi harga berbeda untuk item sama.
    const priceByKey = new Map<string, { price: number | null; source: string }>();
    const grouped = new Map<string, { code: string; unit: string }[]>();
    for (const line of lines) {
        const itemCode = items.get(line.productCode);
        const base = customers.get(line.customerCode);
        if (!itemCode || !base) continue;
        const customerNo = `${base}${suffix}`;
        if (!grouped.has(customerNo)) grouped.set(customerNo, []);
        grouped.get(customerNo)!.push({ code: itemCode, unit: line.unit });
    }
    for (const [customerNo, wanted] of grouped) {
        const results = await resolvePrices(wanted, {
            orderDate: String(batch.period).slice(0, 10) || new Date().toISOString().slice(0, 10),
            customerNo,
            branchId: branchOf.get(customerNo),
        });
        for (const result of results) priceByKey.set(`${customerNo}|${result.code}|${result.unit}`, { price: result.price, source: result.source });
    }

    let ok = 0;
    let review = 0;
    await db.transaction(async (tx) => {
        for (const line of lines) {
            const itemCode = items.get(line.productCode) ?? null;
            const base = customers.get(line.customerCode) ?? null;
            const customerNo = base ? `${base}${suffix}` : null;
            const salesmanInternal = salesmen.get(line.salesmanCode) ?? null;
            const found = itemCode && customerNo ? priceByKey.get(`${customerNo}|${itemCode}|${line.unit.toUpperCase()}`) : undefined;

            const checked = checkLine({
                productCode: line.productCode, itemCode, itemExists: itemCode ? itemSet.has(itemCode) : false,
                customerCode: line.customerCode, customerNo, customerExists: customerNo ? customerSet.has(customerNo) : false,
                salesmanCode: line.salesmanCode, salesmanInternal,
                unit: line.unit, knownUnits: itemCode ? (unitsByCode.get(itemCode) ?? []) : [],
                price: Number(line.price), expectedPrice: found?.price ?? null,
                // ISI baris ini, dibaca dari apa yang sudah terjadi: qty laporan (satuan
                // terkecil) dibagi qty faktur. Baris yang tidak naik ke KRT menghasilkan 1.
                unitRatio: Number(line.qty) > 0 ? Number(line.reportQty) / Number(line.qty) : 1,
                gross: Number(line.reportGross), reportDiscount: Number(line.reportDiscount),
                discounts: (line.discounts as DiscountAt[]) ?? [], bonus: line.bonus,
                hasPublishedRules,
            });
            if (checked.status === "ok") ok += 1; else review += 1;

            await tx.update(principalOrderLine).set({
                itemCode, customerNo, salesmanInternal,
                expectedPrice: found?.price === null || found?.price === undefined ? null : String(found.price),
                priceSource: found?.source ?? null,
                discDistributor: String(checked.split.distributor),
                discPrincipal: String(checked.split.principal),
                discUnowned: String(checked.split.unowned),
                status: checked.status, findings: checked.findings,
            }).where(and(eq(principalOrderLine.batchId, id), eq(principalOrderLine.rowNumber, line.rowNumber)));
        }
        await tx.update(principalOrderBatch).set({
            status: review > 0 ? "review" : "validated",
            okCount: ok, reviewCount: review, validatedAt: new Date(),
        }).where(eq(principalOrderBatch.id, id));
    });

    return NextResponse.json({ ok: true, id, checked: lines.length, okCount: ok, reviewCount: review, hasPublishedRules, priceRefresh });
}
