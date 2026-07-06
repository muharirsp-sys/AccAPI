/*
 * Self-check kalkulasi insentif SPV. Jalankan: node --experimental-strip-types lib/insentif-spv-calc.test.ts
 * Pure, tanpa DB. Gagal → exit non-zero.
 */
import assert from "node:assert";
import { calculateInsentifSPV, ratePerPrincipalSpv, type SpvSalesRow } from "./insentif-spv-calc.ts";

const approx = (a: number, b: number, msg: string) =>
    assert.ok(Math.abs(a - b) < 1e-6, `${msg}: ${a} != ${b}`);

// --- rate table given (n=1..6) cocok persis ---
approx(ratePerPrincipalSpv(1), 1_500_000, "rate n=1");
approx(ratePerPrincipalSpv(2), 800_000, "rate n=2");
approx(ratePerPrincipalSpv(3), 600_000, "rate n=3");
approx(ratePerPrincipalSpv(4), 500_000, "rate n=4");
approx(ratePerPrincipalSpv(5), 440_000, "rate n=5");
approx(ratePerPrincipalSpv(6), 400_000, "rate n=6");
// --- ekstrapolasi n>6 (formula sama, Total(n)=1.2jt+200rb*n, rate=Total/n) ---
approx(ratePerPrincipalSpv(7), 2_600_000 / 7, "rate n=7");
approx(ratePerPrincipalSpv(10), 3_200_000 / 10, "rate n=10");
assert.strictEqual(ratePerPrincipalSpv(0), 0, "rate n=0 → 0");

const row = (principle: string, target: number, real: number, status: SpvSalesRow["statusInsentif"] = "distributor"): SpvSalesRow =>
    ({ principle, targetValue: target, realisasiValue: real, statusInsentif: status });

// === n=1..6, pencapaian 100% → total HARUS cocok "total jika full Nx" di tabel given ===
for (const [n, expectedTotal] of [[1, 1_500_000], [2, 1_600_000], [3, 1_800_000], [4, 2_000_000], [5, 2_200_000], [6, 2_400_000]] as const) {
    const rows = Array.from({ length: n }, (_, i) => row(`P${i}`, 100, 100));
    const r = calculateInsentifSPV(rows);
    assert.strictEqual(r.jumlahValid, n, `n=${n} jumlahValid`);
    approx(r.total, expectedTotal, `n=${n} total (tabel given)`);
}

// === n=0: semua principal status "principle" (full) → tidak ada yang valid ===
{
    const r = calculateInsentifSPV([row("MOTASA", 100, 100, "principle"), row("HEINZ", 100, 100, "principle")]);
    assert.strictEqual(r.jumlahValid, 0, "semua principle → 0 valid");
    assert.strictEqual(r.total, 0, "semua principle → total 0");
}

// === SUM lintas sales bawahan: 2 baris sales beda realisasi, principal sama → SUM sebelum threshold ===
{
    const rows = [
        row("NESTLE", 80, 76, "distributor"),   // sales A
        row("NESTLE", 20, 10, "distributor"),   // sales B
    ];
    const r = calculateInsentifSPV(rows);
    assert.strictEqual(r.rincian.length, 1, "1 principal (SUM, bukan 2 baris terpisah)");
    approx(r.rincian[0].targetValue, 100, "SUM target");
    approx(r.rincian[0].realisasiValue, 86, "SUM realisasi");
    approx(r.rincian[0].pctValue, 0, "86/100=0.86 <0.90 → floor 0");
}

// === exclude campur: 1 principal, 2 baris — 1 "principle" (full) + 1 "distributor" → TETAP valid, SUM keduanya ===
{
    const rows = [
        row("UNILEVER", 60, 60, "principle"),      // sales A full-principle
        row("UNILEVER", 40, 40, "distributor"),    // sales B skema
    ];
    const r = calculateInsentifSPV(rows);
    assert.strictEqual(r.jumlahValid, 1, "campur status → tetap 1 valid (ada yg distributor)");
    approx(r.rincian[0].targetValue, 100, "SUM target termasuk baris principle");
    approx(r.rincian[0].realisasiValue, 100, "SUM realisasi termasuk baris principle");
    approx(r.total, 1_500_000, "n=1 valid → rate 1.5jt, pct 100% → total 1.5jt");
}

// === threshold: >100% di-cap ===
{
    const r = calculateInsentifSPV([row("A", 100, 150), row("B", 100, 100)]);
    assert.strictEqual(r.jumlahValid, 2, "2 valid");
    approx(r.rincian[0].pctValue, 1, "150/100=1.5 → cap 1.00");
    approx(r.rincian[1].pctValue, 1, "100/100=1.0");
    approx(r.total, 1_600_000, "n=2 rate 800rb x2 pct 100% = 1.6jt");
}

console.log("OK — all insentif-spv-calc checks passed");
