/*
 * Self-check konstanta insentif + efeknya ke kalkulasi.
 * Jalankan: node --experimental-strip-types lib/insentif-konstanta.test.ts
 * Yang dijaga: (1) tanpa `k` hasilnya SAMA seperti sebelum editor ada, (2) angka yang diubah
 * benar-benar menggeser nominal, (3) setelan rusak jatuh ke bawaan, bukan ke nol.
 */
import assert from "node:assert";
import {
    DEFAULT_KONSTANTA, parseKonstanta, validateKonstanta, setField, getField, KONSTANTA_FIELDS,
    type Konstanta,
} from "./insentif-konstanta.ts";
import { computeExclusive, computeMix, percentageMultiplier, konstantaMix } from "./insentif-sales-calc.ts";
import { computeMt } from "./insentif-mt-calc.ts";
import { rateSm } from "./insentif-sm-calc.ts";
import { ratePerPrincipalSpv, spvMultiplier } from "./insentif-spv-calc.ts";
import { pphInsentif } from "./insentif-pph.ts";

const approx = (a: number, b: number, msg: string) =>
    assert.ok(Math.abs(a - b) < 1e-6, `${msg}: ${a} != ${b}`);
const K = DEFAULT_KONSTANTA;

// --- bawaan = aturan yang berlaku sebelum editor ada ---
approx(K.gt.pool1, 1_000_000, "pool 1jt");
approx(K.gt.aoAmbang, 240, "ambang AO 240");
approx(K.gt.bobotAo + K.gt.bobotValue, 1, "bobot GT berjumlah 1");
approx(K.mt.bobotValue + K.mt.bobotEc + K.mt.bobotAo + K.mt.bobotIa, 1_000_000, "bobot MT = pool");
approx(K.mt.ambangIa, 0.8, "ambang IA 80%");
approx(ratePerPrincipalSpv(3), 600_000, "rate SPV n=3");
approx(rateSm(1.05), 2_500_000, "strata SM 100-110%");
approx(pphInsentif(1_000_000), 25_000, "PPh 2,5%");

// --- setiap field terdaftar benar-benar ada di objek konstanta ---
for (const f of KONSTANTA_FIELDS) {
    assert.ok(typeof getField(K, f.path) === "number", `field hilang: ${f.path}`);
}

// --- parse: nilai rusak/asing diabaikan, pakai bawaan (BUKAN nol) ---
{
    const p = parseKonstanta({ gt: { pool1: "banyak", aoAmbang: -5 }, sm: { nominal3: null }, asing: 1 });
    approx(p.gt.pool1, 1_000_000, "pool1 teks → bawaan");
    approx(p.gt.aoAmbang, 240, "ambang negatif → bawaan");
    approx(p.sm.nominal3, 3_500_000, "nominal null → bawaan");
    approx(parseKonstanta(null).gt.pool1, 1_000_000, "null → bawaan");
    approx(parseKonstanta({ gt: { pool1: 1e12 } }).gt.pool1, 1_000_000, "di luar batas → bawaan");
    approx(parseKonstanta({ gt: { pool1: 2_000_000 } }).gt.pool1, 2_000_000, "nilai wajar dipakai");
}

// --- validasi menolak yang salah, meloloskan yang benar ---
assert.deepEqual(validateKonstanta({ gt: { pool1: 2_000_000 } }), [], "pool naik → sah");
assert.ok(validateKonstanta({ gt: { pool1: -1 } }).length, "negatif ditolak");
assert.ok(validateKonstanta({ sm: { ambang1: 1.2 } }).length, "strata SM tidak naik ditolak");
assert.ok(validateKonstanta({ gt: { bobotAo: 0.9, bobotValue: 0.9 } }).length, "bobot > 1 ditolak");
assert.ok(validateKonstanta("bukan objek").length, "bukan objek ditolak");

// --- pengali: ambang bisa digeser ---
approx(percentageMultiplier(83.6, 100), 0, "83,6% ambang bawaan 90% → 0");
approx(percentageMultiplier(83.6, 100, 0.8), 0.836, "ambang 80% → dibayar proporsional");
approx(spvMultiplier(95, 100, 0.9), 1, "ambang SPV bisa diturunkan");

