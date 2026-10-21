/*
 * Tujuan: Uji fungsi murni Top 30 (batas bulan, peringkat: urut nilai vs qty, batas 30, seri stabil, pembulatan, satuan).
 * Caller: `npx tsx --test lib/laporan-sales/top30.test.ts` (juga ikut `npm test`).
 * Dependensi: lib/laporan-sales/top30 (tanpa menyentuh DB).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { BATAS, batasBulan, peringkat, type Mentah } from "./top30";

const m = (kode: string, nilai: number, qty: number, over: Partial<Mentah> = {}): Mentah => ({ kode, nama: `PRODUK ${kode}`, nilai, qty, faktur: 1, satuan: "KRT", ...over });

test("batasBulan: batas atas = awal bulan berikut, Desember lompat tahun, Februari tidak bergantung jumlah hari", () => {
    assert.deepEqual(batasBulan("2026-09"), ["2026-09-01", "2026-10-01"]);
    assert.deepEqual(batasBulan("2026-12"), ["2026-12-01", "2027-01-01"]);
    assert.deepEqual(batasBulan("2024-02"), ["2024-02-01", "2024-03-01"]);
});

test("urut nilai vs qty menghasilkan urutan berbeda dari data yang sama", () => {
    const data = [m("A", 100, 5), m("B", 300, 1), m("C", 200, 9)];
    assert.deepEqual(peringkat(data, "nilai").map((b) => b.kode), ["B", "C", "A"]);
    assert.deepEqual(peringkat(data, "qty").map((b) => b.kode), ["C", "A", "B"]);
});

test("peringkat 1..N berurutan dan dibatasi 30 teratas", () => {
    const data = Array.from({ length: 35 }, (_, i) => m(`K${String(i).padStart(2, "0")}`, i + 1, 1));
    const hasil = peringkat(data, "nilai");
    assert.equal(BATAS, 30);
    assert.equal(hasil.length, 30);
    assert.deepEqual(hasil.map((b) => b.peringkat), Array.from({ length: 30 }, (_, i) => i + 1));
    assert.equal(hasil[0].kode, "K34"); // nilai terbesar 35
    assert.equal(hasil[29].kode, "K05"); // 30 teratas = nilai 35..6; nilai 5..1 terbuang
    assert.equal(peringkat(data, "nilai", 3).length, 3);
    assert.deepEqual(peringkat([], "nilai"), []);
});

test("seri nilai: metrik satunya, lalu kode — hasil sama untuk urutan masukan apa pun", () => {
    const data = [m("C", 100, 5), m("A", 100, 5), m("B", 100, 9), m("D", 100, 1)];
    const harapan = ["B", "A", "C", "D"]; // qty 9 dulu; qty sama (A, C) → kode naik; D qty terkecil
    assert.deepEqual(peringkat(data, "nilai").map((b) => b.kode), harapan);
    assert.deepEqual(peringkat([...data].reverse(), "nilai").map((b) => b.kode), harapan);
    // urut qty, seri qty → nilai menentukan
    const qty = [m("X", 50, 7), m("Y", 90, 7), m("Z", 90, 7)];
    assert.deepEqual(peringkat(qty, "qty").map((b) => b.kode), ["Y", "Z", "X"]);
    // masukan tidak diubah
    assert.deepEqual(data.map((b) => b.kode), ["C", "A", "B", "D"]);
});

test("pembulatan terjadi SESUDAH urut: dua nilai yang sama setelah dibulatkan tetap terurut menurut nilai asli", () => {
    const hasil = peringkat([m("A", 100.2, 1), m("B", 100.4, 1)], "nilai");
    assert.deepEqual(hasil.map((b) => [b.kode, b.nilai]), [["B", 100], ["A", 100]]);
    assert.equal(peringkat([m("A", 1568088288.312433, 0.1 + 0.2)], "nilai")[0].nilai, 1568088288);
    assert.equal(peringkat([m("A", 1, 0.1 + 0.2)], "nilai")[0].qty, 0.3); // 0.30000000000000004 → 0.3
});

test("satuan: tunggal = satu elemen; campur = beberapa (terurut); kosong = []", () => {
    const [tunggal, campur, tanpa] = peringkat([m("A", 3, 1, { satuan: "KRT" }), m("B", 2, 1, { satuan: "SCH,KRT" }), m("C", 1, 1, { satuan: "" })], "nilai");
    assert.deepEqual(tunggal.satuan, ["KRT"]);
    assert.deepEqual(campur.satuan, ["KRT", "SCH"]);
    assert.deepEqual(tanpa.satuan, []);
});
