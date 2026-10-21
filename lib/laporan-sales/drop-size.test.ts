/*
 * Tujuan: Uji agregasi murni Drop Size (pembagian nol, total tertimbang vs rata-rata, "Tanpa tipe", urutan, saringan cabang).
 * Caller: npx tsx --test lib/laporan-sales/drop-size.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { susunDropSize, totalDropSize, type KelompokMentah } from "./drop-size";

const k = (cabang: string | null, tipe: string | null, toko: number, faktur: number, nilai: number, tanpaDpp = 0): KelompokMentah => ({ cabang, tipe, toko, faktur, nilai, tanpaDpp });

const MENTAH = [
    k("CABANG A", "TT", 2, 4, 400),
    k("CABANG B", "TT", 1, 1, 600),
    k("CABANG A", "MT", 1, 5, 2_500, 2),
    k("CABANG B", null, 1, 2, 100, 1),
    k("CABANG A", "  ", 0, 0, 0, 3), // semua faktur dpp null: tak punya angka, hanya dihitung di fakturTanpaDpp
];

test("urut nilai turun, drop size = nilai/faktur, nilai/toko = nilai/toko, tipe kosong/null -> 'Tanpa tipe'", () => {
    const { baris, fakturTanpaDpp } = susunDropSize(MENTAH, null);
    assert.deepEqual(baris.map((b) => b.tipe), ["MT", "TT", "Tanpa tipe"]);
    assert.deepEqual(baris[1], { tipe: "TT", toko: 3, faktur: 5, nilai: 1_000, dropSize: 200, nilaiPerToko: 1_000 / 3 });
    assert.equal(baris[2].nilai, 100);
    assert.equal(fakturTanpaDpp, 6); // kelompok tanpa angka tidak jadi baris, tapi tetap terhitung
});

test("saringan cabang: hanya kelompok cabang itu; pilihanCabang tetap SEMUA cabang", () => {
    const a = susunDropSize(MENTAH, "CABANG A");
    assert.deepEqual(a.pilihanCabang, ["CABANG A", "CABANG B"]);
    assert.deepEqual(a.baris.map((b) => [b.tipe, b.nilai]), [["MT", 2_500], ["TT", 400]]);
    assert.equal(a.fakturTanpaDpp, 5);
    const tanpa = susunDropSize([k(null, "TT", 1, 1, 50), k("CABANG A", "TT", 1, 1, 70)], "Tanpa cabang");
    assert.deepEqual(tanpa.baris.map((b) => b.nilai), [50]);
    assert.deepEqual(susunDropSize(MENTAH, "CABANG X").baris, []);
});

test("pembagian nol: tanpa toko/faktur -> 0, bukan NaN/Infinity", () => {
    assert.deepEqual(susunDropSize([], null), { pilihanCabang: [], baris: [], fakturTanpaDpp: 0 });
    const t = totalDropSize([]);
    assert.deepEqual(t, { tipe: "Total", toko: 0, faktur: 0, nilai: 0, dropSize: 0, nilaiPerToko: 0 });
    const bukanToko = susunDropSize([k("CABANG A", "TT", 0, 2, 300)], null).baris[0]; // customer_no kosong: faktur ada, toko 0
    assert.equal(bukanToko.nilaiPerToko, 0);
    assert.equal(bukanToko.dropSize, 150);
});

test("total drop size TERTIMBANG (Σnilai/Σfaktur), bukan rata-rata drop size baris", () => {
    const { baris } = susunDropSize(MENTAH, null); // MT 500/faktur (5 faktur), TT 200/faktur (5 faktur), Tanpa tipe 50/faktur (2 faktur)
    const rataRata = baris.reduce((s, b) => s + b.dropSize, 0) / baris.length;
    const total = totalDropSize(baris);
    assert.equal(total.faktur, 12);
    assert.equal(total.nilai, 3_600);
    assert.equal(total.toko, 5);
    assert.equal(total.dropSize, 300);
    assert.notEqual(total.dropSize, rataRata);
    assert.equal(total.nilaiPerToko, 720);
});

test("nilai dibulatkan 2 desimal (hindari 0.1+0.2) dan urutan seri stabil menurut nama tipe", () => {
    const { baris } = susunDropSize([k("CABANG A", "TT", 1, 1, 0.1), k("CABANG B", "TT", 1, 1, 0.2), k("CABANG A", "MT", 1, 1, 0.3), k("CABANG A", "Umum", 1, 1, 0.3)], null);
    assert.equal(baris.find((b) => b.tipe === "TT")?.nilai, 0.3);
    assert.deepEqual(baris.map((b) => b.tipe), ["MT", "TT", "Umum"]);
});
