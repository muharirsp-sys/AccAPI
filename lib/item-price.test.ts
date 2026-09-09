/* Kunci: satuan salah = nilai order salah 72x (item M5012001000740: BAG 15.900, KRT 1.144.800).
   Urutan keputusan harga dan penolakan satuan di luar master diuji tanpa DB. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { priceForLine } from "./item-price.ts";

const tier = (price: number) => ({ price, priceCategoryName: "TT", branchName: "Kantor Pusat", effectiveDate: "2025-10-31" });

const ctx = {
    bestTier: new Map([["M5012001000740|BAG", tier(15_900)], ["M5012001000740|KRT", tier(1_144_800)]]),
    standard: new Map<string, number | null>([["M5012001000740", 15_900], ["TANPA-HARGA", null]]),
    unitsByCode: new Map([["M5012001000740", ["BAG", "KRT"]]]),
    categoryName: "TT",
};

test("satuan yang ada di master memakai harga tier-nya sendiri", () => {
    assert.deepEqual(priceForLine({ code: "M5012001000740", unit: "BAG" }, ctx).price, 15_900);
    assert.deepEqual(priceForLine({ code: "M5012001000740", unit: "krt" }, ctx).price, 1_144_800);
    assert.equal(priceForLine({ code: "M5012001000740", unit: "KRT" }, ctx).source, "tier");
});

test("satuan di luar master TIDAK boleh diam-diam memakai harga standar", () => {
    const row = priceForLine({ code: "M5012001000740", unit: "LUSIN" }, ctx);
    // Harga standar tetap dikembalikan (aturan fallback pengguna), tapi knownUnits membuat
    // pemanggil menolak. Tanpa penanda ini 3 LUSIN dihitung sebagai 3 BAG.
    assert.equal(row.source, "standard");
    assert.deepEqual(row.knownUnits, ["BAG", "KRT"]);
});

test("satuan ada di master tapi belum berharga di kategori itu = fallback standar tanpa penanda", () => {
    const noTier = { ...ctx, bestTier: new Map() };
    const row = priceForLine({ code: "M5012001000740", unit: "KRT" }, noTier);
    assert.equal(row.source, "standard");
    assert.equal(row.knownUnits, undefined);
});

test("item tanpa daftar harga tidak dapat diperiksa satuannya, dan tanpa harga standar = missing", () => {
    const noUnits = { ...ctx, unitsByCode: new Map<string, string[]>() };
    assert.equal(priceForLine({ code: "M5012001000740", unit: "LUSIN" }, noUnits).knownUnits, undefined);
    assert.equal(priceForLine({ code: "TANPA-HARGA", unit: "PCS" }, ctx).price, null);
    assert.equal(priceForLine({ code: "TIDAK-ADA", unit: "PCS" }, ctx).source, "missing");
});
