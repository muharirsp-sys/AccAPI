/*
 * Uji MURNI tab Coverage Ganda (lib/laporan-sales/coverage.ts susunCoverage) — tanpa DB. Data contoh generik (PRINCIPLE A, TOKO A, SALES A).
 * Jalankan: npx tsx --test lib/laporan-sales/coverage.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { kodeBaku, susunCoverage, type BarisJks } from "./coverage";

const j = (salesCode: string, custCode: string, principle = "PRINCIPLE A", o: Partial<BarisJks> = {}): BarisJks => ({
    salesCode, salesName: `Nama ${salesCode}`, custCode, custName: `TOKO ${custCode}`, principle, hariKunjungan: "Senin", mingguPattern: "all", ...o,
});

test("kodeBaku: trim + huruf besar, null aman", () => {
    assert.equal(kodeBaku("  c-100 a "), "C-100 A");
    assert.equal(kodeBaku(null), "");
    assert.equal(kodeBaku(undefined), "");
});

test("pengelompokan: > 1 salesman untuk (toko, principal) = ganda; 1 salesman bukan; principal berbeda bukan ganda", () => {
    const r = susunCoverage([
        j("SALES B", "C-1", "PRINCIPLE A", { hariKunjungan: "Selasa", mingguPattern: "ganjil" }),
        j("SALES A", "C-1", "PRINCIPLE A", { hariKunjungan: "Senin", mingguPattern: "all" }),
        j("SALES A", "C-2"),                       // satu salesman: bukan ganda
        j("SALES A", "C-3", "PRINCIPLE A"), j("SALES B", "C-3", "PRINCIPLE B"), // dua salesman tetapi beda principal: bukan ganda
    ], null, null);
    assert.equal(r.baris.length, 1);
    assert.deepEqual(r.baris[0], {
        custCode: "C-1", custName: "TOKO C-1", principle: "PRINCIPLE A",
        salesman: [  // urut kode salesman, bukan urutan masuk
            { salesCode: "SALES A", salesNama: "Nama SALES A", hari: "Senin", minggu: "all" },
            { salesCode: "SALES B", salesNama: "Nama SALES B", hari: "Selasa", minggu: "ganjil" },
        ],
    });
    assert.equal(r.totalToko, 3);
    assert.deepEqual(r.pilihanPrincipal, ["PRINCIPLE A", "PRINCIPLE B"]);
});

test("normalisasi: kode toko/salesman/principal beda spasi & huruf dianggap sama", () => {
    // toko sama ditulis 'c-1 ' dan 'C-1', salesman beda -> ganda, bukan dua toko
    const ganda = susunCoverage([j("SALES A", "c-1 "), j("SALES B", "C-1", "principle a ")], null, null);
    assert.equal(ganda.baris.length, 1);
    assert.equal(ganda.baris[0].custCode, "C-1");
    assert.equal(ganda.baris[0].principle, "PRINCIPLE A");
    assert.equal(ganda.totalToko, 1);
    // salesman sama ditulis ' sales a' dan 'SALES A' -> satu salesman -> BUKAN ganda
    assert.deepEqual(susunCoverage([j(" sales a", "C-1"), j("SALES A", "c-1")], null, null).baris, []);
});

test("satu salesman dengan dua baris JKS toko sama BUKAN ganda; bersama salesman lain baris digabung (hari unik)", () => {
    assert.deepEqual(susunCoverage([j("SALES A", "C-1", "PRINCIPLE A", { hariKunjungan: "Senin" }), j("sales a", "C-1", "PRINCIPLE A", { hariKunjungan: "Kamis" })], null, null).baris, []);
    const r = susunCoverage([
        j("SALES A", "C-1", "PRINCIPLE A", { hariKunjungan: "Senin" }), j("sales a ", "C-1", "PRINCIPLE A", { hariKunjungan: "Kamis", mingguPattern: "GENAP" }),
        j("SALES B", "C-1", "PRINCIPLE A", { hariKunjungan: "senin" }), j("SALES B", "C-1", "PRINCIPLE A", { hariKunjungan: "SENIN" }),
    ], null, null);
    assert.equal(r.baris.length, 1);
    assert.deepEqual(r.baris[0].salesman.map((s) => [s.salesCode, s.hari, s.minggu]), [["SALES A", "Senin, Kamis", "all, genap"], ["SALES B", "senin", "all"]]);
});

test("hari/minggu kosong (null) jadi string kosong; nama salesman kosong jatuh ke kode", () => {
    const r = susunCoverage([j("SALES A", "C-1", "PRINCIPLE A", { hariKunjungan: null, mingguPattern: null, salesName: " " }), j("SALES B", "C-1")], null, null);
    assert.deepEqual(r.baris[0].salesman[0], { salesCode: "SALES A", salesNama: "SALES A", hari: "", minggu: "" });
});

test("cakupan non-global: kelompok dengan SATU salesman dalam cakupan tampil UTUH; tanpa salesman cakupan disembunyikan", () => {
    const rows = [
        j("SALES A", "C-1"), j("SALES X", "C-1"),                     // A di cakupan, X di luar -> tampil, dua-duanya
        j("SALES X", "C-2"), j("SALES Y", "C-2"),                     // tidak ada yang di cakupan -> disembunyikan
        j("SALES A", "C-3"), j("SALES B", "C-3"), j("SALES X", "C-3"), // dua di cakupan + satu luar
        j("SALES A", "C-4"),                                          // toko cakupan, tidak ganda
    ];
    const r = susunCoverage(rows, [" sales a", "SALES B"], null);   // kode cakupan beda spasi/huruf tetap cocok
    assert.deepEqual(r.baris.map((b) => [b.custCode, b.salesman.map((s) => s.salesCode)]), [["C-1", ["SALES A", "SALES X"]], ["C-3", ["SALES A", "SALES B", "SALES X"]]]);
    assert.equal(r.totalToko, 3, "C-1, C-3, C-4 (C-2 di luar cakupan tidak dihitung)");
    // global melihat semuanya
    assert.deepEqual(susunCoverage(rows, null, null).baris.map((b) => b.custCode), ["C-1", "C-2", "C-3"]);
    assert.equal(susunCoverage(rows, null, null).totalToko, 4);
});

test("cakupan kosong: tidak ada baris, totalToko 0, pilihanPrincipal kosong", () => {
    assert.deepEqual(susunCoverage([j("SALES A", "C-1"), j("SALES B", "C-1")], [], null), { pilihanPrincipal: [], totalToko: 0, baris: [] });
});

test("principal: saringan tak peka huruf; totalToko menyempit, pilihanPrincipal tidak", () => {
    const rows = [
        j("SALES A", "C-1", "PRINCIPLE A"), j("SALES B", "C-1", "PRINCIPLE A"),
        j("SALES A", "C-1", "PRINCIPLE B"), j("SALES B", "C-1", "PRINCIPLE B"),
        j("SALES A", "C-2", "PRINCIPLE B"),
    ];
    const semua = susunCoverage(rows, null, null);
    assert.deepEqual(semua.baris.map((b) => b.principle), ["PRINCIPLE A", "PRINCIPLE B"], "toko sama, dua principal = dua baris");
    assert.equal(semua.totalToko, 2);
    const a = susunCoverage(rows, null, " principle a");
    assert.deepEqual(a.baris.map((b) => b.principle), ["PRINCIPLE A"]);
    assert.equal(a.totalToko, 1, "hanya toko JKS PRINCIPLE A");
    assert.deepEqual(a.pilihanPrincipal, ["PRINCIPLE A", "PRINCIPLE B"]);
    assert.deepEqual(susunCoverage(rows, null, "PRINCIPLE Z"), { pilihanPrincipal: ["PRINCIPLE A", "PRINCIPLE B"], totalToko: 0, baris: [] });
});

test("urutan baris: principal, nama toko, kode toko", () => {
    const rows = [
        j("SALES A", "C-9", "PRINCIPLE B", { custName: "TOKO A" }), j("SALES B", "C-9", "PRINCIPLE B"),
        j("SALES A", "C-2", "PRINCIPLE A", { custName: "TOKO B" }), j("SALES B", "C-2", "PRINCIPLE A"),
        j("SALES A", "C-1", "PRINCIPLE A", { custName: "TOKO A" }), j("SALES B", "C-1", "PRINCIPLE A"),
    ];
    assert.deepEqual(susunCoverage(rows, null, null).baris.map((b) => b.custCode), ["C-1", "C-2", "C-9"]);
});

test("tanpa baris JKS: jawaban kosong", () => {
    assert.deepEqual(susunCoverage([], null, null), { pilihanPrincipal: [], totalToko: 0, baris: [] });
});

test("kode lengkap Accurate (luar rute) = kode pendek JKS (unggahan): satu toko, ganda terdeteksi, totalToko tidak dihitung dua kali", () => {
    const r = susunCoverage([j("SALES A", "C-1"), j("SALES B", "c-1-cba ")], null, null);
    assert.equal(r.baris.length, 1);
    assert.equal(r.baris[0].custCode, "C-1", "yang tampil kode pendek");
    // urutan masukan dibalik: tetap kode pendek (D2 tinjauan #215)
    assert.equal(susunCoverage([j("SALES B", "C-1-CBA"), j("SALES A", "C-1")], null, null).baris[0].custCode, "C-1");
    assert.deepEqual(r.baris[0].salesman.map((s) => s.salesCode), ["SALES A", "SALES B"]);
    assert.equal(r.totalToko, 1);
    // cakupan hanya SALES B (kode lengkap): kelompok tetap tampil UTUH lewat kunci gabungan, toko dihitung sekali
    const b = susunCoverage([j("SALES A", "C-1"), j("SALES B", "C-1-CBA")], ["SALES B"], null);
    assert.deepEqual(b.baris.map((x) => x.salesman.map((s) => s.salesCode)), [["SALES A", "SALES B"]]);
    assert.equal(b.totalToko, 1);
    // salesman yang sama menulis dua gaya kode = bukan ganda
    assert.deepEqual(susunCoverage([j("SALES A", "C-1"), j("SALES A", "C-1-CBA")], null, null).baris, []);
    // saringan principal tetap bekerja pada kunci gabungan
    assert.equal(susunCoverage([j("SALES A", "C-1"), j("SALES B", "C-1-CBA")], null, "principle a").baris.length, 1);
    assert.equal(susunCoverage([j("SALES A", "C-1"), j("SALES B", "C-1-CBA")], null, "PRINCIPLE B").baris.length, 0);
});

test("penyamaan kode HANYA bila kode pendek ada di JKS aktif principal yang sama; kode tanpa akhiran tak runtuh", () => {
    // kode pendek tak ada di JKS: dua kode lengkap beda akhiran tidak disamakan
    const tanpa = susunCoverage([j("SALES A", "C-1-CBA"), j("SALES B", "C-1-MKS")], null, null);
    assert.deepEqual(tanpa.baris, []);
    assert.equal(tanpa.totalToko, 2);
    // kode pendek hanya ada di principal lain: tidak disamakan
    assert.deepEqual(susunCoverage([j("SALES A", "C-1", "PRINCIPLE B"), j("SALES B", "C-1-CBA", "PRINCIPLE A")], null, null).baris, []);
    // dua kode lengkap di PRINCIPLE A + kode pendek hanya di PRINCIPLE B: bukan ganda (D1 tinjauan #215)
    assert.deepEqual(susunCoverage([j("X", "C-1-CBA", "PRINCIPLE A"), j("Y", "C-1-MKS", "PRINCIPLE A"), j("Z", "C-1", "PRINCIPLE B")], null, null).baris, []);
    // "C-100001" tidak runtuh ke "C" (tak ada toko berkode "C"): tampil utuh
    const utuh = susunCoverage([j("SALES A", "C-100001"), j("SALES B", "C-100001")], null, null);
    assert.equal(utuh.baris[0].custCode, "C-100001");
});