// --- GT: pool & bobot dari konstanta ---
const gtInput = {
    status: "distributor" as const,
    target_value: 100, realisasi_value: 100, realisasi_ao: 240,
};
approx(computeExclusive(gtInput).total, 1_000_000, "GT bawaan → 1jt");
{
    const k2 = setField(K, "gt.pool1", 2_000_000);
    approx(computeExclusive(gtInput, k2).total, 2_000_000, "pool 2jt → 2jt");
    const k3 = setField(K, "gt.aoAmbang", 480);
    // AO 240 vs ambang 480 = 50% → komponen AO (70%) hangus, Value tetap.
    approx(computeExclusive(gtInput, k3).total, 300_000, "ambang AO naik → AO hangus");
    const k4 = setField(setField(K, "gt.bobotAo", 0.5), "gt.bobotValue", 0.5);
    approx(computeExclusive(gtInput, k4).insentif_ao, 500_000, "bobot AO 50%");
}
approx(konstantaMix(3), 1_200_000, "pool mix n=3 bawaan");
approx(konstantaMix(3, setField(K, "gt.mix3", 2_000_000)), 2_000_000, "pool mix n=3 diubah");
{
    const anggota = [1, 2, 3].map((i) => ({
        nama: `P${i}`, status: "distributor" as const,
        target_value: 100, realisasi_value: 100, realisasi_ao: 240,
    }));
    approx(computeMix(anggota).total, 1_200_000, "mix 3 bawaan");
    approx(computeMix(anggota, setField(K, "gt.mix3", 900_000)).total, 900_000, "mix 3 diubah");
}

// --- MT: bobot & ambang IA dari konstanta ---
const mtInput = {
    status: "distributor" as const,
    target_value: 100, target_ec: 100, target_ao: 100, target_ia: 10,
    realisasi_value: 100, realisasi_ec: 100, realisasi_ao: 100, realisasi_ia: 1_000,
};
approx(computeMt(mtInput).total, 1_000_000, "MT bawaan → 1jt");
approx(computeMt({ ...mtInput, realisasi_ia: 836 }).insentif_ia, 350_000 * 0.836, "IA 83,6% → dibayar");
approx(
    computeMt({ ...mtInput, realisasi_ia: 836 }, setField(K, "mt.ambangIa", 0.9)).insentif_ia,
    0, "ambang IA dinaikkan ke 90% → 0",
);
{
    // Bobot diubah: rasio antar KPI ikut berubah, total tetap = pool.
    const k2 = setField(setField(K, "mt.bobotIa", 100_000), "mt.bobotValue", 600_000);
    const r = computeMt(mtInput, k2);
    approx(r.total, 1_000_000, "total MT tetap 1jt setelah bobot digeser");
    approx(r.insentif_ia, 100_000, "IA ikut bobot baru");
    approx(r.insentif_value, 600_000, "Value ikut bobot baru");
}

// --- SM & SPV & PPh ---
approx(rateSm(0.95, setField(K, "sm.nominal1", 1_000_000)), 1_000_000, "nominal strata SM diubah");
approx(rateSm(0.85, setField(K, "sm.ambang1", 0.8)), 1_500_000, "ambang strata SM diturunkan");
approx(ratePerPrincipalSpv(1, setField(K, "spv.rate1", 2_000_000)), 2_000_000, "rate SPV n=1 diubah");
approx(ratePerPrincipalSpv(10, setField(K, "spv.rateFloor", 300_000)), 320_000, "lantai SPV diturunkan");
approx(pphInsentif(1_000_000, 0.05), 50_000, "tarif PPh diubah");

// --- setField tidak mengubah objek asal ---
{
    const salinan: Konstanta = setField(K, "gt.pool1", 5_000_000);
    approx(K.gt.pool1, 1_000_000, "objek asal tidak berubah");
    approx(salinan.gt.pool1, 5_000_000, "salinan berubah");
}

console.log("OK insentif-konstanta");
