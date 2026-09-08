/*
 * Tujuan: Menentukan harga jual yang berlaku untuk satu baris order, dari data Accurate.
 * Caller: app/api/orders/preview (dan nanti jalur order/faktur).
 * Dependensi: db/schema (itemSellingPrice, item, customer).
 * Main Functions: resolvePrices — harga bertingkat per kategori pelanggan, fallback harga standar.
 * Side Effects: DB read-only.
 *
 * Aturan (dibuktikan live 2026-09-08, lihat docs/prd/ACCURATE_API_REFERENCE.md):
 * - `item.detailSellingPrice[]` adalah daftar harga YANG BERLAKU, satu baris per
 *   (kategori harga x satuan x cabang) dengan `effectiveDate` = kapan mulai berlaku.
 * - Ambil `effectiveDate` TERBESAR yang <= tanggal order. Baris bertanggal masa depan
 *   (kenaikan terjadwal) sengaja diabaikan sampai tanggalnya tiba.
 * - Cabang mengikuti itemnya: tidak dipaksa ke satu cabang. Urutan pemilihan CABANG DULU
 *   (cabang order -> cabang default -> id terkecil), BARU tanggal berlaku terbesar di dalam
 *   cabang itu. Urutan sebaliknya membuat cabang lain menang hanya karena harganya paling
 *   baru diperbarui.
 * - Fallback: kalau tidak ada baris harga yang cocok, pakai `item.unitPrice` (harga standar).
 * - Satuan yang SAH untuk sebuah item = satuan yang punya baris harga di `item_selling_price`
 *   (mis. `M5012001000740` hanya BAG dan KRT). Satuan di luar daftar itu bukan fallback yang
 *   aman: harga standar item ini per BAG, jadi "3 LUSIN" bernilai 72x salah. `itemUnits`
 *   adalah sumber pilihan satuan di UI, dan `knownUnits` pada hasil adalah penolakannya.
 */
