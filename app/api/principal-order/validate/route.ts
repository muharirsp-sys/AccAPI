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
import { and, eq, gte, inArray, isNull, lte, or } from "drizzle-orm";
import { db } from "@/lib/db";
import { customer, item, principalMapping, principalOrderBatch, principalOrderLine, promoRule } from "@/db/schema";
import { resolveRequestPermissionsH } from "@/lib/rbac/resolve";
import { itemUnits, resolvePrices } from "@/lib/item-price";
import { syncItemPrices } from "@/lib/item-price-sync";
import { checkLine, checkSoPromo, matchItemRule, splitDiscounts, type DiscountAt, type PublishedRule } from "@/lib/principal-validation";

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

    // Aturan promo terbit dibaca dari `promo_rule` — tabel yang sama dengan yang ditampilkan
    // Rekap Promo. Sampai 2026-09-12 gerbang ini memakai konstanta mati `hasPublishedRules =
    // false`, jadi SETIAP klaim principal ditahan, termasuk yang aturannya sudah termuat dan
    // angkanya cocok persis. Gerbang yang menahan segalanya sama tidak bergunanya dengan
    // gerbang yang meloloskan segalanya: keduanya tidak membedakan benar dari salah.
    const soDate = String(batch.period).slice(0, 10) || new Date().toISOString().slice(0, 10);
    const publishedRules = await db.select({
        suratProgram: promoRule.suratProgram, promoGroup: promoRule.promoGroup, itemCode: promoRule.itemCode,
        tierNo: promoRule.tierNo, triggerQty: promoRule.triggerQty, triggerUnit: promoRule.triggerUnit,
        benefitType: promoRule.benefitType, benefitValue: promoRule.benefitValue, benefitBeban: promoRule.benefitBeban,
    }).from(promoRule).where(and(
        eq(promoRule.active, true),
        or(isNull(promoRule.periodStart), lte(promoRule.periodStart, soDate))!,
        or(isNull(promoRule.periodEnd), gte(promoRule.periodEnd, soDate))!,
    ));
    const rulesByItem = new Map<string, PublishedRule[]>();
    const fakturRules: PublishedRule[] = [];
    for (const row of publishedRules) {
        const rule: PublishedRule = { ...row, triggerQty: Number(row.triggerQty) };
        if (!rule.itemCode) { fakturRules.push(rule); continue; }
        if (!rulesByItem.has(rule.itemCode)) rulesByItem.set(rule.itemCode, []);
        rulesByItem.get(rule.itemCode)!.push(rule);
    }

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

    // Potongan tingkat FAKTUR diputuskan PER SO, bukan per baris: satu nominal untuk seluruh
    // SO yang dibagi rata, sehingga barang yang tidak masuk program pun ikut kebagian. Kalau
    // diperiksa per baris, justru baris yang benar yang akan dituduh.
    const soPromo = new Map<string, string>();
    const soFindings = new Map<string, string[]>();
    if (fakturRules.length > 0) {
        const perSo = new Map<string, { gross: number; claim: number; lines: number }>();
        for (const line of lines) {
            const key = String(line.soNo);
            const entry = perSo.get(key) ?? { gross: 0, claim: 0, lines: 0 };
            const discounts = (line.discounts as DiscountAt[]) ?? [];
            const split = splitDiscounts(Number(line.reportGross), discounts);
            // Ambangnya dihitung dari SELURUH belanja SO; yang dicocokkan hanya SISA klaim
            // yang belum dijelaskan aturan per barang.
            entry.gross += Number(line.reportGross);
            const itemCode = items.get(line.productCode);
            const byItem = itemCode ? matchItemRule(discounts, rulesByItem.get(itemCode) ?? [], itemCode) : null;
            if (!byItem) { entry.claim += split.principal; entry.lines += 1; }
            perSo.set(key, entry);
        }
        for (const [soNo, entry] of perSo) {
            const verdict = checkSoPromo(
                { gross: entry.gross, principalClaim: entry.claim, lineCount: entry.lines },
                fakturRules,
            );
            if (verdict.explained) soPromo.set(soNo, verdict.explained);
            if (verdict.findings.length) soFindings.set(soNo, verdict.findings);
        }
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
                rules: itemCode ? (rulesByItem.get(itemCode) ?? []) : [],
                fakturPromo: soPromo.get(String(line.soNo)),
            });
            // Temuan tingkat SO menahan SETIAP barisnya: nominalnya milik seluruh SO, jadi
            // tidak ada satu baris pun yang bisa dinyatakan benar sendirian.
            const sisi = soFindings.get(String(line.soNo)) ?? [];
            const findings = sisi.length ? [...checked.findings, ...sisi] : checked.findings;
            const status = findings.length ? "review" : "ok";
            if (status === "ok") ok += 1; else review += 1;

            await tx.update(principalOrderLine).set({
                itemCode, customerNo, salesmanInternal,
                expectedPrice: found?.price === null || found?.price === undefined ? null : String(found.price),
                priceSource: found?.source ?? null,
                discDistributor: String(checked.split.distributor),
                discPrincipal: String(checked.split.principal),
                discUnowned: String(checked.split.unowned),
                status, findings,
            }).where(and(eq(principalOrderLine.batchId, id), eq(principalOrderLine.rowNumber, line.rowNumber)));
        }
        await tx.update(principalOrderBatch).set({
            status: review > 0 ? "review" : "validated",
            okCount: ok, reviewCount: review, validatedAt: new Date(),
        }).where(eq(principalOrderBatch.id, id));
    });

    return NextResponse.json({ ok: true, id, checked: lines.length, okCount: ok, reviewCount: review, publishedRules: publishedRules.length, fakturPrograms: [...new Set(soPromo.values())], priceRefresh });
}
