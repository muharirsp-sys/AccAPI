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


// ═══ Support principle utk SPV ═══════════════════════════════════════════════
// Kasus MARTEN (dikonfirmasi user): 3 principal, MOTASA support 4,17jt.
// rate n=3 = 600rb; 4,17jt >= 600rb -> MOTASA keluar -> n=2, rate 800rb.
{
    const rows = [row("MOTASA", 100, 100), row("FORISA", 100, 100), row("PURATOS", 100, 100)];
    const r = calculateInsentifSPV(rows, new Map([["MOTASA", 4_172_278]]));
    assert.strictEqual(r.jumlahValid, 2, "MOTASA keluar -> n=2");
    approx(r.ratePerPrincipal, 800_000, "rate naik ke n=2");
    assert.deepStrictEqual(r.dikecualikan, ["MOTASA"], "MOTASA tercatat dikecualikan");
    approx(r.total, 1_600_000, "2 principal x 800rb");
    assert.ok(!r.rincian.some((d) => d.principle === "MOTASA"), "MOTASA tidak muncul di rincian");
}

// Kasus YARMAN: 1 principal (KINO) support 300rb, rate n=1 = 1,5jt.
// 300rb < 1,5jt -> tetap dihitung, distributor bayar sisanya 1,2jt.
{
    const r = calculateInsentifSPV([row("KINO", 100, 100)], new Map([["KINO", 300_000]]));
    assert.strictEqual(r.jumlahValid, 1, "KINO tetap dihitung (support sebagian)");
    approx(r.ratePerPrincipal, 1_500_000, "rate n=1");
    approx(r.rincian[0].porsiDistributor, 1_200_000, "distributor bayar rate - support");
    approx(r.total, 1_200_000, "total 1,2jt");
    assert.deepStrictEqual(r.dikecualikan, [], "tidak ada yang dikecualikan");
}

// Tanpa support -> perilaku lama tidak berubah.
{
    const rows = [row("A", 100, 100), row("B", 100, 100), row("C", 100, 100)];
    approx(calculateInsentifSPV(rows).total, 1_800_000, "tanpa support = perilaku lama n=3");
    approx(calculateInsentifSPV(rows, new Map()).total, 1_800_000, "peta support kosong sama saja");
}

// Support tepat SAMA dengan rate -> tertutup penuh, keluar dari hitungan.
{
    const rows = [row("A", 100, 100), row("B", 100, 100)];
    const r = calculateInsentifSPV(rows, new Map([["A", 800_000]]));
    assert.strictEqual(r.jumlahValid, 1, "support == rate -> keluar");
    approx(r.ratePerPrincipal, 1_500_000, "sisa 1 principal -> rate n=1");
}

// Semua principal tertutup penuh -> SPV tidak dapat apa pun dari distributor.
{
    const r = calculateInsentifSPV([row("A", 100, 100), row("B", 100, 100)],
        new Map([["A", 9_000_000], ["B", 9_000_000]]));
    assert.strictEqual(r.jumlahValid, 0, "semua tertutup -> 0 valid");
    approx(r.total, 0, "total 0");
    assert.strictEqual(r.dikecualikan.length, 2, "dua-duanya tercatat dikecualikan");
}

// Pengecualian dilakukan SERENTAK (batch), bukan satu per satu — hasilnya tidak bergantung
// urutan pemeriksaan. n=3 rate 600rb: A=650rb dan B=700rb dua-duanya >= 600rb, jadi keluar
// bersamaan; sisa C dihitung pada rate n=1.
// CATATAN: ini titik yang masih ambigu di spec. Kalau dibuang satu per satu (A dulu, rate naik
// 800rb, lalu B=700rb tidak lagi tertutup) hasilnya 900rb, bukan 1,5jt. Batch dipilih karena
// deterministik — hasil per-orang tidak boleh bergantung urutan iterasi. Contoh MARTEN dari
// user tidak membedakan keduanya (support 4,17jt jauh di atas rate mana pun).
{
    const rows = [row("A", 100, 100), row("B", 100, 100), row("C", 100, 100)];
    const r = calculateInsentifSPV(rows, new Map([["A", 650_000], ["B", 700_000]]));
    assert.deepStrictEqual(r.dikecualikan.sort(), ["A", "B"], "A & B keluar serentak");
    assert.strictEqual(r.jumlahValid, 1, "sisa C");
    approx(r.ratePerPrincipal, 1_500_000, "rate n=1");
    approx(r.total, 1_500_000, "C dapat rate penuh n=1");
}

// Support pada principal berstatus full-principle tidak mengacaukan hitungan.
{
    const r = calculateInsentifSPV(
        [row("A", 100, 100), row("MOTASA", 100, 100, "principle")],
        new Map([["MOTASA", 5_000_000]]),
    );
    assert.strictEqual(r.jumlahValid, 1, "MOTASA sudah keluar lewat status, bukan support");
    approx(r.total, 1_500_000, "A dapat rate n=1 penuh");
}

console.log("OK support SPV");

console.log("OK — all insentif-spv-calc checks passed");
