/*
 * Self-check kalkulasi insentif MT. Jalankan: node --experimental-strip-types lib/insentif-mt-calc.test.ts
 * Pure, tanpa DB. Gagal → exit non-zero.
 */
import assert from "node:assert";
import { computeMt, computeMtMix, MT_BOBOT, type MtInput } from "./insentif-mt-calc.ts";

const approx = (a: number, b: number, msg: string) =>
    assert.ok(Math.abs(a - b) < 1e-6, `${msg}: ${a} != ${b}`);

// --- bobot tabel MT: 350/150/150/350 = 1jt ---
approx(MT_BOBOT.value + MT_BOBOT.ec + MT_BOBOT.ao + MT_BOBOT.ia, 1_000_000, "total bobot MT");

// IA dibandingkan per outlet (realisasi_ia / realisasi_ao), jadi realisasi_ia = target_ia x realisasi_ao.
const full = (over = 1): MtInput => ({
    status: "distributor",
    target_value: 100, target_ec: 100, target_ao: 100, target_ia: 10,
    realisasi_value: 100 * over, realisasi_ec: 100 * over, realisasi_ao: 100 * over,
    realisasi_ia: 10 * over * (100 * over),
});

// --- 4 KPI 100% → tepat 1jt, per-KPI sesuai tabel ---
{
    const r = computeMt(full());
    approx(r.insentif_value, 350_000, "value 100%");
    approx(r.insentif_ec, 150_000, "ec 100%");
    approx(r.insentif_ao, 150_000, "ao 100%");
    approx(r.insentif_ia, 350_000, "ia 100%");
    approx(r.total, 1_000_000, "total 100%");
}

// --- >100% di-cap (tidak melebihi 1jt) ---
approx(computeMt(full(3)).total, 1_000_000, "300% tetap cap 1jt");

// --- <90% per KPI → KPI itu 0, KPI lain tetap jalan ---
{
    const r = computeMt({ ...full(), realisasi_ao: 50 });
    approx(r.insentif_ao, 0, "ao 50% → 0");
    approx(r.total, 1_000_000 - 150_000, "sisa KPI tetap dibayar");
}

// --- 95% → aktual (bukan 0, bukan penuh) ---
approx(computeMt(full(0.95)).total, 950_000, "95% → 95% × 1jt");

// --- OA MT memakai target BARIS, bukan konstanta 240 (khusus GT) ---
// Target OA MT di file target berkisar 34-70. Kalau 240 ikut kepakai, realisasi 65 jadi 27% -> 0.
{
    const r = computeMt({
        ...full(), target_ao: 63, realisasi_ao: 65,
        target_ia: 40, realisasi_ia: 40 * 65,
    });
    approx(r.insentif_ao, 150_000, "OA 65 vs target baris 63 -> penuh (bukan 0 seperti kalau dibagi 240)");
}

// --- target 0 → KPI itu 0 (hindari bagi nol) ---
approx(computeMt({ ...full(), target_ia: 0 }).insentif_ia, 0, "target IA 0 → 0");
// --- IA dinilai per outlet: total mentah besar tapi AO besar juga → tetap tidak otomatis penuh ---
{
    const r = computeMt({ ...full(), realisasi_ia: 500 }); // 500/100 = 5 per outlet vs target 10 → 50%
    approx(r.insentif_ia, 0, "IA 5 vs target 10 per outlet → <90% → 0");
}
// --- realisasi_ao 0 → IA tak bisa dihitung per outlet → 0 (hindari bagi nol) ---
approx(computeMt({ ...full(), realisasi_ao: 0 }).insentif_ia, 0, "AO 0 → IA 0");

// --- status "principle" (full principle) → tidak ikut skema ---
approx(computeMt({ ...full(), status: "principle" }).total, 0, "status principle → 0");

// --- support mengurangi pool proporsional; "distributor" abaikan support ---
{
    const r = computeMt({ ...full(), status: "distributor_principle", nilai_support_principal: 700_000 });
    approx(r.total, 300_000, "support 700rb → distributor 300rb");
    approx(r.insentif_value, 350_000 * 0.3, "value ikut proporsional");
    approx(computeMt({ ...full(), nilai_support_principal: 700_000 }).total, 1_000_000, "status distributor → support diabaikan");
}
// support >= pool → 0
approx(computeMt({ ...full(), status: "distributor_principle", nilai_support_principal: 1_000_000 }).total, 0, "support penuh → 0");

// === MIX: 2 principle 100% → konstanta GT n=2 (1jt), dibagi rata ===
{
    const r = computeMtMix([
        { nama: "MUSTIKA", ...full() },
        { nama: "PRISKILA", ...full() },
    ]);
    assert.strictEqual(r.jumlah_valid, 2, "2 principle valid");
    approx(r.konstanta, 1_000_000, "konstanta n=2");
    approx(r.total, 1_000_000, "mix 2 principle 100% → 1jt total (bukan 2jt)");
    approx(r.rincian[0].total, 500_000, "per principle rata");
}

// --- MIX 1 principle valid (sisanya full principle) → pool 1jt utuh ---
{
    const r = computeMtMix([
        { nama: "MUSTIKA", ...full() },
        { nama: "MOTASA", ...full(), status: "principle" },
    ]);
    assert.strictEqual(r.jumlah_valid, 1, "cuma 1 valid");
    approx(r.total, 1_000_000, "1 valid → 1jt");
}

// --- MIX >5 principle → cap konstanta 1,5jt ---
{
    const r = computeMtMix(Array.from({ length: 7 }, (_, i) => ({ nama: `P${i}`, ...full() })));
    approx(r.konstanta, 1_500_000, "n=7 → cap 1,5jt");
    approx(r.total, 1_500_000, "total = pool");
}

console.log("OK insentif-mt-calc");
