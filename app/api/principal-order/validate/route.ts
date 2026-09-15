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
import { and, eq, inArray, ne } from "drizzle-orm";
import { db } from "@/lib/db";
import { customer, item, orderDupeAck, principalMapping, principalOrderBatch, principalOrderLine, promoOutlet, promoRule } from "@/db/schema";
import { resolveRequestPermissionsH } from "@/lib/rbac/resolve";
import { itemUnits, resolvePrices } from "@/lib/item-price";
import { syncItemPrices } from "@/lib/item-price-sync";
import { berlakuPada, bonusQuota, checkLine, checkSoPromo, isBonusLine, matchItemRule, outletAllowed,
    outletListsOn, splitDiscounts, type DiscountAt, type PublishedRule } from "@/lib/principal-validation";
import { duplicateFinding, findDuplicate, type OrderFingerprint } from "@/lib/order-duplicate";

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
    // Periodenya TIDAK disaring di SQL memakai periode batch. Satu berkas bisa memuat lebih
    // dari satu tanggal SO, dan aturan bisa berganti di antaranya — menyaring sekali di muka
    // berarti seluruh batch dinilai dengan aturan tanggal yang salah, diam-diam. Aturannya
    // ratusan baris saja, jadi disaring per baris memakai `so_date` miliknya sendiri.
    const batchDate = String(batch.period).slice(0, 10) || new Date().toISOString().slice(0, 10);
    const dateOf = (line: { soDate: string | null }) => String(line.soDate ?? "").slice(0, 10) || batchDate;
    const publishedRules = await db.select({
        suratProgram: promoRule.suratProgram, promoGroup: promoRule.promoGroup, itemCode: promoRule.itemCode,
        customerCode: promoRule.customerCode,
        periodStart: promoRule.periodStart, periodEnd: promoRule.periodEnd,
        tierNo: promoRule.tierNo, triggerQty: promoRule.triggerQty, triggerUnit: promoRule.triggerUnit,
        benefitType: promoRule.benefitType, benefitValue: promoRule.benefitValue, benefitBeban: promoRule.benefitBeban,
        outletList: promoRule.outletList, outletListMode: promoRule.outletListMode,
    }).from(promoRule).where(eq(promoRule.active, true));

    // Daftar outlet peserta (mis. LOYALTY). Surat sendiri yang menyebutnya: BP2609007713 dan
    // BP2609007664 "KHUSUS CHANNEL GT PESERTA LOYALTY", BP2609006016 "EXCLUDE LOYALTY".
    // Disaring per TANGGAL SO seperti aturannya, karena keanggotaan berganti tiap kuartal.
    const outletMembers = await db.select({
        listName: promoOutlet.listName, customerCode: promoOutlet.customerCode,
        periodStart: promoOutlet.periodStart, periodEnd: promoOutlet.periodEnd, active: promoOutlet.active,
    }).from(promoOutlet);
    const listsByDate = new Map<string, Map<string, Set<string>>>();
    const listsOn = (date: string) => {
        const ada = listsByDate.get(date);
        if (ada) return ada;
        const baru = outletListsOn(outletMembers, date);
        listsByDate.set(date, baru);
        return baru;
    };
    const rulesByItem = new Map<string, PublishedRule[]>();
    const fakturRules: PublishedRule[] = [];
    // Tarif Discount Reguler melekat pada OUTLET, bukan barang: satu baris melayani seluruh
    // belanja outlet itu, jadi dikelompokkan per outlet dan disambungkan ke baris lewat
    // kode internal pelanggannya (tanpa akhiran cabang, seperti yang tercetak di tarifnya).
    const tariffByCustomer = new Map<string, PublishedRule[]>();
    for (const row of publishedRules) {
        const rule: PublishedRule = { ...row, triggerQty: Number(row.triggerQty) };
        if (rule.customerCode) {
            const key = rule.customerCode.toUpperCase();
            if (!tariffByCustomer.has(key)) tariffByCustomer.set(key, []);
            tariffByCustomer.get(key)!.push(rule);
            continue;
        }
        if (!rule.itemCode) { fakturRules.push(rule); continue; }
        if (!rulesByItem.has(rule.itemCode)) rulesByItem.set(rule.itemCode, []);
        rulesByItem.get(rule.itemCode)!.push(rule);
    }
    /** Kode pelanggan Accurate baris ini (dengan akhiran cabang), atau null bila belum dipetakan. */
    const customerNoOf = (line: { customerCode: string }) => {
        const base = customers.get(line.customerCode);
        return base ? `${base}${suffix}` : null;
    };

    /** Tarif outlet ini, dicari dengan kode internal maupun kode ber-akhiran cabang. */
    const tariffOf = (base: string | null, customerNo: string | null): PublishedRule[] =>
        (base ? tariffByCustomer.get(base.toUpperCase()) : undefined)
        ?? (customerNo ? tariffByCustomer.get(customerNo.toUpperCase()) : undefined)
        ?? [];
    /**
     * Aturan yang benar-benar berlaku untuk baris ini: tanggalnya masuk periode DAN outletnya
     * memang peserta daftar yang ditunjuk aturan itu. Dua syarat, satu saringan — supaya tidak
     * ada jalur pencocokan yang lupa menanyakan salah satunya.
     */
    const berlaku = (rules: PublishedRule[], date: string, customerNo?: string | null) =>
        rules.filter((rule) => berlakuPada(rule, date) && outletAllowed(rule, customerNo, listsOn(date)));

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
        const perSo = new Map<string, { gross: number; claim: number; lines: number; date: string; customerNo: string | null }>();
        for (const line of lines) {
            const key = String(line.soNo);
            const entry = perSo.get(key) ?? { gross: 0, claim: 0, lines: 0, date: dateOf(line), customerNo: customerNoOf(line) };
            const discounts = (line.discounts as DiscountAt[]) ?? [];
            const split = splitDiscounts(Number(line.reportGross), discounts);
            // Ambangnya dihitung dari SELURUH belanja SO; yang dicocokkan hanya SISA klaim
            // yang belum dijelaskan aturan per barang.
            entry.gross += Number(line.reportGross);
            const itemCode = items.get(line.productCode);
            const byItem = itemCode
                ? matchItemRule(discounts, berlaku(rulesByItem.get(itemCode) ?? [], dateOf(line), customerNoOf(line)), itemCode)
                : null;
            if (!byItem) { entry.claim += split.principal; entry.lines += 1; }
            perSo.set(key, entry);
        }
        for (const [soNo, entry] of perSo) {
            const verdict = checkSoPromo(
                { gross: entry.gross, principalClaim: entry.claim, lineCount: entry.lines },
                berlaku(fakturRules, entry.date, entry.customerNo),
            );
            if (verdict.explained) soPromo.set(soNo, verdict.explained);
            if (verdict.findings.length) soFindings.set(soNo, verdict.findings);
        }
    }

    // KUOTA BONUS per SO, dihitung sebelum baris mana pun dinilai.
    //
    // Baris bonus pada laporan principal berharga penuh lalu dipotong 100%, sedangkan jumlah
    // BELINYA ada di baris lain. Tanpa pemeriksaan se-SO, "beli 10 pcs dapat bonus 1 pcs" akan
    // lolos gerbang dengan sempurna: barangnya benar, aturannya ada, persennya 100 seperti
    // seharusnya. Ambangnya dihitung dalam SATUAN TERKECIL (`reportQty`), karena satu SO
    // mencampur KRT dan PCS pada barang yang sama.
    const overQuota = new Map<string, string>();
    {
        const perSoLines = new Map<string, typeof lines>();
        for (const line of lines) {
            const key = String(line.soNo);
            perSoLines.set(key, [...(perSoLines.get(key) ?? []), line]);
        }
        for (const [soNo, isi] of perSoLines) {
            const date = dateOf(isi[0]);
            const aturanBonus = publishedRules
                .filter((rule) => rule.benefitType === "BONUS_QTY" && rule.itemCode && berlakuPada(rule, date)
                    && outletAllowed(rule, customerNoOf(isi[0]), listsOn(date)))
                .map((rule) => ({
                    itemCode: rule.itemCode, suratProgram: rule.suratProgram, promoGroup: rule.promoGroup,
                    triggerQty: Number(rule.triggerQty) || 0, benefitValue: rule.benefitValue,
                }));
            if (!aturanBonus.length) continue;
            const kuota = bonusQuota(isi.map((line) => ({
                key: `${soNo}#${line.rowNumber}`,
                itemCode: items.get(line.productCode) ?? "",
                quantity: Number(line.reportQty) || 0,
                bonus: line.bonus || isBonusLine((line.discounts as DiscountAt[]) ?? []),
            })), aturanBonus);
            for (const grup of kuota) {
                for (const key of grup.overKeys) {
                    overQuota.set(key, `Bonus melewati kuota ${grup.promoGroup}: pembelian ${grup.purchased} `
                        + `berhak ${grup.entitled}, tetapi diberikan ${grup.given}. Aturannya "setiap ${grup.trigger}" — `
                        + "bonus tanpa pembeliannya bukan bonus.");
                }
            }
        }
    }

    // GERBANG ORDER GANDA. Satu SO yang outletnya sama dan barangnya MIRIP dengan SO lain pada
    // tanggal yang sama ditahan sampai ada manusia yang menyatakan ia sudah memeriksanya.
    //
    // Yang dicari bukan yang identik saja. Order ganda yang isinya persis sama masih mungkin
    // ketahuan mata; yang berbahaya justru yang hampir sama — satu order diketik ulang karena
    // yang pertama dikira gagal, lalu satu barang ditambah. Keduanya lalu terlihat sebagai order
    // berbeda, dan barangnya keluar gudang dua kali.
    //
    // Dibandingkan dengan SO pada batch INI maupun batch lain milik principal yang sama: order
    // ganda paling sering justru lahir dari unggahan kedua, bukan dari satu berkas.
    const dupeFindings = new Map<string, string>();
    {
        const perSo = new Map<string, OrderFingerprint>();
        for (const line of lines) {
            const soNo = String(line.soNo);
            const entry = perSo.get(soNo) ?? {
                key: soNo, outlet: String(line.customerCode ?? ""), orderDate: dateOf(line), itemCodes: [],
            };
            entry.itemCodes.push(items.get(line.productCode) ?? line.productCode);
            perSo.set(soNo, entry);
        }
        const lain = await db.select({
            soNo: principalOrderLine.soNo, soDate: principalOrderLine.soDate,
            customerCode: principalOrderLine.customerCode, productCode: principalOrderLine.productCode,
            itemCode: principalOrderLine.itemCode,
        }).from(principalOrderLine)
            .innerJoin(principalOrderBatch, eq(principalOrderBatch.id, principalOrderLine.batchId))
            .where(and(eq(principalOrderBatch.principal, batch.principal), ne(principalOrderLine.batchId, id)));
        const perSoLain = new Map<string, OrderFingerprint>();
        for (const row of lain) {
            const soNo = String(row.soNo);
            if (perSo.has(soNo)) continue; // SO yang sama dari unggahan lama bukan order kedua.
            const entry = perSoLain.get(soNo) ?? {
                key: soNo, outlet: String(row.customerCode ?? ""),
                orderDate: String(row.soDate ?? "").slice(0, 10), itemCodes: [],
            };
            entry.itemCodes.push(row.itemCode || row.productCode);
            perSoLain.set(soNo, entry);
        }
        const semua = [...perSo.values(), ...perSoLain.values()];
        const sudahDikonfirmasi = new Set((await db.select({ soNo: orderDupeAck.soNo })
            .from(orderDupeAck).where(eq(orderDupeAck.principal, batch.principal))).map((row) => row.soNo));
        for (const [soNo, sidik] of perSo) {
            if (sudahDikonfirmasi.has(soNo)) continue;
            const hit = findDuplicate(sidik, semua);
            if (hit) dupeFindings.set(soNo, duplicateFinding(hit, `SO ${soNo}`));
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
                rules: berlaku([
                    ...(itemCode ? (rulesByItem.get(itemCode) ?? []) : []),
                    ...tariffOf(base, customerNo),
                ], dateOf(line), customerNo),
                fakturPromo: soPromo.get(String(line.soNo)),
                bonusOverQuota: overQuota.get(`${line.soNo}#${line.rowNumber}`),
            });
            // Temuan tingkat SO menahan SETIAP barisnya: nominalnya milik seluruh SO, jadi
            // tidak ada satu baris pun yang bisa dinyatakan benar sendirian.
            const sisi = soFindings.get(String(line.soNo)) ?? [];
            // Temuan order ganda juga menahan SELURUH SO: yang diduga ganda adalah ordernya,
            // bukan satu barisnya.
            const dupe = dupeFindings.get(String(line.soNo));
            const findings = [...checked.findings, ...sisi, ...(dupe ? [dupe] : [])];
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