import { and, eq, inArray, lte, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { customer, item, itemSellingPrice } from "@/db/schema";

export type PriceRequest = { code: string; unit: string };
export type PriceResult = {
    code: string;
    unit: string;
    price: number | null;
    source: "tier" | "standard" | "missing";
    priceCategoryName?: string;
    branchName?: string;
    effectiveDate?: string;
    // Satuan diminta tidak ada di daftar harga padahal satuan lain ada: tanda kuat satuannya
    // salah. Harga standar tetap dipakai (aturan fallback), tapi jangan sampai tidak terlihat —
    // harga standar item ini per BAG, jadi "3 LUSIN" akan bernilai salah tanpa peringatan.
    knownUnits?: string[];
};

// Satuan master per kode: distinct dari daftar harga Accurate. Dipakai UI untuk membatasi
// pilihan satuan, dan resolvePrices untuk menandai satuan yang tidak ada di master.
export async function itemUnits(codes: string[]): Promise<Map<string, string[]>> {
    const clean = [...new Set(codes.map((code) => code.trim()).filter(Boolean))];
    if (clean.length === 0) return new Map();
    const rows = await db.selectDistinct({ itemNo: itemSellingPrice.itemNo, unitName: itemSellingPrice.unitName })
        .from(itemSellingPrice).where(inArray(itemSellingPrice.itemNo, clean));
    const units = new Map<string, string[]>();
    for (const row of rows) {
        if (!row.unitName) continue;
        if (!units.has(row.itemNo)) units.set(row.itemNo, []);
        units.get(row.itemNo)!.push(row.unitName);
    }
    for (const list of units.values()) list.sort();
    return units;
}

type LineContext = {
    // Kunci `${code}|${unit}` -> baris harga terpilih untuk kategori pelanggan.
    bestTier: Map<string, { price: number; priceCategoryName: string; branchName: string; effectiveDate: string }>;
    standard: Map<string, number | null>;
    unitsByCode: Map<string, string[]>;
    categoryName?: string;
};

// Pure supaya urutan keputusan bisa diuji tanpa DB: tier -> harga standar -> tidak ada harga,
// dan satuan di luar master selalu terlihat lewat knownUnits.
export function priceForLine(line: PriceRequest, ctx: LineContext): PriceResult {
    const code = line.code.trim();
    const unit = line.unit.trim().toUpperCase();
    const known = ctx.unitsByCode.get(code) ?? [];
    const unitOutsideMaster = known.length > 0 && !known.includes(unit);
    const tier = unitOutsideMaster ? undefined : ctx.bestTier.get(`${code}|${unit}`);
    if (tier) {
        return {
            code, unit, price: tier.price, source: "tier",
            priceCategoryName: tier.priceCategoryName || ctx.categoryName,
            branchName: tier.branchName, effectiveDate: tier.effectiveDate,
        };
    }
    const fallback = ctx.standard.get(code);
    if (fallback === null || fallback === undefined) return { code, unit, price: null, source: "missing" };
    return {
        code, unit, price: fallback, source: "standard",
        ...(unitOutsideMaster ? { knownUnits: known } : {}),
    };
}

export async function customerPriceCategory(customerNo: string) {
    if (!customerNo.trim()) return null;
    const [row] = await db.select({ id: customer.priceCategoryId, name: customer.priceCategoryName })
        .from(customer).where(eq(customer.customerNo, customerNo.trim())).limit(1);
    return row?.id ? { id: row.id, name: row.name ?? "" } : null;
}

export async function resolvePrices(
    lines: PriceRequest[],
    options: { orderDate: string; customerNo?: string; branchId?: number } = { orderDate: new Date().toISOString().slice(0, 10) },
): Promise<PriceResult[]> {
    const codes = [...new Set(lines.map((line) => line.code.trim()).filter(Boolean))];
    if (codes.length === 0) return [];

    const category = options.customerNo ? await customerPriceCategory(options.customerNo) : null;

    // Harga standar dulu: dipakai sebagai fallback dan untuk item tanpa daftar harga.
    const standardRows = await db.select({ no: item.no, unitPrice: item.unitPrice })
        .from(item).where(inArray(item.no, codes));
    const standard = new Map(standardRows.map((row) => [row.no, row.unitPrice]));

    let tiers: {
        itemNo: string; unitName: string; price: number; effectiveDate: string;
        branchId: number; branchName: string; defaultBranch: boolean; priceCategoryName: string;
    }[] = [];
    if (category) {
        // Satu baris per (item, satuan), dipilih dengan urutan di orderBy di bawah:
        // cabang dulu, lalu tanggal berlaku terbesar <= tanggal order. Deterministik supaya
        // harga tidak berubah antar pemanggilan untuk masukan yang sama.
        const preferred = options.branchId ?? -1;
        tiers = await db
            .select({
                itemNo: itemSellingPrice.itemNo, unitName: itemSellingPrice.unitName,
                price: itemSellingPrice.price, effectiveDate: itemSellingPrice.effectiveDate,
                branchId: itemSellingPrice.branchId, branchName: itemSellingPrice.branchName,
                defaultBranch: itemSellingPrice.defaultBranch, priceCategoryName: itemSellingPrice.priceCategoryName,
            })
            .from(itemSellingPrice)
            .where(and(
                inArray(itemSellingPrice.itemNo, codes),
                eq(itemSellingPrice.priceCategoryId, category.id),
                lte(itemSellingPrice.effectiveDate, options.orderDate),
            ))
            // CABANG DULU, baru tanggal berlaku. Kalau tanggal ditaruh lebih dulu, cabang mana
            // pun yang harganya paling baru diperbarui akan menang — harga cabang lain terpakai
            // diam-diam. Terbukti 2026-09-08: MIX FOOD mengalahkan Kantor Pusat karena
            // tanggalnya lebih baru sehari.
            .orderBy(
                itemSellingPrice.itemNo, itemSellingPrice.unitName,
                sql`(${itemSellingPrice.branchId} = ${preferred}) desc`,
                sql`${itemSellingPrice.defaultBranch} desc`,
                itemSellingPrice.branchId,
                sql`${itemSellingPrice.effectiveDate} desc`,
            );
    }

    const bestTier = new Map<string, (typeof tiers)[number]>();
    for (const row of tiers) {
        const key = `${row.itemNo}|${row.unitName}`;
        if (!bestTier.has(key)) bestTier.set(key, row);
    }

    // Satuan master diambil lepas dari kategori: pelanggan tanpa kategori harga pun tidak boleh
    // memasukkan satuan yang tidak ada pada itemnya.
    const unitsByCode = await itemUnits(codes);
    const ctx = { bestTier, standard, unitsByCode, categoryName: category?.name };
    return lines.map((line) => priceForLine(line, ctx));
}
