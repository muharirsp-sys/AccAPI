/*
 * Self-check kalkulasi insentif GT. Jalankan: node --experimental-strip-types lib/insentif-sales-calc.test.ts
 * Pure, tanpa DB. Gagal → exit non-zero.
 */
import assert from "node:assert";
import {
    percentageMultiplier,
    computeExclusive,
    computeMix,
    normalizeStatus,
    normalizeTipe,
    type MixPrincipalInput,
} from "./insentif-sales-calc.ts";

const approx = (a: number, b: number, msg: string) =>
    assert.ok(Math.abs(a - b) < 1e-6, `${msg}: ${a} != ${b}`);

// --- threshold ---
assert.strictEqual(percentageMultiplier(89, 100), 0, "<0.90 → 0");
approx(percentageMultiplier(95, 100), 0.95, "0.90–1.00 → aktual");
assert.strictEqual(percentageMultiplier(150, 100), 1, ">1.00 → cap 1.00");
assert.strictEqual(percentageMultiplier(10, 0), 0, "target 0 → 0");

// === CASE 1 (spec): Exclusive, support 700rb, pencapaian 100% → distributor 300rb (210k AO + 90k Value) ===
{
    const r = computeExclusive({
        status: "distributor_principle",
        target_value: 100, realisasi_value: 100, realisasi_ao: 240,
        nilai_support_principal: 700_000,
    });
    approx(r.total, 300_000, "CASE1 total");
    approx(r.insentif_ao, 210_000, "CASE1 AO (70%)");
    approx(r.insentif_value, 90_000, "CASE1 Value (30%)");
}

// exclusive: support 0 → distributor penuh 1jt
approx(
    computeExclusive({ status: "distributor", target_value: 100, realisasi_value: 100, realisasi_ao: 240 }).total,
    1_000_000, "excl distributor penuh",
);

// exclusive: support >= 1jt → 0
assert.strictEqual(
    computeExclusive({ status: "distributor_principle", target_value: 100, realisasi_value: 100, realisasi_ao: 240, nilai_support_principal: 1_000_000 }).total,
    0, "support>=1jt → 0",
);

// exclusive: status principle (full principle) → 0
assert.strictEqual(
    computeExclusive({ status: "principle", target_value: 100, realisasi_value: 100, realisasi_ao: 240 }).total,
    0, "excl status principle → 0",
);

// exclusive: AO <90% → komponen AO 0, Value tetap
{
    const r = computeExclusive({ status: "distributor", target_value: 100, realisasi_value: 100, realisasi_ao: 200 });
    assert.strictEqual(r.insentif_ao, 0, "AO <0.90 → 0");
    approx(r.insentif_value, 300_000, "Value tetap (0.3*1jt)");
}

// === CASE 2 (spec): Mix 3 principle, support total 700rb, pencapaian 100% → distributor 500rb ===
{
    const base = { target_value: 100, realisasi_value: 100, realisasi_ao: 240 };
    const r = computeMix([
        { nama: "A", status: "distributor_principle", ...base, nilai_support_principal: 700_000 },
        { nama: "B", status: "distributor", ...base },
        { nama: "C", status: "distributor", ...base },
    ]);
    assert.strictEqual(r.jumlah_valid, 3, "CASE2 count");
    approx(r.konstanta, 1_200_000, "CASE2 konstanta");
    approx(r.total_support, 700_000, "CASE2 total support");
    approx(r.porsi_distributor, 500_000, "CASE2 porsi distributor");
    approx(r.insentif_value, 150_000, "CASE2 Value (0.3*500k)");
    approx(r.total_ao, 350_000, "CASE2 AO (0.7*500k)");
    approx(r.total, 500_000, "CASE2 total");
}

// mix: pegang 4 principle tapi 1 status=principle → dihitung 3 (konstanta 1.2jt)
{
    const base = { target_value: 100, realisasi_value: 100, realisasi_ao: 240 };
    const r = computeMix([
        { nama: "A", status: "distributor_principle", ...base },
        { nama: "B", status: "distributor", ...base },
        { nama: "C", status: "distributor", ...base },
        { nama: "D", status: "principle", ...base }, // full principle → tidak dihitung
    ]);
    assert.strictEqual(r.jumlah_valid, 3, "4 principle, 1 full → count 3");
    approx(r.konstanta, 1_200_000, "konstanta 3 bukan 4");
    assert.strictEqual(r.rincian.length, 3, "rincian hanya principle skema");
}

// mix: alokasi Value proporsional ke target_value; sum baris = total salesman
{
    const r = computeMix([
        { nama: "A", status: "distributor", target_value: 300, realisasi_value: 300, realisasi_ao: 240 },
        { nama: "B", status: "distributor", target_value: 100, realisasi_value: 100, realisasi_ao: 240 },
    ]);
    // konstanta 1jt, support 0 → Value global = 0.3*1jt = 300k; A share 75%, B 25%.
    approx(r.rincian[0].insentif_value, 225_000, "alloc Value A (75%)");
    approx(r.rincian[1].insentif_value, 75_000, "alloc Value B (25%)");
    const sumValue = r.rincian.reduce((s, x) => s + x.insentif_value, 0);
    const sumTotal = r.rincian.reduce((s, x) => s + x.total, 0);
    approx(sumValue, r.insentif_value, "sum alloc Value == global");
    approx(sumTotal, r.total, "sum baris total == total salesman");
}

// mix: support >= konstanta → 0
{
    const base = { target_value: 100, realisasi_value: 100, realisasi_ao: 240 };
    const r = computeMix([
        { nama: "A", status: "distributor_principle", ...base, nilai_support_principal: 1_000_000 },
        { nama: "B", status: "distributor_principle", ...base, nilai_support_principal: 500_000 },
    ]);
    approx(r.konstanta, 1_000_000, "mix K(2)");
    assert.strictEqual(r.total, 0, "support>=konstanta → 0");
}

// mix: konstanta by count 2..5 + cap
const mk = (n: number): MixPrincipalInput[] =>
    Array.from({ length: n }, (_, i) => ({ nama: `P${i}`, status: "distributor" as const, target_value: 100, realisasi_value: 100, realisasi_ao: 240 }));
approx(computeMix(mk(2)).konstanta, 1_000_000, "K(2)");
approx(computeMix(mk(3)).konstanta, 1_200_000, "K(3)");
approx(computeMix(mk(4)).konstanta, 1_400_000, "K(4)");
approx(computeMix(mk(5)).konstanta, 1_500_000, "K(5)");
approx(computeMix(mk(6)).konstanta, 1_500_000, "K(6) cap 1.5jt");
assert.strictEqual(computeMix(mk(1)).total, 0, "mix <2 valid → 0");

// --- normalisasi Excel ---
assert.strictEqual(normalizeStatus("Distributor+Principle"), "distributor_principle", "norm D+P");
assert.strictEqual(normalizeStatus(" principle "), "principle", "norm principle");
assert.strictEqual(normalizeStatus("Distributor"), "distributor", "norm distributor");
assert.throws(() => normalizeStatus("xxx"), "status tak dikenal → throw");
assert.strictEqual(normalizeTipe("Mix"), "mix", "norm mix");
assert.strictEqual(normalizeTipe("Eksklusif"), "exclusive", "norm exclusive");
assert.throws(() => normalizeTipe("zzz"), "tipe tak dikenal → throw");

console.log("OK — all insentif-sales-calc checks passed");
