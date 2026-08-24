/*
 * Self-check kalkulasi insentif SM. Jalankan: node --experimental-strip-types lib/insentif-sm-calc.test.ts
 * Pure, tanpa DB. Gagal → exit non-zero.
 */
import assert from "node:assert";
import { calculateInsentifSM, rateSm, isSmBerhak, isOfficeRow, type SmSalesRow } from "./insentif-sm-calc.ts";

// --- tabel strata persis seperti yang diberikan user ---
assert.strictEqual(rateSm(0.0), 0, "0% → 0");
assert.strictEqual(rateSm(0.8999), 0, "89,99% → 0");
assert.strictEqual(rateSm(0.9), 1_500_000, "90% → 1,5jt (batas bawah inklusif)");
assert.strictEqual(rateSm(0.95), 1_500_000, "95% → 1,5jt");
assert.strictEqual(rateSm(0.9999), 1_500_000, "99,99% → 1,5jt (celah 99-100 masuk strata bawah)");
assert.strictEqual(rateSm(1.0), 2_500_000, "100% → 2,5jt");
assert.strictEqual(rateSm(1.0999), 2_500_000, "109,99% → 2,5jt");
assert.strictEqual(rateSm(1.1), 3_500_000, "110% → 3,5jt");
assert.strictEqual(rateSm(5.0), 3_500_000, "500% tetap 3,5jt (tidak ada strata di atasnya)");

// --- whitelist SM ---
assert.ok(isSmBerhak("HENDRIK"), "HENDRIK ikut skema");
assert.ok(isSmBerhak(" hendrik "), "case & spasi tidak menggagalkan match");
assert.ok(isSmBerhak("PAK HENDRIK"), "prefiks gelar tetap kena");
assert.ok(!isSmBerhak("ADNAN"), "ADNAN TIDAK ikut skema");
assert.ok(!isSmBerhak(""), "nama kosong tidak berhak");

// --- baris _OFFICE bukan salesman ---
assert.ok(isOfficeRow("M-FN_OFFICE", "OFFICE"), "kode _OFFICE kena");
assert.ok(isOfficeRow("M-XX1", "Office Support"), "nama saja pun kena");
assert.ok(!isOfficeRow("FS1", "GITO ADAM SAPUTRA"), "salesman biasa tidak kena");

let seq = 0;
const row = (target: number, real: number, status: SmSalesRow["statusInsentif"] = "distributor_principle"): SmSalesRow =>
    ({ salesCode: `S${seq++}`, salesName: "SALES", targetValue: target, realisasiValue: real, statusInsentif: status });
const office = (target: number, real: number): SmSalesRow =>
    ({ salesCode: "M-FN_OFFICE", salesName: "OFFICE", targetValue: target, realisasiValue: real, statusInsentif: "distributor_principle" });

// Agregat lintas principal/SPV: yang dipakai total, bukan per-baris.
{
    const r = calculateInsentifSM("HENDRIK", [row(100, 40), row(100, 65)]);
    assert.strictEqual(r.targetValue, 200);
    assert.strictEqual(r.realisasiValue, 105);
    assert.ok(Math.abs(r.pctValue - 0.525) < 1e-9, "pct dari total");
    assert.strictEqual(r.total, 0, "52,5% → 0 walau salah satu baris tembus");
}
// 105% → 2,5jt
{
    const r = calculateInsentifSM("HENDRIK", [row(1_000_000_000, 1_050_000_000)]);
    assert.strictEqual(r.total, 2_500_000, "105% → 2,5jt");
}
// ADNAN: sudah 130% pun tetap 0.
{
    const r = calculateInsentifSM("ADNAN", [row(100, 130)]);
    assert.strictEqual(r.berhak, false);
    assert.strictEqual(r.total, 0, "ADNAN tidak dapat insentif SM");
    assert.ok(Math.abs(r.pctValue - 1.3) < 1e-9, "pct tetap dilaporkan utk tampilan");
}
// Baris full-principle (ENERGIZER) IKUT dihitung untuk SM — beda dari skema Sales/SPV.
{
    // Tanpa baris ENERGIZER pencapaiannya cuma 60% → Rp 0. Dengan ikut → 100% → Rp 2,5jt.
    const r = calculateInsentifSM("HENDRIK", [row(100, 60), row(100, 140, "principle")]);
    assert.strictEqual(r.jumlahBaris, 2, "baris principle ikut dihitung");
    assert.strictEqual(r.targetValue, 200, "baris principle ikut ke target SM");
    assert.strictEqual(r.realisasiValue, 200, "baris principle ikut ke realisasi SM");
    assert.strictEqual(r.total, 2_500_000, "100% → 2,5jt (kalau principle dibuang jadi 0)");
}
// Baris _OFFICE dibuang dari agregat, sekalipun bawa target besar.
{
    const r = calculateInsentifSM("HENDRIK", [row(100, 100), office(900, 0)]);
    assert.strictEqual(r.jumlahBaris, 1, "hanya baris sales yang dihitung");
    assert.strictEqual(r.targetValue, 100, "target _OFFICE dibuang");
    assert.strictEqual(r.total, 2_500_000, "kalau _OFFICE ikut, pct jadi 10% → 0");
}

// Target 0 tidak boleh jadi Infinity/NaN.
{
    const r = calculateInsentifSM("HENDRIK", [row(0, 5_000_000)]);
    assert.strictEqual(r.pctValue, 0);
    assert.strictEqual(r.total, 0, "target 0 → tidak ada strata");
}
// Tidak ada baris sama sekali.
{
    const r = calculateInsentifSM("HENDRIK", []);
    assert.strictEqual(r.total, 0);
}

console.log("OK — all insentif-sm-calc checks passed");
